/**
 * 桌宠悬浮窗：置顶透明小窗（独立渲染进程，路由 /pet-window）。
 *
 * 对齐 resource 窗口模式（trackWindow + 空 watchedSessions + 错误留痕），差异点：
 * - **不订阅任何 pi 会话**：`setWatchedSessions(win.webContents, [])`，主进程不会
 *   向它投递逐 token 增量，悬浮窗零会话成本；
 * - **事件靠转发**：悬浮窗听不到主窗口内存里的 agent-events 总线，主窗口渲染层
 *   经 `pet_relay_event` 把生命周期事件转到这里，再投递给悬浮窗；
 * - **偏好跨窗口同步**：任一窗口 patch 偏好后经 `pet_prefs_changed` 广播
 *   **完整偏好 JSON**，接收方直接采用（不回读 localStorage，防跨进程竞态）；
 * - **点击穿透**：窗口默认 `setIgnoreMouseEvents(true, {forward: true})`，前端在
 *   pointermove 里命中测试后经 `pet_ignore_mouse` 开关——空白区域不吃点击；
 * - **生命周期自管理**：模式由主窗口侧偏好驱动（floating=show，否则 hide），
 *   悬浮窗自己也监听模式收尾，绝不留空壳。
 * - **气泡跳会话/打开设置**：`pet_focus_session` / `pet_open_settings` 聚焦主窗口
 *   并广播，主窗口 PetDock 接收后落到对应视图。
 * - **Windows 置顶保活**：Electron 的 alwaysOnTop 只是建窗时设一次 WS_EX_TOPMOST，
 *   之后可能被其它 topmost 窗/全屏应用挤到下面；Win+D「显示桌面」还会把窗口
 *   最小化，而 skipTaskbar + focusable:false 让它没有任何找回入口。这里在可见
 *   期间低频重申 topmost、监听 minimize 立即还原；原生右键菜单弹出期间暂停，
 *   避免保活把宠物重新抬到自己的菜单之上。
 * - **不抢焦点**：showInactive 显示、Windows focusable:false；悬浮窗只该被看见，
 *   不该抢走用户正在输入的前台焦点。
 *
 * 不自动建窗：设置切到"独立悬浮窗"或托盘菜单触发。
 * 位置经 SQLite kv 持久化（store.ts kvGet/kvSet），跨启动恢复。
 */
import { BrowserWindow, Menu, screen, shell, type WebContents } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { appDataDir } from "./paths";
import { emitToWindows, focusMainWindow, setWatchedSessions, trackWindow, type CmdCtx } from "./ipc";
import { getMainWindow } from "./window";
import { kvGet, kvSet } from "./store";
import { logInfo, logWarn } from "./logging";
import { clampWindowPosition, type Rect } from "./pet-bounds";

const WIDTH = 260;
const HEIGHT = 340;
const BOUNDS_KEY = "pet_window_bounds";
/** Windows 置顶保活间隔：够快能从被压下去/被最小化里自愈，又不至于频繁抢 z-order。 */
const TOPMOST_WATCH_MS = 3000;

/** 宠物库目录（对齐 Codex 的 ~/.codex/pets 心智）：子文件夹即一只宠物。 */
function petsDir(): string {
  return join(appDataDir(), "pets");
}

let petWin: BrowserWindow | null = null;
let topmostWatch: ReturnType<typeof setInterval> | null = null;

/** 置顶重申：level 只在 macOS 生效，Windows 直接映射到 HWND_TOPMOST。 */
function applyTopmost(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (process.platform === "darwin") win.setAlwaysOnTop(true, "floating");
  else win.setAlwaysOnTop(true);
}

/**
 * Windows 置顶保活：Windows 的 topmost 是"一档"而不是"永远最上"——后来出现的
 * topmost 窗（或全屏应用退出/切换）会把宠物压到这一档的下面；Win+D 还会直接
 * 最小化它。定时重申一次 SetWindowPos(HWND_TOPMOST)（SWP_NOACTIVATE，不抢焦点）
 * 让宠物回到这一档的顶部，顺便把被最小化的窗口还原。
 * macOS 的置顶由系统稳定保证，不跑定时器。
 */
