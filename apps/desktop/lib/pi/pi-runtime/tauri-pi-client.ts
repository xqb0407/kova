"use client";

/**
 * TauriPiClient：PiClient 契约的桌面端实现（react-pi 迁移阶段 2+3）。
 *
 * - 管理类方法走 pi-channel 的 request 通道（invoke pi_request，管理队列串行）；
 * - getThread 走 sidecar 命令 thread_snapshot（JSONL 转录 + 在飞 partial →
 *   PiThreadSnapshot，阶段 3c）；
 * - sendMessage 复用现有 pi_prompt（带 sessionId 定靶），不消费 AI SDK chunk 流；
 * - subscribe 完整实现（阶段 3b）：监听 pi-chunk-batch 里的 thread_event 行
 *   （sidecar delta 化原生事件，计划 §3a），按 threadId 分流 + 在 accumulator
 *   上重建 partial 再 dispatch；快照权威兜底（订阅首帧 / 收尾帧 / sidecar 退出）。
 *   阶段 2 的轮询已退役——运行状态由 agent_start/agent_end 事件驱动。
 *
 * 线程身份 = pi sessionId（metadata.id）：usePiRuntime 的 controller 以它为键，
 * sidecar 侧 prompt/abort 的 running 键同样用 sessionId，两端一致。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { piRequest, type PiResponse, type PiSessionSummary } from "@/lib/pi/pi-bridge";
import {
  applyHistoryPending,
  removeResolvedInteraction,
} from "@/lib/pi/pi-interactions";
import { applyQuestionChunk, clearQuestions } from "@/lib/pi/pi-question";
import {
  applyToolApprovalChunk,
  clearToolApprovals,
} from "@/lib/pi/pi-tool-approval";
import { consumeSteerIntent } from "@/lib/pi/pi-steer-intent";
import { applyDelegationChunk } from "@/lib/subagent/subagent-runs";
import { getWorkspace } from "@/lib/workspace/workspace-store";
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

/** pi-chunk-batch 载荷的一行（镜像 pi_agent.rs ChunkLine，pi-channel 未导出） */
type WireLine = { i: number | null; l: string };

/** pi-chunk-batch 行的解析形状：thread_event 帧或带 requestId 的 chunk 帧 */
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

export class TauriPiClient implements PiClient {
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
  private unlistenChunks: UnlistenFn | null = null;

  // ---------- 快照 ----------

