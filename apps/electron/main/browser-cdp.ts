/**
 * 内置浏览器 guest 的 CDP 会话（对齐 X BrowserGuestManager 的 CDP 生命周期，
 * 单 guest 最小版）：
 * - 懒 attach：第一次动作时 `webContents.debugger.attach("1.3")` + `Page.enable`；
 * - 串行队列：同一 guest 的 CDP 命令不并发（Chromium 的 Input/Page 顺序敏感）；
 * - 空闲 30s 自动 detach：把 debugger 让给 DevTools，也降低常驻开销；
 * - 打开 DevTools 前显式 release（同一 webContents 只能挂一个 debugger）；
 * - guest 崩溃先 detach（destroyed 后再碰 debugger 会 UAF）；
 * - 订阅 `Page.javascriptDialogOpening/Closed`，给 browser_dialog 提供状态；
 * - 有未决 dialog 或在飞命令时不空闲释放。
 *
 * 只依赖传入的 host 对象，不 import electron，bun test 可用 fake 驱动。
 */

const CDP_TIMEOUT_MS = 10_000;
const IDLE_RELEASE_MS = 30_000;
const RELEASE_WAIT_MS = 2_000;

/** 用类型而不是错误文案判断超时：页面/命令自己抛出的 "timed out" 不应触发
 *  detach。 */
class CdpTimeoutError extends Error {
  constructor(method: string) {
    super(`CDP ${method} timed out after ${CDP_TIMEOUT_MS}ms`);
    this.name = "CdpTimeoutError";
  }
}

export type BrowserDialogType = "alert" | "confirm" | "prompt" | "beforeunload";

export interface BrowserDialogInfo {
  type: BrowserDialogType;
  message: string;
  defaultPrompt?: string;
}

export interface CdpDebuggerLike {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
  on(event: "message", listener: (event: unknown, method: string, params: unknown) => void): void;
  removeListener(
    event: "message",
    listener: (event: unknown, method: string, params: unknown) => void,
  ): void;
}

export interface CdpHostLike {
  isDestroyed(): boolean;
  isDevToolsOpened?(): boolean;
  debugger: CdpDebuggerLike;
  on(event: string, listener: (...args: any[]) => void): void;
  once(event: "destroyed", listener: () => void): void;
}

interface CdpState {
  attached: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  inFlight: number;
  queue: Promise<unknown>;
  dialog: BrowserDialogInfo | null;
  onMessage: ((event: unknown, method: string, params: unknown) => void) | null;
}

const states = new WeakMap<CdpHostLike, CdpState>();

function normalizeDialogType(raw: unknown): BrowserDialogType {
  return raw === "alert" || raw === "confirm" || raw === "prompt" || raw === "beforeunload"
    ? raw
    : "alert";
}

function stateFor(host: CdpHostLike): CdpState {
  const existing = states.get(host);
  if (existing) return existing;

  const state: CdpState = {
    attached: false,
    idleTimer: null,
    inFlight: 0,
    queue: Promise.resolve(),
    dialog: null,
    onMessage: null,
  };
  states.set(host, state);

  // 崩溃：必须在 WebContents 销毁前 detach（destroyed 之后调 debugger 会抛）。
  host.on("render-process-gone", () => {
    detachCdp(host);
  });
  host.once("destroyed", () => {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = null;
    state.attached = false;
    state.dialog = null;
    state.onMessage = null;
    states.delete(host);
  });
  return state;
}

function wireDialogEvents(host: CdpHostLike, state: CdpState): void {
  if (state.onMessage) {
    try {
      host.debugger.removeListener("message", state.onMessage);
    } catch {
      /* 已 detach：忽略 */
    }
  }
  const onMessage = (_event: unknown, method: string, params: unknown): void => {
    if (method === "Page.javascriptDialogOpening") {
      const data = (params ?? {}) as {
        type?: string;
        message?: string;
        defaultPrompt?: string;
      };
      state.dialog = {
        type: normalizeDialogType(data.type),
        message: typeof data.message === "string" ? data.message : "",
        ...(typeof data.defaultPrompt === "string" && data.defaultPrompt.length > 0
          ? { defaultPrompt: data.defaultPrompt }
          : {}),
      };
    } else if (method === "Page.javascriptDialogClosed") {
      state.dialog = null;
    }
  };
  state.onMessage = onMessage;
  host.debugger.on("message", onMessage);
}