function startTopmostWatch(win: BrowserWindow): void {
  if (process.platform !== "win32" || topmostWatch !== null) return;
  topmostWatch = setInterval(() => {
    if (win.isDestroyed()) {
      stopTopmostWatch();
      return;
    }
    // 先还原再判可见：Windows 上最小化的窗口 isVisible() 为 false，
    // 顺序反了会让 Win+D 之后的窗口永远失去自愈机会。
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) return;
    applyTopmost(win);
  }, TOPMOST_WATCH_MS);
  topmostWatch.unref?.();
}

function stopTopmostWatch(): void {
  if (topmostWatch === null) return;
  clearInterval(topmostWatch);
  topmostWatch = null;
}

function loadBounds(): { x?: number; y?: number } {
  try {
    const raw = kvGet(BOUNDS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { x?: number; y?: number };
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return {};
    return { x: Math.round(parsed.x), y: Math.round(parsed.y) };
  } catch {
    return {};
  }
}

/**
 * 位置钳制：不少于 80px 见方留在某块工作区内。多屏下只要窗口跨屏可见就原样
 * 放行（按左上角最近的单屏钳制会把窗口锁死在主屏边缘，拖不到副屏）。
 */
function clampBoundsToWorkArea(
  point: { x: number; y: number },
  width = WIDTH,
  height = HEIGHT,
): { x: number; y: number } {
  return clampWindowPosition(point, { width, height }, screen.getAllDisplays().map((d) => d.workArea));
}

/** 默认落点：主屏工作区右下角（留出任务栏/托盘余量）。 */
function defaultBounds(): { x: number; y: number } {
  const work = screen.getPrimaryDisplay().workArea;
  return { x: work.x + work.width - WIDTH - 12, y: work.y + work.height - HEIGHT - 12 };
}

function persistBounds(win: BrowserWindow): void {
  const b = win.getBounds();
  kvSet(BOUNDS_KEY, JSON.stringify({ x: b.x, y: b.y }));
}

function createPetWindow(): BrowserWindow {
  const devUrl = (globalThis as any).__KOVA_DEV_URL as string | undefined;
  const fallback = defaultBounds();
  const saved = loadBounds();
  const restored = saved.x !== undefined && saved.y !== undefined
    ? clampBoundsToWorkArea({ x: saved.x, y: saved.y })
    : fallback;
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: restored.x,
    y: restored.y,
    frame: false,
    // 透明窗必须给全透明底色：默认白底在 Windows 上会在首帧前闪一块白/黑
    backgroundColor: "#00000000",
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    // macOS：窗口以 showInactive 显示（不抢焦点），首击必须能同时激活并投递，
    // 否则"点一下宠物唤起主窗"要点击两次；其它平台忽略该选项
    acceptFirstMouse: true,
    // Windows：不可聚焦——否则"首次点击被系统吃掉用于激活窗口"会让拖拽偶发失效；
    // 宠物不需要键盘焦点，鼠标事件照常投递。minimizable:false + 下面的 minimize
    // 还原双保险：Win+D/显示桌面 不能把这个没有任务栏入口的窗口变成"失踪"。
    // thickFrame:false 去掉无边框窗隐形的 WS_THICKFRAME 缩放边框与显隐动画。
    ...(process.platform === "win32"
      ? { focusable: false, minimizable: false, fullscreenable: false, thickFrame: false }
      : {}),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // 悬浮窗几乎永远不是前台窗（focusable:false / showInactive）：Chromium 的
      // 后台节流会把 setTimeout 压到 1s，宠物逐帧动画会卡成 PPT，事件气泡也延迟。
      backgroundThrottling: false,
    },
  });
  applyTopmost(win);
  // 跨工作区常驻（macOS 多桌面/全屏也能看到）；Windows 无此概念，显式跳过
  if (process.platform !== "win32") win.setVisibleOnAllWorkspaces(true);
  trackWindow("pet", win);
  setWatchedSessions(win.webContents, []);
  // 点击穿透只开在 macOS：Windows 上 forward 的 move 不保证按 DOM 命中投递，
  // 命中测试失效会把整窗一直留在"穿透"态（表现为宠物点不到、拖不动、出现禁止光标）。
  // Windows 直接放弃穿透——窗口只有巴掌大，空余区域吃点击可接受。
  if (process.platform === "darwin") {
    win.setIgnoreMouseEvents(true, { forward: true });
  } else {
    // 显式归零：保证任何历史状态/异常路径都不会让 Windows 停在穿透态
    win.setIgnoreMouseEvents(false);
  }
  logInfo(`[pet] window created platform=${process.platform} clickThrough=${process.platform === "darwin"}`);
  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    // show() 会尝试把窗口带到前台；桌宠只该被看见，不该抢用户当前输入焦点
    win.showInactive();
    applyTopmost(win);
  });
  win.on("show", () => {
    applyTopmost(win);
    startTopmostWatch(win);
  });
  win.on("hide", () => {
    stopTopmostWatch();
  });
  win.on("minimize", () => {
    if (process.platform !== "win32") return;
    // Win+D/「显示桌面」会把所有顶层窗最小化；skipTaskbar 下没有找回入口，
    // 下一拍立即还原并重新置顶（异步一拍，避免在 minimize 处理里重入）
    setTimeout(() => {
      if (win.isDestroyed() || !win.isMinimized()) return;
      win.restore();
      applyTopmost(win);
    }, 0);
  });
  // 拔掉副屏/改缩放/换分辨率后，窗口可能落在已不存在的工作区外：直接钳回可见区
  const onDisplayChange = () => keepWindowOnScreen(win);
  screen.on("display-removed", onDisplayChange);
  screen.on("display-metrics-changed", onDisplayChange);
  win.on("closed", () => {
    petWin = null;
    dragBase = null;
    dragCursorBase = null;
    dragWorkAreas = [];
    stopTopmostWatch();
    screen.removeListener("display-removed", onDisplayChange);
    screen.removeListener("display-metrics-changed", onDisplayChange);
    logInfo("[pet] window closed");
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    logWarn(`[pet] renderer gone: ${details?.reason ?? "unknown"} (exitCode=${details?.exitCode ?? "?"})`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    logWarn(`[pet] load failed (${code}): ${desc} — ${url}`);
  });
  // 静态导出路由是 out/pet-window.html：走 kova://app/pet-window；dev 用 Next 路由 URL
  if (devUrl) {
    void win.loadURL(`${devUrl}/pet-window`).catch((e) => logWarn(`[pet] loadURL failed: ${e?.message ?? e}`));
  } else {
    void win.loadURL("kova://app/pet-window").catch((e) => logWarn(`[pet] loadURL failed: ${e?.message ?? e}`));
  }
  return win;
}

