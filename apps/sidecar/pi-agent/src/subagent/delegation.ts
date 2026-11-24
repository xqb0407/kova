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
import { SUBAGENT_MAX_CONCURRENCY_DEFAULT } from "pi-protocol";
import { buildSubagentItem } from "../inbox/items";
import { upsertInboxItem } from "../inbox/store";
import type {
  DelegationRecord,
  Running,
  SubagentActivityItem,
  SubagentRunResult,
  SubagentRunStatus,
} from "../types";
import {
  appendDelegationActivity,
  appendDelegationTranscript,
  findActivityFileId,
  openDelegationActivity,
  pruneActivityFiles,
  readDelegationActivity,
} from "./activity-store";

export const SUBAGENT_TOOL_NAME = "Task";
/** 收敛运行中的委派并读取报告 */
export const SUBAGENT_WAIT_TOOL_NAME = "TaskWait";
/** 不等待、只汇报会话内的委派状态 */
export const SUBAGENT_LIST_TOOL_NAME = "TaskList";
/** 停止运行中的委派 */
export const SUBAGENT_STOP_TOOL_NAME = "TaskStop";
/** 给委派发消息（running=插话下轮消费；finished=resume 续聊） */
export const SUBAGENT_MESSAGE_TOOL_NAME = "SendMessage";

/** 报告是唯一进入父代理上下文的内容，别让它变成委派本想避免的上下文问题 */
export const MAX_SUBAGENT_REPORT_CHARS = 12_000;
/** 默认单会话并发委派上限；运行期以设置页为准（见 subagent/settings.ts） */
export const DEFAULT_SUBAGENT_CONCURRENCY = SUBAGENT_MAX_CONCURRENCY_DEFAULT;
/** @deprecated 运行时上限改用 getSubagentMaxConcurrency()；保留别名兼容旧引用 */
export const MAX_SUBAGENT_CONCURRENCY = DEFAULT_SUBAGENT_CONCURRENCY;
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

/** 委派进全局索引（Task 启动时调用；快照查询与 prune 清理共用同一份）。
 *  同时开启活动落盘（meta 先行）——sidecar 重启后据此回读。 */
export function registerDelegation(record: DelegationRecord): void {
  delegationIndex.set(record.delegationId, record);
  openDelegationActivity(record);
}

