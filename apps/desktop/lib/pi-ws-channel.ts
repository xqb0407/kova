"use client";

import type { UIMessageChunk } from "ai";
import type {
  PiAutomationFrame,
  PiChannel,
  PiChannelStatus,
  PiPluginOpFrame,
  PiRunningTurn,
  PromptStreamArgs,
} from "@/lib/pi-channel";
import type { PiResponse } from "@/lib/pi-bridge";

/**
 * 远程 WebSocket 通道：浏览器 ⇄ 桌面端 remote.rs WS 网关 ⇄ pi-agent sidecar。
 *
 * 第一层协议（见 src-tauri/src/remote.rs）：
 *   连接后先发 {"type":"auth","token"} → {"type":"authed"}；
 *   之后客户端消息为 sidecar 原样 NDJSON（id 由本通道注入），
 *   服务端回发 sidecar 原样行（{id, chunk} 流或管理响应，id 已还原），
 *   另有无 id 自发通知行（turn_changed / subagent_activity）的广播。
 *
 * auth 完成前的消息先入队，authed 后统一发出（防 unauthorized 竞态）。
 * 异常断开时自动重连一次，再失败则交由 UI 呈现状态。
 *
 * 通道能力：未实现 attachStream（刷新重挂）——进行中 run 的路由在连接断开时
 * 被网关摘除，需网关侧保留路由 + resume 协议（二期）。缺省即降级：transport
 * 清掉 resumable 登记，刷新后回落历史加载（run 本身仍在 sidecar 跑完）。
 * subscribeTurns/listRunning/listRunningTurns 已接入：网关把无 id 通知行
 * 广播给已认证连接（remote.rs broadcast_notification），侧边栏运行指示与
 * 桌面端同源（断线/重连发 (null,false) 让订阅方清空并重新水合）。
 */
export class WsPiChannel implements PiChannel {
  readonly kind = "ws" as const;

  private ws: WebSocket | null = null;
  private ready = false;
  private closedByUser = false;
  private retriedOnce = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  /** auth 完成前的出站缓冲 */
  private queue: string[] = [];
  private pending = new Map<
    string,
    {
      resolve: (r: PiResponse) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private streams = new Map<
    string,
    { controller: ReadableStreamDefaultController<UIMessageChunk> }
  >();
  private statusCbs = new Set<(s: PiChannelStatus) => void>();
  private turnCbs = new Set<(sessionId: string | null, active: boolean) => void>();
  private automationCbs = new Set<(frame: PiAutomationFrame) => void>();
  private pluginOpCbs = new Set<(frame: PiPluginOpFrame) => void>();

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {
    this.connect();
  }

  private connect() {
    this.ready = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", token: this.token }));
    };
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onclose = () => this.onClose();
    ws.onerror = () => {
      /* onclose 会随后触发，错误细节浏览器不提供 */
    };
  }

  private emitStatus(s: PiChannelStatus) {
    for (const cb of this.statusCbs) {
      try {
        cb(s);
      } catch {
        /* 回调异常不影响通道 */
      }
    }
  }

