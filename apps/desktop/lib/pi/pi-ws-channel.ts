"use client";

import type {
  PiAutomationFrame,
  PiChannel,
  PiChannelStatus,
  PiContextChangedFrame,
  PiDesignThemePush,
  PiPluginOpFrame,
  PiRunningTurn,
} from "@/lib/pi/pi-channel";
import type { PiResponse } from "@/lib/pi/pi-bridge";

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
 * prompt chunk 流不走本类状态：PiClientBase（迁移 5c）经 onRawLine 看到
 * 全部原始行（含 {id, chunk} 帧）自行分流重建 partial；本类只保留
 * 管理类请求-响应与无 id 通知订阅。
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
  private statusCbs = new Set<(s: PiChannelStatus) => void>();
  private turnCbs = new Set<(sessionId: string | null, active: boolean) => void>();
  private automationCbs = new Set<(frame: PiAutomationFrame) => void>();
  private pluginOpCbs = new Set<(frame: PiPluginOpFrame) => void>();
  private contextCbs = new Set<(frame: PiContextChangedFrame) => void>();
  private designCbs = new Set<(frame: PiDesignThemePush) => void>();
  /** 原始行观察（迁移阶段 5c）：WsPiClient 的 thread_event/chunk 分流入口 */
  private rawCbs = new Set<(raw: string) => void>();
  private closeCbs = new Set<() => void>();
  private authedCbs = new Set<() => void>();

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
    // 事件流随连接中断：订阅方（pi-running）据此作废快照，重连 authed 后重新水合
    for (const cb of this.turnCbs) cb(null, false);
    // 事件源换代（5c）：在飞 chunk 路由全灭，基座清流式台账；authed 后再触发
    // 一次重新拉快照自愈
    for (const cb of this.closeCbs) cb();

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
    // 原始行先行喂观察者（5c）：分发器只认识自己关心的帧，WsPiClient 的
    // thread_event/chunk 分流在基座，必须看到全部行
    for (const cb of this.rawCbs) cb(raw);
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
      // 重连成功：运行投影经 (null,false) 清空并按 list_running 重新水合
      for (const cb of this.turnCbs) cb(null, false);
      // 重连换代（5c）：断线空洞无法补齐，基座逐订阅线程拉快照自愈
      for (const cb of this.authedCbs) cb();
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
    // 上下文读数推送帧（§7，remote.rs 白名单同款放行）
    if (type === "context_changed") {
      const frame = v as unknown as PiContextChangedFrame;
      if (typeof frame.sessionId === "string") {
        for (const cb of this.contextCbs) cb(frame);
      }
      return;
    }
    // 设计主题推送帧（remote.rs 白名单同款放行）。注意：这两个 type 同时也是
    // 应答类型——只有无 id 的自发帧才进推送分发，带 id 的照旧走下方 pending 配对
    if (
      (type === "design_themes" || type === "design_theme_set") &&
      v.id === undefined
    ) {
      const frame = v as unknown as PiDesignThemePush;
      for (const cb of this.designCbs) cb(frame);
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

    // 管理类响应：带 id 的一次性请求-响应。prompt chunk 帧（{id, chunk}）
    // 无 pending 配对，在此自然落空返回——实时流由 PiClientBase 经
    // onRawLine 分流（见文件头注释）
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

  subscribeContextChanges(cb: (frame: PiContextChangedFrame) => void): () => void {
    this.contextCbs.add(cb);
    return () => this.contextCbs.delete(cb);
  }

  subscribeDesignThemes(cb: (frame: PiDesignThemePush) => void): () => void {
    this.designCbs.add(cb);
    return () => this.designCbs.delete(cb);
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

  // ---------- 新链路（迁移阶段 5c）：PiClientBase 传输依赖的 WS 侧实现 ----------

  /** 原始行观察：onMessage 解析前喂全部行（thread_event 广播与 prompt chunk
   *  流都在内），WsPiClient 据此分流。退订即摘除 */
  onRawLine(cb: (raw: string) => void): () => void {
    this.rawCbs.add(cb);
    return () => this.rawCbs.delete(cb);
  }

  /** 连接断开观察（事件源换代之一）：在飞 chunk 路由全灭。
   *  不叫 onClose——类内已有 WebSocket close 私有处理器 */
  onDisconnected(cb: () => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  /** 认证完成观察（事件源换代之二）：断线空洞后重拉快照自愈 */
  onAuthed(cb: () => void): () => void {
    this.authedCbs.add(cb);
    return () => this.authedCbs.delete(cb);
  }

  /** 发起 prompt（fire-and-forget，chunk 行按 id 回流）。
   *  返回 false = 无连接且未入队（调用方按发送失败处理） */
  sendPromptFrame(args: {
    requestId: string;
    text: string;
    threadId: string;
    cwd: string | null;
    attachments: import("@/lib/pi/pi-channel").PiPromptAttachment[] | null;
    steer: boolean;
    goalMaxAutoTurns?: number;
  }): boolean {
    return this.sendRaw({
      type: "prompt",
      id: args.requestId,
      text: args.text,
      threadId: args.threadId,
      // 远程链路线程身份 = sessionId（与桌面新链路一致），running 键同键
      sessionId: args.threadId,
      cwd: args.cwd,
      // 远程路径网关原样转发 JSON，附件直接随帧（sidecar 闸门兜底）
      attachments: args.attachments,
      // 并入当前轮（steer）：sidecar 忙线程注入活跃轮
      steer: args.steer === true,
      goalMaxAutoTurns: args.goalMaxAutoTurns,
    });
  }
}
