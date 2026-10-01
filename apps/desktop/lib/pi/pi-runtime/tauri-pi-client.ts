"use client";

/**
 * TauriPiClient：PiClient 契约的桌面端实现（react-pi 迁移阶段 2）。
 *
 * - 管理类方法走 pi-channel 的 request 通道（invoke pi_request，管理队列串行）；
 * - getThread 走 sidecar 新命令 thread_snapshot（JSONL 转录 → PiThreadSnapshot）；
 * - sendMessage 复用现有 pi_prompt（带 sessionId 定靶），不消费 chunk 流——
 *   终态靠 chunk-batch 收尾帧观察 + 快照轮询落定（阶段 3 换 delta 化事件流）；
 * - subscribe 阶段 2 降级：登记 listener，不做实时事件；快照先发 + 运行期轮询。
 *
 * 线程身份 = pi sessionId（metadata.id）：usePiRuntime 的 controller 以它为键，
 * sidecar 侧 prompt/abort 的 running 键同样用 sessionId，两端一致。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { piRequest, type PiResponse, type PiSessionSummary } from "@/lib/pi/pi-bridge";
import { getWorkspace } from "@/lib/workspace/workspace-store";
import type {
  PiClient,
  PiClientEvent,
  PiHostUiResponse,
  PiModelInfo,
  PiSendMessageInput,
  PiThinkingLevel,
  PiThreadMetadata,
  PiThreadSnapshot,
} from "./types";

/** thread_snapshot 应答载荷 */
type SnapshotReply = { type: "thread_snapshot"; snapshot: PiThreadSnapshot };

/** pi-chunk-batch 载荷的一行（镜像 pi_agent.rs ChunkLine，pi-channel 未导出） */
type WireLine = { i: number | null; l: string };
/** pi-chunk-batch 里按 requestId 过滤后的 chunk 行（收尾帧观察用） */
type ChunkLine = { id?: string | null; chunk?: { type?: string } };

/** 每线程轮询动机：running = 快照看到在跑；pending = 刚发送、等 run 起来（会话
 *  准备段可能超过一个轮询间隔）；stamp = 上次派发快照的指纹（去重防抖动） */
type PollEntry = {
  running: boolean;
  pending: boolean;
  pendingSince: number;
  stamp: string;
};

/** pending 状态安全上限：prompt 起跑前异常且收尾帧丢失时不至于永久轮询 */
const PENDING_TIMEOUT_MS = 90_000;
/** 运行期快照轮询间隔：阶段 2 的降级通道，阶段 3 换事件流后整个轮询退役 */
const POLL_INTERVAL_MS = 1200;

export class TauriPiClient implements PiClient {
  private readonly listeners = new Map<string, Set<(e: PiClientEvent) => void>>();
  private readonly poll = new Map<string, PollEntry>();
  /** 在飞 prompt requestId → sessionId（收尾帧触发即时快照刷新） */
  private readonly inflight = new Map<string, string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private unlistenChunks: UnlistenFn | null = null;

  // ---------- 快照 ----------

  private async fetchSnapshot(sessionId: string): Promise<PiThreadSnapshot> {
    const res = await piRequest<SnapshotReply & PiResponse>({
      type: "thread_snapshot",
      sessionId,
    });
    return res.snapshot;
  }

  /** 快照指纹：seq/状态/条数/末条时间戳/挂起审批数——任一变化才派发，防每秒抖动 */
  private static fingerprint(s: PiThreadSnapshot): string {
    const last = s.messages.at(-1) as { timestamp?: number } | undefined;
    return [
      s.seq ?? "-",
      s.metadata.status,
      s.messages.length,
      last?.timestamp ?? "-",
      s.hostUiRequests?.length ?? 0,
      s.hostUiRequests?.[0]?.id ?? "",
    ].join("|");
  }

