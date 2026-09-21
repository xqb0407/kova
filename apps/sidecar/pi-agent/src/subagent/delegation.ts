/**
 * 委派注册表与活动流（面板可观测性）+ 收敛原语。
 *
 * delegate 的内部过程不进父转录，但归一化成 SubagentActivityItem 后：
 * - 进 DelegationRecord.activity（内存环形缓冲，get_subagent_activity 快照读它）
 * - 以无 id 通知行 {type:"subagent_activity", delegationId, item} 广播
 *   （宿主原样转发，同 turn_changed；父 turn 已结束后台委派仍在跑也送达）
 * Task 工具组见 tools.ts，delegate 执行循环见 run.ts。
 */
import { send } from "../protocol/stream";
import type {
  DelegationRecord,
  Running,
  SubagentActivityItem,
  SubagentRunResult,
  SubagentRunStatus,
} from "../types";

export const SUBAGENT_TOOL_NAME = "Task";
/** 收敛运行中的委派并读取报告 */
export const SUBAGENT_WAIT_TOOL_NAME = "TaskWait";
/** 不等待、只汇报会话内的委派状态 */
export const SUBAGENT_LIST_TOOL_NAME = "TaskList";
/** 停止运行中的委派 */
export const SUBAGENT_STOP_TOOL_NAME = "TaskStop";

/** 报告是唯一进入父代理上下文的内容，别让它变成委派本想避免的上下文问题 */
export const MAX_SUBAGENT_REPORT_CHARS = 12_000;
/** 单会话并发委派上限 */
export const MAX_SUBAGENT_CONCURRENCY = 8;
/** 已完成委派记录的保留上限（最旧的先丢弃，running 永不丢弃） */
const MAX_RETAINED_DELEGATIONS = 50;
/** 活动缓冲上限：满时优先丢最旧的 thinking/text 增量（结构事件永不主动丢） */
export const MAX_ACTIVITY_ITEMS = 400;

/* ----------------------- 运行活动流（面板可观测性） -----------------------
 * delegate 的内部过程不进父转录，但归一化成 SubagentActivityItem 后：
 * - 进 DelegationRecord.activity（内存环形缓冲，get_subagent_activity 快照读它）
 * - 以无 id 通知行 {type:"subagent_activity", delegationId, item} 广播
 *   （宿主原样转发，同 turn_changed；父 turn 已结束后台委派仍在跑也送达）
 */

/** delegationId -> 记录（全局索引：delegationId 是 uuid，快照查询不必先定位会话） */
const delegationIndex = new Map<string, DelegationRecord>();

/** 委派进全局索引（Task 启动时调用；快照查询与 prune 清理共用同一份） */
export function registerDelegation(record: DelegationRecord): void {
  delegationIndex.set(record.delegationId, record);
}

/** 活动条目入缓冲（超限先丢最旧的增量项）并广播通知行 */
export function pushActivity(record: DelegationRecord, item: SubagentActivityItem): void {
  const buf = record.activity;
  if (buf.length >= MAX_ACTIVITY_ITEMS) {
    const dropAt = buf.findIndex(
      (x) => (x.kind === "thinking" || x.kind === "text") && x.op === "delta",
    );
    buf.splice(dropAt >= 0 ? dropAt : 0, 1);
  }
  buf.push(item);
  send({ type: "subagent_activity", delegationId: record.delegationId, item });
}

/** 工具参数的一行摘要（面板工具行展示用）：取首个有值的常见目标字段 */
export function summarizeToolArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "description"]) {
    const v = a[key];
    if (typeof v === "string" && v.trim()) {
      const line = v.trim().split("\n")[0]!;
      return line.length > 100 ? `${line.slice(0, 100)}…` : line;
    }
  }
  return undefined;
}

/** 快照应答载荷（protocol.ts get_subagent_activity 用） */
export function getDelegationSnapshot(delegationId: string):
  | {
      record: {
        /** 规范全量 id：前端按 ≥4 位前缀查询时据此把别名条目迁回正式键 */
        delegationId: string;
        agentName: string;
        description?: string;
        status: SubagentRunStatus;
        startedAt: number;
        completedAt?: number;
        turns: number;
        toolCalls: number;
        report?: string;
      };
      items: SubagentActivityItem[];
    }
  | undefined {
  let record = delegationIndex.get(delegationId);
  if (!record && delegationId.length >= 4) {
    // 短 id（Task 结果里给模型/用户看的 8 位前缀）同样可查，同 findDelegation 语义
    for (const [id, r] of delegationIndex) {
      if (id.startsWith(delegationId)) {
        record = r;
        break;
      }
    }
  }
  if (!record) return undefined;
  return {
    record: {
      delegationId: record.delegationId,
      agentName: record.agentName,
      description: record.description,
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      turns: record.turns,
      toolCalls: record.toolCalls,
      report: record.result?.report,
    },
    items: [...record.activity],
  };
}

