/**
 * 面板内置浏览器（对齐 browser.rs + browser_scripts.rs）：
 * `<webview>` guest 绑定（DOM 嵌入渲染——层级/圆角/遮罩/裁剪全走主 webview 的
 * DOM 合成，浮层天然盖在它上面；因此不再需要原生子视图的 bounds 同步与
 * 「浮层出现即隐藏浏览器」的遮挡让位，对齐 ZCode 的内置浏览器架构）、
 * 视口模式（fill/fixed）、agent 动作原语（导航/快照/点击/输入/滚动/后退）。
 *
 * guest 的 webContents 由渲染端 `<webview>` 在 did-attach 后上报 id + 属主会话
 * 绑定（browser_bind_guest），这里校验 getType()==="webview" 后持有；页面随元素
 * 走，主文档刷新即随 DOM 销毁（destroyed 监听清引用）。
 *
 * 控制通道（对齐 ZCode 的 webview + CDP-on-guest）：
 * - 点击/输入/滚动/按键/拖拽/截图走 CDP（browser-cdp.ts + browser-input.ts），
 *   产生 isTrusted 输入，React/Vue 受控组件与内部滚动容器都能用；
 * - 快照是结构化 DOM（browser-snapshot.ts）：ref 存页面内 Map、每次重建，
 *   带 accessible name/value/checked/disabled/selector/rect；
 * - JS 弹窗由 CDP Page.javascriptDialogOpening 观察，browser_dialog 接受/拒绝；
 * - 权限走 browser-permissions.ts 的白名单 + 面板内询问 + 站点记录。
 */
import { WebContents, session, webContents, nativeImage, app } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { emitToWindow } from "./ipc";
import { logWarn } from "./logging";
import { appDataDir } from "./paths";
import { parseBrowserUrl, isAllowedBrowserUrl } from "./browser-urls";
import { beginBrowserAutomation } from "./browser-automation";
import {
  BROWSER_PARTITION,
  clearBrowserPermissions,
  resolveBrowserPermissionPrompt,
} from "./browser-permissions";
import {
  bindBrowserDialogGuest,
  installBrowserDialogHandler,
  unbindBrowserDialogGuest,
} from "./browser-dialog";
import { classifyNavigation, isSamePage, navigationFailure } from "./browser-nav";
import {
  captureCdpScreenshot,
  cdpLayoutMetrics,
  getPendingDialog,
  handlePendingDialog,
  releaseCdpForDevtools,
  sendCdp,
} from "./browser-cdp";
import {
  SNAPSHOT_JS,
  checkScript,
  focusScript,
  formatSnapshot,
  probeScript,
  resolveScript,
  selectScript,
  selectTextScript,
  type BrowserSnapshotData,
} from "./browser-snapshot";
import {
  dispatchClick,
  dispatchDrag,
  dispatchHover,
  dispatchKey,
  dispatchWheel,
  insertText,
} from "./browser-input";

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
/** 当前 guest 的属主会话（渲染端 bind 时上报）；agent 工具必须与之匹配。 */
let guestOwner: string | null = null;
/** 工具执行期间的调用方 owner；null = UI 命令（允许兜底发现 guest）。 */
let activeToolOwner: string | null = null;
/** 最近一次主框架 did-fail-load，用于把“错误页”讲清楚 */
let lastLoadError: { code: number; desc: string; url: string; ts: number } | null = null;
/** 单 webview 阶段的 popup：原地导航后在下一次快照头部标注 */
let popupNote: string | null = null;
/** 下载旁注（动作结果头部提示，模型能知道点了下载） */
const downloadNotes: string[] = [];
let actionBusy = false;

/**
 * guest 主框架导航在途追踪：did-start-loading/stop 记在途，did-start-navigation
 * （仅主框架）记目标。browser_navigate 靠它识别「渲染端 src 通道已在加载同一
 * URL」：data-panelOpen 帧与工具调用同轮前后脚，渲染端 `<webview src>` 的加载
 * 未提交时 pageState 只看得到 about:blank，此时再 loadURL 同一地址会把 src 那
 * 次顶掉——被顶掉的加载以 GUEST_VIEW_MANAGER_CALL + ERR_ABORTED (-3) 拒绝且
 * 无人接住，成为渲染进程 unhandledrejection（dev 浮层误报的另一个确定性来源；
 * https 页面提交慢，此赛跑近乎必现）。跳过让 src 那次自己落地。
 */
let guestNav: { loading: boolean; url: string } = { loading: false, url: "" };

/* ------------------------------ JS 原语（与 browser_scripts.rs 同源） ------------------------------ */

const STATE_JS = `(() => {
  try {
    return JSON.stringify({ ok: true, url: location.href, readyState: document.readyState, title: document.title || "" });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
})()`;

/* ------------------------------ 基础工具 ------------------------------ */

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
    const hint = guest && !guest.isDestroyed() ? pendingDialogHint(guest) : null;
    if (hint) throw new Error(hint);
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

type CancelGuardLike = { isCancelled?: () => boolean };

function cancelled(guard?: CancelGuardLike): boolean {
  return guard?.isCancelled?.() === true;
}

function stopGuest(): void {
  try {
    if (guest && !guest.isDestroyed()) guest.stop();
  } catch {
    /* guest 已销毁/正在导航：忽略 */
  }
}

