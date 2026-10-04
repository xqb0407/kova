"use client";

/**
 * PiClientBase：PiClient 契约的传输无关基座（react-pi 迁移阶段 5c）。
 *
 * TauriPiClient（桌面）与 WsPiClient（远程网页）都是它的薄适配，只注入
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
import { newRequestId } from "@/lib/mobile/request-id";
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
import { applyTodoChunk } from "@/lib/pi/pi-todo";
import { applyGoalChunk } from "@/lib/pi/pi-goal";
import {
  emitAgentEvent,
  focusPanelTabFor,
  focusPluginPanelFor,
  getCurrentPanelThreadId,
  refreshFileTree,
  resyncPiRunning,
  applyDelegationChunk,
} from "@/lib/host-effects";
import {
  getTurnTiming,
  scopedTurnKey,
  seedTurnTiming,
} from "@/lib/panels/turn-collapse";
import { consumeSteerIntent } from "@/lib/pi/pi-steer-intent";
import { extractPromptAttachments } from "@/lib/attachments/prompt-attachments";
import { setThreadTitle } from "@/lib/pi/pi-thread-titles";
import { getWorkspace } from "@/lib/workspace/workspace-store";
import {
  applySessionSummaries,
  piSessionCwdMap,
} from "@/lib/pi/pi-thread-adapter";
import {
  TurnCheckpointTracker,
  type TurnCheckpointObserver,
} from "./turn-checkpoints";
import type { PendingInteraction } from "pi-protocol";
import type {
  PiAgentMessage,
  PiAssistantMessageDelta,
  PiClient,
  PiClientEvent,
  PiHostUiResponse,
  PiModelInfo,
  PiQueueEntry,
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
};

/** 每线程流式重建 accumulator：sidecar 只发 delta（O(n²) wire 治理），
 *  客户端就地补丁出完整 partial 再 dispatch（reducer 的 message_update
 *  消费完整 message，见 threadState.ts）。 */
type StreamAcc = {
  message: Record<string, unknown> & { content?: unknown[] };
  /** toolcall_delta 的参数 JSON 串缓冲（按 contentIndex；toolcall_end 整体替换） */
  args: Map<number, string>;
};

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
    case "toolcall_delta":
      acc.args.set(i, (acc.args.get(i) ?? "") + (e.delta ?? ""));
      break;
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

