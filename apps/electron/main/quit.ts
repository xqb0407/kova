/**
 * 退出流程（⌘Q 防误触 + 逐项停止运行中任务）。
 *
 * 键盘路径：按住 ⌘Q 满 5s 才确认；中途松开 ⌘/Q、窗口失焦或 Esc 立即取消，
 * 不停止任何任务。确认后按「会话 → 后台命令 → 终端 → 服务」逐项停止，中央
 * 圆形进度卡由渲染层消费 `app-quit-state`。
 *
 * 鼠标路径：菜单 Quit / 托盘“退出”仍走 before-quit → quitImmediately()，
 * 与改造前完全一致（立即收尾、无等待）。
 *
 * 强制退出：停止阶段再次按 ⌘Q，或 watchdog 30s 超时，直接 SIGKILL 子进程后
 * app.exit(0)。
 */
import { app, type BrowserWindow, type Input, type WebContents } from "electron";
import { logError, logInfo, logWarn } from "./logging";
import { emitToWindow, getWindow } from "./ipc";
import { markShutdownGuard, resetShutdownGuard } from "./crash";
import { getDb } from "./store";
import * as pi from "./pi-agent";
import * as automation from "./automation-service";
import * as remote from "./remote";
import * as tunnel from "./tunnel";
import {
  cancelAllTools,
  listRunningBgTasks,
  stopAllBgTasks,
  stopBgTask,
} from "./tool-exec";
import { killAllPty, listPtySessions, ptyClose } from "./pty";
import { stopImSubsystem } from "./im/im-commands";
import { runningImChannelCount } from "./im/manager";
import {
  composeQuitTasks,
  type QuitTaskInfo,
  type QuitTaskKind,
} from "./quit-tasks";

/** 渲染层订阅的退出进度事件（payload 为 QuitStatePayload | null） */
export const QUIT_STATE_EVENT = "app-quit-state";

/** 按住确认时长：给误触留足反悔空间 */
const HOLD_MS = 5_000;
const HOLD_TICK_MS = 100;
const CANCEL_NOTICE_MS = 1_200;
const SESSION_STOP_TIMEOUT_MS = 1_500;
const WATCHDOG_MS = 30_000;
/** 无任务时收尾瞬间完成，留一点时间让进度条走到 100%，避免看起来像闪退 */
const MIN_FINALIZE_MS = 450;

type QuitPhase = "idle" | "holding" | "stopping" | "finalizing" | "cancelled";

export type QuitStatePayload = {
  phase: Exclude<QuitPhase, "idle">;
  /** holding 阶段 0..1；其余阶段恒 1 */
  holdProgress: number;
  /** 按住确认总时长（渲染层算剩余秒数，避免两端各写一份常量） */
  holdMs: number;
  completed: number;
  total: number;
  current: { kind: QuitTaskKind; title: string | null } | null;
  cancelable: boolean;
  stoppedCount: number;
};

type RegisterFn = (
  name: string,
  fn: (args: Record<string, any>, ctx: any) => unknown | Promise<unknown>,
) => void;

let installed = false;
let phase: QuitPhase = "idle";
let tasks: QuitTaskInfo[] = [];
let completed = 0;
let stoppedCount = 0;
let holdStartedAt = 0;
/** 按住确认时按下的物理键 code：keyUp 用同一 code 判定，兼容非 QWERTY 布局 */
let holdKeyCode = "";
let holdProgress = 0;
let holdTimer: NodeJS.Timeout | null = null;
let watchdog: NodeJS.Timeout | null = null;
let noticeTimer: NodeJS.Timeout | null = null;
let cancelRequested = false;
let flowStartedAt = 0;
let immediateStarted = false;
let shutdownWorkStarted = false;
/**
 * 最近一次「按住取消」的时间。菜单加速键的 before-quit 与 keyUp 之间存在
 * 极小的时序差：松手取消后迟到的 before-quit 不能把应用直接退掉。
 */
let lastHoldCancelledAt = 0;
/**
 * 最近一次 ⌘Q keyDown 时间（含 auto-repeat）。before-quit 用它区分
 * 「键盘加速键」与「鼠标点菜单 Quit」：前者在退出流程中忽略，后者保持旧行为。
 */