/** 显示悬浮窗（已存在则显示；不抢前台焦点）。 */
export function petWindowShow(): BrowserWindow {
  if (petWin && !petWin.isDestroyed()) {
    if (petWin.isMinimized()) petWin.restore();
    petWin.showInactive();
    applyTopmost(petWin);
    startTopmostWatch(petWin);
    return petWin;
  }
  petWin = createPetWindow();
  logInfo("[pet] window created");
  return petWin;
}

export function petWindowHide(): void {
  petWin?.hide();
}

export function petWindowIsVisible(): boolean {
  return petWin !== null && !petWin.isDestroyed() && petWin.isVisible();
}

/** 托盘/命令入口：开 ↔ 关。返回切换后的可见态。 */
export function petWindowToggle(): boolean {
  if (petWindowIsVisible()) {
    petWindowHide();
    return false;
  }
  petWindowShow();
  return true;
}

/* ------------------------------ 桥命令实现 ------------------------------ */

/** 主窗口渲染层 → 悬浮窗 的 agent 事件投递（悬浮窗没开就丢弃，不排队）。 */
export function petRelayEvent(a: {
  name: string;
  threadId?: string;
  data?: Record<string, unknown>;
  occurredAt?: number;
}): null {
  if (!petWin || petWin.isDestroyed() || !petWin.isVisible()) return null;
  petWin.webContents.send("kova-event", { event: "pet-agent-event", payload: a });
  return null;
}

/** 悬浮窗气泡点击 → 聚焦主窗口并广播打开会话（主窗口 PetDock 消费）。 */
export function petFocusSession(a: { sessionId?: string }): null {
  if (typeof a.sessionId !== "string" || a.sessionId === "") return null;
  focusMainWindow();
  const main = getMainWindow();
  if (main && !main.isDestroyed()) {
    main.webContents.send("kova-event", { event: "pet-open-session", payload: { sessionId: a.sessionId } });
  }
  return null;
}