/** 传输依赖（构造注入）：桌面 = Tauri invoke/event，远程 = WebSocket 通道。 */
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
    attachments: PiPromptAttachment[] | null;
    steer: boolean;
  }): Promise<void>;
  /** 中断线程的运行轮 */
  abort(threadId: string): Promise<void>;
  /** 订阅原始 sidecar NDJSON 行（批量事件逐行回调）；返回退订 */
  watchLines(cb: (raw: string) => void): Promise<() => void>;
  /** 事件源换代（sidecar 退出 / WS 断开+重连 authed）：基座清流式台账并
   *  逐订阅线程拉快照自愈；同一 cb 可能被多次调用 */
  watchGeneration(cb: () => void): Promise<() => void>;
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
  /** 每会话最近一次发送的 prompt（完成提醒正文用）；仅本实例发起的会话入表
   *  ——automation/他窗发起的 turn 不在表内，不重复提醒（旧链路同语义） */
  private readonly lastPrompts = new Map<string, string>();
  /** 检查点卡观察者（缺口2）：agent_start 打影子仓库快照、agent_end 结算。
   *  默认实现走 turn-checkpoints 的真实依赖；测试可注入记录型假件 */
  private readonly checkpoints: TurnCheckpointObserver;
  private unlistenLines: (() => void) | null = null;
  /** ensureEventWatcher 的在飞注册锁（防同 tick 双监听，见该方法注释） */
  private eventWatcher: Promise<void> | null = null;

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

  /** 快照指纹：seq/状态/条数/末条时间戳/挂起审批数/排队数——任一变化才派发，
   *  防每秒抖动（4a：排队条目入指纹，快照采纳恢复的队列能触发派发） */
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
    ].join("|");
  }

  /**
   * 历史轮耗时播种（取代旧链路 loadPiHistory→seedHistoryTurnTimings——该路径
   * 随阶段 5b 退役，导致所有历史轮 durationMs 缺失、摘要行退回计数文案）。
   * 调用点：fetchSnapshot（唯一快照汇聚点）——2026-10-02 从 dispatch 下沉，
   * 覆盖 controller.load() 的冷读（空闲线程从不 connect/派发，刷新与切会话
   * 正是这条路径，此前时长全缺失）。
   * 用转录行自带时间戳：user 行做轮锚（轮次键 = 投影稳定 id `pi-msg:${seq}`，
   * 与 message-turns 的 turnKey 同值），开始 = user 行 timestamp，结束 = 轮内
   * 最后一条非 user 行的 timestamp。跳过：锚行无 seq（在飞未落盘，轮次键无从
   * 预测）；台账已有 live:true 条目（本窗口盯着跑的轮由 Date.now 计时，更准
   * 且归 noteTurnEnd/timing 管）；值相等（store.set 无条件 notify，快照反复
   * 派发不能引发重渲风暴）。
   */
  private seedHistoryTurnTimings(snapshot: PiThreadSnapshot): void {
    type SeedableLine = { role?: string; __seq?: number; timestamp?: number };
    const threadId = snapshot.metadata.id;
    let anchorSeq: number | undefined;
    let anchorTs: number | undefined;
    let endTs: number | undefined;
    const flush = () => {
      if (anchorSeq === undefined || anchorTs === undefined || endTs === undefined)
        return;
      const scoped = scopedTurnKey(threadId, `pi-msg:${anchorSeq}`);
      const cur = getTurnTiming(scoped);
      if (cur?.live === true) return;
      if (cur?.start === anchorTs && cur?.end === endTs) return;
      seedTurnTiming(scoped, { start: anchorTs, end: endTs });
    };
    for (const line of snapshot.messages as unknown as SeedableLine[]) {
      if (line.role === "user") {
        flush();
        anchorSeq = line.__seq;
        anchorTs = line.timestamp;
        endTs = undefined;
        continue;
      }
      if (anchorSeq !== undefined && typeof line.timestamp === "number") {
        endTs = line.timestamp;
      }
    }
    flush();
  }

  private dispatch(snapshot: PiThreadSnapshot) {
    const id = snapshot.metadata.id;
    const prevSeq = this.lastSeq.get(id) ?? 0;
    const snapSeq = snapshot.seq ?? 0;
    this.lastSeq.set(id, Math.max(prevSeq, snapSeq));
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
   *  force=true 绕过指纹去重（重订阅也要拿到初帧） */
  private async refreshNow(sessionId: string, force = false) {
    try {
      const snapshot = await this.fetchSnapshot(sessionId);
      const stamp = PiClientBase.fingerprint(snapshot);
      if (!force && this.stamps.get(sessionId) === stamp) return;
      this.stamps.set(sessionId, stamp);
      this.dispatch(snapshot);
    } catch {
      // sidecar 不可用/会话已删：静默（重订阅/收尾帧会再触发）
    }
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
   *  空值会双双通过检查、各注册一份监听——Tauri listen 每次都是独立订阅，
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

  /** 事件源换代：清重建台账，逐订阅线程拉快照自愈（空闲态 + 已落盘内容） */
  private handleGenerationChange() {
    this.streams.clear();
    for (const sessionId of this.listeners.keys()) void this.refreshNow(sessionId);
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
              this.checkpoints.begin(sid);
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
    }
    // ---- 面板唤起（4d）：browser_*/open_file/open_plugin_panel 发起的
    // UI 副作用（形状校验与 pi-transport tap 同款）。移动端没有面板，这些帧
    // 落到 host-effects 的空实现——整段照旧解析并丢弃，语义与桌面端"没有
    // 订阅者时静默落桶"一致，不影响后续 data-* 帧的旁路分流。
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
        focusPluginPanelFor(owner, plugin, panel, {
          ...(cwd ? { cwd } : {}),
          ...(path ? { path } : {}),
        });
      }
      return;
    }
    // ---- 收尾帧观察：finish/error 即时拉快照（起跑前失败兜底）----
    if (this.inflight.size === 0) return;
    const requestId = parsed.id;
    if (!requestId || !this.inflight.has(requestId)) return;
    const type = parsed.chunk?.type;
    if (type === "finish" || type === "error") {
      const sessionId = this.inflight.get(requestId)!;
      this.inflight.delete(requestId);
      // force：收尾帧是「本轮已结束」的权威信号，快照必须派发——指纹去重
      // 在这里会吞掉自愈（并入退化流等场景 live 的 agent_end 可能缺失，
      // 不强制刷新 runStatus 就永远停在 running，转圈/停止键永挂）
      void this.refreshNow(sessionId, true);
    }
  }

  /** turn 收尾 → agent-events 总线（失焦弹窗/提示音/webhook 订阅者消费）。
   *  只对本实例发起过 prompt 的会话生效（lastPrompts 台账）——automation 与
   *  他窗的 turn 自有各自的提醒通道，不在这里重复。aborted（用户主动停止）
   *  不算完成不提醒；stopReason=error 走 agent.turn.error，与旧链路 finish
   *  分支的 sawAborted/sawError 语义一致。 */
  private notifyTurnSettled(sessionId: string, body: Record<string, unknown>) {
    if (!this.lastPrompts.has(sessionId)) return;
    const stopReason = typeof body.stopReason === "string" ? body.stopReason : undefined;
    if (stopReason === "aborted") return;
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
      data: { prompt: this.lastPrompts.get(sessionId)?.slice(0, 120) },
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
    const res = await this.transport.request<
      Extract<PiResponse, { type: "session" }>
    >({
      type: "new_session",
      threadId: `pi-${newRequestId()}`,
      cwd,
    });
    // 镜像先登记再返回（对齐阶段 5b 前 piEnsureThreadSession 的语义）：
    // 列表回程（~一次刷新）前新会话的分组归属就已正确。桌面端此处还会广播
    // "pi:session-bound" 让按 sessionId 解析产物目录的视图重取兜底 cwd——
    // 那些视图都在 agent 面板里，移动端没有，无需广播。
    if (cwd) piSessionCwdMap.set(res.sessionId, cwd);
    return this.fetchSnapshot(res.sessionId);
  }

  async getThread(threadId: string): Promise<PiThreadSnapshot> {
    return this.fetchSnapshot(threadId);
  }

  async sendMessage(threadId: string, input: PiSendMessageInput): Promise<void> {
    const requestId = `pi-${newRequestId()}`;
    // steer 意图桥接（4a）：composer 的 Alt+点击 / Shift+⌘+Enter 在发送前置
    // markSteerNextSend 标记（模块级单跳信号，runConfig 不透传）。显式
    // streamingBehavior 优先；无显式行为且标记在 → 升级为 steer（含控制器
    // 忙时默认派生的 followUp——标记只会在「用户明确要点并入」时存在）
    const steer = input.streamingBehavior === "steer" || consumeSteerIntent(threadId);
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
    // 完成提醒台账（缺口3）：排队项每条都经这里发出，agent_end 时取最新
    this.lastPrompts.set(threadId, input.content);
    void this.ensureEventWatcher();
    const inlineImages =
      input.attachments?.map((a, i) => ({
        name: `image-${i}.${a.mimeType.split("/")[1] ?? "png"}`,
        mimeType: a.mimeType,
        data: a.data,
      })) ?? [];
    const attachments: PiPromptAttachment[] = [...inlineImages, ...(fileAttachments ?? [])];
    try {
      await this.transport.sendPrompt({
        requestId,
        text: input.content,
        // running 键统一用 sessionId：abort/steer/队列按同键命中
        threadId,
        cwd: getWorkspace() ?? null,
        attachments: attachments.length ? attachments : null,
        steer,
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

  /** 整队清空（4a 实装）：queue_clear 命令，返回被清文本供 UI 回填 composer。 */
  async clearQueue(threadId: string): Promise<{ steering: string[]; followUp: string[] }> {
    const res = await this.transport.request<{
      cleared?: string[];
    } & PiResponse>({ type: "queue_clear", threadId });
    return { steering: [], followUp: res.cleared ?? [] };
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

  /** 弹出队首（4a：刷新接力泵的孤儿队列场景）。线程忙或链节仍在时
   *  popped 为 null（sidecar 双保险），泵据此判定无孤儿、转由事件流接力。 */
  async queuePop(threadId: string): Promise<PiQueueEntry | null> {
    const res = await this.transport.request<{
      popped?: { reqId: string; text: string; sessionId?: string } | null;
    } & PiResponse>({ type: "queue_pop", threadId });
    const popped = res.popped;
    return popped ? { id: popped.reqId, content: popped.text } : null;
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
      }
    };
  }
}