  private async fetchSnapshot(sessionId: string): Promise<PiThreadSnapshot> {
    const res = await piRequest<SnapshotReply & PiResponse>({
      type: "thread_snapshot",
      sessionId,
    });
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
        console.error("[TauriPiClient] listener threw", err);
      }
    }
  }

  /** 拉一次快照并派发（订阅首帧 / 收尾帧 / sidecar 退出共用）；
   *  force=true 绕过指纹去重（重订阅也要拿到初帧） */
  private async refreshNow(sessionId: string, force = false) {
    try {
      const snapshot = await this.fetchSnapshot(sessionId);
      const stamp = TauriPiClient.fingerprint(snapshot);
      if (!force && this.stamps.get(sessionId) === stamp) return;
      this.stamps.set(sessionId, stamp);
      this.dispatch(snapshot);
    } catch {
      // sidecar 不可用/会话已删：静默（重订阅/收尾帧会再触发）
    }
  }

  /** list_pending 权威拉取（4b 刷新恢复）：新链路 threadId 即 sessionId，必须
   *  带 sessionId 定址——sidecar threadSessions 的键是建会话时的随机 threadId，
   *  按 threadId 反查会落空。applyHistoryPending 幂等并入（与直播流按 id 去重），
   *  不用整表替换语义，防拉空时清掉直播流刚送的卡。 */
  private async pullPendingInteractions(threadId: string): Promise<void> {
    try {
      const res = await piRequest<Extract<PiResponse, { type: "pending" }>>({
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

  private async ensureEventWatcher() {
    if (this.unlistenChunks) return;
    this.unlistenChunks = await listen<WireLine[]>("pi-chunk-batch", (event) => {
      if (this.listeners.size === 0 && this.inflight.size === 0) return;
      for (const wire of event.payload) {
        // 预筛：thread_event 行（原生事件）+ finish/error/start 帧（收尾观察）
        // + 委派绑定行（4c）+ 交互卡行（4b）；其余 token 级 chunk 行（AI SDK
        // 遗留流）不解析
        const looksEvent = wire.l.includes('"thread_event"');
        const looksDelegation = wire.l.includes('"data-subagentDelegation"');
        const looksInteraction =
          wire.l.includes('"data-toolApproval"') ||
          wire.l.includes('"data-question"') ||
          wire.l.includes('"data-interactionResolved"');
        if (
          !looksEvent &&
          !looksDelegation &&
          !looksInteraction &&
          !wire.l.includes('"finish"') &&
          !wire.l.includes('"error"') &&
          !wire.l.includes('"start"')
        ) {
          continue;
        }
        let parsed: WireMsg;
        try {
          parsed = JSON.parse(wire.l) as WireMsg;
        } catch {
          continue;
        }
        if (parsed.type === "thread_event") {
          if (looksEvent) {
            this.routeThreadEvent(
              String(parsed.sessionId ?? ""),
              Number(parsed.eventSeq ?? 0),
              parsed.event ?? {},
            );
          }
          continue;
        }
        // ---- 委派绑定（4c）：Task 工具启动瞬间随活跃请求流发出。旧链路靠
        // transport postTransform 拦同一 chunk；新链路在此拦截喂给
        // subagent-runs（旁路 chunk 不进消息流，绑定语义不变）
        const chunkData = parsed.chunk as
          | { type?: string; data?: unknown }
          | undefined;
        if (chunkData?.type === "data-subagentDelegation") {
          applyDelegationChunk(chunkData.data);
          continue;
        }
        // ---- 交互卡（4b）：审批/提问/结算广播。旧链路靠 transport tap 拦同一
        // chunk；新链路在此喂 pi-interactions（台账键 = 线上 sessionId，与卡片
        // 组件的 mainThreadId 同一命名空间），chunk 不进消息流。正常结算由
        // resolved 帧移除卡片；abort/异常残留由 agent_end 兜底清空
        const sid = parsed.sessionId;
        if (sid) {
          if (chunkData?.type === "data-toolApproval") {
            applyToolApprovalChunk(sid, chunkData.data);
            continue;
          }
          if (chunkData?.type === "data-question") {
            applyQuestionChunk(sid, chunkData.data);
            continue;
          }
          if (chunkData?.type === "data-interactionResolved") {
            const d = chunkData.data as { interactionId?: unknown } | undefined;
            if (d && typeof d.interactionId === "string") {
              removeResolvedInteraction(sid, d.interactionId);
            }
            continue;
          }
        }
        // ---- 收尾帧观察：finish/error 即时拉快照（起跑前失败兜底）----
        if (this.inflight.size === 0) continue;
        const requestId = parsed.id;
        if (!requestId || !this.inflight.has(requestId)) continue;
        const type = parsed.chunk?.type;
        if (type === "finish" || type === "error") {
          const sessionId = this.inflight.get(requestId)!;
          this.inflight.delete(requestId);
          void this.refreshNow(sessionId);
        }
      }
    });
    // sidecar 退出：清重建台账，逐订阅线程拉快照自愈（空闲态 + 已落盘内容）
    await listen<string>("pi-exit", () => {
      this.streams.clear();
      for (const sessionId of this.listeners.keys()) void this.refreshNow(sessionId);
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
    this.lastSeq.set(sessionId, Math.max(this.lastSeq.get(sessionId) ?? 0, seq));
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
      }
      event = { ...body, threadId: sessionId, seq } as unknown as PiClientEvent;
    }
    for (const listener of set) {
      try {
        listener(event);
      } catch (err) {
        console.error("[TauriPiClient] listener threw", err);
      }
    }
  }

  // ---------- PiClient 契约 ----------

  async listThreads(): Promise<PiThreadMetadata[]> {
    const [sessionsRes, runningRes] = await Promise.all([
      piRequest<{ type: "sessions"; sessions: PiSessionSummary[] }>({
        type: "list_sessions",
      }),
      piRequest<{ type: "running"; sessionIds: string[] }>({
        type: "list_running",
      }),
    ]);
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
    const res = await piRequest<Extract<PiResponse, { type: "session" }>>({
      type: "new_session",
      threadId: `pi-${crypto.randomUUID()}`,
      cwd: input?.workspacePath ?? getWorkspace() ?? undefined,
    });
    return this.fetchSnapshot(res.sessionId);
  }

  async getThread(threadId: string): Promise<PiThreadSnapshot> {
    return this.fetchSnapshot(threadId);
  }

  async sendMessage(threadId: string, input: PiSendMessageInput): Promise<void> {
    const requestId = `pi-${crypto.randomUUID()}`;
    // steer 意图桥接（4a）：composer 的 Alt+点击 / Shift+⌘+Enter 在发送前置
    // markSteerNextSend 标记（模块级单跳信号，runConfig 不透传）。显式
    // streamingBehavior 优先；无显式行为且标记在 → 升级为 steer（含控制器
    // 忙时默认派生的 followUp——标记只会在「用户明确要点并入」时存在）。
    const steer = input.streamingBehavior === "steer" || consumeSteerIntent(threadId);
    // 运行中发送 = followUp（sidecar 自动排队）；steer 显式并入当前轮
    this.inflight.set(requestId, threadId);
    void this.ensureEventWatcher();
    try {
      await invoke("pi_prompt", {
        requestId,
        text: input.content,
        // running 键统一用 sessionId：abort/steer/队列按同键命中
        threadId,
        sessionId: threadId,
        cwd: getWorkspace() ?? null,
        attachments:
          input.attachments?.map((a, i) => ({
            name: `image-${i}.${a.mimeType.split("/")[1] ?? "png"}`,
            mimeType: a.mimeType,
            data: a.data,
          })) ?? null,
        steer,
      });
    } catch (err) {
      this.inflight.delete(requestId);
      throw err;
    }
  }

  async cancelRun(threadId: string): Promise<void> {
    await invoke("pi_abort", { threadId });
  }

  /** 整队清空（4a 实装）：queue_clear 命令，返回被清文本供 UI 回填 composer。 */
  async clearQueue(threadId: string): Promise<{ steering: string[]; followUp: string[] }> {
    const res = await piRequest<{
      cleared?: string[];
    } & PiResponse>({ type: "queue_clear", threadId });
    return { steering: [], followUp: res.cleared ?? [] };
  }

  /** 逐项队列操作（4a）：id = 真实 reqId，直通 sidecar 队列引擎。
   *  状态更新由引擎的 queue_update 事件回流，客户端不做本地乐观改写。 */
  async queueCancel(threadId: string, id: string): Promise<void> {
    await piRequest({ type: "queue_cancel", requestId: id });
    void threadId;
  }

  async queuePromote(threadId: string, id: string): Promise<void> {
    await piRequest({ type: "queue_promote", requestId: id });
    void threadId;
  }

  async queueSteer(threadId: string, id: string): Promise<void> {
    await piRequest({ type: "queue_steer", requestId: id });
    void threadId;
  }

  /** 弹出队首（4a：刷新接力泵的孤儿队列场景）。线程忙或链节仍在时
   *  popped 为 null（sidecar 双保险），泵据此判定无孤儿、转由事件流接力。 */
  async queuePop(threadId: string): Promise<PiQueueEntry | null> {
    const res = await piRequest<{
      popped?: { reqId: string; text: string; sessionId?: string } | null;
    } & PiResponse>({ type: "queue_pop", threadId });
    const popped = res.popped;
    return popped ? { id: popped.reqId, content: popped.text } : null;
  }

  async getAvailableModels(): Promise<PiModelInfo[]> {
    const res =
      await piRequest<Extract<PiResponse, { type: "models" }>>({
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
    await piRequest({ type: "set_model", ...input, sessionId: threadId });
  }

  async setThinkingLevel(threadId: string, level: PiThinkingLevel): Promise<void> {
    // 阶段 2 全局档位（sidecar set_thinking 无会话定靶形参）；会话级在阶段 4
    void threadId;
    await piRequest({ type: "set_thinking", level });
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    await piRequest({ type: "rename_session", sessionId: threadId, name: title });
  }

  async archiveThread(threadId: string): Promise<void> {
    await piRequest({ type: "archive_session", sessionId: threadId, archived: true });
  }

  async unarchiveThread(threadId: string): Promise<void> {
    await piRequest({ type: "archive_session", sessionId: threadId, archived: false });
  }

  async deleteThread(threadId: string): Promise<void> {
    await piRequest({ type: "delete_session", sessionId: threadId });
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
      await piRequest({
        type: "tool_confirm",
        threadId,
        approvalId: response.requestId,
        approved: response.confirmed,
      });
      return;
    }
    // select/input/editor 应答无处可去：按拒绝结算，别让审批永久挂起
    await piRequest({
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
    // 之后实时事件增量，收尾帧/退出兜底拉快照
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