/** 悬浮窗右键「打开设置」→ 聚焦主窗口并广播跳桌宠分区（主窗口 PetDock 消费）。 */
export function petOpenSettings(): null {
  logInfo("[pet] open settings from floating window");
  focusMainWindow();
  emitToWindows("pet-open-settings", null);
  return null;
}

/** 左键点宠物 → 只聚焦主窗口（不开会话）。 */
export function petFocusMain(): null {
  focusMainWindow();
  return null;
}

/** 悬浮窗画布跟随显示尺寸：clamp 在最近显示屏工作区内（slider 拉多大窗就多大）。 */
export function petWindowSetSize(a: { width?: number; height?: number }, sender: WebContents): null {
  if (!petWin || petWin.isDestroyed() || sender !== petWin.webContents) return null;
  const bounds = petWin.getBounds();
  const work = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea;
  const width = Math.min(Math.max(Math.round(a.width ?? WIDTH), 160), work.width - 16);
  const height = Math.min(Math.max(Math.round(a.height ?? HEIGHT), 160), work.height - 16);
  petWin.setSize(width, height);
  // 放大后右/下缘可能超出工作区（Windows 会压到任务栏上）：保持位置仍在屏内
  const b = petWin.getBounds();
  const target = clampBoundsToWorkArea({ x: b.x, y: b.y }, b.width, b.height);
  if (target.x !== b.x || target.y !== b.y) petWin.setPosition(target.x, target.y);
  return null;
}

/* ------------------------------ 原生右键菜单 ------------------------------ */
// 对齐桌面应用的常规做法：右键菜单用系统原生 Menu.popup——OS 层浮层，不渲染在
// 透明画布里（DOM 菜单必然盖住宠物本体，还有裁剪/层级一堆破事）。
// 菜单项由渲染层下发 label + 动作代号；动作在主进程执行或转播回窗口。

type PetMenuAction = "open-settings" | "focus-main" | `set-mode:${string}`;

function handlePetMenuAction(action: string): void {
  if (action === "open-settings") {
    petOpenSettings();
    return;
  }
  if (action === "focus-main") {
    petFocusMain();
    return;
  }
  if (action.startsWith("set-mode:")) {
    const mode = action.slice("set-mode:".length);
    if (mode === "inline" || mode === "floating" || mode === "off") {
      emitToWindows("pet-set-mode", { mode });
    }
    return;
  }
  logWarn(`[pet] unknown menu action: ${action}`);
}

/** 右键弹原生菜单（发送者窗口 = 菜单依附的窗口，内嵌/悬浮都能用）。 */
export function petContextMenu(
  a: { items?: { label?: string; action?: string }[] },
  ctx: CmdCtx,
): null {
  const win = BrowserWindow.fromWebContents(ctx.sender);
  if (!win || win.isDestroyed()) return null;
  const items = (Array.isArray(a?.items) ? a.items : []).filter(
    (item): item is { label: string; action: string } =>
      typeof item?.label === "string" && typeof item?.action === "string",
  );
  const menu = Menu.buildFromTemplate(
    items.map((item) => ({
      label: item.label,
      click: () => handlePetMenuAction(item.action),
    })),
  );
  // Windows 置顶保活会在菜单打开期间把宠物重新抬到菜单之上：弹出期间暂停，
  // 关闭后再恢复（菜单是原生顶层窗，同样受 topmost 档位竞争影响）。
  const resumeTopmost = (): void => {
    if (!petWin || petWin.isDestroyed() || !petWin.isVisible()) return;
    applyTopmost(petWin);
    startTopmostWatch(petWin);
  };
  stopTopmostWatch();
  try {
    menu.popup({ window: win, callback: resumeTopmost });
  } catch (e) {
    // 弹窗失败时别让保活永久停摆
    logWarn(`[pet] menu popup failed: ${e instanceof Error ? e.message : e}`);
    resumeTopmost();
  }
  return null;
}