  private dispatch(snapshot: PiThreadSnapshot) {
    const set = this.listeners.get(snapshot.metadata.id);
    if (!set) return;
    const event: PiClientEvent = {
      type: "snapshot",
      snapshot,
      threadId: snapshot.metadata.id,
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

  /** 立即拉一次快照并按指纹去重派发（订阅首帧 / 收尾帧 / 轮询共用） */
  private async refreshNow(sessionId: string) {
    try {
      const snapshot = await this.fetchSnapshot(sessionId);
      const entry = this.poll.get(sessionId);
      const stamp = TauriPiClient.fingerprint(snapshot);
      if (entry && entry.stamp === stamp) {
        // 内容未变也要校准轮询动机（run 可能已在别处结束）
        entry.running = snapshot.metadata.status === "running";
        return;
      }
      if (entry) entry.stamp = stamp;
      this.dispatch(snapshot);
      if (entry) {
        entry.running = snapshot.metadata.status === "running";
        if (entry.running) entry.pending = false;
      }
    } catch {
      // sidecar 不可用/会话已删：静默，下个轮询节拍重试
    }
  }

  private ensurePollLoop() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollTick();
    }, POLL_INTERVAL_MS);
  }

  private async pollTick() {
    const now = Date.now();
    for (const [sessionId, entry] of this.poll) {
      if (!this.listeners.has(sessionId)) continue;
      if (!entry.running && !entry.pending) continue;
      if (
        entry.pending &&
        !entry.running &&
        now - entry.pendingSince > PENDING_TIMEOUT_MS
      ) {
        entry.pending = false;
      }
      await this.refreshNow(sessionId);
    }
  }

  // ---------- 收尾帧观察 ----------

  private async ensureChunkWatcher() {
    if (this.unlistenChunks) return;
    // 前缀预筛：只解析可能带 finish/error 的行，热路径开销与 subscribeTurns 同款
    this.unlistenChunks = await listen<WireLine[]>("pi-chunk-batch", (event) => {
      for (const wire of event.payload) {
        if (this.inflight.size === 0) return;
        if (
          !wire.l.includes('"finish"') &&
          !wire.l.includes('"error"') &&
          !wire.l.includes('"start"')
        ) {
          continue;
        }
        let parsed: ChunkLine;
        try {
          parsed = JSON.parse(wire.l);
        } catch {
          continue;
        }
        const requestId = parsed.id;
        if (!requestId || !this.inflight.has(requestId)) continue;
        const type = parsed.chunk?.type;
        if (type === "start") {
          // run 确认起跑：解除 pending，轮询以 running 语义继续
          const entry = this.poll.get(this.inflight.get(requestId)!);
          if (entry) {
            entry.pending = false;
            entry.running = true;
          }
          continue;
        }
        if (type === "finish" || type === "error") {
          const sessionId = this.inflight.get(requestId)!;
          this.inflight.delete(requestId);
          const entry = this.poll.get(sessionId);
          if (entry) {
            entry.pending = false;
            entry.running = false; // 由即时快照按事实校准（排队链可能续跑）
          }
          void this.refreshNow(sessionId);
        }
      }
    });
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
    const steer = input.streamingBehavior === "steer";
    // 运行中发送 = followUp（sidecar 自动排队）；steer 显式并入当前轮
    this.inflight.set(requestId, threadId);
    const entry = this.poll.get(threadId) ?? {
      running: false,
      pending: true,
      pendingSince: Date.now(),
      stamp: "",
    };
    entry.pending = true;
    entry.pendingSince = Date.now();
    this.poll.set(threadId, entry);
    this.ensurePollLoop();
    void this.ensureChunkWatcher();
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
      entry.pending = false;
      throw err;
    }
  }

  async cancelRun(threadId: string): Promise<void> {
    await invoke("pi_abort", { threadId });
  }

  /** 阶段 2 占位：Pi 契约只有整队清空；我们的逐项操作（合并/立即发送/删除）
   *  在阶段 4a 接 queue_cancel/queue_promote/queue_steer。 */
  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    return { steering: [], followUp: [] };
  }

  async getAvailableModels(): Promise<PiModelInfo[]> {
    const res = await piRequest<Extract<PiResponse, { type: "models" }>>({
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

  /** 阶段 2 只映射 confirm（逐工具审批）；question/editor 类在阶段 4b 接线 */
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
    if (!this.poll.has(threadId)) {
      this.poll.set(threadId, {
        running: false,
        pending: false,
        pendingSince: 0,
        stamp: "",
      });
    }
    this.ensurePollLoop();
    void this.ensureChunkWatcher();
    // 契约默认快照先行：冷读直接落定，后续靠轮询/收尾帧增量
    if (options?.includeSnapshot !== false) void this.refreshNow(threadId);
    return () => {
      const current = this.listeners.get(threadId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(threadId);
      // poll 表保留条目（running/pending 双 false 即零开销），不逐次清理
    };
  }
}
