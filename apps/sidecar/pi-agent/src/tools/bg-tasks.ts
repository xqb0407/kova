/**
 * 后台任务台账（per-thread，sidecar 内存态）：
 * 事实源在宿主（Electron main 的 bgTasks 表，跨回合存活）；sidecar 只在
 * bash/task_output/task_stop 的工具结果落回来时抽结构化字段记账，并把快照经
 * thread_event 推给 UI（header 徽标 + 快速查看浮层的「后台任务」区块）。
 *
 * 刷新时机：
 * - observe：工具结果落位（hostTool execute 统一调）——注册（bash 带 taskId）、
 *   退出（task_output running:false / task_stop）；
 * - 宿主推送（bg_task_exit）：进程一退出就结算（无需等模型轮询/下一次对话），
 *   覆盖「会话空闲后命令自己结束」的场景；
 * - refresh（轮边界）：对运行中任务逐个向宿主探一次 task_output，兼作旧宿主
 *   兼容与兜底；
 * - 水合（get_bg_tasks）：与宿主的任务表对账——sidecar 重启后内存台账清零，
 *   宿主表里仍在跑的任务靠这一步补回 UI。
 *
 * 主动停止入口（任务按设计跨回合存活，但要有界）：
 * - stopBgTaskManually：快速查看浮层的「停止」按钮（UI → stop_bg_task 协议
 *   命令）——用户显式要求停；
 * - 空闲自动停：会话空闲超过 BG_IDLE_STOP_MS 后自动清掉该线程仍在跑的任务，
 *   防 server 型任务（预览/dev server）在无人值守时无限滞留。定时器挂在
 *   轮边界上（runTurnBody 开始 touch / 结束 arm），是尽力而为的清扫：
 *   sidecar 重启丢定时器，下一回合结束重臂；不改变宿主侧生命周期语义
 *   （退出应用仍走宿主 stopAllBgTasks，删除会话仍走 stopBgTasksForSession）。
 *
 * 会话切换/刷新的水合走 get_bg_tasks（sessions.ts handler，与 get_todo_state
 * 同款形态）。台账是旁路：任何解析/探测失败记日志后跳过，绝不影响工具结果
 * 与回合主流程。
 */
import { bgTasksList, bgTasksReown, hostToolCall } from "../storage/hostdb";
import { logErr } from "../log";
import { emitThreadEvent } from "../protocol/thread-events";
import { buildBackgroundTaskItem } from "../inbox/items";
import { upsertInboxItem } from "../inbox/store";

export type BgTaskInfo = {
  taskId: number;
  command: string;
  /** explicit = 模型主动 runInBackground；timeout = 超时自动转后台 */
  source: "explicit" | "timeout";
  startedAt: number;
  running: boolean;
  exitCode: number | null;
  /** 注册时的会话 id：Inbox 深链用；跨回合/重启可能缺省 */
  sessionId?: string;
};

const registries = new Map<string, Map<number, BgTaskInfo>>();
/** 探测用 cwd（bash 观察时登记；task_output 本身不用 cwd，信封要求带上） */
const cwds = new Map<string, string>();
/**
 * 已删除会话的线程键（本进程内）：宿主退出通知迟到时不补登记/不写 Inbox。
 *
 * 只记「确认删除」的键，不能用驻留表推断——未打开、被驱逐、sidecar 重启后
 * 所有线程都非驻留，按驻留判断会把合法终态通知当噪声丢掉（后台任务跑完
 * 却没有完成提醒/Inbox 条目）。删除时机的任务由 stopBgTasksForSession 先停
 * 再记墓碑，退出通知落在这里被安静收掉。
 */
const closedThreads = new Set<string>();

/** 会话删除：登记墓碑（调用方已停止任务并清台账） */
export function markBgThreadClosed(threadId: string): void {
  if (!threadId) return;
  closedThreads.add(threadId);
}

function registryOf(threadId: string): Map<number, BgTaskInfo> {
  let reg = registries.get(threadId);
  if (!reg) {
    reg = new Map();
    registries.set(threadId, reg);
  }
  return reg;
}

function emitSnapshot(threadId: string): void {
  try {
    emitThreadEvent(threadId, {
      type: "bg_tasks",
      tasks: bgTasksSnapshot(threadId),
    });
  } catch (error) {
    logErr("bg-tasks: emit failed:", error);
  }
}