let lastQuitKeyAt = 0;

const isServiceKind = (kind: QuitTaskKind): boolean =>
  kind === "automation" || kind === "engine" || kind === "remote" || kind === "im";

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/* ------------------------------ 状态快照 / 广播 ------------------------------ */

function snapshot(): QuitStatePayload | null {
  if (phase === "idle") return null;
  const current = tasks.find((t) => t.status === "stopping") ?? null;
  return {
    phase,
    holdProgress: phase === "holding" ? holdProgress : 1,
    holdMs: HOLD_MS,
    completed,
    total: tasks.length,
    current: current ? { kind: current.kind, title: current.title } : null,
    cancelable: phase === "holding" || phase === "stopping",
    stoppedCount,
  };
}

function emitState(): void {
  emitToWindow("main", QUIT_STATE_EVENT, snapshot());
}

function clearHoldTimer(): void {
  if (holdTimer) {
    clearInterval(holdTimer);
    holdTimer = null;
  }
}

function clearWatchdog(): void {
  if (watchdog) {
    clearTimeout(watchdog);
    watchdog = null;
  }
}

function clearNoticeTimer(): void {
  if (noticeTimer) {
    clearTimeout(noticeTimer);
    noticeTimer = null;
  }
}

function destroyTimerAll(): void {
  clearHoldTimer();
  clearWatchdog();
  clearNoticeTimer();
}

function mainWindow(): BrowserWindow | null {
  const win = getWindow("main");
  return win && !win.isDestroyed() ? win : null;
}

function markQuittingWindow(): void {
  const win = mainWindow();
  if (win) (win as any).__quitting = true;
}

function clearQuittingWindow(): void {
  const win = mainWindow();
  if (win) (win as any).__quitting = false;
}

/** 把主窗口显示/聚焦到前台：从托盘/隐藏态退出时进度条也要看得见 */
function ensureMainWindowVisible(): BrowserWindow | null {
  const win = mainWindow();
  if (!win) return null;
  try {
    if (process.platform === "darwin") app.show();
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  } catch (err) {
    logWarn(`[quit] focus main window failed: ${errText(err)}`);
  }
  return win;
}

/* ------------------------------ 键盘监听 ------------------------------ */

function isQuitKey(input: Input): boolean {
  const isMac = process.platform === "darwin";
  const modifier = isMac ? input.meta : input.control;
  // 只认精确的 ⌘Q / Ctrl+Q：cmd+shift+Q 是 macOS 注销快捷键，不能顺手拦住
  const extraModifier = isMac ? input.control : input.meta;
  // 按字符而不是物理 code 匹配：菜单加速键按当前布局的 "q" 生效，
  // 用 KeyQ 会把 AZERTY/Dvorak 等布局的其它键误判成退出。
  return (
    modifier &&
    !extraModifier &&
    !input.shift &&
    !input.alt &&
    (input.key ?? "").toLowerCase() === "q"
  );
}

function isReleaseKey(input: Input): boolean {
  const key = (input.key ?? "").toLowerCase();
  return (
    input.key === "Meta" ||
    input.key === "Control" ||
    key === "q" ||
    (holdKeyCode !== "" && input.code === holdKeyCode)
  );
}

/**
 * 给每个 webContents 挂 ⌘Q 监听（主窗、桌宠、资源窗、浏览器 <webview>）。
 * 只读模块状态，contents 销毁后事件自然停止；webview 获得焦点时也能截到按键。
 */
function attachQuitKeyEvents(contents: WebContents): void {
  if (contents.isDestroyed()) return;
  contents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown") {
      if (input.key === "Escape" || input.code === "Escape") {
        if (phase === "holding" || phase === "stopping") {
          event.preventDefault();
          requestCancel("escape");
        }
        return;
      }
      if (!isQuitKey(input)) return;
      // 关键：这里**不能** preventDefault。preventDefault 会让随后的 keyUp
      // 也送不到渲染层/本监听器（macOS 实测按住确认收不到松手事件），
      // 菜单加速键触发的 before-quit 由 installQuitGuard 在流程进行中忽略。
      lastQuitKeyAt = Date.now();
      if (input.isAutoRepeat) return;
      if (phase === "idle" || phase === "cancelled") startHold(input.code);
      else if (phase === "stopping" || phase === "finalizing") forceQuitNow();
      return;
    }
    if (input.type === "keyUp" && phase === "holding" && isReleaseKey(input)) {
      requestCancel("key-release");
    }
  });
}