async function waitStable(
  maxMs: number,
  requireChange: boolean,
  beforeUrl: string,
  guard?: CancelGuardLike,
): Promise<{ url: string; readyState: string }> {
  const deadline = Date.now() + maxMs;
  const CHANGE_DEADLINE = Math.min(maxMs, 10_000);
  if (requireChange) {
    const changeDeadline = Date.now() + CHANGE_DEADLINE;
    while (Date.now() < changeDeadline) {
      if (cancelled(guard)) {
        stopGuest();
        throw new Error("browser action cancelled");
      }
      const openDialog = guest && !guest.isDestroyed() ? getPendingDialog(guest) : null;
      if (openDialog) {
        throw new Error(
          `a JavaScript ${openDialog.type} dialog is open: ${JSON.stringify(openDialog.message.slice(0, 200))}. ` +
            "Call browser_dialog with accept/dismiss first, then continue.",
        );
      }
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
    if (cancelled(guard)) {
      stopGuest();
      throw new Error("browser action cancelled");
    }
    const openDialog = guest && !guest.isDestroyed() ? getPendingDialog(guest) : null;
    if (openDialog) {
      throw new Error(
        `a JavaScript ${openDialog.type} dialog is open: ${JSON.stringify(openDialog.message.slice(0, 200))}. ` +
          "Call browser_dialog with accept/dismiss first, then continue.",
      );
    }
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
    const loadErr =
      lastLoadError && Date.now() - lastLoadError.ts < maxMs + 5_000
        ? ` (last did-fail-load: ${lastLoadError.code} ${lastLoadError.desc || "unknown"} ${lastLoadError.url})`
        : "";
    throw new Error(
      `browser navigation did not load: the panel webview stayed on ${lastUrl.length > 0 ? lastUrl : "<empty>"} (readyState=${JSON.stringify(lastReady)}, last eval error=${JSON.stringify(lastErr)})${loadErr}. The browser panel may not be open or attached yet — open it, or retry browser_navigate.`,
    );
  }
  await sleep(400);
  return { url: lastUrl, readyState: lastReady };
}

/* ------------------------------ 站点数据清理（设置页"浏览器数据"） ------------------------------ */

/** 面板 `<webview>` 的持久化分区（渲染端 partition 属性同值）：清除类操作
 *  落在它的 session 上。**不要用删磁盘目录的方式替代**——应用运行时目录
 *  被 session 占着句柄，删不干净、还会留下半截缓存。 */
const PANEL_PARTITION = BROWSER_PARTITION;

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
  // 站点权限记录与会话数据同生命周期：清数据即回到「每次询问」，避免
  // 已清空的站点仍凭旧记录继续拿到摄像头/定位。
  await clearBrowserPermissions();
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
  // 主进程清了、渲染端没清会让旧页日志一直挂在面板上（导航/面板重建后
  // 错误计数还是上一页的）。reset 帧让两侧同一时刻归零。
  emitToWindow("main", "browser:console", { entries: [], reset: true });
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

/** Electron 在未打包构建里会给每个渲染进程打印安全提示；guest 是三方页面，
 *  CSP 由站点自行决定、应用既无法也不该改，这类提示对页面调试纯属噪声。
 *  只折叠 CSP 这一条（与 frontend-logging.ts 的「窄匹配宿主噪声」同款），
 *  其余安全告警仍原样进控制台。 */
const HOST_SECURITY_NOISE_RE =
  /Electron Security Warning \(Insecure Content-Security-Policy\)/;

function wireConsole(wc: WebContents): void {
  if (consoleWired.has(wc)) return;
  consoleWired.add(wc);
  wc.on("console-message", (details) => {
    const message = String(details?.message ?? "");
    if (!message || HOST_SECURITY_NOISE_RE.test(message)) return;
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
 *  eval 直接操作应用自己的 UI）。重复接受同一 guest 幂等。
 *  owner：渲染端当前会话 id；同一 guest 再次上报时刷新属主（切会话重挂载）。 */
function holdGuest(wc: WebContents, owner: string | null): WebContents {
  if (guest !== wc) {
    guest = wc;
    guestOwner = owner;
    guestNav = { loading: false, url: "" };
    lastLoadError = null;
    // 导航在途追踪（见 guestNav 注释）：browser_navigate 判定「已在加载同
    // 一 URL」的依据。换 guest（面板重挂载）时整体复位
    wc.on("did-start-loading", () => {
      guestNav.loading = true;
    });
    wc.on("did-stop-loading", () => {
      guestNav.loading = false;
    });
    wc.on("did-start-navigation", (_e, url, _isInPlace, isMainFrame) => {
      if (isMainFrame) guestNav.url = String(url ?? "");
    });
    // 主框架加载失败：错误页/断网/DNS 失败时给工具一个可读原因，而不是
    // 只看到“停在 chrome-error://”。
    wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame) return;
      lastLoadError = {
        code: Number(code) || 0,
        desc: String(desc ?? ""),
        url: String(url ?? ""),
        ts: Date.now(),
      };
    });
    // 元素卸载/主文档刷新 → guest 随 DOM 销毁：清引用与日志，工具侧回到「面板没开」口径
    wc.once("destroyed", () => {
      unbindBrowserDialogGuest(wc);
      if (guest === wc) {
        guest = null;
        guestOwner = null;
      }
      guestNav = { loading: false, url: "" };
      lastLoadError = null;
      clearConsole();
    });
    // 单 webview 阶段：window.open/target=_blank 原地导航（源页面留在引擎历史里，
    // 可后退）。多标签落地后再改为新标签；popup 的 URL 走同一白名单。
    try {
      wc.setWindowOpenHandler(({ url }) => {
        const raw = String(url ?? "");
        if (isAllowedBrowserUrl(raw) && raw !== "about:blank") {
          popupNote = raw;
          void wc.loadURL(raw).catch((e: unknown) => {
            logWarn(`[browser] popup navigation failed: ${String((e as Error)?.message ?? e)}`);
          });
          return { action: "deny" };
        }
        logWarn(`[browser] blocked popup: ${raw}`);
        return { action: "deny" };
      });
    } catch {
      /* 绑定晚于销毁等边缘：忽略 */
    }
    // 主框架自导航也只放行白名单协议（拦 data:/javascript: 等）。
    wc.on("will-navigate", (event, navUrl) => {
      const raw = String(navUrl ?? "");
      if (raw === "about:blank" || isAllowedBrowserUrl(raw)) return;
      event.preventDefault();
      logWarn(`[browser] blocked navigation: ${raw}`);
    });
    bindBrowserDialogGuest(wc);
  } else if (owner !== null) {
    guestOwner = owner;
  }
  wireConsole(wc);
  return wc;
}

/** `<webview>` guest 显式绑定：渲染端（did-attach / dom-ready 后）上报 id 与属主。 */
export function browserBindGuest(args: {
  webContentsId?: number | null;
  threadId?: unknown;
}): null {
  const id = Number(args?.webContentsId ?? 0);
  const wc = Number.isInteger(id) && id > 0 ? webContents.fromId(id) : undefined;
  if (!wc || wc.isDestroyed()) throw new Error("browser_bind_guest: webContents not found");
  if (wc.getType() !== "webview") {
    throw new Error(`browser_bind_guest: not a <webview> guest (type=${wc.getType()})`);
  }
  const threadId = typeof args?.threadId === "string" ? args.threadId.trim() : "";
  holdGuest(wc, threadId.length > 0 ? threadId : null);
  return null;
}

/** 属主校验：agent 工具只能驱动“本会话面板”的 guest。 */
function assertGuestOwner(owner: string): void {
  if (!guest || guest.isDestroyed()) throw new Error(PANEL_NOT_OPEN);
  if (!guestOwner) {
    throw new Error(
      "browser panel has no owning conversation yet: reopen the browser panel and retry",
    );
  }
  if (!owner) {
    throw new Error(
      "browser tool call has no conversation owner: reopen the browser panel and retry",
    );
  }
  if (guestOwner !== owner) {
    throw new Error(
      `browser panel belongs to another conversation (owner=${guestOwner}); this call is from ${owner}. ` +
        "Switch to that conversation to drive its browser, or stop using browser tools here.",
    );
  }
}

/** UI 兜底发现：本应用只有浏览器面板一个 `<webview>`。只允许 UI 命令使用；
 *  agent 工具必须走显式绑定（否则后台会话会抢走前台会话的页面）。 */
function discoverGuestForUi(): WebContents | null {
  if (guest && !guest.isDestroyed()) return guest;
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    try {
      if (wc.getType() === "webview") return holdGuest(wc, null);
    } catch {
      /* 某些内部 webContents 不支持 getType：跳过 */
    }
  }
  return null;
}