/** 透明窗点击穿透开关（发送者必须是悬浮窗自身）。仅 macOS 生效：Windows 一律可点击。 */
export function petIgnoreMouse(a: { ignore?: boolean }, sender: WebContents): null {
  if (!petWin || petWin.isDestroyed() || sender !== petWin.webContents) return null;
  if (process.platform !== "darwin") {
    petWin.setIgnoreMouseEvents(false);
    return null;
  }
  petWin.setIgnoreMouseEvents(a.ignore === true, { forward: true });
  return null;
}

/* ------------------------------ 程序化拖窗 ------------------------------ */
// 不用 -webkit-app-region：它与 ignoreMouseEvents 的穿透开关存在按下时序竞争
// （穿透未解除的那次 mousedown 吃不到，拖拽发不起来），且浏览器直开路由时该
// 属性完全无效。改为渲染层 pointer 事件 + 主进程 setPosition 的显式协议。

let dragBase: { x: number; y: number } | null = null;
/** 拖拽起点时的系统光标位置：窗口位移 = 当前光标 - 这个基点。
 *  不信任渲染层的 screenX——Windows 透明/无焦点窗下它可能恒为 0。 */
let dragCursorBase: { x: number; y: number } | null = null;
/** 本次拖拽是否已打过 first-move 日志（每轮只打一次，定位"命令有没有到"）。 */
let dragMoveLogged = false;
// 拖拽期间沿用开始时的显示器快照：pointermove 频率高，别每帧都问 screen
let dragSize: { width: number; height: number } = { width: WIDTH, height: HEIGHT };
let dragWorkAreas: Rect[] = [];

/** 拖拽开始：记住窗口基点与光标基点（主进程按系统光标算位移）。 */
export function petWindowBeginDrag(sender: WebContents): null {
  if (!petWin || petWin.isDestroyed() || sender !== petWin.webContents) return null;
  const b = petWin.getBounds();
  dragBase = { x: b.x, y: b.y };
  dragCursorBase = screen.getCursorScreenPoint();
  dragMoveLogged = false;
  dragSize = { width: b.width, height: b.height };
  dragWorkAreas = screen.getAllDisplays().map((d) => d.workArea);
  logInfo(
    `[pet] drag begin window=${b.x},${b.y} cursor=${dragCursorBase.x},${dragCursorBase.y}`,
  );
  return null;
}

/** 拖拽中：主进程直接采样系统光标，窗口 = 起点 + (光标 - 光标起点)。
 *  渲染层只负责按帧触发（不再传 screenX 偏移）。 */
export function petWindowMoveOffset(_a: unknown, sender: WebContents): null {
  if (!dragBase || !dragCursorBase || !petWin || petWin.isDestroyed() || sender !== petWin.webContents) {
    return null;
  }
  const cursor = screen.getCursorScreenPoint();
  const offsetX = cursor.x - dragCursorBase.x;
  const offsetY = cursor.y - dragCursorBase.y;
  const raw = { x: dragBase.x + offsetX, y: dragBase.y + offsetY };
  // 拖动中也钳在"至少留 80px 可见"：否则一次甩手就能把没有任务栏入口的窗口
  // 拖出屏幕，只能靠切换模式/托盘重新找回。
  const target = clampWindowPosition(raw, dragSize, dragWorkAreas);
  if (target.x !== raw.x || target.y !== raw.y) {
    // 被屏边挡住时重设基点：指针回拖时窗口立即跟手，不积累"粘边"位移
    dragBase = { x: target.x - offsetX, y: target.y - offsetY };
  }
  petWin.setPosition(target.x, target.y);
  if (!dragMoveLogged) {
    dragMoveLogged = true;
    logInfo(`[pet] drag move cursor=${cursor.x},${cursor.y} target=${target.x},${target.y}`);
  }
  return null;
}

/** 拖拽结束：清基点并落盘位置（setPosition 下 moved 事件不保证触发）。 */
export function petWindowEndDrag(sender: WebContents): null {
  if (!petWin || petWin.isDestroyed() || sender !== petWin.webContents) return null;
  if (dragBase) persistBounds(petWin);
  dragBase = null;
  dragCursorBase = null;
  dragWorkAreas = [];
  logInfo("[pet] drag end");
  return null;
}

