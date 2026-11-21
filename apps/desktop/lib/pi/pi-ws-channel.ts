"use client";

import type {
  PiAutomationFrame,
  PiChannel,
  PiChannelStatus,
  PiContextChangedFrame,
  PiDesignThemePush,
  PiMcpAuthFrame,
  PiPluginOpFrame,
  PiProjectsChangedFrame,
  PiRunningTurn,
  PiSessionsChangedFrame,
} from "@/lib/pi/pi-channel";
import type { PiResponse } from "@/lib/pi/pi-bridge";
import { channelTimeoutMs, type InboxChangedFrame } from "pi-protocol";

/**
 * 远程 WebSocket 通道：浏览器 ⇄ 桌面端 remote.rs WS 网关 ⇄ pi-agent sidecar。
 *
 * 第一层协议（见 原 Rust 宿主的 remote.rs）：
 *   连接后先发 {"type":"auth","token"} → {"type":"authed"}；
 *   之后客户端消息为 sidecar 原样 NDJSON（id 由本通道注入），
 *   服务端回发 sidecar 原样行（{id, chunk} 流或管理响应，id 已还原），
 *   另有无 id 自发通知行（turn_changed / subagent_activity）的广播。
 *
 * auth 完成前的消息先入队，authed 后统一发出（防 unauthorized 竞态）。
 *
 * 重连策略（与移动端同款）：后台指数退避（3s 起、倍增至 30s 封顶、带抖动），
 * authed 即清零；authed 后起应用层心跳（25s ping、8s 无 pong 判半开并重连）。
 * 网关没有应用层心跳、也没有 authed 后的空闲超时，半开连接只能靠下一次写
 * 失败或主动探活暴露。连续失败上限后置 disconnected 交 UI。
 *
 * prompt 投递确认（断线语义）：prompt 帧进入 outbox 台账，收到任意同 id 回帧
 * （网关 accepted / start / queue 快照 / finish）即出账；断线重连后把未出账的
 * prompt 原样重发。网关按 requestId 幂等去重，重发不会重复执行。
 *
 * prompt chunk 流不走本类状态：PiClientBase（迁移 5c）经 onRawLine 看到
 * 全部原始行（含 {id, chunk} 帧）自行分流重建 partial；本类只保留
 * 管理类请求-响应与无 id 通知订阅。
 * subscribeTurns/listRunning/listRunningTurns 已接入：网关把无 id 通知行
 * 广播给已认证连接（remote.rs broadcast_notification），侧边栏运行指示与
 * 桌面端同源（断线/重连发 (null,false) 让订阅方清空并重新水合）。
 */
/** 连续失败上限：3+6+12+24+30×4 ≈ 3 分钟后停手交 UI，不再无限静默重试 */
const MAX_RECONNECT_ATTEMPTS = 8;
/** 应用层心跳周期：网关没有心跳也没有 authed 后的空闲超时，半开连接只能自戳 */
const KEEPALIVE_MS = 25_000;
/** 单轮 ping→pong 的等待上限：超时即判半开，杀掉这条连接走退避重连 */
const PING_TIMEOUT_MS = 8_000;
/** 未送达 prompt 台账上限：断线期间最多攒这么多条，超出按发送失败交给调用方 */
const PROMPT_OUTBOX_LIMIT = 64;

/** prompt outbox 条目：line 是原始出站帧（重发幂等依赖同一 requestId）；
 *  delivered 区分「已进过 socket」与「断线期间还没发出去」——收尾清理只动
 *  前者，离线攒下的消息必须留到重连补发。 */
type PromptOutboxEntry = { line: string; threadId: string; delivered: boolean };

export class WsPiChannel implements PiChannel {
  readonly kind = "ws" as const;