/** 后台任务终态写入 Inbox；失败只记日志，不影响台账/工具结果 */
function recordBgInbox(threadId: string, task: BgTaskInfo, stopped = false): void {
  try {
    upsertInboxItem(
      buildBackgroundTaskItem({
        taskId: task.taskId,
        command: task.command,
        source: task.source,
        startedAt: task.startedAt,
        exitCode: task.exitCode,
        stopped,
        threadId,
        ...(task.sessionId ? { sessionId: task.sessionId } : {}),
      }),
      // task_stop 是用户主动停的：直接进历史，不占待关注
      { markRead: stopped },
    );
  } catch (error) {
    logErr("bg-tasks: inbox record failed:", error);
  }
}

/** 当前线程的快照（startAt 升序，UI 行序稳定） */
export function bgTasksSnapshot(threadId: string): BgTaskInfo[] {
  return [...(registries.get(threadId)?.values() ?? [])].sort(
    (a, b) => a.startedAt - b.startedAt || a.taskId - b.taskId,
  );
}

/**
 * 工具结果记账（hostTool execute 对 bash/task_output/task_stop 统一调用）。
 * data 是宿主信封的结构化返回：注册看 taskId 字段，状态看 running/exitCode。
 */
export function observeBgToolResult(
  threadId: string,
  cwd: string,
  name: string,
  params: Record<string, unknown>,
  data: Record<string, unknown>,
  sessionId?: string,
): void {
  const reg = registryOf(threadId);
  if (name === "bash" && typeof data.taskId === "number") {
    const command = typeof params.command === "string" ? params.command : "";
    const taskId = data.taskId;
    const source = params.runInBackground === true ? "explicit" : "timeout";
    const existing = reg.get(taskId);
    // 已有终态（bg_task_exit 可能先于工具结果到达——命令秒退）时保持终态：
    // taskId 单调分配不复用，同一个 id 不会代表新任务；这里若按「注册即
    // 运行中」重新点亮，快速查看会留下一条永远不退的「运行中」残影。
    const terminal = existing !== undefined && !existing.running;
    reg.set(taskId, {
      taskId,
      command: command || existing?.command || "",
      source,
      startedAt: existing?.startedAt ?? Date.now(),
      // 注册即运行中：宿主两条后台路径（显式 runInBackground / 超时转后台）的
      // 返回都不带 running 字段或带 true——能用 taskId 注册就说明进程活着。
      // 用 !== false 而不是 === true，否则显式后台任务被记成已结束（徽标不亮）。
      running: terminal ? false : data.running !== false,
      exitCode: terminal
        ? existing.exitCode
        : typeof data.exitCode === "number"
          ? data.exitCode
          : null,
      ...(sessionId ? { sessionId } : {}),
    });
    if (cwd) cwds.set(threadId, cwd);
    emitSnapshot(threadId);
    return;
  }
  if (name === "task_output" && typeof params.taskId === "number") {
    const task = reg.get(params.taskId);
    if (!task) return; // 别的会话的任务 / 重启前的旧任务：不记账
    const nextRunning = data.running === true;
    const nextExit = typeof data.exitCode === "number" ? data.exitCode : task.exitCode;
    // 无变化不发事件：模型可能连续 task_output 轮询，同一状态不刷 UI
    if (nextRunning === task.running && nextExit === task.exitCode) return;
    task.running = nextRunning;
    task.exitCode = nextExit;
    if (!nextRunning) recordBgInbox(threadId, task);
    emitSnapshot(threadId);
    return;
  }
  if (name === "task_stop" && typeof params.taskId === "number") {
    const task = reg.get(params.taskId);
    if (!task) return;
    task.running = false;
    recordBgInbox(threadId, task, true);
    emitSnapshot(threadId);
    return;
  }
}

/**
 * 宿主退出通知（bg_task_exit 自发帧）记账：任务进程退出时宿主立刻推一条，
 * 不需要等模型的 task_output 或下一次轮边界探测。会话空闲/被 Stop 之后命令
 * 自己退出、被外部 kill、超时后台化的构建跑完——这些场景此前没有任何后续
 * 探测，快速查看会一直挂着「运行中」。
 *
 * 幂等：task_output/task_stop 已结算过同一终态时不重复写 Inbox/发帧。
 * 台账里没有的任务（sidecar 重启后才退出）按通知自带字段补一条终态，
 * 保证 Inbox 与快照都能看到「已结束」。
 */