/** 取 guest：显式绑定优先；工具执行期间禁止兜底发现，并做属主校验。 */
function ensureGuest(): WebContents | null {
  const wc = guest && !guest.isDestroyed() ? guest : null;
  // guestOwner 为空说明渲染端的 bind 还没到：先返回 guest，让 waitForGuest
  // 继续等属主上报，而不是在这里误报“没有属主”。
  if (activeToolOwner !== null && wc && guestOwner !== null) {
    assertGuestOwner(activeToolOwner);
  }
  if (wc) return wc;
  return activeToolOwner === null ? discoverGuestForUi() : null;
}

/** 等 guest 就绪：同一轮里 data-panelOpen 帧与工具调用前后脚到达，渲染端挂载
 *  `<webview>` 到 dom-ready/did-attach 上报之间 guest 还不存在。
 *  requireOwner：工具调用为 true，等到属主上报后再放行（避免抢别的会话）。 */
async function waitForGuest(maxMs: number, requireOwner = false): Promise<WebContents | null> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const wc = ensureGuest();
    if (wc && (!requireOwner || (activeToolOwner !== null && guestOwner === activeToolOwner))) {
      return wc;
    }
    if (Date.now() >= deadline) return wc;
    await sleep(100);
  }
}

/** 工具动作期间登记调用方 owner：期间 ensureGuest 只认这个会话的 guest。 */
function withToolOwner<T>(owner: string, fn: () => Promise<T>): Promise<T> {
  const previous = activeToolOwner;
  activeToolOwner = owner ?? "";
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      activeToolOwner = previous;
    });
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

/** 程序化打开浏览器面板（e2e 与未来“在面板中打开”入口）：
 *  渲染端按当前会话开一个浏览器标签；URL 走同一白名单。 */
export function browserOpenPanel(args: { url?: unknown }): null {
  const raw = typeof args?.url === "string" ? args.url.trim() : "";
  if (raw.length > 0 && !isAllowedBrowserUrl(raw)) {
    throw new Error(`browser_open_panel: blocked unsupported url: ${raw}`);
  }
  emitToWindow("main", "browser:open-panel", raw.length > 0 ? { url: raw } : {});
  return null;
}

