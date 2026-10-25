/**
 * 微信 iLink 通道适配器：长轮询 monitor 循环 + 入站前置过滤 + 出站发文本。
 *
 * 循环职责（协议事实决定的门控，均在此层完成）：
 * - cursor（get_updates_buf）持久化进 kv，重启后从上次位置续传，不重放积压
 * - 只投 message_state=FINISH 的消息（NEW/GENERATING 是同一消息的中间态）
 * - 滤 BOT 自身消息（message_type=BOT 回环）与超过 10 分钟的旧消息
 *   （重启重放保护）
 * - 生命周期：start() 幂等、stop() 收轮询；会话过期（-14 等）转 reauth 态
 */
import { kvGet, kvSet } from "../../../store";
import { logInfo, logWarn } from "../../../logging";
import { getWechatCredential } from "../../router";
import type {
  ImChannelAdapter,
  ImChannelRuntimeConfig,
  ImChannelStatus,
  ImInboundMessage,
  ImOutboundTarget,
} from "../../types";
import { IlinkClient } from "./ilink-client";
import type { IlinkMessage } from "./ilink-protocol";

const CURSOR_KV_PREFIX = "im.wechat.cursor.";
const STALE_THRESHOLD_MS = 10 * 60_000;
const STOP_POLL_INTERVAL_MS = 200;
/** typing keepalive 上限（5s × 120 = 10min）：异常路径的自我过期兜底 */
const TYPING_MAX_KEEPALIVE_TICKS = 120;

export class WechatAdapter implements ImChannelAdapter {
  readonly platform = "wechat" as const;
  readonly channelId: string;

  private cfg: ImChannelRuntimeConfig | null = null;
  private running = false;
  /** 启动代际：stop→start 后旧长轮询必须失效，否则两条循环并存
   *  （cursor 互踩 + 平台侧重复拉取） */
  private generation = 0;
  private statusSnapshot: ImChannelStatus = { state: "unbound" };
  /** bot 用户 id（回环过滤纵深：SDK 侧过滤之外的兜底） */
  private botId = "";
  /** 进行中的 typing 会话（chatId → keepalive 定时器 + 票） */
  private typingSessions = new Map<
    string,
    { stop(): void; ticket: string | null }
  >();

  constructor(channelId: string) {
    this.channelId = channelId;
  }