export function observeBgTaskExit(
  threadId: string,
  notice: {
    taskId: number;
    exitCode: number | null;
    stopped?: boolean;
    command?: string;
    source?: "explicit" | "timeout";
    startedAt?: number;
  },
): void {
  if (!threadId || !Number.isFinite(notice.taskId)) return;
  const reg = registryOf(threadId);
  const existing = reg.get(notice.taskId);
  // 已删除线程：迟到通知安静收掉（台账已清、会话行已删，补登记只会留下
  // 指向不存在会话的 Inbox 行）。只拦「台账里没有」的全新补账——已有行照常
  // 结算（删除流程会停任务并清台账，窗口内的迟到通知正好把终态补上）。
  if (!existing && closedThreads.has(threadId)) return;
  if (existing) {
    if (!existing.running && existing.exitCode === notice.exitCode) return;
    existing.running = false;
    if (typeof notice.exitCode === "number") existing.exitCode = notice.exitCode;
    recordBgInbox(threadId, existing, notice.stopped === true);
    emitSnapshot(threadId);
    return;
  }
  const task: BgTaskInfo = {
    taskId: notice.taskId,
    command: typeof notice.command === "string" ? notice.command : "",
    source: notice.source === "timeout" ? "timeout" : "explicit",
    startedAt:
      typeof notice.startedAt === "number" ? notice.startedAt : Date.now(),
    running: false,
    exitCode: typeof notice.exitCode === "number" ? notice.exitCode : null,
  };
  reg.set(task.taskId, task);
  recordBgInbox(threadId, task, notice.stopped === true);
  emitSnapshot(threadId);
}

/**
 * 与宿主后台任务表对账（水合时调用）：sidecar 内存台账随重启清零，但宿主
 * 表里的任务还活着——不补登记的话，快速查看会漏掉仍在跑的任务；反过来，
 * 宿主说已结束而台账还标着运行中的行也在这里纠偏。
 *
 * 只做「补登记 + 状态纠偏」，不因为宿主列表里没有就清本地条目：远程线程 /
 * 本地 ACP 执行路径的任务不归宿主这张表管。宿主不可用（本地模式）时静默
 * 保留内存快照。
 */
export async function reconcileBgTasksWithHost(
  threadId: string,
  sessionId?: string,
): Promise<void> {
  // 已删除会话：水合不能把宿主表里的终态行又拉回台账（会给已删线程造新行）
  if (closedThreads.has(threadId)) return;
  let rows: Awaited<ReturnType<typeof bgTasksList>>;
  try {
    rows = await bgTasksList(threadId);
  } catch {
    return;
  }
  if (!Array.isArray(rows) || rows.length === 0) return;
  const reg = registryOf(threadId);
  let changed = false;
  for (const row of rows) {
    const taskId = Number(row?.taskId);
    if (!Number.isFinite(taskId)) continue;
    const running = row.running === true;
    const exitCode = typeof row.exitCode === "number" ? row.exitCode : null;
    const existing = reg.get(taskId);
    if (!existing) {
      reg.set(taskId, {
        taskId,
        command: typeof row.command === "string" ? row.command : "",
        source: row.source === "timeout" ? "timeout" : "explicit",
        startedAt: Number.isFinite(row.startedAt) ? row.startedAt : Date.now(),
        running,
        exitCode,
        ...(sessionId ? { sessionId } : {}),
      });
      changed = true;
      continue;
    }
    if (existing.running === running && existing.exitCode === exitCode) continue;
    const wasRunning = existing.running;
    existing.running = running;
    if (exitCode !== null) existing.exitCode = exitCode;
    changed = true;
    // 退出推送落在重启窗口里（旧实例已死/新实例未起）时，这里补一条终态
    if (wasRunning && !running) recordBgInbox(threadId, existing);
  }
  if (changed) emitSnapshot(threadId);
}

/* ------------------------------ 主动停止 ------------------------------ */

