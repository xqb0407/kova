/**
 * 面板内置浏览器（对齐 browser.rs + browser_scripts.rs）：
 * `<webview>` guest 绑定（DOM 嵌入渲染——层级/圆角/遮罩/裁剪全走主 webview 的
 * DOM 合成，浮层天然盖在它上面；因此不再需要原生子视图的 bounds 同步与
 * 「浮层出现即隐藏浏览器」的遮挡让位，对齐 ZCode 的内置浏览器架构）、
 * 视口模式（fill/fixed）、agent 动作原语（导航/快照/点击/输入/滚动/后退）。
 *
 * guest 的 webContents 由渲染端 `<webview>` 在 did-attach 后上报 id 绑定
 * （browser_bind_guest），这里校验 getType()==="webview" 后持有；页面随元素
 * 走，主文档刷新即随 DOM 销毁（destroyed 监听清引用）。
 *
 * 与 Rust 版的差异（PORTING-NOTES 记录）：ARIA 快照（Playwright 注入运行时）
 * 未移植，快照统一走 browser_scripts.rs 的文本快照（data-xr-ref 打标）。
 */
import { WebContents, session, webContents } from "electron";
import { emitToWindow } from "./ipc";
import { logWarn } from "./logging";

export const BROWSER_LABEL = "browser-panel";

const NAVIGATE_SETTLE_MS = 30_000;
const ACTION_SETTLE_MS = 10_000;
const EVAL_TIMEOUT_MS = 5_000;
/** panelOpen 帧 → 渲染端挂载 <webview> → did-attach 上报之间隔着 IPC 竞态，
 *  工具侧等 guest 出现的窗口 */
const PANEL_WAIT_MS = 5_000;
/** 「面板没开」的统一错误口径（工具错误串历史上被模型按字面理解，别改） */
const PANEL_NOT_OPEN = "browser panel is not open: call browser_navigate first";

type ViewportMode = { mode: "fill" } | { mode: "fixed"; width: number; height: number };

const state: { viewport: ViewportMode } = { viewport: { mode: "fill" } };

let guest: WebContents | null = null;
let actionBusy = false;

/* ------------------------------ JS 原语（与 browser_scripts.rs 同源） ------------------------------ */

const STATE_JS = `(() => {
  try {
    return JSON.stringify({ ok: true, url: location.href, readyState: document.readyState, title: document.title || "" });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
})()`;

const RESOLVE_JS = `var el = document.querySelector("[data-xr-ref=\\"" + ref + "\\"]");
    if (!el) {
      var sel = (window.__xrSelectors || {})[ref];
      try { if (sel) el = document.querySelector(sel); } catch (e) {}
    }
    if (!el) return JSON.stringify({ ok: false, error: "stale ref: " + ref + " not found — page may have changed, take a new snapshot" });`;