  private onClose() {
    this.ws = null;
    const wasReady = this.ready;
    this.ready = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("connection closed"));
    }
    this.pending.clear();
    for (const s of this.streams.values()) {
      s.controller.enqueue({
        type: "error",
        errorText: "connection closed",
      } as UIMessageChunk);
      s.controller.close();
    }
    this.streams.clear();
    // 事件流随连接中断：订阅方（pi-running）据此作废快照，重连 authed 后重新水合
    for (const cb of this.turnCbs) cb(null, false);

    if (this.closedByUser) return;
    // 异常断开：自动重连一次，再失败交 UI
    if (wasReady && !this.retriedOnce) {
      this.retriedOnce = true;
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      this.emitStatus({ connected: false, error: "reconnecting..." });
    } else {
      this.emitStatus({ connected: false, error: "disconnected" });
    }
  }

  private onMessage(raw: string) {
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = v.type as string | undefined;

    if (type === "authed") {
      this.ready = true;
      const queue = this.queue;
      this.queue = [];
      for (const line of queue) this.ws?.send(line);
      this.emitStatus({ connected: true });
      // 重连成功：告知订阅方事件源已换代，清空并按 listRunning 重新水合
      for (const cb of this.turnCbs) cb(null, false);
      return;
    }

    // sidecar 无 id 自发通知行（网关只把白名单类型广播给已认证连接）
    if (type === "turn_changed") {
      const sessionId = typeof v.sessionId === "string" ? v.sessionId : null;
      if (sessionId) {
        for (const cb of this.turnCbs) cb(sessionId, v.active === true);
      }
      return;
    }
    // 定时任务通知帧（remote.rs 白名单同款放行）
    if (type === "automation_fired" || type === "automation_run_done") {
      const frame = v as unknown as PiAutomationFrame;
      if (typeof frame.taskId === "string") {
        for (const cb of this.automationCbs) cb(frame);
      }
      return;
    }
    // 插件耗时操作结果帧（remote.rs 白名单同款放行）
    if (type === "plugin_op_result") {
      const frame = v as unknown as PiPluginOpFrame;
      if (typeof frame.opId === "string") {
        for (const cb of this.pluginOpCbs) cb(frame);
      }
      return;
    }

    // 协议层错误（无 id）：auth 失败/认证超时等
    if (type === "error" && v.id === undefined && !("chunk" in v)) {
      const errorText = String(v.errorText ?? "protocol error");
      this.emitStatus({ connected: this.ready, error: errorText });
      if (!this.ready) {
        // 认证不通过，重连无意义
        this.closedByUser = true;
        this.ws?.close();
      }
      return;
    }

    if (type === "closed") {
      this.closedByUser = true;
      this.ws?.close();
      return;
    }

    const id = typeof v.id === "string" ? v.id : undefined;

    // prompt chunk 流：{id, chunk}
    if ("chunk" in v && id) {
      const entry = this.streams.get(id);
      const chunk = v.chunk as UIMessageChunk | undefined;
      if (!entry || !chunk) return;
      entry.controller.enqueue(chunk);
      if (chunk.type === "finish" || chunk.type === "error") {
        this.streams.delete(id);
        entry.controller.close();
      }
      return;
    }

    // 管理类响应：带 id 的一次性请求-响应
    if (id) {
      const entry = this.pending.get(id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve(v as PiResponse);
    }
  }

  /** 就绪直发；socket 建立/认证中则入队（authed 后 flush）；无连接返回 false */
  private sendRaw(value: Record<string, unknown>): boolean {
    const line = JSON.stringify(value);
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(line);
      return true;
    }
    if (this.ws && !this.ready) {
      this.queue.push(line);
      return true;
    }
    return false;
  }

  request(
    payload: Record<string, unknown>,
    timeoutMs = 15000,
  ): Promise<PiResponse> {
    const id = `ws-${++this.seq}-${Date.now()}`;
    return new Promise<PiResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("pi-agent request timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sendRaw({ ...payload, id });
    });
  }

  promptStream(args: PromptStreamArgs): ReadableStream<UIMessageChunk> {
    const { requestId, text, threadId, sessionId, cwd, abortSignal } = args;
    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        // 先挂流再发 prompt，避免漏掉最早的 chunk
        this.streams.set(requestId, { controller });
        abortSignal?.addEventListener(
          "abort",
          () => {
            void this.abort(threadId);
          },
          { once: true },
        );
        const ok = this.sendRaw({
          type: "prompt",
          id: requestId,
          text,
          threadId,
          sessionId: sessionId ?? null,
          cwd: cwd ?? null,
          // 远程路径网关原样转发 JSON，附件直接随帧（sidecar 闸门兜底）
          attachments: args.attachments ?? null,
          // 并入当前轮（steer）：sidecar 忙线程注入活跃轮，本请求退化流收尾
          steer: args.steer === true,
        });
        if (!ok) {
          // 无连接且未入队：立即报错收流
          this.streams.delete(requestId);
          controller.enqueue({
            type: "error",
            errorText: "not connected",
          } as UIMessageChunk);
          controller.close();
        }
      },
      cancel: () => {
        this.streams.delete(requestId);
      },
    });
  }

  async abort(threadId?: string) {
    this.sendRaw({ type: "abort", threadId: threadId ?? null });
  }

  /** 与 Tauri 通道同款语义：登记同步返回（ws onmessage 即事件源），退订即摘除 */
  subscribeTurns(
    cb: (sessionId: string | null, active: boolean) => void,
  ): () => void {
    this.turnCbs.add(cb);
    return () => this.turnCbs.delete(cb);
  }

  subscribeAutomationEvents(cb: (frame: PiAutomationFrame) => void): () => void {
    this.automationCbs.add(cb);
    return () => this.automationCbs.delete(cb);
  }

  subscribePluginOps(cb: (frame: PiPluginOpFrame) => void): () => void {
    this.pluginOpCbs.add(cb);
    return () => this.pluginOpCbs.delete(cb);
  }

  async listRunning(): Promise<string[]> {
    const res = await this.request({ type: "list_running" });
    return res.type === "running" ? res.sessionIds : [];
  }

  async listRunningTurns(): Promise<PiRunningTurn[]> {
    const res = await this.request({ type: "list_running" });
    // 旧网关/旧 sidecar 应答无 turns 字段：空清单 = 登记重建能力自动缺位
    const turns =
      res.type === "running" ? (res as { turns?: unknown }).turns : undefined;
    if (!Array.isArray(turns)) return [];
    return turns.filter(
      (t): t is PiRunningTurn =>
        !!t &&
        typeof (t as PiRunningTurn).sessionId === "string" &&
        typeof (t as PiRunningTurn).requestId === "string",
    );
  }

  close() {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.emitStatus({ connected: false });
  }

  onStatusChange(cb: (s: PiChannelStatus) => void): () => void {
    this.statusCbs.add(cb);
    return () => this.statusCbs.delete(cb);
  }
}