/**
 * 用户主动停单个任务（快速查看「停止」按钮 → stop_bg_task 协议命令）。
 * 与模型 task_stop 工具同一条宿主链路：owner=threadId 由宿主做归属校验，
 * 跨线程凭猜测的 taskId 停别人的任务会被宿主拒绝（tool-exec.ts ownedTask）。
 * 成功后本地立即结算（与模型 task_stop 的工具结果记账同款形状）；宿主
 * bg_task_exit 推送随后到达时按同一终态幂等，不会重复写 Inbox/发帧。
 * 台账查无此任务不预拦：直接交宿主裁决（sidecar 重启后台账为空但宿主任务
 * 还在跑，宿主能停；真不存在/别人的任务宿主会抛错，错误透传给 UI toast）。
 */
export async function stopBgTaskManually(
  threadId: string,
  taskId: number,
): Promise<void> {
  if (!threadId || !Number.isFinite(taskId)) {
    throw new Error("stop_bg_task: threadId and taskId are required");
  }
  const task = registries.get(threadId)?.get(taskId);
  // 已终态：幂等 no-op（UI 双击/竞态点击不重复杀、不重复写 Inbox）
  if (task && !task.running) return;
  const cwd = cwds.get(threadId) ?? "";
  try {
    await hostToolCall(
      "task_stop",
      cwd,
      { taskId },
      AbortSignal.timeout(5_000),
      threadId,
      undefined,
    );
  } catch (error) {
    // 归属拒绝/宿主忙等透传：UI 端 toast 需要真实原因，吞掉就没有反馈了
    logErr(`bg-tasks: manual stop task ${taskId} failed:`, error);
    throw error;
  }
  observeBgToolResult(
    threadId,
    cwd,
    "task_stop",
    { taskId },
    { output: `task ${taskId} stopped`, running: false },
  );
}

/* --------------------------- 空闲自动停（清扫） --------------------------- */

/**
 * 会话空闲多久后自动停掉其名下仍在跑的后台任务。默认 30 分钟：给「回合结束
 * 后命令自己再跑一会儿」（超时转后台的长 build）留足余量，又不会让 server
 * 型任务无限滞留。暂为常量，后续接设置页再改会话级/全局偏好。
 */
const BG_IDLE_STOP_MS = 30 * 60 * 1000;
let bgIdleStopMs = BG_IDLE_STOP_MS;

/** 每线程一个 pending 定时器；activeIdleThreads = 本轮未结束的线程 */
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activeIdleThreads = new Set<string>();

function clearIdleTimer(threadId: string): void {
  const timer = idleTimers.get(threadId);
  if (timer !== undefined) {
    clearTimeout(timer);
    idleTimers.delete(threadId);
  }
}

/**
 * 回合开始（runTurnBody，改绑后调）：撤销上一回合结束臂上的定时器并标记
 * 线程活跃——用户回来继续对话了，自动停顺延到这回合结束再算 30 分钟。
 */
export function touchBgTasksIdle(threadId: string): void {
  if (!threadId) return;
  clearIdleTimer(threadId);
  activeIdleThreads.add(threadId);
}

/**
 * 回合结束（runTurnBody finally，与 refreshBgTasks 同点调）：解除活跃标记，
 * 名下还有运行中任务才臂定时器。重复调用幂等（先清后设）。
 */
export function armBgTasksIdle(threadId: string): void {
  if (!threadId) return;
  activeIdleThreads.delete(threadId);
  clearIdleTimer(threadId);
  const hasRunning = [...(registries.get(threadId)?.values() ?? [])].some(
    (t) => t.running,
  );
  if (!hasRunning) return;
  const timer = setTimeout(() => void stopIdleBgTasks(threadId), bgIdleStopMs);
  // unref：清扫是旁路，不能反过来拖住 sidecar 进程退出
  timer.unref?.();
  idleTimers.set(threadId, timer);
}

