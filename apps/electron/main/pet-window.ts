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

const WIDTH = 260;
const HEIGHT = 340;
const BOUNDS_KEY = "pet_window_bounds";

/** 宠物库目录（对齐 Codex 的 ~/.codex/pets 心智）：子文件夹即一只宠物。 */
function petsDir(): string {
  return join(appDataDir(), "pets");
}

let petWin: BrowserWindow | null = null;

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

/** 恢复位置时按最近显示屏的工作区 clamp：至少留 80px 在屏内，防止窗口被拖到屏外后"失踪"。 */
function clampBoundsToWorkArea(point: { x: number; y: number }): { x: number; y: number } {
  const display = screen.getDisplayNearestPoint(point);
  const work = display.workArea;
  const visible = 80;
  const x = Math.min(Math.max(point.x, work.x - WIDTH + visible), work.x + work.width - visible);
  const y = Math.min(Math.max(point.y, work.y - HEIGHT + visible), work.y + work.height - visible);
  return { x, y };
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
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, "floating");
  // 跨工作区常驻（macOS 多桌面/全屏也能看到）；Windows 无此概念，调用无害
  win.setVisibleOnAllWorkspaces(true);
  trackWindow("pet", win);
  setWatchedSessions(win.webContents, []);
  // 默认全窗穿透：前端 pointermove 命中宠物/气泡时经 pet_ignore_mouse 关闭
  win.setIgnoreMouseEvents(true, { forward: true });
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.show();
  });
  win.on("closed", () => {
    petWin = null;
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

/** 显示悬浮窗（已存在则聚焦显示）。 */
export function petWindowShow(): BrowserWindow {
  if (petWin && !petWin.isDestroyed()) {
    petWin.show();
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
  menu.popup({ window: win });
  return null;
}

/** 透明窗点击穿透开关（发送者必须是悬浮窗自身）。 */
export function petIgnoreMouse(a: { ignore?: boolean }, sender: WebContents): null {
  if (!petWin || petWin.isDestroyed() || sender !== petWin.webContents) return null;
  petWin.setIgnoreMouseEvents(a.ignore === true, { forward: true });
  return null;
}

/* ------------------------------ 程序化拖窗 ------------------------------ */
// 不用 -webkit-app-region：它与 ignoreMouseEvents 的穿透开关存在按下时序竞争
// （穿透未解除的那次 mousedown 吃不到，拖拽发不起来），且浏览器直开路由时该
// 属性完全无效。改为渲染层 pointer 事件 + 主进程 setPosition 的显式协议。

let dragBase: { x: number; y: number } | null = null;

/** 拖拽开始：记住窗口基点（渲染层随后按相对偏移驱动）。 */
export function petWindowBeginDrag(sender: WebContents): null {
  if (!petWin || petWin.isDestroyed() || sender !== petWin.webContents) return null;
  const b = petWin.getBounds();
  dragBase = { x: b.x, y: b.y };
  return null;
}

/** 拖拽中：把渲染层累计的屏幕偏移应用到窗口（offset 从拖拽起点算起）。 */
export function petWindowMoveOffset(a: { ox?: number; oy?: number }, sender: WebContents): null {
  if (!dragBase || !petWin || petWin.isDestroyed() || sender !== petWin.webContents) return null;
  const ox = typeof a.ox === "number" && Number.isFinite(a.ox) ? a.ox : 0;
  const oy = typeof a.oy === "number" && Number.isFinite(a.oy) ? a.oy : 0;
  petWin.setPosition(dragBase.x + Math.round(ox), dragBase.y + Math.round(oy));
  return null;
}

/** 拖拽结束：清基点并落盘位置（setPosition 下 moved 事件不保证触发）。 */
export function petWindowEndDrag(sender: WebContents): null {
  if (!petWin || petWin.isDestroyed() || sender !== petWin.webContents) return null;
  if (dragBase) persistBounds(petWin);
  dragBase = null;
  return null;
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