export async function browserOpenDevtools(): Promise<null> {
  const wc = ensureGuest();
  if (!wc) throw new Error("browser panel not open");
  // 同一个 webContents 只能挂一个 debugger：先让出 CDP，DevTools 才能打开。
  await releaseCdpForDevtools(wc);
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
    // 先把元素滚到视口中间再量 rect：否则部分在视口外的元素截图会被裁错。
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (err) {}
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
      // CSS px → DIP：页面 zoom 不是 1 时 capturePage 的 rect 需要按缩放换算。
      const zoom = typeof wc.getZoomFactor === "function" ? wc.getZoomFactor() || 1 : 1;
      const img = await wc.capturePage({
        x: Math.round(r.x * zoom),
        y: Math.round(r.y * zoom),
        width: Math.round(r.width * zoom),
        height: Math.round(r.height * zoom),
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
    await releaseCdpForDevtools(wc);
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
  const v = (await evalJson(SNAPSHOT_JS)) as BrowserSnapshotData;
  if (v?.ok === false) throw new Error(`snapshot failed: ${v.error ?? "unknown error"}`);
  const formatted = formatSnapshot(v ?? {});
  const url = String(v?.url ?? "");
  const title = String(v?.title ?? "");
  let out = formatted.output;
  if (formatted.empty) {
    out +=
      url.length === 0 || url === "about:blank"
        ? "\n\n（面板还停在 about:blank，这一页根本没加载出来。别在这里重试快照：先确认浏览器面板已打开，或重新 browser_navigate）"
        : "\n\n（页面无可交互元素或文本，可能仍在加载；canvas/WebGL 页面请用 browser_shot 看图）";
  }
  // 动作副作用旁注（popup / 下载）：放在快照头部，模型能知道点出了什么。
  const notes: string[] = [];
  if (popupNote) {
    notes.push(`↪ popup opened: ${popupNote}`);
    popupNote = null;
  }
  while (downloadNotes.length > 0) {
    const note = downloadNotes.shift();
    if (note) notes.push(note);
  }
  if (notes.length > 0) out = `${notes.join("\n")}\n\n${out}`;
  return { output: out, url, title, truncated: formatted.truncated };
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

/* ------------------------------ 动作辅助 ------------------------------ */

const VIEWPORT_JS = `JSON.stringify({ w: window.innerWidth, h: window.innerHeight, sx: window.scrollX, sy: window.scrollY })`;

function numberParam(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function viewportSize(): Promise<{ w: number; h: number }> {
  const v = await evalJson(VIEWPORT_JS).catch(() => null);
  return {
    w: Number((v as any)?.w) || 0,
    h: Number((v as any)?.h) || 0,
  };
}

async function resolvePoint(ref: string): Promise<{
  cx: number;
  cy: number;
  ax: number;
  ay: number;
  width: number;
  height: number;
}> {
  const v = await evalJson(resolveScript(ref));
  if (v?.ok === false) throw new Error(String(v.error ?? `stale ref: ${ref}`));
  return {
    cx: Number(v.cx),
    cy: Number(v.cy),
    ax: Number(v.ax),
    ay: Number(v.ay),
    width: Number(v.width),
    height: Number(v.height),
  };
}

/** 需要 user activation 的页面脚本（聚焦/全选/select/check）统一走这里：
 *  userGesture 下执行。注意 CDP 输入事件不产生 user activation——Chromium 会
 *  压掉无激活的 confirm/alert，所以 agent 的 click/press 不会弹出模态框；
 *  要驱动弹窗流程时由模型用 browser_evaluate 显式 el.click()（userGesture 会
 *  让弹窗真正打开），再用 browser_dialog 接受/拒绝。 */
async function evalGestureAction(js: string, what: string): Promise<any> {
  const wc = ensureGuest();
  if (!wc) throw new Error(PANEL_NOT_OPEN);
  let result: {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  try {
    result = (await sendCdp(wc, "Runtime.evaluate", {
      expression: js,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })) as typeof result;
  } catch (err) {
    const hint = pendingDialogHint(wc);
    if (hint) throw new Error(hint);
    throw err;
  }
  if (result?.exceptionDetails) {
    throw new Error(
      `${what} failed: ${
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "unknown error"
      }`,
    );
  }
  const v = result?.result?.value as { ok?: boolean; error?: string } | undefined;
  if (v?.ok === false) throw new Error(`${what} failed: ${v.error ?? "unknown error"}`);
  return v;
}

/** ref 优先，其次显式坐标；都没有就报参数错误。 */
async function pointFromArgs(p: any): Promise<{ x: number; y: number }> {
  const ref = typeof p?.ref === "string" ? p.ref : "";
  if (ref) {
    const r = await resolvePoint(ref);
    return { x: r.cx, y: r.cy };
  }
  const x = numberParam(p?.x);
  const y = numberParam(p?.y);
  if (x != null && y != null) return { x, y };
  throw new Error("missing param: ref (or x+y)");
}

function pendingDialogHint(wc: WebContents): string | null {
  const dialog = getPendingDialog(wc);
  if (!dialog) return null;
  return (
    `JavaScript ${dialog.type} dialog opened: ${JSON.stringify(dialog.message.slice(0, 200))}. ` +
    "Call browser_dialog with accept/dismiss, then continue."
  );
}

/** 动作后的收敛：dialog 打开时不 waitStable（executeJavaScript 会被阻塞）。
 *  输入事件改为不等响应后，dialog 事件可能比 settle 晚几十毫秒，先短轮询。 */
async function settleAction(wc: WebContents, guard?: CancelGuardLike): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    if (getPendingDialog(wc)) return;
    await sleep(50);
  }
  if (getPendingDialog(wc)) return;
  await waitStable(ACTION_SETTLE_MS, false, "", guard);
}

/** 动作结果：有 dialog 就回可读提示（快照会挂），否则回新快照。 */
async function actionOutput(wc: WebContents, options?: { note?: string }): Promise<any> {
  const hint = pendingDialogHint(wc);
  if (hint) return { output: `${options?.note ? `${options.note}\n` : ""}${hint}` };
  const out = await snapshotOutput();
  if (options?.note) out.output = `${options.note}\n\n${out.output}`;
  return out;
}

function formatEvaluatedValue(value: unknown): string {
  let text: string;
  try {
    text =
      typeof value === "string"
        ? value
        : value === undefined
          ? "undefined"
          : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  const MAX = 20_000;
  return text.length > MAX ? `${text.slice(0, MAX)}\n…[截断]` : text;
}

/** 面板活页面截图：Page.captureScreenshot（登录态/滚动位置都在），失败退回 capturePage。 */
async function captureLiveShot(wc: WebContents, p: any): Promise<any> {
  const maxDim = clamp(Number(p?.maxDim) || 1920, 320, 7680);
  const quality = clamp(Number(p?.quality) || 80, 30, 100);
  const format = p?.format === "png" ? "png" : "jpeg";

  let clip: { x: number; y: number; width: number; height: number; scale?: number } | null = null;
  if (p?.clip && typeof p.clip === "object") {
    const c = p.clip as Record<string, unknown>;
    const width = Number(c.width);
    const height = Number(c.height);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      clip = {
        x: Number(c.x) || 0,
        y: Number(c.y) || 0,
        width,
        height,
      };
    }
  } else if (typeof p?.ref === "string" && p.ref) {
    const r = await resolvePoint(p.ref);
    clip = { x: r.ax, y: r.ay, width: r.width, height: r.height };
  } else {
    const metrics = (await cdpLayoutMetrics(wc).catch(() => null)) as any;
    const content = metrics?.cssContentSize ?? metrics?.contentSize;
    const viewport = metrics?.cssVisualViewport ?? metrics?.visualViewport;
    if (p?.fullPage === true) {
      const width = Number(content?.width) || 0;
      const height = Number(content?.height) || 0;
      if (width > 0 && height > 0) clip = { x: 0, y: 0, width, height };
    } else {
      const width = Number(viewport?.clientWidth) || 0;
      const height = Number(viewport?.clientHeight) || 0;
      if (width > 0 && height > 0) {
        clip = {
          x: Number(viewport?.pageX) || 0,
          y: Number(viewport?.pageY) || 0,
          width,
          height,
        };
      }
    }
  }

  if (clip) {
    const maxSide = Math.max(clip.width, clip.height);
    let scale = Math.min(1, maxDim / Math.max(1, maxSide));
    const pixels = clip.width * clip.height * scale * scale;
    if (pixels > 16_000_000) scale *= Math.sqrt(16_000_000 / pixels);
    if (scale < 1) clip = { ...clip, scale };
  }

  const params: Record<string, unknown> = {
    format,
    ...(format === "jpeg" ? { quality } : {}),
    ...(clip ? { clip, captureBeyondViewport: p?.fullPage === true } : {}),
  };

  let base64 = "";
  try {
    const shot = await captureCdpScreenshot(wc, params);
    base64 = typeof shot?.data === "string" ? shot.data : "";
  } catch {
    // DevTools 打开/外部 debugger 占用时 CDP 不可用：退回 capturePage（视口范围）。
    const image = await wc.capturePage();
    if (!image.isEmpty()) {
      base64 = (format === "png" ? image.toPNG() : image.toJPEG(quality)).toString("base64");
    }
  }
  if (!base64) throw new Error("screenshot produced no output");
  const bytes = Buffer.from(base64, "base64");
  const size = nativeImage.createFromBuffer(bytes).getSize();
  return {
    base64,
    mimeType: format === "png" ? "image/png" : "image/jpeg",
    bytes: bytes.length,
    width: size.width,
    height: size.height,
    url: wc.getURL(),
  };
}

async function waitViewportApplied(
  width: number | null,
  height: number | null,
  guard?: CancelGuardLike,
): Promise<void> {
  // fill 模式没有目标尺寸；给渲染端一拍完成重排即可。
  if (width == null || height == null) {
    await sleep(250);
    return;
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (cancelled(guard)) throw new Error("browser action cancelled");
    try {
      const v = await evalJson(
        `JSON.stringify({ w: window.innerWidth, h: window.innerHeight })`,
      );
      if (
        v &&
        typeof v === "object" &&
        Math.abs(Number((v as any).w) - width) <= 1 &&
        Math.abs(Number((v as any).h) - height) <= 1
      ) {
        return;
      }
    } catch {
      /* 重排瞬间 eval 丢失：下一轮 */
    }
    await sleep(100);
  }
}

async function historyAction(
  direction: "back" | "forward",
  guard?: CancelGuardLike,
): Promise<any> {
  const wc = ensureGuest();
  if (!wc) throw new Error(PANEL_NOT_OPEN);
  const history = wc.navigationHistory;
  const canGo = direction === "back" ? history.canGoBack() : history.canGoForward();
  if (!canGo) {
    const out = await snapshotOutput();
    out.output = `历史里没有更${direction === "back" ? "早" : "晚"}的页面（url 未变化）\n\n${out.output}`;
    return out;
  }
  if (direction === "back") history.goBack();
  else history.goForward();
  await waitStable(ACTION_SETTLE_MS, false, "", guard);
  return await snapshotOutput();
}

async function reloadPage(guard?: CancelGuardLike): Promise<any> {
  const wc = ensureGuest();
  if (!wc) throw new Error(PANEL_NOT_OPEN);
  lastLoadError = null;
  wc.reload();
  await waitStable(ACTION_SETTLE_MS, false, "", guard);
  return await snapshotOutput();
}

/**
 * browser_shot 的入口：显式 url 走隐藏窗口（不碰面板）；无 url 拍面板当前页。
 * 无 url 必须在属主上下文里取 URL（currentUrl → ensureGuest 会校验 owner）。
 * 阶段 3 会把无 url 分支换成 CDP 活页面截图。
 */
export async function captureLive(
  p: any,
  owner: string,
  guard?: CancelGuardLike,
): Promise<any> {
  const maxDim = typeof p?.maxDim === "number" ? p.maxDim : null;
  const quality = typeof p?.quality === "number" ? p.quality : null;
  const explicit = typeof p?.url === "string" && p.url.trim().length > 0;
  if (explicit) {
    const shot = await import("./browser-shot");
    return shot.capture(String(p.url).trim(), maxDim, quality, guard);
  }
  return withToolOwner(owner, async () => {
    const wc = ensureGuest();
    if (!wc) throw new Error(PANEL_NOT_OPEN);
    const hint = pendingDialogHint(wc);
    if (hint) throw new Error(hint);
    // URL 可用性校验（about:blank / 空文档给清晰错误）。dialog 刚被关闭的
    // 渲染器上 executeJavaScript 可能瞬态失败（UnknownVizError 一类）：
    // 重试一次再放弃。
    try {
      await currentUrl();
    } catch (err) {
      if (cancelled(guard) || String((err as Error)?.message ?? err).startsWith(PANEL_NOT_OPEN)) throw err;
      await sleep(250);
      await currentUrl();
    }
    return await captureLiveShot(wc, p);
  });
}

export async function runTool(
  name: string,
  p: any,
  owner = "",
  guard?: CancelGuardLike,
): Promise<any> {
  if (actionBusy) throw new Error("browser busy: another browser action is still in flight");
  actionBusy = true;
  // 自动化窗口：权限请求直接拒绝、弹窗交给 CDP 处理（见 browser-automation）。
  const endAutomation = beginBrowserAutomation();
  const previousOwner = activeToolOwner;
  activeToolOwner = owner ?? "";
  try {
    if (name === "browser_navigate") {
      // 面板 <webview> 由渲染端挂载，did-attach 上报后才可驱动：等 guest
      // 出现（data-panelOpen 帧与工具调用是同轮的前后脚）
      if (!(await waitForGuest(PANEL_WAIT_MS, true))) throw new Error(PANEL_NOT_OPEN);
      assertGuestOwner(owner);
      const url = parseBrowserUrl(String(p?.url ?? ""));
      let retried = false;
      for (;;) {
        if (cancelled(guard)) {
          stopGuest();
          throw new Error("browser action cancelled");
        }
        const wc = ensureGuest();
        if (!wc) throw new Error(PANEL_NOT_OPEN);
        const before = await pageState()
          .then((v) => String(v?.url ?? ""))
          .catch(() => "");
        if (before !== url) {
          // 渲染端 src 通道已在加载同一 URL 时不要再 loadURL（见 guestNav 注释）：
          // 跳过让 src 那次自己落地。若 src 加载失败，waitStable 报「did not
          // load」走下面的重试——届时 loading 已复位，这里照常 loadURL
          const srcInFlight = guestNav.loading && isSamePage(guestNav.url, url);
          if (!srcInFlight) {
            lastLoadError = null;
            try {
              await wc.loadURL(url);
            } catch (e: any) {
              const msg = `browser_navigate: navigate failed: ${e?.message ?? e}`;
              if (!retried) {
                logWarn(`[browser] ${msg}; retrying once`);
                retried = true;
                await sleep(300);
                continue;
              }
              throw new Error(msg);
            }
          }
        }
        try {
          const settled = await waitStable(NAVIGATE_SETTLE_MS, !retried, before, guard);
          const outcome = classifyNavigation({
            requested: url,
            landed: settled.url,
            readyState: settled.readyState,
            sawPage: true,
          });
          if (!outcome.ok) {
            if (!retried) {
              retried = true;
              continue;
            }
            throw new Error(navigationFailure(outcome.reason));
          }
          const out = await snapshotOutput();
          if (outcome.redirected) {
            // 重定向是正常结果（http→https、登录跳转），不再当错误；只标注落点。
            out.output = `↪ redirected to ${outcome.url}\n\n${out.output}`;
            out.redirected = true;
          }
          return out;
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

    if (!(await waitForGuest(PANEL_WAIT_MS, true))) throw new Error(PANEL_NOT_OPEN);
    assertGuestOwner(owner);
    const activeGuest = ensureGuest();
    if (!activeGuest) throw new Error(PANEL_NOT_OPEN);
    // 有未决 JS dialog 时页面线程被阻塞：除 dialog/state 外的动作立即给出
    // 可执行的下一步，而不是等 10s eval 超时。
    if (name !== "browser_dialog" && name !== "browser_state") {
      const hint = pendingDialogHint(activeGuest);
      if (hint) throw new Error(hint);
    }

    switch (name) {
      case "browser_snapshot":
        return await snapshotOutput();
      case "browser_resize": {
        const fill = p?.fill === true;
        const w = p?.width;
        const h = p?.height;
        const vp: ViewportMode =
          fill || w == null || h == null
            ? { mode: "fill" }
            : { mode: "fixed", width: clamp(Number(w), 200, 4000), height: clamp(Number(h), 200, 4000) };
        setViewport(vp);
        await waitViewportApplied(
          vp.mode === "fixed" ? vp.width : null,
          vp.mode === "fixed" ? vp.height : null,
          guard,
        );
        return await snapshotOutput();
      }
      case "browser_click": {
        // 统一走 CDP 可信输入。不要改成 element.click()：CDP 输入不产生
        // user activation，Chromium 会压掉无激活的 confirm/alert——这反而是
        // 优点（agent 的点击不会弹一个没人点的模态框把主进程冻住）。
        // 需要触发弹窗流程时用 browser_evaluate 显式 el.click() + browser_dialog。
        const point = await pointFromArgs(p);
        const button =
          p?.button === "right" || p?.button === "middle" ? p.button : "left";
        await dispatchClick(activeGuest, point, {
          button,
          doubleClick: p?.doubleClick === true,
          modifiers: Array.isArray(p?.modifiers) ? p.modifiers : undefined,
        });
        await settleAction(activeGuest, guard);
        return await actionOutput(activeGuest);
      }
      case "browser_type": {
        const ref = p?.ref;
        const text = p?.text;
        if (typeof ref !== "string") throw new Error("missing param: ref");
        if (typeof text !== "string") throw new Error("missing param: text");
        // 聚焦 + 全选（userGesture 下 JS 完成）：CDP insertText 是光标处插入，
        // 全选后插入才等价于「替换现有文本」。
        await evalGestureAction(selectTextScript(ref), "focus");
        try {
          await insertText(activeGuest, text);
        } catch (err) {
          const hint = pendingDialogHint(activeGuest);
          if (hint) throw new Error(hint);
          throw err;
        }
        if (p?.submit === true) await dispatchKey(activeGuest, "Enter");
        await settleAction(activeGuest, guard);
        return await actionOutput(activeGuest);
      }
      case "browser_press": {
        const key = typeof p?.key === "string" ? p.key : "";
        if (!key) throw new Error("missing param: key");
        if (typeof p?.ref === "string" && p.ref) {
          await evalGestureAction(focusScript(p.ref), "focus");
        }
        await dispatchKey(
          activeGuest,
          key,
          Array.isArray(p?.modifiers) ? p.modifiers : undefined,
        );
        await settleAction(activeGuest, guard);
        return await actionOutput(activeGuest);
      }
      case "browser_hover": {
        const point = await pointFromArgs(p);
        await dispatchHover(
          activeGuest,
          point,
          Array.isArray(p?.modifiers) ? p.modifiers : undefined,
        );
        await settleAction(activeGuest, guard);
        return await actionOutput(activeGuest);
      }
      case "browser_scroll": {
        const dir = String(p?.direction ?? "down").toLowerCase();
        let point: { x: number; y: number };
        if (typeof p?.ref === "string" && p.ref) {
          const r = await resolvePoint(p.ref);
          point = { x: r.cx, y: r.cy };
        } else if (numberParam(p?.x) != null && numberParam(p?.y) != null) {
          point = { x: Number(p.x), y: Number(p.y) };
        } else {
          const vp = await viewportSize();
          point = { x: Math.round(vp.w / 2), y: Math.round(vp.h / 2) };
        }

        const dx = numberParam(p?.deltaX);
        const dy = numberParam(p?.deltaY);
        if (dx != null || dy != null) {
          await dispatchWheel(activeGuest, point, dx ?? 0, dy ?? 0);
        } else if (dir === "top" || dir === "bottom") {
          const js =
            dir === "top"
              ? `(() => { window.scrollTo(0, 0); return { ok: true }; })()`
              : `(() => { window.scrollTo(0, document.documentElement.scrollHeight); return { ok: true }; })()`;
          await evalAction(js, "scroll");
        } else {
          if (!["up", "down"].includes(dir)) {
            throw new Error(`invalid direction: ${dir} (up|down|top|bottom)`);
          }
          const amount = Math.min(Number(p?.amount ?? 600) || 600, 100_000);
          await dispatchWheel(activeGuest, point, 0, dir === "up" ? -amount : amount);
        }
        await settleAction(activeGuest, guard);
        return await actionOutput(activeGuest);
      }
      case "browser_select": {
        const ref = typeof p?.ref === "string" ? p.ref : "";
        if (!ref) throw new Error("missing param: ref");
        const values = Array.isArray(p?.values)
          ? p.values.filter((v: unknown): v is string => typeof v === "string")
          : [];
        if (values.length === 0) throw new Error("missing param: values (non-empty string[])");
        await evalGestureAction(selectScript(ref, values), "select");
        await settleAction(activeGuest, guard);
        return await actionOutput(activeGuest);
      }
      case "browser_check": {
        const ref = typeof p?.ref === "string" ? p.ref : "";
        if (!ref) throw new Error("missing param: ref");
        const checked = p?.checked !== false;
        await evalGestureAction(checkScript(ref, checked), "check");
        await settleAction(activeGuest, guard);
        return await actionOutput(activeGuest);
      }
      case "browser_drag": {
        let from: { x: number; y: number } | null = null;
        let to: { x: number; y: number } | null = null;
        if (typeof p?.fromRef === "string" && p.fromRef) {
          const r = await resolvePoint(p.fromRef);
          from = { x: r.cx, y: r.cy };
        } else if (p?.from && numberParam(p.from.x) != null && numberParam(p.from.y) != null) {
          from = { x: Number(p.from.x), y: Number(p.from.y) };
        }
        if (typeof p?.toRef === "string" && p.toRef) {
          const r = await resolvePoint(p.toRef);
          to = { x: r.cx, y: r.cy };
        } else if (p?.to && numberParam(p.to.x) != null && numberParam(p.to.y) != null) {
          to = { x: Number(p.to.x), y: Number(p.to.y) };
        }
        if (!from || !to) throw new Error("missing param: fromRef/from and toRef/to");
        await dispatchDrag(
          activeGuest,
          from,
          to,
          Array.isArray(p?.modifiers) ? p.modifiers : undefined,
        );
        await settleAction(activeGuest, guard);
        return await actionOutput(activeGuest);
      }
      case "browser_evaluate": {
        const expression = typeof p?.expression === "string" ? p.expression : "";
        if (!expression.trim()) throw new Error("missing param: expression");
        let result: {
          result?: { value?: unknown; description?: string };
          exceptionDetails?: { text?: string; exception?: { description?: string } };
        };
        try {
          result = (await sendCdp(activeGuest, "Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
            userGesture: true,
          })) as typeof result;
        } catch (err) {
          // userGesture 下页面若弹 confirm/alert，evaluate 会被 Dialog 阻塞；
          // 保留 CDP session 并告诉模型先处理 dialog。
          const hint = pendingDialogHint(activeGuest);
          if (hint) throw new Error(hint);
          throw err;
        }
        if (result?.exceptionDetails) {
          throw new Error(
            `evaluate failed: ${
              result.exceptionDetails.exception?.description ??
              result.exceptionDetails.text ??
              "unknown error"
            }`,
          );
        }
        const value =
          result?.result?.value !== undefined
            ? result.result.value
            : result?.result?.description;
        return { output: formatEvaluatedValue(value), value };
      }
      case "browser_wait_for": {
        const selector = typeof p?.selector === "string" ? p.selector : "";
        const text = typeof p?.text === "string" ? p.text : "";
        const textGone = typeof p?.textGone === "string" ? p.textGone : "";
        if (!selector && !text && !textGone) {
          throw new Error("missing param: selector, text, or textGone");
        }
        const timeout = clamp(Number(p?.timeoutMs) || 10_000, 500, 30_000);
        const script = probeScript({ selector, text, textGone });
        const deadline = Date.now() + timeout;
        for (;;) {
          if (cancelled(guard)) throw new Error("browser action cancelled");
          const hint = pendingDialogHint(activeGuest);
          if (hint) throw new Error(hint);
          const v = await evalJson(script);
          if (v?.ok === false) throw new Error(`wait_for probe failed: ${v.error ?? "unknown"}`);
          const matched =
            (selector.length > 0 && v?.selectorFound === true) ||
            (text.length > 0 && v?.textFound === true) ||
            (textGone.length > 0 && v?.textGone === true);
          if (matched) {
            await waitStable(ACTION_SETTLE_MS, false, "", guard);
            return await snapshotOutput();
          }
          if (Date.now() >= deadline) {
            throw new Error(
              `browser_wait_for timed out after ${timeout}ms ` +
                `(selector=${JSON.stringify(selector)}, text=${JSON.stringify(text)}, textGone=${JSON.stringify(textGone)})`,
            );
          }
          await sleep(200);
        }
      }
      case "browser_state": {
        const history = activeGuest.navigationHistory;
        const dialog = getPendingDialog(activeGuest);
        let scroll = { sx: 0, sy: 0 };
        let viewport = { w: 0, h: 0 };
        if (!dialog) {
          try {
            const v = await evalJson(VIEWPORT_JS);
            scroll = { sx: Number((v as any)?.sx) || 0, sy: Number((v as any)?.sy) || 0 };
            viewport = { w: Number((v as any)?.w) || 0, h: Number((v as any)?.h) || 0 };
          } catch {
            /* 页面正在导航：仅回 URL/历史/弹窗 */
          }
        }
        return {
          output: [
            `url: ${activeGuest.getURL()}`,
            `title: ${activeGuest.getTitle()}`,
            `canGoBack: ${history.canGoBack()}`,
            `canGoForward: ${history.canGoForward()}`,
            `scroll: ${scroll.sx},${scroll.sy}`,
            `viewport: ${viewport.w}x${viewport.h}`,
            `dialog: ${
              dialog
                ? `${dialog.type} ${JSON.stringify(dialog.message.slice(0, 200))}`
                : "none"
            }`,
          ].join("\n"),
        };
      }
      case "browser_dialog": {
        const accept = p?.accept === true;
        const promptText =
          typeof p?.promptText === "string" ? p.promptText : undefined;
        await handlePendingDialog(activeGuest, accept, promptText);
        await sleep(150);
        try {
          await waitStable(ACTION_SETTLE_MS, false, "", guard);
          return await actionOutput(activeGuest, {
            note: `dialog ${accept ? "accepted" : "dismissed"}`,
          });
        } catch {
          return {
            output:
              `dialog ${accept ? "accepted" : "dismissed"}; ` +
              "the page is still navigating/loading — call browser_state or browser_snapshot next.",
          };
        }
      }
      case "browser_back":
        return await historyAction("back", guard);
      case "browser_forward":
        return await historyAction("forward", guard);
      case "browser_reload":
        return await reloadPage(guard);
      default:
        throw new Error(`unknown browser tool: ${name}`);
    }
  } finally {
    activeToolOwner = previousOwner;
    endAutomation();
    actionBusy = false;
  }
}

/* ------------------------------ 命令注册 ------------------------------ */

function pushDownloadNote(note: string): void {
  downloadNotes.push(note);
  // 没有后续快照消费时不能无界增长（页面可以连续触发下载）。
  while (downloadNotes.length > 20) downloadNotes.shift();
}

function sanitizeDownloadName(raw: string): string {
  const cleaned = (raw ?? "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim();
  return (cleaned.length > 0 ? cleaned : "download").slice(0, 120);
}

let downloadsInstalled = false;

/** 面板 guest 的下载：落到 <appData>/browser-downloads，并在动作结果里留旁注。 */
function installBrowserDownloads(): void {
  if (downloadsInstalled) return;
  downloadsInstalled = true;
  const target = session.fromPartition(PANEL_PARTITION);
  target.on("will-download", (_event, item, wc) => {
    // 只接管面板 guest 的下载；隐藏截图窗口的下载不写进浏览器下载目录。
    if (!guest || wc !== guest) return;
    const dir = join(appDataDir(), "browser-downloads");
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return; // 建目录失败：交给 Electron 默认保存流程
    }
    const name = sanitizeDownloadName(item.getFilename());
    const path = join(dir, `${Date.now()}-${name}`);
    try {
      item.setSavePath(path);
    } catch {
      return;
    }
    pushDownloadNote(`下载已开始: ${name} → ${path}`);
    emitToWindow("main", "browser:download", { name, path, state: "started" });
    item.once("done", (_e, state) => {
      const label = state === "completed" ? "完成" : state === "cancelled" ? "取消" : "失败";
      pushDownloadNote(`下载${label}: ${name} → ${path}`);
      emitToWindow("main", "browser:download", { name, path, state });
    });
  });
}

export function setupBrowserCommands(register: (name: string, fn: (args: any) => any) => void): void {
  installBrowserDialogHandler();
  installBrowserDownloads();
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
  register("browser_open_panel", (a) => browserOpenPanel(a ?? {}));
  register("browser_permission_resolve", (a) => resolveBrowserPermissionPrompt(a ?? {}));
  register("browser_permission_clear", () => clearBrowserPermissions());
  // 仅开发构建：e2e 需要绕过 sidecar 直接驱动面板（真实工具链路仍是
  // sidecar → hostToolCall → runTool）。打包版一律拒绝。
  register("browser_debug_state", () => {
    if (app.isPackaged) throw new Error("browser_debug_state is dev-only");
    let url = "";
    try {
      if (guest && !guest.isDestroyed()) url = guest.getURL();
    } catch {
      /* 销毁竞态：回空 */
    }
    return {
      owner: guestOwner,
      guestId: guest && !guest.isDestroyed() ? guest.id : null,
      url,
    };
  });
  register("browser_debug_tool", (a) => {
    if (app.isPackaged) throw new Error("browser_debug_tool is dev-only");
    const name = typeof a?.name === "string" ? a.name : "";
    const params = a?.params && typeof a.params === "object" ? a.params : {};
    const owner =
      typeof a?.threadId === "string" && a.threadId.length > 0
        ? a.threadId
        : (guestOwner ?? "");
    if (name === "browser_shot") {
      return captureLive(params, owner, { isCancelled: () => false });
    }
    return runTool(name, params, owner, { isCancelled: () => false });
  });
}