/** 显示器拓扑变化（拔掉副屏/改缩放/换分辨率）后把窗口拉回可见区。 */
function keepWindowOnScreen(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const b = win.getBounds();
  const target = clampBoundsToWorkArea({ x: b.x, y: b.y }, b.width, b.height);
  if (target.x !== b.x || target.y !== b.y) win.setPosition(target.x, target.y);
}

/* ------------------------------ 宠物库（目录扫描） ------------------------------ */
// 对齐 Codex 的 ~/.codex/pets 模型：把宠物文件夹放进 petsDir 就会被扫描出来，
// 没有"添加"动作。扫描只读元数据；图集字节按需读取（base64），路径一律钳在库目录内。

const PET_ASSET_MAX_BYTES = 24 * 1024 * 1024;
const ASSET_MIME: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  apng: "image/png",
  gif: "image/gif",
  json: "application/json",
};

function resolvePetAssetPath(rel: string): string {
  const root = normalize(petsDir());
  const abs = normalize(join(root, rel));
  if (!abs.startsWith(root + sep)) throw new Error("path-not-allowed");
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error("not-found");
  if (statSync(abs).size > PET_ASSET_MAX_BYTES) throw new Error("too-large");
  return abs;
}

function petLibraryScan(): unknown {
  const dir = petsDir();
  if (!existsSync(dir)) return { dir, pets: [] };
  const pets: { dir: string; rel: string; name: string; configUrl: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(dir, entry.name, "pet.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { displayName?: unknown };
      pets.push({
        dir: join(dir, entry.name),
        rel: `${entry.name}/pet.json`,
        name: typeof manifest.displayName === "string" && manifest.displayName ? manifest.displayName : entry.name,
        configUrl: `kova://pet/${encodeURIComponent(entry.name)}/pet.json`,
      });
    } catch (e) {
      logWarn(`[pet] skip broken pet dir ${entry.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { dir, pets };
}

function petAssetRead(a: { rel?: string }): { base64: string; mime: string } {
  const abs = resolvePetAssetPath(String(a?.rel ?? ""));
  const ext = abs.slice(abs.lastIndexOf(".") + 1).toLowerCase();
  return { base64: readFileSync(abs).toString("base64"), mime: ASSET_MIME[ext] ?? "application/octet-stream" };
}

function petOpenDir(): null {
  const dir = petsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  void shell.openPath(dir);
  return null;
}

/* ------------------------------ 桥命令注册 ------------------------------ */

export function setupPetWindowCommands(register: (name: string, fn: (args: any, ctx: CmdCtx) => any) => void): void {
  register("pet_window_toggle", () => petWindowToggle());
  register("pet_window_show", () => {
    petWindowShow();
    return null;
  });
  register("pet_window_hide", () => {
    petWindowHide();
    return null;
  });
  register("pet_window_is_visible", () => petWindowIsVisible());
  register("pet_relay_event", (a) => petRelayEvent(a));
  register("pet_focus_session", (a) => petFocusSession(a));
  register("pet_focus_main", () => petFocusMain());
  register("pet_open_settings", () => petOpenSettings());
  register("pet_window_set_size", (a, ctx) => petWindowSetSize(a, ctx.sender));
  register("pet_ignore_mouse", (a, ctx) => petIgnoreMouse(a, ctx.sender));
  register("pet_context_menu", (a, ctx) => petContextMenu(a, ctx));
  register("pet_window_begin_drag", (_a, ctx) => petWindowBeginDrag(ctx.sender));
  register("pet_window_move_offset", (a, ctx) => petWindowMoveOffset(a, ctx.sender));
  register("pet_window_end_drag", (_a, ctx) => petWindowEndDrag(ctx.sender));
  // 偏好变更跨窗口同步：写方窗口 localStorage 的 storage 事件不可靠，
  // 渲染层 patch 后显式走这里把完整偏好 JSON 广播给所有窗口
  register("pet_prefs_changed", (a) => {
    emitToWindows("pet-prefs-changed", typeof a?.prefs === "string" ? a.prefs : null);
    return null;
  });
  register("pet_library_scan", () => petLibraryScan());
  register("pet_asset_read", (a) => petAssetRead(a));
  register("pet_open_dir", () => petOpenDir());
}