/** 窗口级兜底：失焦/隐藏/关闭时取消按住确认 */
function attachQuitWindowGuard(win: BrowserWindow): void {
  win.on("blur", () => {
    // 只认主窗口失焦：从桌宠/资源窗发起时会主动把主窗聚焦到前台，
    // 那些窗口的 blur 是聚焦转移的副产物，不能当成用户取消。
    if (phase !== "holding" || mainWindow() !== win) return;
    // 菜单加速键/焦点转移可能瞬间 blur，等一拍确认应用真的失活再取消；
    // 否则按 ⌘Q 弹出的菜单会让“按住确认”一开始就被自己取消。
    setTimeout(() => {
      if (phase === "holding" && mainWindow() === win && !win.isFocused()) {
        requestCancel("blur");
      }
    }, 120).unref?.();
  });
  win.on("hide", () => {
    if (phase === "holding" && mainWindow() === win) requestCancel("hide");
  });
  win.on("closed", () => {
    // 按住期间主窗口被关掉（macOS ⌘W）：没有进度条可看，取消本次退出
    if (phase === "holding" && mainWindow() === null) requestCancel("window-closed");
  });
}

/* ------------------------------ 生命周期 ------------------------------ */

export function installQuitGuard(): void {
  if (installed) return;
  installed = true;
  app.on("before-quit", (event) => {
    // 键盘 ⌘Q 也会触发菜单加速键并走到这里：退出流程已接管时直接忽略。
    // 鼠标 Quit（菜单/托盘）在空闲态保持旧行为：立即收尾退出，不等待。
    event.preventDefault();
    if (phase === "holding" || phase === "stopping" || phase === "finalizing") {
      // 键盘加速键（含 repeat）在流程中忽略；鼠标点菜单 Quit 走旧的优雅收尾
      if (phase !== "finalizing" && Date.now() - lastQuitKeyAt > 1_500) {
        logInfo(`[quit] before-quit by mouse while ${phase}; immediate quit`);
        phase = "finalizing";
        emitState();
        void quitImmediately();
      }
      return;
    }
    // 松手取消后，菜单加速键的 before-quit 可能晚到一拍：不能当成真的退出请求。
    // 窗口已不存在时不做此保护——Linux 关最后一个窗触发的 app.quit 必须放行。
    if (Date.now() - lastHoldCancelledAt < 500 && mainWindow()) {
      logInfo("[quit] before-quit ignored right after hold cancel");
      return;
    }
    void quitImmediately();
  });
  // 按键挂到所有 webContents（含 <webview>），窗口生命周期单独挂
  app.on("web-contents-created", (_event, contents) => attachQuitKeyEvents(contents));
  app.on("browser-window-created", (_event, win) => attachQuitWindowGuard(win));
}

/** 按住确认开始：窗口可见 + 进入 holding，5s 计时器推进进度 */
function startHold(keyCode = ""): void {
  if (immediateStarted) return; // 鼠标退出已在收尾，不再起键盘流程
  destroyTimerAll();
  shutdownWorkStarted = false;
  phase = "holding";
  holdProgress = 0;
  holdKeyCode = keyCode;
  holdStartedAt = Date.now();
  flowStartedAt = holdStartedAt;
  cancelRequested = false;
  tasks = [];
  completed = 0;
  stoppedCount = 0;

  const win = ensureMainWindowVisible();
  if (!win) {
    logInfo("[quit] no main window; falling back to immediate quit");
    void quitImmediately();
    return;
  }
  emitState();
  logInfo(`[quit] hold started (${HOLD_MS}ms)`);

  holdTimer = setInterval(() => {
    holdProgress = Math.min(1, (Date.now() - holdStartedAt) / HOLD_MS);
    emitState();
    if (holdProgress >= 1) {
      clearHoldTimer();
      void beginStopping();
    }
  }, HOLD_TICK_MS);
  holdTimer.unref?.();

  watchdog = setTimeout(() => {
    logWarn(`[quit] watchdog fired after ${WATCHDOG_MS}ms; forcing exit`);
    forceQuitNow();
  }, WATCHDOG_MS);
  watchdog.unref?.();
}