/** 定时器 fire：逐个停掉该线程运行中的任务（串行 + 5s 超时，同删除会话） */
async function stopIdleBgTasks(threadId: string): Promise<void> {
  idleTimers.delete(threadId);
  // 防御：fire 时线程又活跃了（touch/arm 竞态、goal loop 私有轮次等挂点
  // 缺漏的场景）——顺延而不是误杀正在被模型使用的任务
  if (activeIdleThreads.has(threadId)) {
    armBgTasksIdle(threadId);
    return;
  }
  const running = [...(registries.get(threadId)?.values() ?? [])].filter(
    (t) => t.running,
  );
  if (running.length === 0) return;
  const cwd = cwds.get(threadId) ?? "";
  for (const task of running) {
    try {
      await hostToolCall(
        "task_stop",
        cwd,
        { taskId: task.taskId },
        AbortSignal.timeout(5_000),
        threadId,
        undefined,
      );
    } catch (error) {
      // 单条失败只留痕：结算交还既有兜底（bg_task_exit / 轮边界 refresh /
      // 水合对账），不能让一条卡住拖过其余任务
      logErr(`bg-tasks: idle stop task ${task.taskId} failed:`, error);
      continue;
    }
    observeBgToolResult(
      threadId,
      cwd,
      "task_stop",
      { taskId: task.taskId },
      { output: `task ${task.taskId} stopped: idle cleanup`, running: false },
    );
  }
}

/**
 * 线程键迁移（刷新后 run 改绑新 threadId，见 rebindRunThread）：台账、探测
 * cwd 与空闲定时器一并挪到新键。不迁的话新键水合为空，仍在跑的任务会从
 * 快速查看消失；定时器留在旧键上 fire 后只会撞到空台账白跑一趟。
 */
export function migrateBgTasks(oldThreadId: string, newThreadId: string): void {
  if (!oldThreadId || !newThreadId || oldThreadId === newThreadId) return;
  const reg = registries.get(oldThreadId);
  if (!reg) return;
  const target = registryOf(newThreadId);
  for (const [id, task] of reg) {
    if (!target.has(id)) target.set(id, task);
  }
  registries.delete(oldThreadId);
  const cwd = cwds.get(oldThreadId);
  if (cwd !== undefined) {
    cwds.set(newThreadId, cwd);
    cwds.delete(oldThreadId);
  }
  const timer = idleTimers.get(oldThreadId);
  if (timer !== undefined) {
    idleTimers.delete(oldThreadId);
    idleTimers.set(newThreadId, timer);
  }
  if (activeIdleThreads.delete(oldThreadId)) {
    activeIdleThreads.add(newThreadId);
  }
  emitSnapshot(newThreadId);
}

/**
 * 宿主侧归属改绑（与 migrateBgTasks 配对）：宿主按 owner 校验 task_output /
 * task_stop，台账挪键而宿主不动的话，刷新后所有探测都会被判「属于别的线程」，
 * 反过来把仍在跑的任务错标成已停止。失败静默：旧宿主没有该通道，退化为
 * 探测失败兜底（不会卡住会话恢复）。
 */
export async function reassignBgTasksOwner(
  oldThreadId: string,
  newThreadId: string,
): Promise<void> {
  if (!oldThreadId || !newThreadId || oldThreadId === newThreadId) return;
  try {
    // await 而非 fire-and-forget：改绑窗口内模型立刻 task_output 的话，宿主
    // 还按旧 owner 拒绝会把仍在跑的任务错标成「已停止」。RPC 本身 3s 超时
    // （hostdb 侧），失败仍静默——本地模式/旧宿主没有此通道，退化为探测兜底。
    await bgTasksReown(oldThreadId, newThreadId);
  } catch {
    // 本地模式/旧宿主：无此通道，保持原样
  }
}

/**
 * 会话删除：停掉该会话名下的后台任务并清台账。会话行消失后没人再能看见/
 * 停止这些进程，不杀就会变成看不见的常驻进程（还握着旧工作目录的句柄）。
 * 单条失败只留痕：删除流程不能反过来被旁路卡住。
 */
