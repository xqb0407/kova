/**
 * 面板内置浏览器（对齐 browser.rs + browser_scripts.rs）：
 * WebContentsView 子视图（替代 Tauri 子 webview）、物理像素 bounds 同步、
 * 视口模式（fill/fixed）、agent 动作原语（导航/快照/点击/输入/滚动/后退）。
 *
 * 与 Rust 版的差异（PORTING-NOTES 记录）：ARIA 快照（Playwright 注入运行时）
 * 未移植，快照统一走 browser_scripts.rs 的文本快照（data-xr-ref 打标）。
 */
import { BrowserWindow, WebContentsView, screen, session } from "electron";
import { getMainWindow } from "./window";
import { emitToWindow } from "./ipc";
import { logInfo, logWarn } from "./logging";

export const BROWSER_LABEL = "browser-panel";

const NAVIGATE_SETTLE_MS = 30_000;
const ACTION_SETTLE_MS = 10_000;
const EVAL_TIMEOUT_MS = 5_000;

type ViewportMode = { mode: "fill" } | { mode: "fixed"; width: number; height: number };

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const state: {
  frame: Rect | null;
  container: Rect | null;
  viewport: ViewportMode;
} = { frame: null, container: null, viewport: { mode: "fill" } };

let view: WebContentsView | null = null;
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