/** 5s 确认完成：先查清单，再逐项停止非服务任务；服务留到 finalizing */
async function beginStopping(): Promise<void> {
  if (phase !== "holding") return;
  phase = "stopping";
  markShutdownGuard();
  // 确认后才关闸：取消按住（未确认）不能影响定时任务的正常派发
  automation.beginAutomationShutdown();
  try {
    tasks = collectTasks();
  } catch (err) {
    logWarn(`[quit] collect tasks failed: ${errText(err)}`);
    tasks = [];
  }
  completed = 0;
  stoppedCount = 0;
  emitState();
  logInfo(`[quit] confirmed; ${tasks.length} task(s) to stop`);

  for (const task of tasks) {
    if (cancelRequested) {
      finishCancelled("stopping");
      return;
    }
    if (isServiceKind(task.kind)) break; // 服务在 finalizing 里收，避免取消后半残
    const t0 = Date.now();
    task.status = "stopping";
    emitState();
    let confirmed = false;
    try {
      confirmed = await stopTask(task);
    } catch (err) {
      logWarn(`[quit] stop ${task.id} failed: ${errText(err)}`);
    }
    task.status = "stopped";
    // 取消/强制打断等待时不算“已停止”，避免取消提示虚报数量
    if (confirmed) {
      completed += 1;
      stoppedCount += 1;
    }
    emitState();
    if (confirmed) logInfo(`[quit] stopped ${task.id} in ${Date.now() - t0}ms`);
  }

  if (cancelRequested) {
    finishCancelled("stopping");
    return;
  }
  await finalizeShutdown();
}

/** 不可取消的收尾：服务级停止 + 兜底清理 + app.exit(0) */
async function finalizeShutdown(): Promise<void> {
  if (shutdownWorkStarted) return;
  shutdownWorkStarted = true;
  const finalizeStartedAt = Date.now();
  // watchdog 保留到最后：服务级关闭（sidecar 6s 宽限/IM 断连）卡住时兜底强退
  clearHoldTimer();
  clearNoticeTimer();
  phase = "finalizing";
  cancelRequested = false;
  markQuittingWindow();
  logInfo(`[quit] finalizing with ${completed}/${tasks.length} stopped`);
  tasks = tasks.map((t) => (t.status === "stopping" ? { ...t, status: "stopped" } : t));
  emitState();

  for (const task of tasks) {
    if (!isServiceKind(task.kind)) continue;
    task.status = "stopping";
    emitState();
    const t0 = Date.now();
    try {
      await stopServiceTask(task);
    } catch (err) {
      logWarn(`[quit] stop service ${task.kind} failed: ${errText(err)}`);
    }
    task.status = "stopped";
    completed += 1;
    stoppedCount += 1;
    emitState();
    logInfo(`[quit] stopped service ${task.kind} in ${Date.now() - t0}ms`);
  }

  // 兜底：逐项停止期间可能还有新登记的后台任务/终端/工具；服务调用幂等，
  // 统一再收一次，保证与旧 before-quit 路径的清理面完全一致。
  try {
    cancelAllTools();
  } catch (err) {
    logError(`[quit] cancel tools: ${errText(err)}`);
  }
  try {
    stopAllBgTasks();
  } catch (err) {
    logError(`[quit] stop bg tasks: ${errText(err)}`);
  }
  try {
    killAllPty();
  } catch (err) {
    logError(`[quit] kill pty: ${errText(err)}`);
  }
  try {
    await automation.stopAutomationService();
  } catch (err) {
    logError(`[quit] automation: ${errText(err)}`);
  }
  try {
    await pi.killOnExit();
  } catch (err) {
    logError(`[quit] pi-agent: ${errText(err)}`);
  }
  try {
    remote.stopOnExit();
  } catch {
    /* ignore */
  }
  try {
    tunnel.stopNow();
  } catch {
    /* ignore */
  }
  try {
    await stopImSubsystem();
  } catch {
    /* ignore */
  }
  const remain = MIN_FINALIZE_MS - (Date.now() - finalizeStartedAt);
  if (remain > 0) await delay(remain);
  logInfo(`[quit] done in ${Date.now() - flowStartedAt}ms; exiting`);
  app.exit(0);
}

