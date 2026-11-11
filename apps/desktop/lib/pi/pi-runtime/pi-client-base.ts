"use client";

/**
 * PiClientBase：PiClient 契约的传输无关基座（react-pi 迁移阶段 5c）。
 *
 * DesktopPiClient（桌面）与 WsPiClient（远程网页）都是它的薄适配，只注入
 * 传输依赖（管理请求 / prompt 直发 / 中断 / 原始 NDJSON 行回流 / 事件源换代），
 * 其余全部逻辑在此共享：
 * - 管理类方法走 request 通道（管理队列串行）；
 * - getThread 走 sidecar 命令 thread_snapshot（JSONL 转录 + 在飞 partial →
 *   PiThreadSnapshot，阶段 3c）；
 * - sendMessage 复用现有 pi_prompt（带 sessionId 定靶），不消费 AI SDK chunk 流；
 * - subscribe 完整实现（阶段 3b）：监听原始 NDJSON 行里的 thread_event 行
 *   （sidecar delta 化原生事件，计划 §3a），按 threadId 分流 + 在 accumulator
 *   上重建 partial 再 dispatch；快照权威兜底（订阅首帧 / 收尾帧 / 事件源换代）。
 *
 * 线程身份 = pi sessionId（metadata.id）：usePiRuntime 的 controller 以它为键，
 * sidecar 侧 prompt/abort 的 running 键同样用 sessionId，两端一致。
 */
import type { PiResponse, PiSessionSummary } from "@/lib/pi/pi-bridge";
import type { PiPromptAttachment } from "@/lib/pi/pi-channel";
import { parsePartialJsonObject } from "pi-runtime";
import {
  findRemoteProjectByPath,
  resolveRemoteTargetPayload,
  type RemoteTargetPayload,
} from "@/lib/workspace/remote-projects";
import { sessionModeSnapshot, fetchPlanningState } from "@/lib/pi/pi-session-mode";
import {
  goalAcceptanceModeForSend,
  goalDurationDraftForSend,
  goalTurnDraftForSend,
} from "@/lib/pi/pi-goal-limit-draft";
import {
  applyHistoryPending,
  removeResolvedInteraction,
} from "@/lib/pi/pi-interactions";
import { applyQuestionChunk, clearQuestions } from "@/lib/pi/pi-question";
import {
  applyToolApprovalChunk,
  clearToolApprovals,
} from "@/lib/pi/pi-tool-approval";
import { applyAskNeedsWorkChunk } from "@/lib/pi/pi-ask-needs-work";
import { applyPlanningChunk } from "@/lib/pi/pi-session-mode";
import { applyTodoChunk, fetchTodoState } from "@/lib/pi/pi-todo";
import { applyGoalChunk, fetchGoalState } from "@/lib/pi/pi-goal";
import { applyRetryChunk, clearRetryState } from "@/lib/pi/pi-retry-state";
import { refreshContextMirror } from "@/lib/pi/pi-context";
import { piResumableStorage } from "@/lib/pi/pi-resume-storage";
import { readLastThread, syncClearLastThread } from "@/lib/pi/pi-last-thread";
import {
  applyDelegationChunk,
  emitAgentEvent,
  focusPanelTabFor,
  focusPluginPanelFor,
  getCurrentPanelThreadId,
  refreshFileTree,
  resyncPiRunning,
} from "@/lib/host-effects";
import {
  getTurnTiming,
  scopedTurnKey,
  seedTurnTimings,
} from "@/lib/panels/turn-collapse";
import { extractPromptAttachments } from "@/lib/attachments/prompt-attachments";
import { setThreadTitle } from "@/lib/pi/pi-thread-titles";
import { getProjectId, getWorkspace } from "@/lib/workspace/workspace-store";
import {
  applySessionSummaries,
  piSessionCwdMap,
  piSessionProjectIdMap,
} from "@/lib/pi/pi-thread-adapter";
import {
  TurnCheckpointTracker,
  type TurnCheckpointObserver,
} from "./turn-checkpoints";
import {
  isAutoContinueMessage,
  isCapabilityReminderMessage,
  isGoalInternalMessage,
  type PendingInteraction,
  type QueueAttachment,
} from "pi-protocol";
import type {
  PiAgentMessage,
  PiAssistantMessageDelta,
  PiClearedQueue,
  PiClient,
  PiClientEvent,
  PiHostUiResponse,
  PiModelInfo,
  PiQueueEntry,
  PiImageContent,
  PiSendMessageInput,
  PiThinkingLevel,
  PiThreadMetadata,
  PiThreadSnapshot,
} from "./types";

/** thread_snapshot 应答载荷 */
type SnapshotReply = { type: "thread_snapshot"; snapshot: PiThreadSnapshot };

/** 原始 NDJSON 行的解析形状：thread_event 帧或带 requestId 的 chunk 帧 */
type WireMsg = {
  id?: string | null;
  chunk?: { type?: string };
  type?: string;
  sessionId?: string;
  eventSeq?: number;
  event?: Record<string, unknown>;
  /** 顶层错误帧（网关转发失败/认证类）的说明文本 */
  errorText?: string;
};

/** 每线程流式重建 accumulator：sidecar 只发 delta（O(n²) wire 治理），
 *  客户端就地补丁出完整 partial 再 dispatch（reducer 的 message_update
 *  消费完整 message，见 threadState.ts）。 */
type StreamAcc = {
  message: Record<string, unknown> & { content?: unknown[] };
  /** toolcall_delta 的参数 JSON 串缓冲（按 contentIndex；toolcall_end 整体替换） */
  args: Map<number, string>;
};

/** 工具参数预览缓冲上限：只需要取出 file_path/command 这类前置字段；write
 *  正文可达 MB 级，整段攒下来既浪费内存，字符串 += 还会退化成 O(n²)。
 *  超限后停止缓冲——toolcall_end 带完整参数整体替换，预览缺失不影响正确性。 */
const MAX_PARTIAL_ARGS_BYTES = 64 * 1024;

/** delta → partial 重建（计划 §3b）：按 contentIndex 在 accumulator 上就地
 *  补丁——text/thinking 追加、toolcall 参数缓冲（end 帧整体替换）、done/error
 *  用终态消息整体替换。start 变体无内容可补。 */
function applyStreamDelta(
  acc: StreamAcc,
  e: Record<string, unknown> & {
    type?: string;
    contentIndex?: number;
    delta?: string;
    content?: string;
    toolCall?: Record<string, unknown>;
    message?: Record<string, unknown>;
    error?: Record<string, unknown>;
  },
): void {
  if (!Array.isArray(acc.message.content)) acc.message.content = [];
  const blocks = acc.message.content as Record<string, unknown>[];
  const i = e.contentIndex ?? -1;
  const ensure = (init: Record<string, unknown>): Record<string, unknown> => {
    let block = blocks[i];
    if (!block || block.type !== init.type) {
      block = { ...init };
      blocks[i] = block;
    }
    return block;
  };
  switch (e.type) {
    case "text_start":
      ensure({ type: "text", text: "" });
      break;
    case "text_delta":
      (ensure({ type: "text", text: "" }) as { text: string }).text += e.delta ?? "";
      break;
    case "text_end":
      (ensure({ type: "text", text: "" }) as { text: string }).text = e.content ?? "";
      break;
    case "thinking_start":
      ensure({ type: "thinking", thinking: "" });
      break;
    case "thinking_delta":
      (ensure({ type: "thinking", thinking: "" }) as { thinking: string }).thinking +=
        e.delta ?? "";
      break;
    case "thinking_end":
      (ensure({ type: "thinking", thinking: "" }) as { thinking: string }).thinking =
        e.content ?? "";
      break;
    case "toolcall_start":
      ensure({
        type: "toolCall",
        id: (e.toolCall as { id?: string } | undefined)?.id ?? "",
        name: (e.toolCall as { name?: string } | undefined)?.name ?? "",
        arguments: {},
      });
      acc.args.set(i, "");
      break;
    case "toolcall_delta": {
      const block = blocks[i];
      if (!block || block.type !== "toolCall") break;
      const args = block.arguments;
      const filled =
        args != null &&
        typeof args === "object" &&
        !Array.isArray(args) &&
        Object.keys(args).length > 0;
      // 预览字段已拿到（或没有 toolcall_start 可补）：不再缓冲正文。
      if (filled) break;
      const prev = acc.args.get(i) ?? "";
      if (prev.length >= MAX_PARTIAL_ARGS_BYTES) break;
      const buffer = `${prev}${e.delta ?? ""}`;
      // 只补第一次解析出的完整字段（通常是 file_path/command）；一旦拿到就
      // 立即释放缓冲，后续长正文不再进内存。最终仍以 toolcall_end 的整体
      // 替换为权威值。
      const partial = parsePartialJsonObject(buffer);
      if (partial) {
        block.arguments = partial;
        acc.args.delete(i);
      } else {
        acc.args.set(i, buffer);
      }
      break;
    }
    case "toolcall_end":
      if (e.toolCall) blocks[i] = e.toolCall;
      acc.args.delete(i);
      break;
    case "done":
      if (e.message) acc.message = e.message as StreamAcc["message"];
      break;
    case "error":
      if (e.error) acc.message = e.error as StreamAcc["message"];
      break;
  }
}