const SNAPSHOT_JS = `(() => {
  try {
    var MAX_LINES = 400, MAX_CHARS = 20000, MAX_WALKED = 4000;
    window.__xrRefSeq = window.__xrRefSeq || 0;
    var SKIP = { SCRIPT:1, STYLE:1, NOSCRIPT:1, TEMPLATE:1, SVG:1, IFRAME:1, LINK:1, META:1 };
    var INTER_TAGS = { A:1, BUTTON:1, INPUT:1, TEXTAREA:1, SELECT:1, SUMMARY:1 };
    var INTER_ROLES = { button:1, link:1, checkbox:1, radio:1, tab:1, menuitem:1, menuitemcheckbox:1, menuitemradio:1, combobox:1, option:1, switch:1, slider:1, searchbox:1, textbox:1, treeitem:1 };
    var lines = [], walked = 0, truncated = false;
    function hidden(el) {
      var s;
      try { s = getComputedStyle(el); } catch (err) { return true; }
      if (!s || s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return true;
      if (el.closest("[aria-hidden='true'],[hidden]")) return true;
      var r = el.getBoundingClientRect();
      return r.width === 0 && r.height === 0;
    }
    function isInteractive(el) {
      if (el.disabled === true) return false;
      var t = el.tagName;
      if (t === "INPUT" && (el.type || "").toLowerCase() === "hidden") return false;
      if (INTER_TAGS[t]) return true;
      if (el.isContentEditable) return true;
      var role = el.getAttribute("role");
      if (role && INTER_ROLES[role]) return true;
      return el.hasAttribute("onclick") || (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1");
    }
    function label(el) {
      var v = el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("alt") || el.title || "";
      if (!v && el.tagName === "INPUT") {
        var ty = (el.type || "text").toLowerCase();
        if (["text","search","email","password","tel","url","number"].indexOf(ty) === -1) v = el.value || "";
      }
      if (!v) v = (el.textContent || "").trim();
      return String(v).replace(/\\s+/g, " ").slice(0, 120);
    }
    function roleOf(el) {
      var t = el.tagName, role = el.getAttribute("role");
      if (role) return role;
      if (t === "A") return "link";
      if (t === "BUTTON") return "button";
      if (t === "TEXTAREA") return "textbox";
      if (t === "SELECT") return "combobox";
      if (t === "SUMMARY") return "summary";
      if (t === "INPUT") {
        var ty = (el.type || "text").toLowerCase();
        if (["checkbox","radio","button","submit","file","range","image"].indexOf(ty) !== -1) return ty;
        return "textbox";
      }
      if (/^H[1-6]$/.test(t)) return "heading";
      return t.toLowerCase();
    }
    function ownText(el) {
      var out = "";
      for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) out += n.nodeValue;
      return out.replace(/\\s+/g, " ").trim().slice(0, 200);
    }
    function walk(el, depth) {
      if (truncated || walked >= MAX_WALKED) return;
      walked++;
      var t = el.tagName;
      if (SKIP[t]) return;
      if (hidden(el)) return;
      var ind = "  ".repeat(Math.min(depth, 4));
      if (isInteractive(el)) {
        var ref = "e" + (++window.__xrRefSeq);
        el.setAttribute("data-xr-ref", ref);
        var extra = (el.tagName === "INPUT" && (el.type || "").toLowerCase() === "password") ? " (password)" : "";
        lines.push(ind + "- " + roleOf(el) + extra + " \\"" + label(el) + "\\" [ref=" + ref + "]");
        return;
      }
      if (/^H[1-6]$/.test(t)) {
        var h = (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 160);
        if (h) lines.push(ind + "- heading \\"" + h + "\\" [" + t.toLowerCase() + "]");
      } else if (t === "IMG" && el.alt) {
        lines.push(ind + "- image \\"" + String(el.alt).slice(0, 120) + "\\"");
      } else {
        var ot = ownText(el);
        if (ot) lines.push(ind + "- text: " + ot);
      }
      var kids = el.children;
      for (var i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
    }
    if (document.body) {
      walk(document.body, 0);
      if (walked >= MAX_WALKED || lines.length >= MAX_LINES) truncated = true;
    }
    var tree = lines.join("\\n");
    if (tree.length > MAX_CHARS) { tree = tree.slice(0, MAX_CHARS) + "\\n…[截断]"; truncated = true; }
    return JSON.stringify({ ok: true, url: location.href, title: document.title || "", tree: tree, refCount: window.__xrRefSeq, truncated: truncated });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
})()`;

const CLICK_JS_TEMPLATE = `(() => {
  try {
    var ref = "__XR_REF__";
    __XR_RESOLVE__
    el.scrollIntoView({ block: "center" });
    var r = el.getBoundingClientRect();
    var opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    try { el.dispatchEvent(new PointerEvent("pointerdown", opts)); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    try { el.dispatchEvent(new PointerEvent("pointerup", opts)); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    return JSON.stringify({ ok: true });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
})()`;

const TYPE_JS_TEMPLATE = `(() => {
  try {
    var ref = "__XR_REF__";
    var value = __XR_VALUE__;
    var submit = __XR_SUBMIT__;
    __XR_RESOLVE__
    el.focus();
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
    } else if (el.tagName === "SELECT") {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var d = Object.getOwnPropertyDescriptor(proto, "value");
      if (d && d.set) d.set.call(el, value); else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (submit) {
      var ke = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true });
      el.dispatchEvent(ke);
      var form = el.closest("form");
      if (form && !ke.defaultPrevented) { try { form.requestSubmit(); } catch (e) {} }
    }
    return JSON.stringify({ ok: true });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
})()`;

const SCROLL_JS_TEMPLATE = `(() => {
  try {
    var dir = "__XR_DIR__";
    var amount = __XR_AMOUNT__;
    if (dir === "top") window.scrollTo(0, 0);
    else if (dir === "bottom") window.scrollTo(0, document.documentElement.scrollHeight);
    else window.scrollBy(0, dir === "up" ? -amount : amount);
    var max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    return JSON.stringify({ ok: true, scrollY: Math.round(window.scrollY), maxScrollY: Math.round(max) });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
})()`;

const BACK_JS = `(() => {
  try { history.back(); return JSON.stringify({ ok: true }); }
  catch (err) { return JSON.stringify({ ok: false, error: String((err && err.message) || err) }); }
})()`;

/* ------------------------------ 基础工具 ------------------------------ */