/** 活动条目入缓冲（超限先丢最旧的增量项）并广播通知行；同时边干边落盘 */
export function pushActivity(record: DelegationRecord, item: SubagentActivityItem): void {
  const buf = record.activity;
  if (buf.length >= MAX_ACTIVITY_ITEMS) {
    const dropAt = buf.findIndex(
      (x) => (x.kind === "thinking" || x.kind === "text") && x.op === "delta",
    );
    buf.splice(dropAt >= 0 ? dropAt : 0, 1);
  }
  buf.push(item);
  appendDelegationActivity(record.delegationId, item);
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

/**
 * write/edit 的结构化文件路径：产物卡只认路径，不要从 100 字符截断的
 * argsSummary 里再解析。其他工具（bash/MCP/插件）不返回。
 */
export function toolFilePath(
  toolName: string,
  args: unknown,
): string | undefined {
  if (toolName !== "write" && toolName !== "edit") return undefined;
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  const value = a.file_path ?? a.path;
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

/**
 * 从磁盘活动文件重建一个委派记录（内存未命中时调用）。
 * 无终态记录的委派由 readDelegationActivity 判为 interrupted——进程没了、没跑完。
 * 重建项只服务回放：completion 立即 resolve、abort 为 no-op，不参与执行链。
 */
function restoreDelegation(idOrPrefix: string): DelegationRecord | undefined {
  const fileId = findActivityFileId(idOrPrefix);
  if (!fileId) return undefined;
  const restored = readDelegationActivity(fileId);
  if (!restored) return undefined;
  const r = restored.record;
  const record: DelegationRecord = {
    delegationId: r.delegationId,
    agentName: r.agentName,
    modelId: r.modelId,
    status: r.status,
    ...(r.description ? { description: r.description } : {}),
    ...(r.externalResponseId ? { externalResponseId: r.externalResponseId } : {}),
    activity: restored.items,
    stopRequested: false,
    startedAt: r.startedAt,
    ...(r.completedAt !== undefined ? { completedAt: r.completedAt } : {}),
    turns: r.turns,
    toolCalls: r.toolCalls,
    ...(r.report
      ? {
          result: {
            agentName: r.agentName,
            modelId: r.modelId,
            status: r.status,
            report: r.report,
            turns: r.turns,
            toolCalls: r.toolCalls,
          } satisfies SubagentRunResult,
        }
      : {}),
    reportedToParent: true,
    ...(restored.history?.length ? { history: restored.history } : {}),
    ...(restored.record.ownerSession ? { ownerSession: restored.record.ownerSession } : {}),
    completion: Promise.resolve(),
    resolveCompletion: () => {},
    abort: () => {},
  };
  delegationIndex.set(record.delegationId, record);
  return record;
}

/**
 * 全局查一条委派记录（协议 handler 用；工具走会话内的 findDelegation）。
 * 完整 id 或 ≥4 位前缀；内存未命中回读磁盘（重启/裁剪后仍可寻址，回放的
 * 记录 completion 立即 resolve、abort no-op——只服务 resume/回放，不参与执行链）。
 */
export function findDelegationRecord(idOrPrefix: string): DelegationRecord | undefined {
  if (idOrPrefix.length < 4) return undefined;
  for (const r of delegationIndex.values()) {
    if (r.delegationId.startsWith(idOrPrefix)) return r;
  }
  return restoreDelegation(idOrPrefix);
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
        /** 终态且留有存档历史 = 可以 resume 续聊 */
        canResume: boolean;
        /** 本轮运行起点（resume 标记时间）；缺省 = 初次 Task 的 startedAt */
        activeSince?: number;
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
  // 内存未命中 → 回读磁盘（sidecar 重启/记录被裁后仍能回放；无文件则保持 undefined）
  if (!record) record = restoreDelegation(delegationId);
  if (!record) return undefined;
  // resume 后的本轮起点：面板用时按本轮算，不把上一轮/上几天的时长算进来。
  // 只在最后一条 status 是 running（resume 标记）时给出；初次 Task 没有标记。
  let activeSince: number | undefined;
  if (record.status === "running") {
    for (let i = record.activity.length - 1; i >= 0; i--) {
      const item = record.activity[i]!;
      if (item.kind !== "status") continue;
      if (item.status === "running") activeSince = item.at;
      break;
    }
  }
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
      // 面板只能按记录里的 ownerSession 物化父会话：老记录即使有历史，
      // 缺这个字段也无法从面板续聊，输入行应直接禁用而不是发送后才报错。
      canResume:
        record.status !== "running" &&
        (record.history?.length ?? 0) > 0 &&
        record.ownerSession !== undefined,
      ...(activeSince !== undefined ? { activeSince } : {}),
    },
    // 状态条目不回放进 items：快照 record 的 status/report/turns/toolCalls
    // 才是权威值。回放旧 status 会把磁盘上已判 interrupted 的记录重新翻成
    // completed（上一轮的终态）或 running（本轮 resume 标记），盖掉真实状态。
    items: record.activity.filter((item) => item.kind !== "status"),
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
  // 子代理的用量记到父 run 的目标账上：它的消耗不进父会话转录，不收在这里就永远看不到
  run.usagePending += result.tokens ?? 0;
  record.status =
    record.stopRequested && result.status === "aborted" ? "stopped" : result.status;
  record.result = result;
  record.turns = result.turns;
  record.toolCalls = result.toolCalls;
  record.completedAt = Date.now();
  // 会话历史存档（resume 的初始上下文）：先写 transcript 再发 status——
  // 反向顺序下进程若在两次刷盘之间被杀，会留下"已完成但没有历史"的记录。
  // archive 自身同步刷盘，保证 resume 数据绝不因节流丢失。
  if (record.archiveHistory) {
    const history = record.archiveHistory();
    if (history.length) {
      record.history = history;
      appendDelegationTranscript(record.delegationId, history);
    }
  }
  pushActivity(record, {
    kind: "status",
    status: record.status,
    turns: record.turns,
    toolCalls: record.toolCalls,
    report: result.report,
    canResume:
      (record.history?.length ?? 0) > 0 && record.ownerSession !== undefined,
    at: record.completedAt,
  });
  // Inbox 投影：只收终态；reportedToParent 是模型投递标记，不是用户已读
  const inboxItem = buildSubagentItem({
    delegationId: record.delegationId,
    agentName: record.agentName,
    status: record.status,
    ...(result.report ? { report: result.report } : {}),
    turns: record.turns,
    toolCalls: record.toolCalls,
    completedAt: record.completedAt,
    ...(record.ownerSession
      ? {
          sessionId: record.ownerSession.sessionId,
          threadId: record.ownerSession.threadId,
        }
      : {}),
  });
  // 用户主动停止的委派已经处理完，直接进历史；失败/完成仍需用户查看
  if (inboxItem) {
    upsertInboxItem(inboxItem, {
      markRead: record.status === "stopped" || record.status === "aborted",
    });
  }
  record.resolveCompletion();
  pruneFinishedDelegations(run);
  // 活动文件目录级清理（扫盘，跳过仍在跑的委派）
  pruneActivityFiles((id) => delegationIndex.get(id)?.status === "running");
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
    // 哨兵前缀（pi-protocol 单源判定）：这条注入以 user 角色落转录，UI 各路径
    // 按前缀隐藏——不带哨兵会在刷新后渲染成用户气泡（capability-reminder 同款泄漏）
    `[[subagent-report]] Background subagents you started with Task have finished. Their reports follow. Use them to continue your work; do not re-delegate the same tasks.`,
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