export async function stopBgTasksForSession(sessionId: string): Promise<void> {
  if (!sessionId) return;
  const targets: Array<{ threadId: string; taskId: number; cwd: string }> = [];
  /** 该会话名下出现过的线程键（含只有终态行的）：删除时整组清掉并立墓碑 */
  const touched = new Set<string>();
  for (const [threadId, reg] of registries) {
    for (const task of reg.values()) {
      if (task.sessionId !== sessionId) continue;
      touched.add(threadId);
      if (!task.running) continue;
      targets.push({ threadId, taskId: task.taskId, cwd: cwds.get(threadId) ?? "" });
    }
  }
  for (const target of targets) {
    try {
      // 5s 上限：删除会话在管理串行队列上，单条 task_stop 卡住（宿主忙/无响应）
      // 不能把整条删除链拖满默认 15s 超时；超时按失败记日志，台账照清。
      await hostToolCall(
        "task_stop",
        target.cwd,
        { taskId: target.taskId },
        AbortSignal.timeout(5_000),
        target.threadId,
        undefined,
      );
    } catch (error) {
      logErr(`bg-tasks: stop task ${target.taskId} on session delete failed:`, error);
    }
  }
  if (touched.size === 0) return;
  // 终态行也一并清：会话行都删了，台账里的历史行没人能看见（只占内存）
  for (const threadId of touched) {
    registries.delete(threadId);
    cwds.delete(threadId);
    clearIdleTimer(threadId); // 会话已删，空闲定时器留着 fire 只会撞空台账
    activeIdleThreads.delete(threadId);
    // 墓碑：随后到达的 bg_task_exit 不能再给已删会话补台账/写 Inbox
    markBgThreadClosed(threadId);
    emitSnapshot(threadId);
  }
}

/**
 * 轮边界探测（兜底）：对运行中任务逐个向宿主查 task_output。退出实时性由
 * 宿主 bg_task_exit 推送保证，这里只补充「推送丢失/旧宿主」的场景：
 * - 宿主确认任务已不存在（完成超上限被逐出）→ 按退出结算；
 * - 传输类失败（超时/宿主忙/侧车换代）→ **保持运行中**，下一轮再探。
 *   此前一律按退出处理，瞬时 RPC 失败会把仍在跑的任务错标成「已停止」，
 *   随后 task_output 又翻回运行中 → 快速查看里状态来回跳。
 */
export async function refreshBgTasks(threadId: string): Promise<void> {
  const reg = registries.get(threadId);
  if (!reg) return;
  const running = [...reg.values()].filter((t) => t.running);
  if (running.length === 0) return;
  const cwd = cwds.get(threadId) ?? "";
  let changed = false;
  const finished: Array<{ task: BgTaskInfo; stopped: boolean }> = [];
  for (const task of running) {
    try {
      const data = (await hostToolCall(
        "task_output",
        cwd,
        { taskId: task.taskId },
        undefined,
        threadId,
        undefined,
      )) as { running?: boolean; exitCode?: number | null };
      const nextRunning = data.running === true;
      const nextExit = typeof data.exitCode === "number" ? data.exitCode : task.exitCode;
      if (nextRunning !== task.running || nextExit !== task.exitCode) {
        task.running = nextRunning;
        task.exitCode = nextExit;
        changed = true;
        // 正常退出：保留 exitCode，由 Inbox 判定成功/失败（0 = 成功，非零 = 失败）
        if (!nextRunning) finished.push({ task, stopped: false });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logErr(`bg-tasks: probe task ${task.taskId} failed:`, error);
      // 只有宿主明确说「没这条任务」才是真退出；其余失败不能改状态
      if (!/no such background task/.test(message)) continue;
      task.running = false;
      changed = true;
      finished.push({ task, stopped: true });
    }
  }
  // 探测到退出也算终态：先记 Inbox 再刷 UI 快照
  for (const entry of finished) recordBgInbox(threadId, entry.task, entry.stopped);
  if (changed) emitSnapshot(threadId);
}

/* ------------------------- 测试缝 ------------------------- */

/** 注入空闲自动停延迟（测试注入短延迟/0；不传回落默认） */
export function setBgIdleStopDelayForTest(ms: number): void {
  bgIdleStopMs = ms;
}

/** 绕过真实定时器等待，直接触发某线程的空闲清扫（fire 路径与定时器一致；
 *  返回在飞 Promise 供测试断言终态） */
export function fireBgIdleStopForTest(threadId: string): Promise<void> {
  return stopIdleBgTasks(threadId);
}

/** 清空某线程台账（测试隔离用） */
export function resetBgTasksForTest(threadId?: string): void {
  if (threadId) {
    registries.delete(threadId);
    cwds.delete(threadId);
    closedThreads.delete(threadId);
    clearIdleTimer(threadId);
    activeIdleThreads.delete(threadId);
  } else {
    registries.clear();
    cwds.clear();
    closedThreads.clear();
    for (const timer of idleTimers.values()) clearTimeout(timer);
    idleTimers.clear();
    activeIdleThreads.clear();
    bgIdleStopMs = BG_IDLE_STOP_MS;
  }
}