  async start(cfg: ImChannelRuntimeConfig, sink: (msg: ImInboundMessage) => void): Promise<void> {
    if (this.running) return;
    const token = cfg.credentials.botToken;
    if (!token) {
      this.setStatus({ state: "unbound" });
      return;
    }
    this.cfg = cfg;
    this.botId = cfg.credentials.botId ?? "";
    this.running = true;
    const gen = ++this.generation;
    this.setStatus({ state: "connecting" });
    void this.loop(sink, gen);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.generation += 1; // 在飞循环就此失效（醒来后立即退出）
    // 等在飞的长轮询 fetch 返回（≤请求超时），至多等一拍
    const deadline = Date.now() + STOP_POLL_INTERVAL_MS;
    while (this.loopInFlight && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // 清掉进行中的 typing keepalive（不发取消：通道都要下线了）
    for (const session of this.typingSessions.values()) session.stop();
    this.typingSessions.clear();
    // 尽力通知服务端下线（失败忽略）
    const token = this.cfg?.credentials.botToken;
    if (token) {
      const client = new IlinkClient({
        botToken: token,
        baseUrl: this.cfg?.credentials.baseUrl,
      });
      await client.notifyStop();
    }
    this.setStatus({ state: "unbound" });
  }

  status(): ImChannelStatus {
    return this.statusSnapshot;
  }

  async sendText(target: ImOutboundTarget, text: string): Promise<void> {
    // cfg 为空（通道尚未 start）时退回 manager 侧凭据：回复路径不因适配器
    // 未启动而失效（绑定即签发凭据，token 在 kv）
    const token =
      this.cfg?.credentials.botToken ??
      (getWechatCredential(this.channelId).botToken || undefined);
    if (!token) throw new Error("wechat bot not bound");
    const client = new IlinkClient({
      botToken: token,
      baseUrl: this.cfg?.credentials.baseUrl || undefined,
    });
    await client.sendText({
      toUserId: target.chatId,
      text,
      contextToken:
        typeof target.replyContext === "string" ? target.replyContext : undefined,
    });
  }

  /**
   * 「对方正在输入」：getconfig 换票（按 chat 缓存）→ sendtyping；
   * on=true 时启动 5s keepalive 定时器，on=false 停表并取消状态。
   * ticket 过期（发送失败）自动重取一次。全部尽力而为，不抛错。
   */
  async setTyping(target: ImOutboundTarget, on: boolean): Promise<void> {
    const token =
      this.cfg?.credentials.botToken ??
      (getWechatCredential(this.channelId).botToken || undefined);
    if (!token) return;
    const contextToken =
      typeof target.replyContext === "string" ? target.replyContext : undefined;
    const existing = this.typingSessions.get(target.chatId);
    const client = new IlinkClient({
      botToken: token,
      baseUrl: this.cfg?.credentials.baseUrl || undefined,
    });

    if (existing) {
      if (on) return; // 已在输入中：保持会话，重复开启是 no-op
      // 停：清定时器 + 发取消
      existing.stop();
      this.typingSessions.delete(target.chatId);
      if (existing.ticket) {
        await client.sendTyping({
          toUserId: target.chatId,
          ticket: existing.ticket,
          on: false,
        });
      }
      return;
    }
    if (!on) return; // 无进行中的 typing 会话，取消无意义

    const ticket = await client.getTypingTicket({
      toUserId: target.chatId,
      contextToken,
    });
    if (!ticket) return;
    const send = (onFlag: boolean) =>
      client.sendTyping({
        toUserId: target.chatId,
        ticket,
        on: onFlag,
      });
    await send(true);
    // 5s keepalive；自过期兜底（异常情况下 agent_end 丢失也不让状态永挂）
    let ticks = 0;
    const keepalive = setInterval(() => {
      ticks += 1;
      if (ticks > TYPING_MAX_KEEPALIVE_TICKS) {
        clearInterval(keepalive);
        this.typingSessions.delete(target.chatId);
        return;
      }
      void send(true);
    }, 5_000);
    keepalive.unref?.();
    this.typingSessions.set(target.chatId, {
      stop: () => clearInterval(keepalive),
      ticket,
    });
  }

  /* ------------------------------ 内部 ------------------------------ */

  private setStatus(s: ImChannelStatus): void {
    const prev = this.statusSnapshot;
    const prevMessage = "message" in prev ? prev.message : undefined;
    const nextMessage = "message" in s ? s.message : undefined;
    if (prev.state === s.state && prevMessage === nextMessage) {
      return;
    }
    this.statusSnapshot = s;
    this.cfg?.onStatus(s);
  }

  private loopInFlight = false;

  private async loop(sink: (msg: ImInboundMessage) => void, gen: number): Promise<void> {
    // 代际守卫：仅当仍是当前代且 running 时继续（stop→start 后旧循环立即退场）
    const alive = () => this.running && gen === this.generation;
    this.loopInFlight = true;
    try {
      let cursor = kvGet(CURSOR_KV_PREFIX + this.channelId) ?? "";
      let backoffMs = 1000;
      while (alive()) {
        const token = this.cfg?.credentials.botToken;
        if (!token) break;
        const client = new IlinkClient({ botToken: token, baseUrl: this.cfg?.credentials.baseUrl });
        try {
          const resp = await client.getUpdates(cursor);
          if (!alive()) return; // 停止/换代后的响应不再消费
          // 业务码 -14 = 会话暂停期（官方语义：token 仍有效，暂停 ~1h 后自动
          // 恢复，与"需重新扫码"的 reauth 不同）；其余非 0 码按一般错误退避
          if (resp.ret === -14) {
            this.setStatus({
              state: "connecting",
              message: "微信会话暂时不可用（官方冷却期），稍后自动恢复",
            });
            logWarn(`[im/wechat] session paused by server (channel=${this.channelId})`);
            await sleepInterruptible(60_000, alive);
            continue;
          }
          if (resp.ret !== 0) {
            const errmsg =
              (resp as { errmsg?: string }).errmsg ?? `ret=${resp.ret}`;
            this.setStatus({ state: "error", message: errmsg });
            logWarn(`[im/wechat] getupdates ret=${resp.ret}: ${errmsg}`);
            await sleepInterruptible(backoffMs, alive);
            backoffMs = Math.min(30_000, backoffMs * 2);
            continue;
          }
          cursor = resp.buf || cursor;
          kvSet(CURSOR_KV_PREFIX + this.channelId, cursor);
          backoffMs = 1000;
          this.setStatus({ state: "connected" });
          for (const msg of resp.messages) {
            this.dispatchIfDeliverable(msg, sink);
          }
          // 无新消息时短滞后再拉（长轮询挂起由请求自身承担）
          if (resp.messages.length === 0) {
            await sleepInterruptible(500, alive);
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!alive()) return;
          if (/timed out|超时/i.test(msg)) {
            // 客户端超时 ≠ 服务异常：长轮询被服务端挂满属正常节奏，
            // 不刷 error 状态，短暂停顿后立即续拉
            await sleepInterruptible(500, alive);
          } else {
            this.setStatus({ state: "error", message: msg });
            logWarn(`[im/wechat] poll failed: ${msg}`);
            await sleepInterruptible(backoffMs, alive);
            backoffMs = Math.min(30_000, backoffMs * 2);
          }
        }
      }
    } finally {
      this.loopInFlight = false;
    }
  }

  /** 投递前兜底过滤：客户端已归一文本/滤 BOT；这里再滤空文本、自身回环与超时旧消息。
   *  注意不按 message_state 过滤——已验证的接入实现证明用户消息无需状态门
   *  （NEW/GENERATING 是 BOT 流式消息的语义，方向过滤已覆盖）。 */
  private dispatchIfDeliverable(
    msg: IlinkMessage,
    sink: (msg: ImInboundMessage) => void,
  ): void {
    if (msg.message_type === 2) return; // 兜底：BOT 回环
    const text = (msg.text ?? "").trim();
    if (!text) return; // 非文本消息首发降级忽略
    const chatId = msg.from_user_id ?? "";
    if (!chatId || chatId === this.botId) return;
    const ts = msg.create_time_ms ?? 0;
    if (ts > 0 && Date.now() - ts > STALE_THRESHOLD_MS) return;
    const cfg = this.cfg;
    if (!cfg) return;
    const inbound: ImInboundMessage = {
      platform: this.platform,
      channelId: this.channelId,
      chatType: "p2p",
      chatId,
      senderId: chatId,
      eventId: msg.message_id != null ? String(msg.message_id) : undefined,
      messageId: msg.message_id != null ? String(msg.message_id) : undefined,
      text,
      replyContext: msg.context_token,
    };
    logInfo(
      `[im/wechat] inbound channel=${this.channelId} chat=${chatId.slice(0, 8)}… len=${text.length}`,
    );
    sink(inbound);
  }
}

async function sleepInterruptible(ms: number, alive: () => boolean): Promise<void> {
  const step = 100;
  let waited = 0;
  while (alive() && waited < ms) {
    await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
    waited += step;
  }
}