function parseWebUrl(s: string): string {
  const t = (s ?? "").trim();
  if (!t) throw new Error("url is required");
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw new Error(`invalid url: ${t}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "file:") {
    throw new Error(`only http/https/file urls are supported: ${t}`);
  }
  return u.toString();
}

function jsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

function samePage(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\/+$/, "");
  const na = norm(a);
  return na.length > 0 && na === norm(b);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function evalJson(js: string): Promise<any> {
  const wc = ensureGuest();
  if (!wc) throw new Error(PANEL_NOT_OPEN);
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error("browser eval timeout")), EVAL_TIMEOUT_MS),
  );
  let raw: unknown;
  try {
    raw = await Promise.race([wc.executeJavaScript(js, true), timeout]);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("timeout")) throw e;
    throw new Error(
      "browser eval returned no result — the panel webview has no live page yet (load failed or still initializing)",
    );
  }
  return parseEvalResult(raw);
}

function parseEvalResult(raw: unknown): any {
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    throw new Error(
      "browser eval returned no result — the panel webview has no live page yet (load failed or still initializing)",
    );
  }
  let v: any = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return v;
    }
    if (typeof v === "string") {
      try {
        const inner = JSON.parse(v);
        if (inner && typeof inner === "object") return inner;
      } catch {
        /* 原样返回 */
      }
    }
  }
  return v;
}

async function pageState(): Promise<any> {
  const v = await evalJson(STATE_JS);
  if (v?.ok === false) {
    throw new Error(
      `the panel webview did not answer (its page script failed: ${v.error ?? "unknown error"}). The panel is most likely stale or already torn down — reopen the browser panel, or pass an explicit url to browser_shot to photograph a specific page instead.`,
    );
  }
  return v;
}

async function evalAction(js: string, what: string): Promise<any> {
  const v = await evalJson(js);
  if (v?.ok === false) throw new Error(`${what} failed: ${v.error ?? "unknown error"}`);
  return v;
}

async function waitStable(maxMs: number, requireChange: boolean, beforeUrl: string): Promise<void> {
  const deadline = Date.now() + maxMs;
  if (requireChange) {
    const changeDeadline = Date.now() + Math.min(maxMs, 10_000);
    while (Date.now() < changeDeadline) {
      try {
        const v = await pageState();
        const url = String(v?.url ?? "");
        const ready = String(v?.readyState ?? "complete");
        if ((url.length > 0 && url !== beforeUrl) || ready !== "complete") break;
      } catch {
        /* 导航瞬间 eval 丢失：下一轮 */
      }
      await sleep(100);
    }
  }
  let lastUrl = "";
  let lastReady = "";
  let lastErr = "";
  let stable = 0;
  let sawPage = false;
  while (Date.now() < deadline) {
    try {
      const v = await pageState();
      const url = String(v?.url ?? "");
      const ready = String(v?.readyState ?? "");
      lastErr = "";
      if (ready === "complete" && url.length > 0 && url !== "about:blank") sawPage = true;
      if (ready === "complete" && url.length > 0 && url === lastUrl) {
        stable += 1;
        if (stable >= 2) break;
      } else {
        stable = 0;
        lastUrl = url;
        lastReady = ready;
      }
    } catch (e: any) {
      stable = 0;
      lastErr = String(e?.message ?? e);
    }
    await sleep(250);
  }
  if (!sawPage) {
    throw new Error(
      `browser navigation did not load: the panel webview stayed on ${lastUrl.length > 0 ? lastUrl : "<empty>"} (readyState=${JSON.stringify(lastReady)}, last eval error=${JSON.stringify(lastErr)}). The browser panel may not be open or attached yet — open it, or retry browser_navigate.`,
    );
  }
  await sleep(400);
}

/* ------------------------------ 站点数据清理（设置页"浏览器数据"） ------------------------------ */

/** 面板 `<webview>` 的持久化分区（渲染端 partition 属性同值）：清除类操作
 *  落在它的 session 上。**不要用删磁盘目录的方式替代**——应用运行时目录
 *  被 session 占着句柄，删不干净、还会留下半截缓存。 */
const PANEL_PARTITION = "persist:browser-panel";

/** 清渲染缓存（HTTP 缓存 / Cache Storage / Service Worker），保留 Cookie 与登录态 */
export async function browserClearCache(): Promise<null> {
  await session.fromPartition(PANEL_PARTITION).clearCache();
  return null;
}

/** 清全部站点数据（Cookie / localStorage / IndexedDB …）+ 缓存，不可撤销；
 *  清完顺手重载面板，让"已退出登录"立刻可见 */
export async function browserClearData(): Promise<null> {
  const s = session.fromPartition(PANEL_PARTITION);
  await s.clearStorageData();
  await s.clearCache();
  const wc = ensureGuest();
  if (wc) {
    try {
      wc.reload();
    } catch {
      /* 面板未就绪/正在导航：忽略 */
    }
  }
  return null;
}

/* ------------------------------ 控制台日志 ------------------------------ */

type ConsoleLevel = "error" | "warning" | "info" | "debug";
type ConsoleEntry = {
  id: number;
  level: ConsoleLevel;
  message: string;
  source: string;
  line: number;
  ts: number;
};

/** 环缓冲上限：页面控制台可能非常吵（三方 SDK 刷屏），只保留最近 N 条 */
const CONSOLE_MAX = 300;
const consoleEntries: ConsoleEntry[] = [];
let consoleSeq = 0;
/** 已挂监听器的 guest（holdGuest 幂等重入保护） */
const consoleWired = new WeakSet<WebContents>();
/** 批量推送：高峰期逐条发 IPC 太吵，攒 150ms 一发 */
const consolePending: ConsoleEntry[] = [];
let consoleFlushTimer: NodeJS.Timeout | null = null;

function flushConsole(): void {
  consoleFlushTimer = null;
  if (consolePending.length === 0) return;
  const batch = consolePending.splice(0, consolePending.length);
  emitToWindow("main", "browser:console", { entries: batch });
}

function clearConsole(): void {
  consoleEntries.length = 0;
  consolePending.length = 0;
  if (consoleFlushTimer !== null) {
    clearTimeout(consoleFlushTimer);
    consoleFlushTimer = null;
  }
}

/** 面板内页面统一用应用同款细滚动条：guest 页面默认滚动条是 Chromium 原生
 *  样式（宽、带轨道底色），与主界面的 6px 悬浮式滚动条不一致，观感很跳。
 *  用 insertCSS（cssOrigin:"user"）压过页面自身样式；导航会清掉注入，
 *  由 did-finish-load 重新注入（旧 key 先撤销，避免多层叠加）。 */
const PANEL_SCROLLBAR_CSS = `
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background-color: rgba(127,127,127,0.35); border-radius: 9999px; }
  ::-webkit-scrollbar-thumb:hover { background-color: rgba(127,127,127,0.55); }
  ::-webkit-scrollbar-corner { background: transparent; }
`;
const scrollbarCssKeys = new WeakMap<WebContents, string>();

function injectPanelScrollbars(wc: WebContents): void {
  if (wc.isDestroyed()) return;
  const prev = scrollbarCssKeys.get(wc);
  if (prev) {
    wc.removeInsertedCSS(prev).catch(() => {});
    scrollbarCssKeys.delete(wc);
  }
  wc.insertCSS(PANEL_SCROLLBAR_CSS, { cssOrigin: "user" })
    .then((key) => {
      if (!wc.isDestroyed()) scrollbarCssKeys.set(wc, key);
    })
    .catch(() => {
      /* 注入失败不拦浏览 */
    });
}

function wireConsole(wc: WebContents): void {
  if (consoleWired.has(wc)) return;
  consoleWired.add(wc);
  wc.on("console-message", (details) => {
    const message = String(details?.message ?? "");
    if (!message) return;
    const level = (details?.level ?? "info") as ConsoleLevel;
    const entry: ConsoleEntry = {
      id: ++consoleSeq,
      level,
      message: message.length > 2000 ? `${message.slice(0, 2000)}…` : message,
      source: String(details?.sourceId ?? ""),
      line: Number(details?.lineNumber ?? 0),
      ts: Date.now(),
    };
    consoleEntries.push(entry);
    if (consoleEntries.length > CONSOLE_MAX) {
      consoleEntries.splice(0, consoleEntries.length - CONSOLE_MAX);
    }
    consolePending.push(entry);
    if (consoleFlushTimer === null) consoleFlushTimer = setTimeout(flushConsole, 150);
  });
  // DevTools 默认行为：主框架导航即清空（保留日志关）；否则错误会带着旧页的
  // 上下文一路累积，面板上的统计失去意义
  wc.on("did-start-navigation", (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) clearConsole();
  });
  // 细滚动条：导航后重注入（insertCSS 随文档走），当前文档则立即注入一次
  wc.on("did-finish-load", () => injectPanelScrollbars(wc));
  injectPanelScrollbars(wc);
}

/** 面板底部控制台：全量拉取（挂载/重连时对齐真相） */
export function browserConsoleGet(): any {
  return { entries: consoleEntries.slice() };
}

/** 面板底部控制台：手动清空 */
export function browserConsoleClear(): null {
  clearConsole();
  return null;
}

/* ------------------------------ guest 生命周期 ------------------------------ */

/** 接受一个 guest 句柄（校验 fail closed：误绑主窗口 webContents 会让 agent 的
 *  eval 直接操作应用自己的 UI）。重复接受同一 guest 幂等 */
function holdGuest(wc: WebContents): WebContents {
  if (guest !== wc) {
    guest = wc;
    // 元素卸载/主文档刷新 → guest 随 DOM 销毁：清引用与日志，工具侧回到「面板没开」口径
    wc.once("destroyed", () => {
      if (guest === wc) guest = null;
      clearConsole();
    });
    // 面板内 window.open 一律拒绝（旧原生视图同策；外链跳转走用户手势）
    try {
      wc.setWindowOpenHandler(() => ({ action: "deny" }));
    } catch {
      /* 绑定晚于销毁等边缘：忽略 */
    }
  }
  wireConsole(wc);
  return wc;
}

/** `<webview>` guest 显式绑定：渲染端（did-attach / dom-ready 后）上报 id。 */
export function browserBindGuest(args: { webContentsId?: number | null }): null {
  const id = Number(args?.webContentsId ?? 0);
  const wc = Number.isInteger(id) && id > 0 ? webContents.fromId(id) : undefined;
  if (!wc || wc.isDestroyed()) throw new Error("browser_bind_guest: webContents not found");
  if (wc.getType() !== "webview") {
    throw new Error(`browser_bind_guest: not a <webview> guest (type=${wc.getType()})`);
  }
  holdGuest(wc);
  return null;
}

/** 兜底自动发现：本应用只有浏览器面板一个 `<webview>`。渲染端上报失败
 *  （版本差异/时序）不该让 agent 工具与 DevTools 命令一起失联——工具链的
 *  命脉不押在渲染端。显式绑定的句柄优先 */
function autoDiscoverGuest(): WebContents | null {
  if (guest && !guest.isDestroyed()) return guest;
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    try {
      if (wc.getType() === "webview") return holdGuest(wc);
    } catch {
      /* 某些内部 webContents 不支持 getType：跳过 */
    }
  }
  return null;
}

/** 取 guest：显式绑定优先，未绑定则现场发现 */
function ensureGuest(): WebContents | null {
  return guest && !guest.isDestroyed() ? guest : autoDiscoverGuest();
}

/** 等 guest 就绪：同一轮里 data-panelOpen 帧与工具调用前后脚到达，渲染端挂载
 *  `<webview>` 到 dom-ready 之间 guest 还不存在 */
async function waitForGuest(maxMs: number): Promise<WebContents | null> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const wc = ensureGuest();
    if (wc) return wc;
    if (Date.now() >= deadline) return null;
    await sleep(100);
  }
}

/* ------------------------------ 视口 ------------------------------ */

function viewportPayload(vp: ViewportMode): any {
  return vp.mode === "fill"
    ? { mode: "fill", width: null, height: null }
    : { mode: "fixed", width: vp.width, height: vp.height };
}

/** 视口由渲染端按 CSS 尺寸落位（`<webview>` 元素本身就是视口）：这里只存状态
 *  并广播，页面重排交给元素尺寸变化（fill=撑满面板 / fixed=居中固定尺寸） */
function setViewport(vp: ViewportMode): void {
  state.viewport = vp;
  emitToWindow("main", "browser:viewport", viewportPayload(vp));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function browserViewportSet(args: { mode?: string | null; width?: number | null; height?: number | null }): null {
  const vp: ViewportMode =
    args?.mode === "fixed" && args.width != null && args.height != null
      ? { mode: "fixed", width: clamp(Number(args.width), 200, 4000), height: clamp(Number(args.height), 200, 4000) }
      : { mode: "fill" };
  setViewport(vp);
  return null;
}

export function browserViewportGet(): any {
  return viewportPayload(state.viewport);
}

export function browserOpenDevtools(): null {
  const wc = ensureGuest();
  if (!wc) throw new Error("browser panel not open");
  wc.openDevTools({ mode: "detach" });
  return null;
}

/* ------------------------------ 页面元素拾取（"选择元素"） ------------------------------ */

/** 注入页面的拾取器：高亮悬停元素 + 左上角标签徽标（Chrome 元素拾取同款交互），
 *  点击即选中并回传元素信息；Esc 取消。整个脚本是"返回 Promise 的表达式"——
 *  executeJavaScript 会等这个 Promise 落定，所以一次调用就是一次完整拾取会话。
 *  重复调用先取消上一个（防叠加多套监听）。 */
const PICK_ELEMENT_JS = `(() => new Promise((resolve) => {
  try { if (window.__kovaPicker) window.__kovaPicker.cancel(); } catch (e) {}
  var box = document.createElement("div");
  var badge = document.createElement("div");
  var S = box.style, BS = badge.style;
  // 中性锌灰（与主界面同族）：不用绿/蓝；暗底页面靠角标的白描边保持可见
  S.position = "fixed"; S.zIndex = "2147483646"; S.pointerEvents = "none";
  S.border = "1.5px solid #52525b"; S.background = "rgba(82,82,91,0.14)";
  S.borderRadius = "2px"; S.transition = "all 40ms linear";
  BS.position = "fixed"; BS.zIndex = "2147483647"; BS.pointerEvents = "none";
  BS.background = "#27272a"; BS.color = "#fafafa"; BS.font = "11px/1.5 ui-monospace, monospace";
  BS.padding = "0 5px"; BS.borderRadius = "3px"; BS.maxWidth = "70vw";
  BS.boxShadow = "0 0 0 1px rgba(255,255,255,0.55)";
  BS.whiteSpace = "nowrap"; BS.overflow = "hidden"; BS.textOverflow = "ellipsis";
  document.documentElement.appendChild(box);
  document.documentElement.appendChild(badge);
  var done = false;
  function label(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    else if (el.classList && el.classList.length) s += "." + el.classList[0];
    return s;
  }
  function selector(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      var s = node.tagName.toLowerCase();
      if (node.id) { parts.unshift("#" + node.id); break; }
      if (node.classList && node.classList.length) s += "." + node.classList[0];
      parts.unshift(s);
      node = node.parentElement;
      if (node === document.body || node === document.documentElement) break;
    }
    return parts.join(" > ");
  }
  function place(el) {
    var r = el.getBoundingClientRect();
    S.left = r.left + "px"; S.top = r.top + "px";
    S.width = r.width + "px"; S.height = r.height + "px";
    // 角标贴住高亮框左上角（底缘略压在框线上，读作"这个框的标签"）；
    // 顶部空间不够（元素贴着视口上缘）时落到框内侧
    BS.left = Math.max(0, r.left - 1) + "px";
    BS.top = (r.top > 22 ? r.top - 17 : r.top + 1) + "px";
    BS.textContent = label(el);
  }
  function cleanup() {
    try { document.removeEventListener("mousemove", onMove, true); } catch (e) {}
    try { document.removeEventListener("click", onClick, true); } catch (e) {}
    try { document.removeEventListener("keydown", onKey, true); } catch (e) {}
    try { box.remove(); } catch (e) {}
    try { badge.remove(); } catch (e) {}
    try { window.__kovaPicker = null; } catch (e) {}
  }
  function finish(payload) { if (done) return; done = true; cleanup(); resolve(payload); }
  function onMove(e) { var t = e.target; if (t && t.nodeType === 1) place(t); }
  function onClick(e) {
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    e.preventDefault(); e.stopPropagation();
    var r = el.getBoundingClientRect();
    finish({
      ok: true,
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      classes: Array.prototype.slice.call(el.classList || []).slice(0, 5),
      selector: selector(el),
      text: String(el.innerText || el.textContent || "").trim().slice(0, 300),
      html: String(el.outerHTML || "").slice(0, 2000),
      url: location.href,
      title: document.title || "",
      rect: { x: r.left, y: r.top, width: r.width, height: r.height }
    });
  }
  function onKey(e) { if (e.key === "Escape") { e.preventDefault(); finish({ ok: false, cancelled: true }); } }
  window.__kovaPicker = { cancel: function () { finish({ ok: false, cancelled: true }); } };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
}))()`;

/** 拾取会话上限：超时自动取消（注入脚本里没有计时器，超时由这里竞速兜住） */
const PICK_TIMEOUT_MS = 120_000;

/** 页面元素拾取：返回 {ok:false} 表示用户取消/超时；成功时附元素截图（尽力而为）。
 *  截图走 capturePage + rect 裁剪（CSS 像素 = DIP），面积过大时跳过（base64 太大没意义）。 */
export async function browserPickElement(): Promise<any> {
  const wc = ensureGuest();
  if (!wc) throw new Error("browser panel not open");
  const timeout = new Promise<{ ok: false; timeout: true }>((resolve) =>
    setTimeout(() => resolve({ ok: false, timeout: true }), PICK_TIMEOUT_MS),
  );
  let raw: any;
  try {
    raw = await Promise.race([wc.executeJavaScript(PICK_ELEMENT_JS, true), timeout]);
  } catch (e: any) {
    throw new Error(`browser_pick_element: ${e?.message ?? e}`);
  }
  // 超时兜底：把页面里的拾取器收掉（否则监听器与高亮框一直挂着）
  if (raw?.ok === false && raw.timeout)
    void wc.executeJavaScript(`(() => { try { window.__kovaPicker && window.__kovaPicker.cancel(); } catch (e) {} })()`).catch(() => {});
  if (!raw?.ok) return raw ?? { ok: false, cancelled: true };
  let shot: string | null = null;
  const r = raw.rect;
  if (r && r.width >= 4 && r.height >= 4 && r.width * r.height <= 400_000) {
    try {
      const img = await wc.capturePage({
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
      if (!img.isEmpty()) shot = img.toDataURL();
    } catch {
      /* 截图失败不拦拾取：对话框里退回纯文本信息 */
    }
  }
  return { ...raw, shot };
}

/** 取消进行中的拾取（面板上的"取消"按钮；Esc 也可以，在页面里生效） */
export async function browserPickCancel(): Promise<null> {
  const wc = ensureGuest();
  if (!wc) return null;
  await wc
    .executeJavaScript(`(() => { try { window.__kovaPicker && window.__kovaPicker.cancel(); } catch (e) {} })()`)
    .catch(() => {});
  return null;
}

/** DevTools 定向命令（对齐 Trae 地址栏右侧下拉）：
 *  open=只打开；inspect=元素拾取；device=设备工具栏；console=控制台。
 *  拾取/设备/控制台没有对应 API，走 DevTools 前端自身的快捷键
 *  （Cmd/Ctrl+Shift+C / M / J），键发到 DevTools 自己的 webContents 上。
 *  DevTools 前端是异步加载的：opened 事件 ≠ 前端就绪，发键前留一小段
 *  加载窗口（轮询 dom-ready 拿不到 DevTools 的 WebContents 事件面，
 *  短延时是最稳的近似；按键失败不影响 DevTools 已打开这一事实）。 */
export async function browserDevtoolsCommand(args: { command?: string | null }): Promise<null> {
  const wc = ensureGuest();
  if (!wc) throw new Error("browser panel not open");
  const cmd = String(args?.command ?? "open");
  const key = cmd === "inspect" ? "C" : cmd === "device" ? "M" : cmd === "console" ? "J" : null;
  if (!wc.isDevToolsOpened()) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 3_000);
      wc.once("devtools-opened", () => {
        clearTimeout(timer);
        resolve();
      });
      wc.openDevTools({ mode: "detach" });
    });
  }
  if (!key) return null;
  const dt = wc.devToolsWebContents;
  if (dt && !dt.isDestroyed()) {
    await sleep(400);
    const modifiers: Array<"meta" | "control" | "shift"> =
      process.platform === "darwin" ? ["meta", "shift"] : ["control", "shift"];
    try {
      dt.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
      dt.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
    } catch (e: any) {
      logWarn(`[browser] devtools shortcut failed: ${e?.message ?? e}`);
    }
  }
  return null;
}

/* ------------------------------ 快照与 agent 动作 ------------------------------ */

async function snapshotOutput(): Promise<any> {
  const v = await evalJson(SNAPSHOT_JS);
  if (v?.ok === false) throw new Error(`snapshot failed: ${v.error ?? "unknown error"}`);
  const url = String(v?.url ?? "");
  const title = String(v?.title ?? "");
  const tree = String(v?.tree ?? "");
  let out = `${url}\n${title}\n`;
  if (v?.truncated === true) {
    out += "（快照被截断：用 browser_scroll 分段查看或聚焦目标区域）\n";
  }
  if (tree.trim().length === 0) {
    if (url.length === 0 || url === "about:blank") {
      out +=
        "（面板还停在 about:blank，这一页根本没加载出来。别在这里重试快照：先确认浏览器面板已打开，或重新 browser_navigate）";
    } else {
      out += "（页面无可交互元素或文本，可能仍在加载，稍后重新 browser_snapshot）";
    }
  } else {
    out += tree;
  }
  return { output: out, url, title, truncated: v?.truncated === true };
}

export async function currentUrl(): Promise<string> {
  if (!ensureGuest()) throw new Error(PANEL_NOT_OPEN);
  const v = await pageState();
  const url = String(v?.url ?? "").trim();
  if (url.length === 0) {
    throw new Error(
      "the panel webview has no loaded document yet (location.href is empty). Navigate it first, or pass an explicit url to browser_shot.",
    );
  }
  if (url === "about:blank") {
    throw new Error(
      "the browser panel is still on about:blank — it has not navigated anywhere yet. Pass an explicit url to browser_shot to photograph a specific page instead.",
    );
  }
  return url;
}

export async function runTool(name: string, p: any): Promise<any> {
  if (actionBusy) throw new Error("browser busy: another browser action is still in flight");
  actionBusy = true;
  try {
    if (name === "browser_navigate") {
      // 面板 <webview> 由渲染端挂载，did-attach 上报后才可驱动：等 guest
      // 出现（data-panelOpen 帧与工具调用是同轮的前后脚）
      if (!(await waitForGuest(PANEL_WAIT_MS))) throw new Error(PANEL_NOT_OPEN);
      const url = parseWebUrl(String(p?.url ?? ""));
      let retried = false;
      for (;;) {
        const wc = ensureGuest();
        if (!wc) throw new Error(PANEL_NOT_OPEN);
        const before = await pageState()
          .then((v) => String(v?.url ?? ""))
          .catch(() => "");
        if (before !== url) {
          try {
            await wc.loadURL(url);
          } catch (e: any) {
            throw new Error(`browser_navigate: navigate failed: ${e?.message ?? e}`);
          }
        }
        try {
          await waitStable(NAVIGATE_SETTLE_MS, !retried, before);
          const v = await pageState();
          const landed = String(v?.url ?? "").trim();
          if (samePage(landed, url)) return await snapshotOutput();
          const msg = `browser_navigate: asked for ${url} but the panel landed on ${JSON.stringify(landed)}. The page redirected, or the panel webview is not the one being driven. Reopen the browser panel and retry.`;
          if (!retried) {
            logWarn(`[browser] ${msg}`);
            retried = true;
            continue;
          }
          throw new Error(msg);
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          if (!retried && msg.startsWith("browser navigation did not load")) {
            logWarn(`[browser] ${msg}; retrying once`);
            retried = true;
            continue;
          }
          throw e;
        }
      }
    }

    if (!(await waitForGuest(PANEL_WAIT_MS))) throw new Error(PANEL_NOT_OPEN);

    switch (name) {
      case "browser_snapshot":
        return await snapshotOutput();
      case "browser_resize": {
        const fill = p?.fill === true;
        const w = p?.width;
        const h = p?.height;
        setViewport(
          fill || w == null || h == null
            ? { mode: "fill" }
            : { mode: "fixed", width: clamp(Number(w), 200, 4000), height: clamp(Number(h), 200, 4000) },
        );
        await sleep(500);
        return await snapshotOutput();
      }
      case "browser_click": {
        const ref = p?.ref;
        if (typeof ref !== "string") throw new Error("missing param: ref");
        const js = CLICK_JS_TEMPLATE.replace("__XR_RESOLVE__", RESOLVE_JS).replace("__XR_REF__", jsEscape(ref));
        await evalAction(js, "click");
        await waitStable(ACTION_SETTLE_MS, false, "");
        return await snapshotOutput();
      }
      case "browser_type": {
        const ref = p?.ref;
        const text = p?.text;
        if (typeof ref !== "string") throw new Error("missing param: ref");
        if (typeof text !== "string") throw new Error("missing param: text");
        const js = TYPE_JS_TEMPLATE.replace("__XR_RESOLVE__", RESOLVE_JS)
          .replace("__XR_REF__", jsEscape(ref))
          .replace("__XR_VALUE__", JSON.stringify(text))
          .replace("__XR_SUBMIT__", p?.submit === true ? "true" : "false");
        await evalAction(js, "type");
        await waitStable(ACTION_SETTLE_MS, false, "");
        return await snapshotOutput();
      }
      case "browser_scroll": {
        const dir = String(p?.direction ?? "down").toLowerCase();
        if (!["up", "down", "top", "bottom"].includes(dir)) {
          throw new Error(`invalid direction: ${dir} (up|down|top|bottom)`);
        }
        const amount = Math.min(Number(p?.amount ?? 600) || 600, 100_000);
        const js = SCROLL_JS_TEMPLATE.replace("__XR_DIR__", jsEscape(dir)).replace("__XR_AMOUNT__", String(amount));
        await evalAction(js, "scroll");
        await waitStable(ACTION_SETTLE_MS, false, "");
        return await snapshotOutput();
      }
      case "browser_back": {
        const before = String((await pageState())?.url ?? "");
        await evalAction(BACK_JS, "back");
        await waitStable(ACTION_SETTLE_MS, false, "");
        const after = String((await pageState())?.url ?? "");
        const out = await snapshotOutput();
        if (before === after) {
          out.output = `历史没有更早的页面（url 未变化：${before}）\n\n${out.output}`;
        }
        return out;
      }
      default:
        throw new Error(`unknown browser tool: ${name}`);
    }
  } finally {
    actionBusy = false;
  }
}

/* ------------------------------ 命令注册 ------------------------------ */

export function setupBrowserCommands(register: (name: string, fn: (args: any) => any) => void): void {
  register("browser_bind_guest", (a) => browserBindGuest(a ?? {}));
  register("browser_open_devtools", () => browserOpenDevtools());
  register("browser_devtools_command", (a) => browserDevtoolsCommand(a ?? {}));
  register("browser_console_get", () => browserConsoleGet());
  register("browser_console_clear", () => browserConsoleClear());
  register("browser_clear_cache", () => browserClearCache());
  register("browser_clear_data", () => browserClearData());
  register("browser_pick_element", () => browserPickElement());
  register("browser_pick_cancel", () => browserPickCancel());
  register("browser_viewport_set", (a) => browserViewportSet(a ?? {}));
  register("browser_viewport_get", () => browserViewportGet());
}