/** 传输依赖（构造注入）：桌面 = 桌面壳 invoke/event，远程 = WebSocket 通道。 */
/** 显式改过才带这些字段（见 pi-goal-limit-draft 的分层说明） */
function sendGoalCreationPrefs(threadId: string): {
  goalMaxAutoTurns?: number;
  goalAcceptanceMode?: "auto" | "manual" | "skip";
  goalMaxDurationMinutes?: number;
} {
  const turns = goalTurnDraftForSend(threadId);
  const mode = goalAcceptanceModeForSend(threadId);
  const duration = goalDurationDraftForSend(threadId);
  return {
    ...(turns === undefined ? {} : { goalMaxAutoTurns: turns }),
    ...(mode === undefined ? {} : { goalAcceptanceMode: mode }),
    ...(duration === undefined ? {} : { goalMaxDurationMinutes: duration }),
  };
}

export type PiClientTransport = {
  /** 管理类请求-响应（error 应答归一为异常，语义同 piRequest） */
  request<T extends PiResponse>(
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
  /** 发起 prompt：fire-and-forget，chunk/thread_event 行经 watchLines 回流 */
  sendPrompt(args: {
    requestId: string;
    text: string;
    threadId: string;
    cwd: string | null;
    /** 远程项目绑定：cwd 命中远程项目时携带（草稿会话在 sidecar 侧补绑） */
    remote?: RemoteTargetPayload | null;
    attachments: PiPromptAttachment[] | null;
    steer: boolean;
    /** goal 档建目标时随首条消息带过去的轮次上限（0 = 不限；非 goal 档不发） */
    goalMaxAutoTurns?: number;
    /** goal 档建目标时的验收标准启动模式（显式改过才带） */
    goalAcceptanceMode?: "auto" | "manual" | "skip";
    /** goal 档建目标时的时长上限（分钟；0 = 不限；显式改过才带） */
    goalMaxDurationMinutes?: number;
  }): Promise<void>;
  /** 中断线程的运行轮 */
  abort(threadId: string): Promise<void>;
  /** 订阅原始 sidecar NDJSON 行（批量事件逐行回调）；返回退订 */
  watchLines(cb: (raw: string) => void): Promise<() => void>;
  /** 事件源换代（sidecar 退出 / WS 断开+重连 authed）：基座清流式台账并
   *  逐订阅线程拉快照自愈；同一 cb 可能被多次调用 */
  watchGeneration(cb: () => void): Promise<() => void>;
  /** 声明本窗口在看的会话（桌面壳据此把后台会话的逐 token 增量挡在主进程，
   *  不跨进程送过来）；可缺省——远程 WS 通道不做窗口级裁剪 */
  watchSessions?(sessionIds: string[]): void;
};

/** queue_update 事件里的排队 reqId 集合（两条车道都算；条目 id = 真实 reqId，
 *  与 inflight 台账同键）。 */
const queuedRequestIdsOf = (body: Record<string, unknown>): Set<string> => {
  const ids = new Set<string>();
  for (const lane of ["steering", "followUp"] as const) {
    const entries = body[lane];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const id = (entry as { id?: unknown } | null)?.id;
      if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
};

export class PiClientBase implements PiClient {
  private readonly listeners = new Map<string, Set<(e: PiClientEvent) => void>>();
  /** 每线程上次派发 seq（快照/事件共用 per-session 号段） */
  private readonly lastSeq = new Map<string, number>();
  /** 快照指纹（去重防抖动；订阅首帧 force 绕过） */
  private readonly stamps = new Map<string, string>();
  /** 流式重建台账（message_start 建、message_end/agent_end 清） */
  private readonly streams = new Map<string, StreamAcc>();
  /** 在飞 prompt requestId → sessionId（收尾帧触发即时快照刷新：
   *  prompt 起跑前失败等不走 agent 事件的路径的兜底，阶段 5 随 chunk 流退役） */
  private readonly inflight = new Map<string, string>();
  /** 最近快照里的排队请求 id：agent_end 收尾时区分「仍在队列」与「已结束/丢失」，
   *  避免重连后重发命中去重的 prompt 永远占着 inflight 台账 */
  private readonly queuedIds = new Map<string, Set<string>>();
  /** 每会话最近一次发起的 prompt requestId（sessionId → requestId）：检查点
   *  条目所有权层的回合键（checkpoint_status 按它查，见 lib/pi/pi-edits.ts）。
   *  跨轮驻留语义与 lastPrompts 相同——排队项在派发时才开轮，但 agent_start
   *  一定晚于其 sendMessage 登记，取"最近发起"与"正在跑"在该路径同值；
   *  steer 并入当前轮不改写（轮键保持首轮，卡片按首轮查）。会话删除时摘除。 */
  private readonly sessionTurn = new Map<string, string>();
  /** 每会话最近一次发送的 prompt **摘要**（完成提醒正文用，消费方只取前
   *  120 字符，存 200 留余量——整段原文驻留是白花的内存）；仅本实例发起的
   *  会话入表——automation/他窗发起的 turn 不在表内，不重复提醒（旧链路同
   *  语义）。跨轮驻留（重试路径不再经 sendMessage 重登记），会话删除时摘除
   *  （deleteThread）。 */
  private readonly lastPrompts = new Map<string, string>();
  /** prompt 起跑通知台账（sessionId → 监听者）：start 帧是「这条消息真的
   *  开跑了」的权威信号，控制器据此摘掉本地乐观队列条目（见 onPromptStart） */
  private readonly promptStartListeners = new Map<
    string,
    Set<(requestId: string) => void>
  >();
  /** prompt 终结通知台账（sessionId → 监听者）：finish/error 帧是「这条
   *  prompt 不会再回显了」的权威信号，控制器据此撤掉起跑时上屏的乐观消息
   *  （见 onPromptEnd） */
  private readonly promptEndListeners = new Map<
    string,
    Set<(requestId: string) => void>
  >();
  /** 检查点卡观察者（缺口2）：agent_start 打影子仓库快照、agent_end 结算。
   *  默认实现走 turn-checkpoints 的真实依赖；测试可注入记录型假件 */
  private readonly checkpoints: TurnCheckpointObserver;
  private unlistenLines: (() => void) | null = null;
  /** ensureEventWatcher 的在飞注册锁（防同 tick 双监听，见该方法注释） */
  private eventWatcher: Promise<void> | null = null;
  /** 上次上报给桌面壳的观看集合指纹（只在集合真变时发命令） */
  private watchedKey = "";

  constructor(
    private readonly transport: PiClientTransport,
    checkpoints?: TurnCheckpointObserver,
  ) {
    this.checkpoints =
      checkpoints ??
      new TurnCheckpointTracker({
        fetchSnapshot: (sessionId) =>
          this.fetchSnapshot(sessionId).catch(() => undefined),
      });
  }

  // ---------- 快照 ----------

  private async fetchSnapshot(sessionId: string): Promise<PiThreadSnapshot> {
    const res = await this.transport.request<SnapshotReply & PiResponse>({
      type: "thread_snapshot",
      sessionId,
    });
    // 耗时台账播种放在这条**唯一汇聚点**：refreshNow 派发路径之外，controller
    // .load() 的冷读（空闲线程从不 connect → 不订阅 → 不派发；刷新页面/切换
    // 会话正是这条路径）也只在这拿快照——播种若只挂 dispatch，空闲装载后全部
    // 轮次时长缺失、摘要行退回「X 条较早消息」（2026-10-02 修复）。同一份快照
    // 会经 refreshNow→dispatch 再播一次，由等值跳过兜住，无 notify 风暴。
    this.seedHistoryTurnTimings(res.snapshot);
    return res.snapshot;
  }

  /** 快照指纹：seq/状态/条数/末条时间戳/挂起审批数/排队数/权威工时——任一变化
   *  才派发，防每秒抖动（4a：排队条目入指纹，快照采纳恢复的队列能触发派发；
   *  turn_timing 行不占 seq，必须单独入指纹，否则收尾快照可能被判为未变化） */
  private static fingerprint(s: PiThreadSnapshot): string {
    const last = s.messages.at(-1) as { timestamp?: number } | undefined;
    return [
      s.seq ?? "-",
      s.metadata.status,
      s.messages.length,
      last?.timestamp ?? "-",
      s.hostUiRequests?.length ?? 0,
      s.hostUiRequests?.[0]?.id ?? "",
      s.metadata.queuedMessages?.length ?? 0,
      s.metadata.queuedMessages?.[0]?.id ?? "",
      s.metadata.turnTimings?.length ?? 0,
      s.metadata.turnTimings?.at(-1)?.endedAt ?? "-",
    ].join("|");
  }

  /**
   * 历史轮耗时播种（取代旧链路 loadPiHistory→seedHistoryTurnTimings——该路径
   * 随阶段 5b 退役，导致所有历史轮 durationMs 缺失、摘要行退回计数文案）。
   * 调用点：fetchSnapshot（唯一快照汇聚点）——2026-10-02 从 dispatch 下沉，
   * 覆盖 controller.load() 的冷读（空闲线程从不 connect/派发，刷新与切会话
   * 正是这条路径，此前时长全缺失）。
   *
   * 两级来源：
   *  1. 权威：sidecar 转录里的 turn_timing 行（快照 metadata.turnTimings）——
   *     轮收尾时由后端写下的真实起止，覆盖本地推导值。
   *  2. 兜底：旧转录没有 turn_timing 行时，用转录行时间戳推导：user 行做轮锚
   *     （轮次键 = 投影稳定 id `pi-msg:${seq}`，与 message-turns 的 turnKey
   *     同值），开始 = user 行 timestamp，结束 = 轮内最后一条非 user 行的
   *     timestamp。刚开始、还没有助手行的最新轮只给开始（live），结束交给
   *     轮收尾打点。
   * 跳过：锚行无 seq（在飞未落盘，轮次键无从预测）；时间戳兜底遇到台账已有
   * live:true 条目（本窗口盯着跑的轮由 Date.now 计时，更准）；值相等
   * （store.set 无条件 notify，快照反复派发不能引发重渲风暴）。
   */
  private seedHistoryTurnTimings(snapshot: PiThreadSnapshot): void {
    type SeedableLine = {
      role?: string;
      content?: unknown;
      __seq?: number;
      timestamp?: number;
    };
    const isInjectedUserLine = (line: SeedableLine): boolean =>
      isAutoContinueMessage(line) ||
      isGoalInternalMessage(line) ||
      isCapabilityReminderMessage(line);
    const threadId = snapshot.metadata.id;
    const threadRunning = snapshot.metadata.status === "running";
    let anchorSeq: number | undefined;
    let anchorTs: number | undefined;
    let endTs: number | undefined;
    // 逐轮写曾是「每写一次整表复制 + 全量 notify」，200 轮的会话首开就是
    // O(n²)；先收集再 seedTurnTimings 一次落账、一次通知
    const entries = new Map<
      string,
      { start: number; end?: number; live?: boolean; authoritative?: boolean }
    >();
    const sameTiming = (
      a: { start?: number; end?: number; live?: boolean; authoritative?: boolean } | undefined,
      b: { start: number; end?: number; live?: boolean; authoritative?: boolean },
    ) =>
      a?.start === b.start &&
      a?.end === b.end &&
      (a?.live === true) === (b.live === true) &&
      (a?.authoritative === true) === (b.authoritative === true);
    const put = (
      scoped: string,
      value: { start: number; end?: number; live?: boolean; authoritative?: boolean },
    ) => {
      if (sameTiming(getTurnTiming(scoped), value)) {
        // 权威值已与台账一致：撤销本轮可能暂存的时间戳候选，别让它反向覆盖
        entries.delete(scoped);
        return;
      }
      if (sameTiming(entries.get(scoped), value)) return;
      entries.set(scoped, value);
    };
    const flush = (isLast: boolean) => {
      if (anchorSeq === undefined || anchorTs === undefined) return;
      const scoped = scopedTurnKey(threadId, `pi-msg:${anchorSeq}`);
      const cur = getTurnTiming(scoped);
      // 权威条目与直播条目都不接受时间戳兜底（前者是后端事实，后者更准）
      if (cur?.live === true || cur?.authoritative === true) return;
      if (endTs !== undefined) {
        put(scoped, { start: anchorTs, end: endTs });
      } else if (isLast && threadRunning) {
        // 刚开始的轮（只有 user 行）：结束时刻还不存在，先记开始，
        // 由 TurnTimingRecorder 在轮收尾时补，权威行到达后再覆盖。
        put(scoped, { start: anchorTs, live: true });
      }
    };
    for (const line of snapshot.messages as unknown as SeedableLine[]) {
      if (line.role === "user") {
        // 内部注入的 user 行（日期/技能更新、auto-continue、goal 续跑）不是
        // 用户发起的轮次：整行跳过，既不抢锚也不污染上一轮的 endTs。
        if (isInjectedUserLine(line)) continue;
        flush(false);
        anchorSeq = line.__seq;
        anchorTs = line.timestamp;
        endTs = undefined;
        continue;
      }
      if (anchorSeq !== undefined && typeof line.timestamp === "number") {
        endTs = line.timestamp;
      }
    }
    flush(true);
    // 权威工时覆盖本地推导：已收尾的轮两端都以后端记录为准并打上 authoritative
    // （时间戳兜底从此让位）；运行中的轮（endedAt 缺失，前向兼容）只给开始，
    // 本地已补记的结束保留。
    for (const timing of snapshot.metadata.turnTimings ?? []) {
      const scoped = scopedTurnKey(threadId, `pi-msg:${timing.anchorSeq}`);
      if (typeof timing.endedAt === "number") {
        put(scoped, {
          start: timing.startedAt,
          end: timing.endedAt,
          authoritative: true,
        });
        continue;
      }
      const cur = getTurnTiming(scoped);
      if (cur?.end === undefined) {
        put(scoped, {
          start: timing.startedAt,
          live: true,
          authoritative: true,
        });
      } else if (cur.live === true && cur.start !== timing.startedAt) {
        put(scoped, { start: timing.startedAt, end: cur.end, live: true });
      }
    }
    if (entries.size > 0) seedTurnTimings(entries);
  }

  private dispatch(snapshot: PiThreadSnapshot) {
    const id = snapshot.metadata.id;
    const prevSeq = this.lastSeq.get(id) ?? 0;
    const snapSeq = snapshot.seq ?? 0;
    this.lastSeq.set(id, Math.max(prevSeq, snapSeq));
    this.queuedIds.set(
      id,
      new Set((snapshot.metadata.queuedMessages ?? []).map((m) => m.id)),
    );
    // 流式 accumulator 对齐（3b/3c 合缝）：running 且末条是 assistant → 以
    // 快照里的在飞 partial 为重建基底（线程中途打开时没有 message_start 可
    // 依赖）；陈旧快照（seq 落后于已流式状态）不回退基底
    const last = snapshot.messages.at(-1) as { role?: string } | undefined;
    if (snapshot.metadata.status === "running" && last?.role === "assistant") {
      if (snapSeq >= prevSeq || !this.streams.has(id)) {
        this.streams.set(id, {
          message: last as StreamAcc["message"],
          args: new Map(),
        });
      }
    } else {
      this.streams.delete(id);
    }
    const set = this.listeners.get(id);
    if (!set) return;
    const event: PiClientEvent = {
      type: "snapshot",
      snapshot,
      threadId: id,
      seq: snapshot.seq ?? 0,
    };
    for (const listener of set) {
      try {
        listener(event);
      } catch (err) {
        console.error("[PiClientBase] listener threw", err);
      }
    }
  }

  /** 拉一次快照并派发（订阅首帧 / 收尾帧 / 事件源换代共用）；
   *  force=true 绕过指纹去重（重订阅也要拿到初帧）。
   *  返回 false = 快照没取到（断线中/会话已删），换代水合据此跳过外围状态拉取，
   *  避免在离线时打一串注定超时的请求。 */
  private async refreshNow(sessionId: string, force = false): Promise<boolean> {
    try {
      const snapshot = await this.fetchSnapshot(sessionId);
      const stamp = PiClientBase.fingerprint(snapshot);
      if (!force && this.stamps.get(sessionId) === stamp) return true;
      this.stamps.set(sessionId, stamp);
      this.dispatch(snapshot);
      return true;
    } catch {
      // sidecar 不可用/会话已删：静默（重订阅/收尾帧会再触发）
      return false;
    }
  }

  /**
   * 换代后补外围状态：thread_snapshot 只覆盖消息/队列/审批，todo、goal、
   * 模式、上下文读数不在里面。断线期间这些状态若发生变化，重连后必须重拉一次，
   * 否则界面会一直停在断线前的旧值（直到用户切会话/刷新）。
   */
  private rehydrateSideState(threadId: string): void {
    try {
      fetchTodoState(threadId);
    } catch {
      /* 草稿/旧通道：跳过 */
    }
    void fetchGoalState(threadId).catch(() => {});
    void fetchPlanningState(threadId).catch(() => {});
    refreshContextMirror(threadId);
  }

  /** list_pending 权威拉取（4b 刷新恢复）：新链路 threadId 即 sessionId，必须
   *  带 sessionId 定址——sidecar threadSessions 的键是建会话时的随机 t，
   *  按 threadId 反查会落空。applyHistoryPending 幂等并入（与直播流按 id 去重），
   *  不用整表替换语义，防拉空时清掉直播流刚送的卡。 */
  private async pullPendingInteractions(threadId: string): Promise<void> {
    try {
      const res = await this.transport.request<
        Extract<PiResponse, { type: "pending" }>
      >({
        type: "list_pending",
        sessionId: threadId,
      });
      const items = Array.isArray(res.items)
        ? (res.items as PendingInteraction[])
        : [];
      applyHistoryPending(threadId, items);
    } catch {
      // sidecar 不可用/会话已删：静默（直播流与结算路径照常工作）
    }
  }

  // ---------- 事件路由（阶段 3b） ----------

  /** 事件源注册（幂等）。⚠ 必须 promise 锁收口：unlistenLines 要等
   *  transport.watchLines 的异步注册完成才有值，同一 tick 内两次进入
   *  （多线程序订阅并发、StrictMode 挂载-卸载-重挂、订阅+发送同帧）若只查
   *  空值会双双通过检查、各注册一份监听——桌面壳 listen 每次都是独立订阅，
   *  于是每行 NDJSON 喂两遍、流式 delta 应用两遍（文本成倍重复，终态整条
   *  替换后才恢复正常）。 */
  private ensureEventWatcher(): Promise<void> {
    if (this.unlistenLines) return Promise.resolve();
    if (!this.eventWatcher) {
      const registering = this.registerEventWatcher();
      this.eventWatcher = registering;
      // 注册失败不留锁：后续订阅/发送可重试（监听未成，无泄漏可言）
      registering.catch(() => {
        if (this.eventWatcher === registering) this.eventWatcher = null;
      });
    }
    return this.eventWatcher;
  }

  private async registerEventWatcher(): Promise<void> {
    const unlisten = await this.transport.watchLines((raw) =>
      this.handleWireLine(raw),
    );
    await this.transport.watchGeneration(() => this.handleGenerationChange());
    this.unlistenLines = unlisten;
  }

  /** 事件源换代：清重建台账，逐订阅线程拉快照自愈（空闲态 + 已落盘内容）。
   *  快照取到后再补拉 pending/todo/goal/模式/上下文（断线期间独立变化的状态
   *  不在这份快照里）；断线中的一次换代取快照必失败，自然跳过外围请求。 */
  private handleGenerationChange() {
    this.streams.clear();
    for (const sessionId of this.listeners.keys()) {
      void this.refreshNow(sessionId).then((ok) => {
        if (!ok) return;
        void this.pullPendingInteractions(sessionId);
        this.rehydrateSideState(sessionId);
      });
    }
  }

  /** session_info_changed 行 → 本地实时标题表（渲染侧优先于列表快照） */
  private applySessionInfoLine(raw: string) {
    let parsed: WireMsg;
    try {
      parsed = JSON.parse(raw) as WireMsg;
    } catch {
      return;
    }
    if (parsed.type !== "thread_event") return;
    const event = parsed.event;
    if (event?.type !== "session_info_changed") return;
    const name = event.name;
    setThreadTitle(
      String(parsed.sessionId ?? ""),
      typeof name === "string" ? name : undefined,
    );
  }

  private handleWireLine(raw: string) {
    // 会话标题单独一条捷径：列表快照的 title 只在整表 reload 时刷新，标题
    // 事件（智能标题/改名）必须即时透传才能让顶栏与侧边栏跟着变。放在
    // 「有无订阅者」早退之前，后台会话（定时任务等无订阅）的改名同样生效。
    if (raw.includes('"session_info_changed"')) this.applySessionInfoLine(raw);
    if (this.listeners.size === 0 && this.inflight.size === 0) return;
    // 预筛：thread_event 行（原生事件）+ finish/error/start 帧（收尾观察）
    // + data-* 旁路行（4b 交互卡 / 4c 委派 / 4d 模式与清单与面板唤起）；
    // 其余 token 级 chunk 行（AI SDK 遗留流）不解析
    const looksEvent = raw.includes('"thread_event"');
    const looksDelegation = raw.includes('"data-subagentDelegation"');
    const looksBypass =
      looksDelegation ||
      raw.includes('"data-toolApproval"') ||
      raw.includes('"data-question"') ||
      raw.includes('"data-interactionResolved"') ||
      raw.includes('"data-planningState"') ||
      raw.includes('"data-askNeedsWork"') ||
      raw.includes('"data-todo"') ||
      raw.includes('"data-goal-state"') ||
      raw.includes('"data-retry"') ||
      raw.includes('"data-panelOpen"') ||
      raw.includes('"data-pluginOpen"');
    if (
      !looksEvent &&
      !looksBypass &&
      !raw.includes('"finish"') &&
      !raw.includes('"error"') &&
      !raw.includes('"start"')
    ) {
      return;
    }
    let parsed: WireMsg;
    try {
      parsed = JSON.parse(raw) as WireMsg;
    } catch {
      return;
    }
    if (parsed.type === "thread_event") {
      if (looksEvent) {
        const sid = String(parsed.sessionId ?? "");
        const body = parsed.event ?? {};
        // 检查点卡（缺口2，迁移后接回）：agent_start 打影子仓库快照、
        // agent_end 结算 diff。只跟踪本窗口相关的会话——打开中的
        // （listeners）或本实例发起过 prompt 的（lastPrompts，覆盖后台
        // 线程）；subagent 等旁路会话两表皆无，不做影子快照
        if (body.type === "agent_start" || body.type === "agent_end") {
          if (this.listeners.has(sid) || this.lastPrompts.has(sid)) {
            if (body.type === "agent_start") {
              this.checkpoints.begin(sid, this.sessionTurn.get(sid) ?? null);
              // 排队项派发即见：引擎派发在 agent.prompt 落转录之后，
              // agent_start 拉一次快照把排队 user 消息补进列表（否则要
              // 等本轮 finish 帧才可见）；顺带自愈运行起点前的转录漂移
              void this.refreshNow(sid);
            } else {
              this.checkpoints.settle(sid);
              // 侧边栏运行集合种子纠偏（旧链路 finish 的 resyncPiRunning
              // 同语义）：补漏掉的 agent_end 增量，防 spinner 挂死
              resyncPiRunning();
            }
          }
        }
        // 完成提醒（缺口3，迁移后接回）：agent_end 收尾定调全局生效——
        // 不依赖该线程是否有订阅者，后台线程同样提醒（旧 transport 对齐）
        if (body.type === "agent_end") this.notifyTurnSettled(sid, body);
        this.routeThreadEvent(sid, Number(parsed.eventSeq ?? 0), body);
      }
      return;
    }
    // ---- 委派绑定（4c）：Task 工具启动瞬间随活跃请求流发出。旧链路靠
    // transport postTransform 拦同一 chunk；新链路在此拦截喂给
    // subagent-runs（旁路 chunk 不进消息流，绑定语义不变）
    const chunkData = parsed.chunk as
      | { type?: string; data?: unknown }
      | undefined;
    if (chunkData?.type === "data-subagentDelegation") {
      applyDelegationChunk(chunkData.data);
      return;
    }
    // ---- 交互卡（4b）：审批/提问/结算广播。旧链路靠 transport tap 拦同一
    // chunk；新链路在此喂 pi-interactions（台账键 = 线上 sessionId，与卡片
    // 组件的 mainThreadId 同一命名空间），chunk 不进消息流。正常结算由
    // resolved 帧移除卡片；abort/异常残留由 agent_end 兜底清空
    const sid = parsed.sessionId;
    if (sid) {
      if (chunkData?.type === "data-toolApproval") {
        applyToolApprovalChunk(sid, chunkData.data);
        return;
      }
      if (chunkData?.type === "data-question") {
        applyQuestionChunk(sid, chunkData.data);
        return;
      }
      if (chunkData?.type === "data-interactionResolved") {
        const d = chunkData.data as { interactionId?: unknown } | undefined;
        if (d && typeof d.interactionId === "string") {
          removeResolvedInteraction(sid, d.interactionId);
        }
        return;
      }
      // ---- 模式/切档提议/任务清单（4d）：同为 per-thread store 直更
      if (chunkData?.type === "data-planningState") {
        applyPlanningChunk(sid, chunkData.data);
        return;
      }
      if (chunkData?.type === "data-askNeedsWork") {
        applyAskNeedsWorkChunk(sid, chunkData.data);
        return;
      }
      if (chunkData?.type === "data-todo") {
        applyTodoChunk(sid, chunkData.data);
        return;
      }
      // ---- 目标状态（goal 档常驻条）：同为 per-thread store 直更
      if (chunkData?.type === "data-goal-state") {
        applyGoalChunk(sid, chunkData.data);
        return;
      }
      // ---- provider 重试（流尾倒计时行）：per-thread store 直更。
      // 行带 sessionId 盖章（sidecar sendEventChunk 第三参），无章行丢弃——
      // 老版 sidecar 的 data-retry 行没有 sessionId，键不了桶也不能乱挂
      if (chunkData?.type === "data-retry") {
        if (sid) applyRetryChunk(sid, chunkData.data);
        return;
      }
    }
    // ---- 面板唤起（4d）：browser_*/open_file/open_plugin_panel 发起的
    // UI 副作用（形状校验与 pi-transport tap 同款）。按帧属主定靶落桶：
    // sessionId 即分桶键（rekey 后一致），后台会话的工具不得写进用户正在
    // 看的会话；展开/刷新事件只在属主=当前显示时派发，否则静默落桶、
    // 切回属主会话时标签自然出现。
    if (chunkData?.type === "data-panelOpen") {
      const d = chunkData.data as
        | { type?: unknown; url?: unknown; path?: unknown; cwd?: unknown }
        | undefined;
      const owner = sid ?? getCurrentPanelThreadId();
      if (!owner) return;
      const displayed = owner === getCurrentPanelThreadId();
      if (d && d.type === "browser") {
        const url =
          typeof d.url === "string" && d.url ? { url: d.url } : undefined;
        focusPanelTabFor(owner, "browser", url);
        if (displayed) window.dispatchEvent(new Event("agent-panel:open"));
        return;
      }
      // 文件唤起（sidecar open-file-tool.ts）：文件 tab 磁盘实时模式；
      // focus:undefined 清掉该 tab 可能残留的 read/plan 快照上下文
      if (d && d.type === "file" && typeof d.path === "string" && d.path) {
        focusPanelTabFor(owner, "file", {
          cwd: typeof d.cwd === "string" && d.cwd ? d.cwd : undefined,
          path: d.path,
          focus: undefined,
        });
        if (displayed) window.dispatchEvent(new Event("agent-panel:open"));
      }
      return;
    }
    if (chunkData?.type === "data-pluginOpen") {
      const d = chunkData.data as
        | { plugin?: unknown; panel?: unknown; path?: unknown; cwd?: unknown }
        | undefined;
      const plugin = typeof d?.plugin === "string" && d.plugin ? d.plugin : "";
      const panel = typeof d?.panel === "string" && d.panel ? d.panel : "";
      if (d && plugin && panel) {
        const path = typeof d.path === "string" && d.path ? d.path : undefined;
        const cwd = typeof d.cwd === "string" && d.cwd ? d.cwd : undefined;
        const owner = sid ?? getCurrentPanelThreadId();
        if (!owner) return;
        // 不传 path/cwd 键 = 保留该 tab 现有文档绑定（纯唤起不清绑）；
        // 属主定靶同 data-panelOpen：后台会话静默落桶，不抢面板。
        // 刷新事件只在属主=显示会话时派发（视图挂载中才需要推文档）；
        // 否则 path/cwd 已写进 tab extra，属主会话重挂载时自取。
        focusPluginPanelFor(owner, plugin, panel, {
          ...(cwd ? { cwd } : {}),
          ...(path ? { path } : {}),
        });
        if (owner === getCurrentPanelThreadId()) {
          window.dispatchEvent(
            new CustomEvent("plugin-panel:refresh", {
              detail: { plugin, panel, path, cwd },
            }),
          );
          window.dispatchEvent(new Event("agent-panel:open"));
        }
      }
      return;
    }
    // ---- 收尾帧观察：finish/error 即时拉快照（起跑前失败兜底）----
    if (this.inflight.size === 0) return;
    const requestId = parsed.id;
    if (!requestId || !this.inflight.has(requestId)) return;
    const type = parsed.chunk?.type;
    // 起跑帧（start）：通知控制器「这条消息真的开跑了」。此前只观察 finish/error，
    // 控制器无从知道某条本地乐观队列条目其实没在服务端排队（空闲直接执行），
    // 那条幽灵永远等不到 queue_update 来清——气泡已渲染、队列条还挂着它。
    if (type === "start") {
      const sessionId = this.inflight.get(requestId)!;
      // 新轮开跑即清重试态：store 里最多允许残留到上一轮收尾（idle chunk 是
      // 主动清台，这里是被动的二道闸）
      clearRetryState(sessionId);
      for (const listener of this.promptStartListeners.get(sessionId) ?? []) {
        try {
          listener(requestId);
        } catch (err) {
          console.error("[PiClientBase] promptStart listener threw", err);
        }
      }
      return;
    }
    if (type === "finish" || type === "error") {
      const sessionId = this.inflight.get(requestId)!;
      this.inflight.delete(requestId);
      // 轮收尾清重试态：倒计时是纯直播呈现，结算后不留痕
      clearRetryState(sessionId);
      this.notifyPromptEnd(sessionId, requestId);
      // force：收尾帧是「本轮已结束」的权威信号，快照必须派发——指纹去重
      // 在这里会吞掉自愈（并入退化流等场景 live 的 agent_end 可能缺失，
      // 不强制刷新 runStatus 就永远停在 running，转圈/停止键永挂）
      void this.refreshNow(sessionId, true);
      return;
    }
    // 顶层错误帧（网关转发失败等，无 chunk）：同样终结该 prompt。先拉快照
    // 清掉乐观消息，再把失败原因写进线程错误位，避免消息无声消失。
    if (!type && parsed.type === "error") {
      const sessionId = this.inflight.get(requestId)!;
      this.inflight.delete(requestId);
      this.notifyPromptEnd(sessionId, requestId);
      const errorText =
        typeof parsed.errorText === "string" && parsed.errorText
          ? parsed.errorText
          : "消息发送失败";
      void this.refreshNow(sessionId, true).then(() => {
        const event = {
          type: "error",
          error: errorText,
          threadId: sessionId,
          seq: this.lastSeq.get(sessionId) ?? 0,
        } as PiClientEvent;
        for (const listener of this.listeners.get(sessionId) ?? []) {
          try {
            listener(event);
          } catch (err) {
            console.error("[PiClientBase] listener threw", err);
          }
        }
      });
    }
  }

  /** turn 收尾 → agent-events 总线（失焦弹窗/提示音/webhook 订阅者消费）。
   *  只对本实例发起过 prompt 的会话生效（lastPrompts 台账）——automation 与
   *  他窗的 turn 自有各自的提醒通道，不在这里重复。aborted（用户主动停止）
   *  不算完成不提醒；stopReason=error 走 agent.turn.error，与旧链路 finish
   *  分支的 sawAborted/sawError 语义一致。 */
  private notifyTurnSettled(sessionId: string, body: Record<string, unknown>) {
    // 台账跨轮驻留（不随结算摘除）：重试/重新生成等路径可能不经 sendMessage
    // 重登记，摘了后续 turn 的提醒就哑了。内存口径靠「只存 200 字符摘要 +
    // deleteThread 摘除」收口，见 lastPrompts 声明
    const promptNote = this.lastPrompts.get(sessionId);
    if (promptNote === undefined) return;
    const stopReason = typeof body.stopReason === "string" ? body.stopReason : undefined;
    if (stopReason === "aborted") {
      // 用户主动停止：不算完成也不算错误（不弹提醒），但要发停止信号——
      // 否则桌宠这类"工作中"态的消费者会永远卡在忙碌
      emitAgentEvent("agent.turn.stopped", { threadId: sessionId });
      return;
    }
    if (stopReason === "error") {
      emitAgentEvent("agent.turn.error", {
        threadId: sessionId,
        data: {
          message:
            typeof body.errorMessage === "string" && body.errorMessage
              ? body.errorMessage
              : "pi agent error",
        },
      });
      return;
    }
    emitAgentEvent("agent.turn.completed", {
      threadId: sessionId,
      data: { prompt: promptNote.slice(0, 120) },
    });
  }

  /** thread_event 分流 + partial 重建后按契约信封 dispatch */
  private routeThreadEvent(
    sessionId: string,
    seq: number,
    body: Record<string, unknown>,
  ) {
    const set = this.listeners.get(sessionId);
    if (!set) return;
    // 排队台账随 queue_update 实时维护（不能只靠快照）：轮中入队的消息还没进过
    // 快照，台账停在旧值时上一轮 agent_end 的 inflight 收口会把它误删，派发时
    // 的 start 帧就再也唤不醒 onPromptStart（排队消息起跑时不上屏）。
    if (body.type === "queue_update") {
      this.queuedIds.set(sessionId, queuedRequestIdsOf(body));
    }
    const prevSeq = this.lastSeq.get(sessionId) ?? 0;
    // delta 帧幂等兑底：文本增量是台账上唯一非幂等的操作（+= 追加），
    // seq 不大于已见水位 = 重复帧（传输层双投递）或快照水位已涵盖的在飞帧
    // （其内容已在快照基底里），再应用即成倍重复——直接丢弃。其余帧
    // （start/end/agent_*）本身幂等，照常派发推进水位。
    if (body.type === "message_update" && seq <= prevSeq) return;
    this.lastSeq.set(sessionId, Math.max(prevSeq, seq));
    let event: PiClientEvent;
    if (body.type === "message_update") {
      // delta 帧：在 accumulator 上重建完整 partial（无基底 = 监听中途挂上且
      // 快照未到，丢弃等 message_start/快照）
      const acc = this.streams.get(sessionId);
      const delta = body.assistantMessageEvent as
        | (Record<string, unknown> & Parameters<typeof applyStreamDelta>[1])
        | undefined;
      if (!acc || !delta) return;
      applyStreamDelta(acc, delta);
      event = {
        type: "message_update",
        message: acc.message as PiAgentMessage,
        assistantMessageEvent: delta as unknown as PiAssistantMessageDelta,
        threadId: sessionId,
        seq,
      } as unknown as PiClientEvent;
    } else {
      if (body.type === "message_start") {
        this.streams.set(sessionId, {
          message: (body.message ?? { content: [] }) as StreamAcc["message"],
          args: new Map(),
        });
      }
      if (body.type === "message_end" || body.type === "agent_end") {
        this.streams.delete(sessionId);
      }
      if (body.type === "agent_end") {
        // turn 收尾清残留（4b，abort/异常的兜底出口）：正常结算路径由
        // data-interactionResolved 先行移除，此处通常为空操作
        clearToolApprovals(sessionId);
        clearQuestions(sessionId);
        // 文件树失效（旧链路 finish/error 同款）：非 git 工作区 agent 也在改
        // 盘上文件；跨工作区后台线程收尾时刷的是当前工作区树，视觉无害
        refreshFileTree(getWorkspace() ?? null);
        // inflight 收口：不在最新快照队列里的请求已经跑完/失败（重连重发命中
        // 网关去重时收尾帧不会回到本连接），摘掉防台账无限增长。仍在队列的
        // 条目保留，等它们真正开跑时 start 帧还能唤醒 onPromptStart 对账。
        // 被摘掉的请求不会再等到 finish（下一次收尾帧进来时 inflight 已空），
        // 这里补一次终结通知：控制器据此撤掉起跑上屏但始终没回显的乐观消息。
        const queued = this.queuedIds.get(sessionId);
        for (const [requestId, sid] of this.inflight) {
          if (sid === sessionId && !queued?.has(requestId)) {
            this.inflight.delete(requestId);
            this.notifyPromptEnd(sessionId, requestId);
          }
        }
      }
      event = { ...body, threadId: sessionId, seq } as unknown as PiClientEvent;
    }
    for (const listener of set) {
      try {
        listener(event);
      } catch (err) {
        console.error("[PiClientBase] listener threw", err);
      }
    }
  }

  // ---------- PiClient 契约 ----------

  async listThreads(): Promise<PiThreadMetadata[]> {
    const [sessionsRes, runningRes] = await Promise.all([
      this.transport.request<{ type: "sessions"; sessions: PiSessionSummary[] }>({
        type: "list_sessions",
      }),
      this.transport.request<{ type: "running"; sessionIds: string[] }>({
        type: "list_running",
      }),
    ]);
    // 会话镜像落点（阶段 5b 随旧 adapter 删除而断供）：cwd 分组 / 偏好水合
    // 全靠这份快照——不补写的话侧边栏项目分组整体消失、胶囊不跟随、
    // mode/model picker 切回会话拿不到偏好。
    applySessionSummaries(sessionsRes.sessions);
    const running = new Set(runningRes.sessionIds);
    return sessionsRes.sessions.map((s) => ({
      id: s.sessionId,
      title: s.name || s.firstMessage?.slice(0, 50) || "新会话",
      workspacePath: s.cwd || undefined,
      archived: s.archived,
      status: running.has(s.sessionId) ? ("running" as const) : ("idle" as const),
      config: {
        provider: s.modelProvider,
        modelId: s.modelId,
      },
      messageCount: s.messageCount,
      updatedAt: s.modified,
    }));
  }

  async createThread(input?: { workspacePath?: string }): Promise<PiThreadSnapshot> {
    // threadId 形参只是 running 键：真正身份由 sidecar 生成的 sessionId 承担
    const cwd = input?.workspacePath ?? getWorkspace() ?? undefined;
    const projectId = getProjectId() ?? undefined;
    // 远程项目绑定：按 workspace 路径反查远程项目（不依赖临时选中态），
    // 命中即随 new_session 携带 remote 载荷——sidecar 据此把工具执行分流到 SSH。
    // 主机已删除/停用时回落本地语义（target 为 null，远端命令自然报错暴露）
    let remote: RemoteTargetPayload | undefined;
    if (cwd) {
      const project = findRemoteProjectByPath(cwd);
      if (project) {
        const target = await resolveRemoteTargetPayload(project);
        if (target) remote = target;
        else {
          // 远程项目的主机被删除/停用：绝不能静默按本地会话创建
          //（cwd 是远端路径，本地执行只会报目录不存在——错误且误导）
          throw new Error(
            `远程项目「${project.name}」的 SSH 主机不存在或已停用，无法创建会话。` +
              `请到 设置 → 系统 → SSH 主机 修复后重试。`,
          );
        }
      }
    }
    const res = await this.transport.request<
      Extract<PiResponse, { type: "session" }>
    >({
      type: "new_session",
      threadId: `pi-${crypto.randomUUID()}`,
      cwd,
      ...(projectId ? { projectId } : {}),
      ...(remote ? { remote } : {}),
    });
    // 镜像先登记再返回（对齐阶段 5b 前 piEnsureThreadSession 的语义）：
    // 列表回程（~一次刷新）前新会话的分组归属就已正确；广播一声让
    // usePanelCwd 等按 sessionId 解析产物目录的视图重取兜底 cwd。
    if (cwd) piSessionCwdMap.set(res.sessionId, cwd);
    if (projectId) piSessionProjectIdMap.set(res.sessionId, projectId);
    window.dispatchEvent(new Event("pi:session-bound"));
    return this.fetchSnapshot(res.sessionId);
  }

  async getThread(threadId: string): Promise<PiThreadSnapshot> {
    return this.fetchSnapshot(threadId);
  }

  async sendMessage(threadId: string, input: PiSendMessageInput): Promise<void> {
    // requestId 可由调用方预生成（队列条目 id 与真实 reqId 同值，见控制器
    // sendQueued/queueResend）：撤销/并入/立即发送拿到的 id 必须 sidecar 认得
    const requestId = input.requestId ?? `pi-${crypto.randomUUID()}`;
    // steer 车道由显式 streamingBehavior 声明（v3.1 清理：旧 markSteerNextSend
    // 模块级单跳信号已无人 mark，兼容位连同 pi-steer-intent 模块一并删除）
    const steer = input.streamingBehavior === "steer";
    // composer file parts（对话框直选的图片/文档）→ 协议附件：合成消息复用
    // 旧链路 extractPromptAttachments 的全部裁决（file:// 零拷贝带路径、文档
    // 经 attachment_stage 落盘中转、data:/blob: 解析内联）。FileMessagePart 的
    // 裸 base64 约定（sourceType 非 url 且非已知 scheme）就地包成 data: URL
    const fileAttachments = input.files?.length
      ? await extractPromptAttachments(
          {
            parts: input.files.map((f) => ({
              type: "file" as const,
              url:
                /^(?:data:|blob:|https?:|file:\/\/|[A-Za-z]:[\\/])/i.test(f.data) ||
                f.data.startsWith("/")
                  ? f.data
                  : `data:${f.mimeType};base64,${f.data}`,
              mediaType: f.mimeType,
              ...(f.filename ? { filename: f.filename } : {}),
            })),
          } as Parameters<typeof extractPromptAttachments>[0],
          threadId,
        )
      : null;
    // 运行中发送 = followUp（sidecar 自动排队）；steer 显式并入当前轮
    this.inflight.set(requestId, threadId);
    this.sessionTurn.set(threadId, requestId);
    // 过程性状态信号（不在 AGENT_EVENT_REGISTRY，不触发弹窗/提示音/webhook）：
    // 桌宠等氛围消费者据此进入"工作中"态
    emitAgentEvent("agent.turn.started", { threadId });
    // 完成提醒台账（缺口3）：排队项每条都经这里发出，agent_end 时取最新。
    // 只存摘要：消费方（弹窗正文）用前 120 字符，留 200 的余量足够
    this.lastPrompts.set(threadId, input.content.slice(0, 200));
    void this.ensureEventWatcher();
    const inlineImages =
      input.attachments?.map((a, i) => ({
        name: `image-${i}.${a.mimeType.split("/")[1] ?? "png"}`,
        mimeType: a.mimeType,
        data: a.data,
      })) ?? [];
    const attachments: PiPromptAttachment[] = [...inlineImages, ...(fileAttachments ?? [])];
    // 远程项目绑定：与 createThread 同一反查逻辑（按当前 workspace 路径）。
    // prompt 恒携带全局 workspace，这里同步携带 remote——「先开对话、后选
    // 远程项目」的草稿会话才能在 sidecar 侧补绑（createThread 已错过了）
    const promptWorkspace = getWorkspace() ?? null;
    let promptRemote: RemoteTargetPayload | null = null;
    if (promptWorkspace) {
      const project = findRemoteProjectByPath(promptWorkspace);
      if (project) promptRemote = await resolveRemoteTargetPayload(project);
    }
    try {
      await this.transport.sendPrompt({
        requestId,
        text: input.content,
        // running 键统一用 sessionId：abort/steer/队列按同键命中
        threadId,
        cwd: promptWorkspace,
        remote: promptRemote,
        attachments: attachments.length ? attachments : null,
        steer,
        // 目标轮数上限只在 goal 档、且用户本次运行显式改过时才发。没改过就不带字段：
        // sidecar 按「会话偏好 → 默认」自己裁决，前端补默认值只会冲掉会话记忆
        ...(sessionModeSnapshot(threadId).mode === "goal"
          ? sendGoalCreationPrefs(threadId)
          : {}),
      });
    } catch (err) {
      this.inflight.delete(requestId);
      throw err;
    }
  }

  async cancelRun(threadId: string): Promise<void> {
    await this.transport.abort(threadId);
  }

  /** 编辑/重新生成的服务端截断（vendored 基座扩展，配套 sidecar
   *  truncate_session）：丢 seq >= beforeSeq 的转录行。busy 时 sidecar 抛错，
   *  原样透传给调用方；截断结果由随后的 prompt → 快照回流，无需单独刷新。 */
  async truncateToSeq(threadId: string, beforeSeq: number): Promise<void> {
    await this.transport.request<{ removed?: number } & PiResponse>({
      type: "truncate_session",
      threadId,
      sessionId: threadId,
      beforeSeq,
    });
  }

  /** 整队清空（4a 实装）：queue_clear 命令，返回被清条目载荷（文本 + 图片
   *  附件）——「停止生成」把排队内容原样回填 composer（文本进草稿、图片还原
   *  成附件），不再静默丢弃。 */
  async clearQueue(threadId: string): Promise<PiClearedQueue> {
    const res = await this.transport.request<{
      cleared?: string[];
      items?: {
        reqId?: string;
        text?: string;
        attachments?: QueueAttachment[];
      }[];
    } & PiResponse>({ type: "queue_clear", threadId });
    const items: PiQueueEntry[] = (res.items ?? []).flatMap((item) =>
      typeof item.reqId === "string" && typeof item.text === "string"
        ? [
            {
              id: item.reqId,
              content: item.text,
              ...(item.attachments && item.attachments.length > 0
                ? { attachments: item.attachments }
                : {}),
            },
          ]
        : [],
    );
    // 旧 sidecar 只回 cleared（无 items）：退化成纯文本条目，后端能力不一致时
    // 也不丢「回填文本」这个主诉求
    const fallback =
      items.length === 0
        ? (res.cleared ?? []).map((text, index) => ({
            id: `queue-cleared-${index}`,
            content: text,
          }))
        : items;
    return { steering: [], followUp: fallback.map((i) => i.content), items: fallback };
  }

  /** 逐项队列操作（4a）：id = 真实 reqId，直通 sidecar 队列引擎。
   *  状态更新由引擎的 queue_update 事件回流，客户端不做本地乐观改写。 */
  async queueCancel(threadId: string, id: string): Promise<void> {
    await this.transport.request({ type: "queue_cancel", requestId: id });
    void threadId;
  }

  async queuePromote(threadId: string, id: string): Promise<void> {
    await this.transport.request({ type: "queue_promote", requestId: id });
    void threadId;
  }

  async queueSteer(threadId: string, id: string): Promise<void> {
    await this.transport.request({ type: "queue_steer", requestId: id });
    void threadId;
  }

  /** 弹出队首（4a：刷新接力泵的孤儿队列场景）。线程忙、链节仍在或队列
   *  暂停时 popped 为 null（sidecar 三保险），泵据此判定无孤儿、转由事件流
   *  接力。附件为协议形状（{ name, mimeType, data }）——sidecar 已把 path-only
   *  项读盘内联，重发只需 data。 */
  async queuePop(threadId: string): Promise<PiQueueEntry | null> {
    const res = await this.transport.request<{
      popped?: {
        reqId: string;
        text: string;
        sessionId?: string;
        attachments?: QueueAttachment[];
      } | null;
    } & PiResponse>({ type: "queue_pop", threadId });
    const popped = res.popped;
    if (!popped) return null;
    return {
      id: popped.reqId,
      content: popped.text,
      ...(popped.attachments && popped.attachments.length > 0
        ? { attachments: popped.attachments }
        : {}),
    };
  }

  /** 队列暂停/恢复（v3.1）：冻结/解冻自动派发，状态由引擎 queue_update
   *  事件回流，客户端不做本地乐观改写。 */
  async queuePause(threadId: string): Promise<void> {
    await this.transport.request({ type: "queue_pause", threadId });
  }

  async queueResume(threadId: string): Promise<void> {
    await this.transport.request({ type: "queue_resume", threadId });
  }

  /** 排序（v3.1）：把排队项移到 toIndex（移动后最终下标，sidecar clamp）。 */
  async queueMove(threadId: string, id: string, toIndex: number): Promise<void> {
    await this.transport.request({
      type: "queue_move",
      requestId: id,
      toIndex,
    });
    void threadId;
  }

  async getAvailableModels(): Promise<PiModelInfo[]> {
    const res = await this.transport.request<
      Extract<PiResponse, { type: "models" }>
    >({
      type: "list_models",
    });
    return res.models.map((m) => ({
      provider: m.provider,
      modelId: m.id,
      name: m.name,
      supportsThinking: m.reasoning,
      availableThinkingLevels: m.supportedThinkingLevels?.filter(
        (l) => l !== "off",
      ) as PiModelInfo["availableThinkingLevels"],
    }));
  }

  async setModel(
    threadId: string,
    input: { provider: string; modelId: string },
  ): Promise<void> {
    // sessionId 定靶：只落该会话（转录 model_change 行 + 偏好列）
    await this.transport.request({ type: "set_model", ...input, sessionId: threadId });
  }

  async setThinkingLevel(threadId: string, level: PiThinkingLevel): Promise<void> {
    // sessionId 定靶（迁移阶段 4 已具备协议形态）：只落该会话的转录档位行 +
    // 偏好列，不广播、不写全局默认档位 kv。新链路 threadId = remoteId = sessionId。
    await this.transport.request({ type: "set_thinking", level, sessionId: threadId });
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    await this.transport.request({ type: "rename_session", sessionId: threadId, name: title });
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.transport.request({ type: "archive_session", sessionId: threadId, archived: true });
  }

  async unarchiveThread(threadId: string): Promise<void> {
    await this.transport.request({ type: "archive_session", sessionId: threadId, archived: false });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.transport.request({ type: "delete_session", sessionId: threadId });
    // 启动回切指针清扫：残留指针（在飞登记/最近会话）会让下次启动的回切把
    // 已删会话当目标——switchToThread 对不在列表的 id 走 adapter.fetch，
    // 空快照被 RemoteThreadList 收编成列表项，就是侧边栏那行幽灵「新对话」
    //（2026-10-22 用户报：任务运行中删对话，重启后多出一行）。删除即作废。
    piResumableStorage.clear(threadId);
    if (readLastThread() === threadId) syncClearLastThread();
    // 检查点渲染轮基线随会话作废（引用的影子快照 hash 已无意义）
    this.checkpoints.forgetSession?.(threadId);
    // 会话级台账终清：unsubscribe 已负责 listeners/streams/stamps/lastSeq，
    // lastPrompts 与 inflight 不在其作用域——会话没了就一并摘
    this.lastPrompts.delete(threadId);
    this.sessionTurn.delete(threadId);
    this.queuedIds.delete(threadId);
    for (const [reqId, sid] of this.inflight) {
      if (sid === threadId) this.inflight.delete(reqId);
    }
  }

  /** dev 探针（window.__kovaPerf 经 app-runtime-provider 注册）：各台账当前
   *  规模。增长型泄漏验证口径：翻 N 个会话前后各读一次，条数应只跟「最近
   *  活跃窗口」挂钩，而不是单调爬。 */
  debugLedgerSizes(): Record<string, number> {
    return {
      listeners: this.listeners.size,
      streams: this.streams.size,
      stamps: this.stamps.size,
      lastSeq: this.lastSeq.size,
      queuedIds: this.queuedIds.size,
      inflight: this.inflight.size,
      lastPrompts: this.lastPrompts.size,
      promptStartListeners: this.promptStartListeners.size,
      promptEndListeners: this.promptEndListeners.size,
    };
  }

  /** host-UI 契约应答（阶段 4b 决策：审批/提问走 pi-interactions 工具卡原路径
   *  ——data-toolApproval/data-question chunk 直拦喂 store，快照 hostUiRequests
   *  恒空，本方法实际不会被走到；confirm 映射保留兜底，select/input/editor
   *  维持拒绝结算防悬挂） */
  async respondToHostUiRequest(
    threadId: string,
    response: PiHostUiResponse,
  ): Promise<void> {
    if ("confirmed" in response) {
      await this.transport.request({
        type: "tool_confirm",
        threadId,
        approvalId: response.requestId,
        approved: response.confirmed,
      });
      return;
    }
    // select/input/editor 应答无处可去：按拒绝结算，别让审批永久挂起
    await this.transport.request({
      type: "tool_confirm",
      threadId,
      approvalId: response.requestId,
      approved: false,
    });
  }

  subscribe(
    threadId: string,
    listener: (event: PiClientEvent) => void,
    options?: { includeSnapshot?: boolean },
  ): () => void {
    let set = this.listeners.get(threadId);
    if (!set) {
      set = new Set();
      this.listeners.set(threadId, set);
    }
    set.add(listener);
    this.publishWatchedSessions();
    void this.ensureEventWatcher();
    // 契约默认快照先行：冷读直接落定（force：重订阅同指纹也要拿到初帧），
    // 之后实时事件增量，收尾帧/换代兜底拉快照
    if (options?.includeSnapshot !== false) {
      void this.refreshNow(threadId, true);
      // 刷新/挂载恢复（4b）：权威拉取补挂起审批/提问卡（幂等并入）
      void this.pullPendingInteractions(threadId);
    }
    return () => {
      const current = this.listeners.get(threadId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(threadId);
        this.streams.delete(threadId);
        this.stamps.delete(threadId);
        this.lastSeq.delete(threadId);
        this.queuedIds.delete(threadId);
      }
      this.publishWatchedSessions();
    };
  }

  /**
   * 把「本窗口正在看的会话」同步给桌面壳：主进程据此裁掉后台会话的逐 token
   * 增量（多会话并发时不再逐帧跨进程送给完全不看它的窗口）。集合没变就不发，
   * 订阅/退订本身是高频动作。
   */
  private publishWatchedSessions(): void {
    const report = this.transport.watchSessions;
    if (!report) return;
    const ids = [...this.listeners.keys()].sort();
    const key = ids.join("\n");
    if (key === this.watchedKey) return;
    this.watchedKey = key;
    report(ids);
  }

  /** prompt 终结（finish/error 帧）：通知观察席一次。调用点已先删 inflight，
   *  同一 reqId 的后续帧不会再进来，天然只通知一次。 */
  private notifyPromptEnd(sessionId: string, requestId: string) {
    for (const listener of this.promptEndListeners.get(sessionId) ?? []) {
      try {
        listener(requestId);
      } catch (err) {
        console.error("[PiClientBase] promptEnd listener threw", err);
      }
    }
  }

  /** prompt 真的开跑（start 帧）的观察席：控制器用它把「本地乐观队列条目」与
   *  「服务端实际没排队、已直接执行」的对账收敛（见 ThreadController 的
   *  dropLocalQueueEntry）。同一 id 只会通知一次（start 每流一帧）。 */
  onPromptStart(
    threadId: string,
    listener: (requestId: string) => void,
  ): () => void {
    let set = this.promptStartListeners.get(threadId);
    if (!set) {
      set = new Set();
      this.promptStartListeners.set(threadId, set);
    }
    set.add(listener);
    return () => {
      const current = this.promptStartListeners.get(threadId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.promptStartListeners.delete(threadId);
    };
  }

  /** prompt 终结（finish/error 帧）的观察席：控制器用它撤掉起跑时上屏、
   *  却始终没等到回显的乐观用户消息（见 ThreadController 的
   *  finishPendingPrompt）。与 onPromptStart 同款登退订。 */
  onPromptEnd(
    threadId: string,
    listener: (requestId: string) => void,
  ): () => void {
    let set = this.promptEndListeners.get(threadId);
    if (!set) {
      set = new Set();
      this.promptEndListeners.set(threadId, set);
    }
    set.add(listener);
    return () => {
      const current = this.promptEndListeners.get(threadId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.promptEndListeners.delete(threadId);
    };
  }
}