/** 窗口的设备像素比（前端 bounds 为物理像素；Electron setBounds 用 DIP） */
function currentDpr(): number {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return 1;
  try {
    return screen.getDisplayMatching(win.getBounds()).scaleFactor || 1;
  } catch {
    return 1;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function evalJson(js: string): Promise<any> {
  if (!view) throw new Error("browser panel is not open: call browser_navigate first");
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error("browser eval timeout")), EVAL_TIMEOUT_MS),
  );
  let raw: unknown;
  try {
    raw = await Promise.race([view.webContents.executeJavaScript(js, true), timeout]);
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

/* ------------------------------ 子视图生命周期 ------------------------------ */

function emitNavigated(url: string, phase: string, title: string | null): void {
  emitToWindow("main", "browser:navigated", { url, phase, title });
}

function createView(url: string | null): WebContentsView {
  const win = getMainWindow();
  if (!win) throw new Error("main window not found");
  if (view) return view;
  const v = new WebContentsView({
    webPreferences: {
      session: session.fromPartition("persist:browser-panel"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  view = v;
  const wc = v.webContents;
  wc.on("did-start-navigation", (_e, navUrl, _isInPlace, isMainFrame) => {
    if (isMainFrame) emitNavigated(navUrl, "started", null);
  });
  wc.on("did-finish-load", () => {
    const u = wc.getURL();
    emitNavigated(u, "finished", null);
    void evalJson(STATE_JS)
      .then((sv) => emitNavigated(String(sv?.url ?? u), "title", String(sv?.title ?? "")))
      .catch(() => undefined);
  });
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  win.contentView.addChildView(v);
  v.setBounds(state.frame ?? fallbackBounds(win));
  try {
    v.setVisible(false);
  } catch {
    /* ignore */
  }
  if (url) void wc.loadURL(url).catch((e) => logWarn(`[browser] loadURL failed: ${e?.message ?? e}`));
  return v;
}

function fallbackBounds(win: BrowserWindow): Rect {
  const b = win.getContentBounds();
  const half = Math.floor(b.width / 2);
  return { x: half, y: 0, width: b.width - half, height: b.height };
}

function setVisible(show: boolean): void {
  if (!view) return;
  try {
    view.setVisible(show);
  } catch {
    /* ignore */
  }
}

/** 主页面（重）加载开始即移除子视图（对齐 destroy_for_reload；index.ts 挂载） */
export function destroyForReload(): void {
  if (!view) return;
  const win = getMainWindow();
  const v = view;
  view = null;
  try {
    if (win && !win.isDestroyed()) win.contentView.removeChildView(v);
    v.webContents.close();
  } catch {
    /* ignore */
  }
  logInfo("[browser] main webview reload: destroyed child webview");
}

/* ------------------------------ 前端命令 ------------------------------ */

export async function browserAttach(args: { url?: string | null; force?: boolean | null }): Promise<null> {
  const parsed = args?.url && String(args.url).trim() ? parseWebUrl(String(args.url)) : null;
  if (view) {
    if (parsed) {
      const skipSame = !args?.force;
      let current: string | null = null;
      if (skipSame) {
        try {
          current = String((await pageState())?.url ?? "");
        } catch {
          current = null;
        }
      }
      if (current !== parsed) await view.webContents.loadURL(parsed);
    }
    setVisible(true);
    return null;
  }
  if (!parsed) throw new Error("browser_attach: url required to create the panel webview");
  createView(parsed);
  setVisible(true);
  return null;
}

export function browserDetach(args: { destroy?: boolean | null }): null {
  if (view) {
    if (args?.destroy) destroyForReload();
    else setVisible(false);
  }
  return null;
}

export function browserSyncBounds(args: {
  x: number;
  y: number;
  width: number;
  height: number;
  cx?: number | null;
  cy?: number | null;
  cwidth?: number | null;
  cheight?: number | null;
}): null {
  const width = Math.trunc(Number(args.width ?? 0));
  const height = Math.trunc(Number(args.height ?? 0));
  if (width <= 0 || height <= 0) return null; // 不可见：不更新，避免定位到废位置
  const dpr = currentDpr() || 1;
  const toDip = (v: number) => Math.round(v / dpr);
  const rect: Rect = {
    x: toDip(Math.trunc(Number(args.x ?? 0))),
    y: toDip(Math.trunc(Number(args.y ?? 0))),
    width: Math.max(1, toDip(width)),
    height: Math.max(1, toDip(height)),
  };
  state.frame = rect;
  if (args.cx != null && args.cy != null && args.cwidth != null && args.cheight != null) {
    const cw = Math.trunc(Number(args.cwidth));
    const ch = Math.trunc(Number(args.cheight));
    if (cw > 0 && ch > 0) {
      state.container = {
        x: toDip(Math.trunc(Number(args.cx))),
        y: toDip(Math.trunc(Number(args.cy))),
        width: toDip(cw),
        height: toDip(ch),
      };
    }
  }
  if (view) view.setBounds(rect);
  return null;
}

function viewportPayload(vp: ViewportMode): any {
  return vp.mode === "fill"
    ? { mode: "fill", width: null, height: null }
    : { mode: "fixed", width: vp.width, height: vp.height };
}

function setViewport(vp: ViewportMode): void {
  state.viewport = vp;
  emitToWindow("main", "browser:viewport", viewportPayload(vp));
  applyViewport();
}

/** Fixed 视口：容器内钳制 + 居中（面板未挂载时也落位，保证页面按新尺寸重排） */
function applyViewport(): void {
  const vp = state.viewport;
  if (vp.mode !== "fixed" || !view) return;
  const area = state.container ?? state.frame;
  if (!area) return;
  const w = Math.max(1, Math.round(Math.min(vp.width, area.width)));
  const h = Math.max(1, Math.round(Math.min(vp.height, area.height)));
  const x = area.x + Math.round((area.width - w) / 2);
  const y = area.y + Math.round((area.height - h) / 2);
  view.setBounds({ x, y, width: w, height: h });
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
  if (!view) throw new Error("browser panel not open");
  view.webContents.openDevTools({ mode: "detach" });
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
  if (!view) throw new Error("browser panel is not open: call browser_navigate first");
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
      const url = parseWebUrl(String(p?.url ?? ""));
      let rebuilt = false;
      for (;;) {
        if (rebuilt) destroyForReload();
        if (!view) createView(null);
        const before = await pageState()
          .then((v) => String(v?.url ?? ""))
          .catch(() => "");
        if (before !== url) {
          try {
            await view!.webContents.loadURL(url);
          } catch (e: any) {
            throw new Error(`browser_navigate: navigate failed: ${e?.message ?? e}`);
          }
        }
        try {
          await waitStable(NAVIGATE_SETTLE_MS, !rebuilt, before);
          const v = await pageState();
          const landed = String(v?.url ?? "").trim();
          if (samePage(landed, url)) return await snapshotOutput();
          const msg = `browser_navigate: asked for ${url} but the panel landed on ${JSON.stringify(landed)}. The page redirected, or the panel webview is not the one being driven. Reopen the browser panel and retry.`;
          if (!rebuilt) {
            logWarn(`[browser] ${msg}`);
            rebuilt = true;
            continue;
          }
          throw new Error(msg);
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          if (!rebuilt && msg.startsWith("browser navigation did not load")) {
            logWarn(`[browser] ${msg}; recreating the panel webview and retrying once`);
            rebuilt = true;
            continue;
          }
          throw e;
        }
      }
    }

    if (!view) throw new Error("browser panel is not open: call browser_navigate first");

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
  register("browser_attach", (a) => browserAttach(a ?? {}));
  register("browser_detach", (a) => browserDetach(a ?? {}));
  register("browser_sync_bounds", (a) => browserSyncBounds(a));
  register("browser_open_devtools", () => browserOpenDevtools());
  register("browser_viewport_set", (a) => browserViewportSet(a ?? {}));
  register("browser_viewport_get", () => browserViewportGet());
}