/* ------------------------------ 逐项停止 ------------------------------ */

function collectTasks(): QuitTaskInfo[] {
  // 侧车已死时 activeTurns 可能是陈旧投影：此时没有可中止的会话，
  // 也不能在退出途中因为 piAbort 的 ensureSpawned 再把侧车拉起来。
  const sessionIds = pi.piAgentRunning() ? pi.piActiveTurnSessionIds() : [];
  const titles = sessionTitles(sessionIds);
  const sessions = sessionIds.map((id) => ({ id, ...(titles.get(id) ?? {}) }));
  const background = listRunningBgTasks().map((task) => ({
    id: task.id,
    // 命令可能带 token：进度条是上屏内容，先走与日志同口径的脱敏
    command: pi.redactSecrets(task.command),
  }));
  return composeQuitTasks({
    sessions,
    background,
    terminals: listPtySessions(),
    services: [
      { kind: "automation", running: automation.automationServiceRunning() },
      { kind: "engine", running: pi.piAgentRunning() },
      { kind: "remote", running: remote.currentPort() !== null },
      { kind: "im", running: runningImChannelCount() > 0 },
    ],
  });
}

/** 会话标题：主进程 sessions 表批量读；库未就绪/查询失败时降级为空 */
function sessionTitles(
  ids: string[],
): Map<string, { title?: string; firstMessage?: string }> {
  const out = new Map<string, { title?: string; firstMessage?: string }>();
  if (ids.length === 0) return out;
  try {
    const unique = [...new Set(ids)].slice(0, 200);
    const placeholders = unique.map(() => "?").join(",");
    const rows = getDb()
      .prepare(`SELECT id, title, first_message FROM sessions WHERE id IN (${placeholders})`)
      .all(...unique) as { id: string; title: string | null; first_message: string | null }[];
    for (const row of rows) {
      out.set(row.id, {
        ...(row.title ? { title: row.title } : {}),
        ...(row.first_message ? { firstMessage: row.first_message } : {}),
      });
    }
  } catch (err) {
    logWarn(`[quit] session title lookup failed: ${errText(err)}`);
  }
  return out;
}

/** 返回是否可计入“已停止”：取消/强制打断等待时返回 false */
async function stopTask(task: QuitTaskInfo): Promise<boolean> {
  const sep = task.id.indexOf(":");
  const kind = task.id.slice(0, sep);
  const key = task.id.slice(sep + 1);
  switch (kind) {
    case "session": {
      if (!pi.piAgentRunning()) return true;
      await pi.piAbort({ threadId: key });
      await waitUntil(() => !pi.piActiveTurnSessionIds().includes(key), SESSION_STOP_TIMEOUT_MS);
      // 超时仍按“已请求停止”计（不再阻塞后续任务）；用户取消则不计
      return !cancelRequested;
    }
    case "background": {
      stopBgTask(Number(key));
      await delay(120);
      return true;
    }
    case "terminal": {
      ptyClose({ id: key });
      await delay(80);
      return true;
    }
    default:
      logWarn(`[quit] unexpected task kind in stopping loop: ${task.id}`);
      return false;
  }
}

async function stopServiceTask(task: QuitTaskInfo): Promise<void> {
  switch (task.kind) {
    case "automation":
      await automation.stopAutomationService();
      return;
    case "engine":
      await pi.killOnExit();
      return;
    case "remote":
      remote.stopOnExit();
      tunnel.stopNow();
      await delay(80);
      return;
    case "im":
      await stopImSubsystem();
      return;
    default:
      logWarn(`[quit] unexpected service kind: ${task.kind}`);
  }
}

