/**
 * 后台任务台账（per-thread，sidecar 内存态）：
 * 事实源在宿主（Electron main 的 bgTasks 表，跨回合存活）；sidecar 只在
 * bash/task_output/task_stop 的工具结果落回来时抽结构化字段记账，并把快照经
 * thread_event 推给 UI（header 徽标 + 快速查看浮层的「后台任务」区块）。
 *
 * 刷新时机：
 * - observe：工具结果落位（hostTool execute 统一调）——注册（bash 带 taskId）、
 *   退出（task_output running:false / task_stop）；
 * - refresh（轮边界）：对运行中任务逐个向宿主探一次 task_output，把「任务在
 *   模型工作期间自己退出了」的状态带回来——退出实时可见，不需要宿主→sidecar
 *   的推送通道（探测是普通 host RPC，本地开销可忽略；只在有运行中任务时发生）。
 *
 * 会话切换/刷新的水合走 get_bg_tasks（sessions.ts handler，与 get_todo_state
 * 同款形态）。台账是旁路：任何解析/探测失败记日志后跳过，绝不影响工具结果
 * 与回合主流程。
 */
import { hostToolCall } from "../storage/hostdb";
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
    reg.set(taskId, {
      taskId,
      command: command || existing?.command || "",
      source,
      startedAt: existing?.startedAt ?? Date.now(),
      // 注册即运行中：宿主两条后台路径（显式 runInBackground / 超时转后台）的
      // 返回都不带 running 字段或带 true——能用 taskId 注册就说明进程活着。
      // 用 !== false 而不是 === true，否则显式后台任务被记成已结束（徽标不亮）。
      running: data.running !== false,
      exitCode: typeof data.exitCode === "number" ? data.exitCode : null,
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
 * 轮边界探测（P1）：对运行中任务逐个向宿主查 task_output，把期间自行退出的
 * 状态带回来。只在有运行中任务时发 RPC；全部失败静默（下一轮再探）。
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
      // 任务可能已被宿主回收（reaped）：视作退出，避免徽标永远挂着
      logErr(`bg-tasks: probe task ${task.taskId} failed:`, error);
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

/** 清空某线程台账（测试隔离用） */
export function resetBgTasksForTest(threadId?: string): void {
  if (threadId) {
    registries.delete(threadId);
    cwds.delete(threadId);
  } else {
    registries.clear();
    cwds.clear();
  }
}