/** 超长报告保留头尾、中间截断 */
export function boundedReport(value: string): string {
  const text = value.trim();
  if (text.length <= MAX_SUBAGENT_REPORT_CHARS) return text;
  const marker = "\n\n[subagent report truncated]\n\n";
  const available = MAX_SUBAGENT_REPORT_CHARS - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

/** "provider/modelId" → { provider, modelId }（首个 "/" 分隔） */
export function parseModelKey(key: string): { provider: string; modelId: string } | undefined {
  const idx = key.indexOf("/");
  if (idx <= 0 || idx === key.length - 1) return undefined;
  return { provider: key.slice(0, idx), modelId: key.slice(idx + 1) };
}

/** 运行中的委派记录 */
export function runningDelegations(run: Running): DelegationRecord[] {
  return [...run.delegations.values()].filter((r) => r.status === "running");
}

/** 结算一次委派并唤醒所有等待它的 TaskWait */
export function settleDelegation(
  run: Running,
  record: DelegationRecord,
  result: SubagentRunResult,
): void {
  if (record.status !== "running") return;
  record.status =
    record.stopRequested && result.status === "aborted" ? "stopped" : result.status;
  record.result = result;
  record.turns = result.turns;
  record.toolCalls = result.toolCalls;
  record.completedAt = Date.now();
  pushActivity(record, {
    kind: "status",
    status: record.status,
    turns: record.turns,
    toolCalls: record.toolCalls,
    report: result.report,
    at: record.completedAt,
  });
  record.resolveCompletion();
  pruneFinishedDelegations(run);
}

/** 已完成记录超上限时丢弃最旧的；running 永不丢弃 */
function pruneFinishedDelegations(run: Running): void {
  const finished = [...run.delegations.values()]
    .filter((r) => r.status !== "running")
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
  const excess = finished.length - MAX_RETAINED_DELEGATIONS;
  for (const record of finished.slice(0, Math.max(0, excess))) {
    run.delegations.delete(record.delegationId);
    delegationIndex.delete(record.delegationId);
  }
}

/** 单行进度描述（TaskList 与等待心跳共用） */
export function delegationHeartbeat(record: DelegationRecord): string {
  const end = record.completedAt ?? Date.now();
  const secs = Math.max(0, Math.round((end - record.startedAt) / 1000));
  const id = record.delegationId.slice(0, 8);
  return record.status === "running"
    ? `${record.agentName} (${id}): running ${secs}s`
    : `${record.agentName} (${id}): ${record.status} after ${secs}s`;
}

/**
 * 生成给父代理的恢复 prompt：所有尚未投递的已结算报告 + 仍在运行的进度行。
 * 没有可投递内容时返回空串（调用方据此退出收敛循环）。投递过的记录就地标记。
 */
export function delegationResumeText(run: Running): string {
  const settled = [...run.delegations.values()]
    .filter((r) => r.status !== "running" && r.result && !r.reportedToParent)
    .sort((a, b) => a.startedAt - b.startedAt);
  if (settled.length === 0) return "";
  for (const record of settled) record.reportedToParent = true;
  const still = runningDelegations(run).sort((a, b) => a.startedAt - b.startedAt);
  const reports = settled
    .map(
      (r) =>
        `[${r.agentName} (delegation ${r.delegationId.slice(0, 8)}, ${r.status})]\n${r.result!.report}`,
    )
    .join("\n\n");
  const heartbeat = still.length
    ? `Still running:\n${still.map(delegationHeartbeat).join("\n")}`
    : "";
  return [
    "Background subagents you started with Task have finished. Their reports follow. Use them to continue your work; do not re-delegate the same tasks.",
    reports,
    heartbeat,
  ]
    .filter((part) => part.trim())
    .join("\n\n");
}

/** 等到 targetCompleted 条记录结算、或超时/中止；返回是否超时或被中止 */
export function waitForDelegations(
  targets: readonly DelegationRecord[],
  targetCompleted: number,
  deadline: number | null,
  signal?: AbortSignal,
): Promise<boolean> {
  const settledCount = () => targets.filter((r) => r.status !== "running").length;
  if (settledCount() >= targetCompleted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (timedOut: boolean) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(timedOut);
    };
    const check = () => {
      if (settledCount() >= targetCompleted) finish(false);
    };
    for (const record of targets) {
      if (record.status === "running") record.completion.then(check);
    }
    const onAbort = () => finish(true);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer =
      deadline === null
        ? undefined
        : setTimeout(() => finish(true), Math.max(0, deadline - Date.now()));
  });
}