function scheduleIdleRelease(host: CdpHostLike, state: CdpState): void {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = null;
  // 有未决 dialog 时不释放：detach 会把 dialog 的生命周期和事件一起丢掉。
  if (state.inFlight > 0 || state.dialog) return;
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null;
    if (state.inFlight === 0 && !state.dialog) detachCdp(host);
  }, IDLE_RELEASE_MS);
  state.idleTimer.unref?.();
}

async function rawSend(
  host: CdpHostLike,
  method: string,
  params?: unknown,
): Promise<unknown> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new CdpTimeoutError(method)), CDP_TIMEOUT_MS);
    timerId.unref?.();
  });
  try {
    return await Promise.race([host.debugger.sendCommand(method, params), timer]);
  } catch (err) {
    // 超时后底层命令可能仍在跑：若没有 dialog 在等，主动 detach，下一次动作
    // 重新 attach，避免半死不活的 session 继续吞命令。dialog 在等时必须保留
    // session，否则 Page.handleJavaScriptDialog 无从下发（点击 confirm 就是
    // 这个场景：mouseReleased 的响应会被 Dialog 一起阻塞）。
    if (err instanceof CdpTimeoutError && !states.get(host)?.dialog) {
      detachCdp(host);
    }
    throw err;
  } finally {
    // 命令正常返回后 timeout 仍在计时器表里；高频动作下会白攒一批 10s 定时器。
    if (timerId !== undefined) clearTimeout(timerId);
  }
}

export function isCdpAttached(host: CdpHostLike): boolean {
  return states.get(host)?.attached === true;
}

export async function ensureCdp(host: CdpHostLike): Promise<void> {
  if (host.isDestroyed()) throw new Error("browser guest was destroyed");
  const state = stateFor(host);
  if (state.attached && host.debugger.isAttached()) return;

  if (host.isDevToolsOpened?.()) {
    throw new Error(
      "DevTools is open for the browser page; the agent cannot drive it at the same time. " +
        "Close DevTools (or let the page reload) and retry.",
    );
  }
  if (host.debugger.isAttached()) {
    throw new Error(
      "another debugger is already attached to the browser page (DevTools or a previous session). " +
        "Close it and retry.",
    );
  }

  host.debugger.attach("1.3");
  state.attached = true;
  wireDialogEvents(host, state);
  try {
    // Page 域 enable 是 per-session 的：每次 re-attach 都要重放，否则
    // dialog 事件黑洞、getDialog 恒 null。
    await rawSend(host, "Page.enable");
  } catch (err) {
    detachCdp(host);
    throw new Error(`browser CDP Page.enable failed: ${String((err as Error)?.message ?? err)}`);
  }
  scheduleIdleRelease(host, state);
}

/** 实际下发一条命令并做 attach / 在飞记账。正常命令由串行队列调用；dialog
 *  处理可以不进队列直接调用——触发 dialog 的命令会一直挂起并占着队首，
 *  handle 若排队就只能等 CDP_TIMEOUT_MS 超时。 */
async function sendNow(
  host: CdpHostLike,
  state: CdpState,
  method: string,
  params?: unknown,
): Promise<unknown> {
  await ensureCdp(host);
  if (host.isDestroyed()) throw new Error("browser guest was destroyed");
  state.inFlight += 1;
  try {
    return await rawSend(host, method, params);
  } finally {
    state.inFlight = Math.max(0, state.inFlight - 1);
    scheduleIdleRelease(host, state);
  }
}

function enqueueWithEnsure(
  host: CdpHostLike,
  state: CdpState,
  method: string,
  params?: unknown,
): Promise<unknown> {
  // ensure 必须在队列内：并发的 sendCdp 按调用顺序逐个 attach + Page.enable，
  // 不能在队列外各自 await（第二个调用可能先入队，命令顺序就反了）。
  const run = state.queue.then(() => sendNow(host, state, method, params));
  state.queue = run.catch(() => undefined);
  return run;
}

export function sendCdp(
  host: CdpHostLike,
  method: string,
  params?: unknown,
): Promise<unknown> {
  const state = stateFor(host);
  return enqueueWithEnsure(host, state, method, params);
}

/**
 * 同 sendCdp，但 dialog 一打开就立即拒绝，不等底层命令自己返回。
 *
 * confirm/alert 会阻塞执行命令的渲染线程（典型是 Runtime.evaluate）；若等
 * CDP_TIMEOUT_MS 才把「先处理 dialog」的提示交给模型，用户要白等 10 秒。
 * 底层命令不取消：它仍留在队列里，browser_dialog 处理完弹窗后会自然落地。
 */