  private ws: WebSocket | null = null;
  private ready = false;
  private closedByUser = false;
  /** 网关支持 accepted 幂等去重（authed 帧声明）；老网关不重发已投递项 */
  private dedupSupported = false;
  /** 连续失败次数（authed 清零），驱动指数退避 */
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 应用层心跳定时器（authed 起、断开/关闭止） */
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  /** auth 完成前的出站缓冲（管理帧；prompt 走 outbox 单独重发） */
  private queue: string[] = [];
  /** 未确认送达的 prompt（requestId → 原始帧）。任何同 id 回帧即出账 */
  private promptOutbox = new Map<string, PromptOutboxEntry>();
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
  private inboxCbs = new Set<(frame: InboxChangedFrame) => void>();
  private sessionsCbs = new Set<(frame: PiSessionsChangedFrame | null) => void>();
  private projectsCbs = new Set<(frame: PiProjectsChangedFrame | null) => void>();
  private pluginOpCbs = new Set<(frame: PiPluginOpFrame) => void>();
  private mcpAuthCbs = new Set<(frame: PiMcpAuthFrame) => void>();
  private contextCbs = new Set<(frame: PiContextChangedFrame) => void>();
  private designCbs = new Set<(frame: PiDesignThemePush) => void>();
  /** sidecar 换代广播（pi_restarted）：在跑线程快照归位 */
  private restartCbs = new Set<() => void>();
  /** 原始行观察（迁移阶段 5c）：WsPiClient 的 thread_event/chunk 分流入口 */
  private rawCbs = new Set<(raw: string) => void>();
  private closeCbs = new Set<() => void>();
  private authedCbs = new Set<() => void>();
  /** 最近一次状态（订阅时立即回放一次：横幅/设置页挂载即拿到现状） */
  private lastStatus: PiChannelStatus = { connected: false };

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
    ws.onclose = () => this.onClose(ws);
    ws.onerror = () => {
      /* onclose 会随后触发，错误细节浏览器不提供 */
    };
  }

  private emitStatus(s: PiChannelStatus) {
    this.lastStatus = s;
    for (const cb of this.statusCbs) {
      try {
        cb(s);
      } catch {
        /* 回调异常不影响通道 */
      }
    }
  }

  private onClose(ws: WebSocket) {
    // 只处理"当前这条"连接的断开：reconnectNow 换连接时，旧 socket 的 onclose
    // 会在新 socket 建好之后才到，无条件 this.ws = null 会误杀新连接
    if (this.ws !== ws) return;
    this.ws = null;
    this.ready = false;
    this.stopKeepalive();
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
    this.scheduleReconnect();
  }

  /**
   * 断线重连：3s 起指数退避、30s 封顶、带 1s 抖动（多台设备同时唤醒时
   * 避免齐刷刷撞网关）。连续 MAX_RECONNECT_ATTEMPTS 次仍连不上就停手，
   * 置 disconnected 交 UI。
   */
  private scheduleReconnect() {
    if (this.reconnectTimer || this.closedByUser) return;
    if (this.attempt >= MAX_RECONNECT_ATTEMPTS) {
      this.emitStatus({ connected: false, error: "disconnected" });
      return;
    }
    const base = Math.min(3000 * 2 ** this.attempt, 30000);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, base + Math.floor(Math.random() * 1000));
    this.emitStatus({ connected: false, error: "reconnecting..." });
  }

  /** 立即重试一次不等退避（UI「重试」按钮/前台唤醒用）。
   *  显式重试视作新意图：清掉 closedByUser（auth 失败/网关关闭后的手动重试）。 */
  reconnectNow() {
    this.attempt = 0;
    this.closedByUser = false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.probeAlive();
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const stale = this.ws;
    this.ws = null;
    try {
      stale?.close();
    } catch {
      /* 已断开，关掉旧句柄即可 */
    }
    this.connect();
  }

  // ---------- 应用层心跳（半开连接探测器） ----------

  private startKeepalive() {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => this.probeAlive(), KEEPALIVE_MS);
  }

  private stopKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  /** 发一条 ping：PING_TIMEOUT_MS 内没有 pong 回来就判半开。
   *  半开 socket 的 close() 可能迟迟不触发 onclose，所以不等系统回调，
   *  直接手动驱动 onClose 进重连；晚到的 onclose 由「只认当前 socket」守卫吞掉。 */
  private probeAlive() {
    const ws = this.ws;
    if (!this.ready || !ws) return;
    this.request({ type: "ping" }, PING_TIMEOUT_MS).catch(() => {
      if (this.ws !== ws) return; // 期间已经换链/断链，不归本轮探测管
      try {
        ws.close();
      } catch {
        /* 已经在关 */
      }
      this.onClose(ws);
    });
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
    const id = typeof v.id === "string" ? v.id : undefined;
    // 任意同 id 回帧 = prompt 已到达 sidecar（网关 accepted / 流式 chunk /
    // 队列快照 / finish 都会带原 requestId）。出账后不再重发。
    if (id && this.promptOutbox.delete(id)) {
      /* ack 记账，帧照常往下分发 */
    }

    if (type === "authed") {
      this.ready = true;
      // 老网关不带 accepted：只补发从未出站的 prompt，已投递的不重发（无去重）
      this.dedupSupported = v.accepted === true;
      // 连通即视为网络恢复：退避计数归零，下次断开从 3s 重新起算
      this.attempt = 0;
      this.startKeepalive();
      const queue = this.queue;
      this.queue = [];
      for (const line of queue) this.ws?.send(line);
      // 断线期间未确认的 prompt 重发；网关按 requestId 幂等去重，不会重复执行
      this.flushOutbox();
      this.emitStatus({ connected: true });
      // 重连成功：运行投影经 (null,false) 清空并按 list_running 重新水合
      for (const cb of this.turnCbs) cb(null, false);
      // 清单变更订阅（sessions_changed）：断档期变化无法回补，cb(null)
      // 提示订阅方重拉一次会话列表兜底
      for (const cb of this.sessionsCbs) cb(null);
      // 项目实体变更（projects_changed）：断档期同样提示重拉项目清单
      for (const cb of this.projectsCbs) cb(null);
      // 重连换代（5c）：断线空洞无法补齐，基座逐订阅线程拉快照自愈
      for (const cb of this.authedCbs) cb();
      return;
    }

    // sidecar 无 id 自发通知行（网关只把白名单类型广播给已认证连接）
    // sidecar 换代广播：与桌面同源（remote.ts 白名单放行）。远程窗口据此
    // 对在跑线程拉快照归位——旧实例的 running 表已清零，agent_end 不会再来
    if (type === "pi_restarted") {
      for (const cb of this.restartCbs) cb();
      return;
    }
    if (type === "turn_changed") {
      const sessionId = typeof v.sessionId === "string" ? v.sessionId : null;
      if (sessionId) {
        if (v.active === false) this.dropOutboxForThread(sessionId);
        for (const cb of this.turnCbs) cb(sessionId, v.active === true);
      }
      return;
    }
    // thread_event 只在会话收尾时清 outbox（agent_end 意味着该线程此前收到的
    // prompt 已全部进入处理流程，未出账的重发也没有意义）
    if (type === "thread_event") {
      const event = v.event as { type?: unknown } | undefined;
      if (event?.type === "agent_end" && typeof v.sessionId === "string") {
        this.dropOutboxForThread(v.sessionId);
      }
      return;
    }
    // Inbox 计数变更帧（remote.rs 白名单同款放行）：只更新徽标/触发重拉
    if (type === "inbox_changed" && v.id === undefined) {
      const frame = v as unknown as InboxChangedFrame;
      if (frame.counts) {
        for (const cb of this.inboxCbs) cb(frame);
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
    // MCP OAuth 授权结果帧（remote.rs 白名单同款放行）
    if (type === "mcp_auth_result") {
      const frame = v as unknown as PiMcpAuthFrame;
      if (typeof frame.name === "string") {
        for (const cb of this.mcpAuthCbs) cb(frame);
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
    // 会话清单变更帧（remote.rs 白名单同款放行）：另一端建/删/改名/归档会话
    if (type === "sessions_changed" && v.id === undefined) {
      const frame = v as unknown as PiSessionsChangedFrame;
      if (typeof frame.sessionId === "string") {
        for (const cb of this.sessionsCbs) cb(frame);
      }
      return;
    }
    // 项目实体变更帧（save/delete 后广播）：重拉项目注册表
    if (type === "projects_changed" && v.id === undefined) {
      const frame = v as unknown as PiProjectsChangedFrame;
      for (const cb of this.projectsCbs) cb(frame);
      return;
    }

    // 协议层错误（无 id）：auth 失败/认证超时等
    if (type === "error" && v.id === undefined && !("chunk" in v)) {
      const errorText = String(v.errorText ?? "protocol error");
      this.emitStatus({ connected: this.ready, error: errorText });
      if (!this.ready) {
        // 认证不通过，重连无意义
        this.closedByUser = true;
        this.promptOutbox.clear();
        this.ws?.close();
      }
      return;
    }

    if (type === "closed") {
      this.closedByUser = true;
      this.promptOutbox.clear();
      this.ws?.close();
      return;
    }

    // 网关 accepted 已在上方出账；这里只处理带 id 的管理类应答。
    // prompt chunk 帧（{id, chunk}）没有 pending 配对，在此自然落空返回——
    // 实时流由 PiClientBase 经 onRawLine 分流（见文件头注释）
    if (id) {
      const entry = this.pending.get(id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve(v as PiResponse);
    }
  }

  /** 重连后补发台账里的 prompt；单条发送失败留在台账等下一轮。
   *  已投递过的条目只在网关声明支持 accepted 幂等去重时重发——老网关没有
   *  去重能力，重发会把同一条消息执行两遍。 */
  private flushOutbox() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    for (const [requestId, entry] of this.promptOutbox) {
      if (entry.delivered && !this.dedupSupported) {
        this.promptOutbox.delete(requestId);
        continue;
      }
      try {
        ws.send(entry.line);
        entry.delivered = true;
      } catch {
        /* 留在台账，下一次重连再试 */
      }
    }
  }

  /** 收尾清理：只摘已投递过的条目；断线期间还没发出去的必须留到重连补发 */
  private dropOutboxForThread(threadId: string) {
    for (const [id, entry] of this.promptOutbox) {
      if (entry.threadId === threadId && entry.delivered) this.promptOutbox.delete(id);
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
    timeoutMs?: number,
  ): Promise<PiResponse> {
    // 超时预算取自协议表（pi-protocol/timeouts），与桌面通道同款：慢命令的侧车侧
    // 上限远大于默认 15s，写短了（或不写）一律抬到预算，别让这一层白报超时
    const type = typeof payload?.type === "string" ? payload.type : "";
    const budget = channelTimeoutMs(type);
    const waitMs = Math.max(timeoutMs ?? 0, budget);
    if (timeoutMs !== undefined && timeoutMs < budget) {
      console.warn(
        `[pi-ws-channel] ${type || "<no type>"} 的显式超时 ${timeoutMs}ms 低于预算 ${budget}ms，已抬到预算`,
      );
    }
    const id = `ws-${++this.seq}-${Date.now()}`;
    return new Promise<PiResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("pi-agent request timed out"));
      }, waitMs);
      this.pending.set(id, { resolve, reject, timer });
      // 无连接时快速失败：此前只挂 15s 定时器再超时，界面上的操作白等一轮
      if (!this.sendRaw({ ...payload, id })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("not connected"));
      }
    });
  }

  async abort(threadId?: string) {
    this.sendRaw({ type: "abort", threadId: threadId ?? null });
  }

  /** 与 桌面通道同款语义：登记同步返回（ws onmessage 即事件源），退订即摘除 */
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

  subscribeInboxChanged(cb: (frame: InboxChangedFrame) => void): () => void {
    this.inboxCbs.add(cb);
    return () => this.inboxCbs.delete(cb);
  }

  subscribePluginOps(cb: (frame: PiPluginOpFrame) => void): () => void {
    this.pluginOpCbs.add(cb);
    return () => this.pluginOpCbs.delete(cb);
  }

  subscribeMcpAuth(cb: (frame: PiMcpAuthFrame) => void): () => void {
    this.mcpAuthCbs.add(cb);
    return () => this.mcpAuthCbs.delete(cb);
  }

  subscribeContextChanges(cb: (frame: PiContextChangedFrame) => void): () => void {
    this.contextCbs.add(cb);
    return () => this.contextCbs.delete(cb);
  }

  subscribeDesignThemes(cb: (frame: PiDesignThemePush) => void): () => void {
    this.designCbs.add(cb);
    return () => this.designCbs.delete(cb);
  }

  /** 与桌面通道同款语义：登记同步返回（ws onmessage 即事件源），退订即摘除 */
  subscribeSidecarRestart(cb: () => void): () => void {
    this.restartCbs.add(cb);
    return () => this.restartCbs.delete(cb);
  }

  subscribeSessionsChanged(
    cb: (frame: PiSessionsChangedFrame | null) => void,
  ): () => void {
    this.sessionsCbs.add(cb);
    // 登记即补一次 cb(null)：本连接建立前可能已有变化（且重连路径同款兜底），
    // 订阅方按"重拉清单"语义合并去抖即可
    cb(null);
    return () => this.sessionsCbs.delete(cb);
  }

  subscribeProjectsChanged(
    cb: (frame: PiProjectsChangedFrame | null) => void,
  ): () => void {
    this.projectsCbs.add(cb);
    cb(null);
    return () => this.projectsCbs.delete(cb);
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
    this.stopKeepalive();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.promptOutbox.clear();
    this.ws?.close();
    this.ws = null;
    this.emitStatus({ connected: false });
  }

  onStatusChange(cb: (s: PiChannelStatus) => void): () => void {
    this.statusCbs.add(cb);
    // 立即回放当前状态（订阅语义：先给现状，再等变化）
    cb(this.lastStatus);
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
   *  返回 false = 通道已关闭/台账已满（调用方按发送失败处理）。
   *  断线中返回 true：帧进 outbox，重连 authed 后自动补发。 */
  sendPromptFrame(args: {
    requestId: string;
    text: string;
    threadId: string;
    cwd: string | null;
    attachments: import("@/lib/pi/pi-channel").PiPromptAttachment[] | null;
    steer: boolean;
    goalMaxAutoTurns?: number;
    goalAcceptanceMode?: "auto" | "manual" | "skip";
    goalMaxDurationMinutes?: number;
  }): boolean {
    if (this.closedByUser) return false;
    if (this.promptOutbox.size >= PROMPT_OUTBOX_LIMIT) return false;
    const line = JSON.stringify({
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
      goalAcceptanceMode: args.goalAcceptanceMode,
      goalMaxDurationMinutes: args.goalMaxDurationMinutes,
    });
    const entry: PromptOutboxEntry = {
      line,
      threadId: args.threadId,
      delivered: false,
    };
    this.promptOutbox.set(args.requestId, entry);
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(line);
        entry.delivered = true;
      } catch {
        // 同步写失败（连接正在关）：撤回台账，按发送失败交给调用方，
        // 避免 UI 已报错、重连后又把同一条消息补发出去
        this.promptOutbox.delete(args.requestId);
        return false;
      }
    }
    // 未就绪时留在台账里：authed 后统一补发（含已发未确认的重发）
    return true;
  }
}