/** 轮询等待：退出/取消/强制请求会提前打断，单项最长 1.5s */
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (cancelRequested) return;
    await delay(50);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------ 取消 / 强制 ------------------------------ */

function requestCancel(reason: string): void {
  if (phase === "holding") {
    finishCancelled(reason);
    return;
  }
  if (phase === "stopping") cancelRequested = true;
}

function finishCancelled(reason: string): void {
  if (phase === "finalizing") return;
  const wasHolding = phase === "holding";
  const stopped = stoppedCount;
  destroyTimerAll();
  cancelRequested = false;
  automation.endAutomationShutdown();
  // 复位退出标记：Windows 的关窗进托盘逻辑要恢复原行为
  clearQuittingWindow();
  resetShutdownGuard();

  if (wasHolding && stopped === 0) {
    phase = "idle";
    lastHoldCancelledAt = Date.now();
    emitState();
    logInfo(`[quit] hold cancelled (${reason})`);
    return;
  }

  phase = "cancelled";
  emitState();
  logInfo(`[quit] cancelled (${reason}); stopped=${stopped}`);
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    if (phase === "cancelled") {
      phase = "idle";
      emitState();
    }
  }, CANCEL_NOTICE_MS);
  noticeTimer.unref?.();
}

/** 强制退出：不再等待任何 agent 结算/服务优雅关闭 */
function forceQuitNow(): void {
  if (phase === "idle") return;
  destroyTimerAll();
  markShutdownGuard();
  phase = "finalizing";
  markQuittingWindow();
  emitState();
  logWarn("[quit] forcing immediate exit");
  try {
    cancelAllTools();
  } catch {
    /* ignore */
  }
  try {
    stopAllBgTasks();
  } catch {
    /* ignore */
  }
  try {
    killAllPty();
  } catch {
    /* ignore */
  }
  try {
    pi.piKillNow();
  } catch {
    /* ignore */
  }
  try {
    automation.killAutomationNow();
  } catch {
    /* ignore */
  }
  try {
    remote.stopOnExit();
  } catch {
    /* ignore */
  }
  try {
    tunnel.stopNow();
  } catch {
    /* ignore */
  }
  void stopImSubsystem().catch(() => undefined);
  app.exit(0);
}

/* ------------------------------ 鼠标路径（旧行为） ------------------------------ */

/**
 * before-quit 的旧收尾路径：菜单点击 Quit / 托盘退出 / 无窗口兜底。
 * 顺序与改造前一致（工具 → 自动化 → sidecar → 网关/隧道 → IM → 终端），
 * 额外补了后台 bash 的清理。
 */
async function quitImmediately(): Promise<void> {
  if (immediateStarted) return;
  immediateStarted = true;
  destroyTimerAll();
  markShutdownGuard();
  automation.beginAutomationShutdown();
  markQuittingWindow();
  logInfo("[quit] immediate quit (menu/tray)");
  try {
    cancelAllTools();
  } catch (err) {
    logError(`[exit] cancel tools: ${errText(err)}`);
  }
  try {
    await automation.stopAutomationService();
  } catch (err) {
    logError(`[exit] automation: ${errText(err)}`);
  }
  try {
    await pi.killOnExit();
  } catch (err) {
    logError(`[exit] pi-agent: ${errText(err)}`);
  }
  try {
    remote.stopOnExit();
  } catch {
    /* ignore */
  }
  try {
    tunnel.stopNow();
  } catch {
    /* ignore */
  }
  try {
    await stopImSubsystem();
  } catch {
    /* ignore */
  }
  try {
    killAllPty();
  } catch {
    /* ignore */
  }
  try {
    stopAllBgTasks();
  } catch {
    /* ignore */
  }
  app.exit(0);
}

/* ------------------------------ IPC commands ------------------------------ */

export function setupQuitCommands(register: RegisterFn): void {
  register("quit_get_state", () => snapshot());
  register("quit_cancel", () => {
    const accepted = phase === "holding" || phase === "stopping";
    if (accepted) requestCancel("ui");
    return { cancelled: accepted };
  });
  register("quit_force", () => {
    if (phase !== "idle") forceQuitNow();
    return null;
  });
}