export async function sendCdpRacingDialog(
  host: CdpHostLike,
  method: string,
  params?: unknown,
  pollMs = 50,
): Promise<unknown> {
  const state = stateFor(host);
  if (state.dialog) throw new Error("JavaScript dialog opened");
  const settled = sendCdp(host, method, params).then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
  for (;;) {
    if (state.dialog) throw new Error("JavaScript dialog opened");
    const outcome = await Promise.race([
      settled,
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), Math.max(10, pollMs));
        timer.unref?.();
      }),
    ]);
    if (outcome === null) continue;
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
}

/**
 * 不等响应的 CDP 命令（仅输入事件用）：点击/回车触发 alert/confirm 时，
 * 渲染线程被 Dialog 阻塞，mouseReleased / keyDown 的响应可能一直不返回；
 * 若走串行队列会卡死后续 Page.handleJavaScriptDialog。这里只保证命令按调用
 * 顺序发出，不占队列、不等待响应。
 */
export async function sendCdpNoWait(
  host: CdpHostLike,
  method: string,
  params?: unknown,
): Promise<void> {
  const state = stateFor(host);
  await ensureCdp(host);
  if (host.isDestroyed()) return;
  state.inFlight += 1;
  let command: Promise<unknown>;
  try {
    command = host.debugger.sendCommand(method, params);
  } catch (err) {
    // sendCommand 在 detach 竞态下可能同步抛：这里必须回滚 inFlight，
    // 否则空闲释放和 releaseCdpForDevtools 会永久把它当成「有命令在飞」。
    state.inFlight = Math.max(0, state.inFlight - 1);
    scheduleIdleRelease(host, state);
    throw err;
  }
  void command
    .catch(() => undefined)
    .finally(() => {
      state.inFlight = Math.max(0, state.inFlight - 1);
      scheduleIdleRelease(host, state);
    });
}

export function detachCdp(host: CdpHostLike): void {
  const state = states.get(host);
  if (!state) return;
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = null;
  if (state.onMessage) {
    try {
      host.debugger.removeListener("message", state.onMessage);
    } catch {
      /* 已 detach：忽略 */
    }
    state.onMessage = null;
  }
  if (state.attached && !host.isDestroyed()) {
    try {
      if (host.debugger.isAttached()) host.debugger.detach();
    } catch {
      /* session 可能已销毁：状态复位仍要完成 */
    }
  }
  state.attached = false;
  state.dialog = null;
}

/** 打开 DevTools 前调用：等在飞命令落地再 detach（等不到也照常 detach）。 */
export async function releaseCdpForDevtools(host: CdpHostLike): Promise<void> {
  const state = states.get(host);
  if (!state) return;
  const deadline = Date.now() + RELEASE_WAIT_MS;
  while (state.inFlight > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  detachCdp(host);
}

export function getPendingDialog(host: CdpHostLike): BrowserDialogInfo | null {
  return states.get(host)?.dialog ?? null;
}

export async function handlePendingDialog(
  host: CdpHostLike,
  accept: boolean,
  promptText?: string,
): Promise<void> {
  const state = states.get(host);
  if (!state?.dialog) {
    throw new Error("no JavaScript dialog is currently open");
  }
  // 不走 sendCdp：触发 dialog 的 Runtime.evaluate 会一直挂起并占着队首，
  // handle 若排在其后会白等 CDP_TIMEOUT_MS（实测 CDP 本身允许 evaluate
  // 挂起时并发处理 dialog）。dialog 处理必须插队。
  await sendNow(host, state, "Page.handleJavaScriptDialog", {
    accept,
    ...(promptText !== undefined ? { promptText } : {}),
  });
  state.dialog = null;
  // sendNow 的 finally 里 dialog 还没清空，scheduleIdleRelease 会直接跳过；
  // 这里补一次，否则 click 触发的弹窗处理完可能一直保持 attach。
  scheduleIdleRelease(host, state);
}

export async function captureCdpScreenshot(
  host: CdpHostLike,
  params: Record<string, unknown>,
): Promise<{ data?: string }> {
  return (await sendCdp(host, "Page.captureScreenshot", params)) as { data?: string };
}

export async function cdpLayoutMetrics(host: CdpHostLike): Promise<any> {
  return await sendCdp(host, "Page.getLayoutMetrics");
}
