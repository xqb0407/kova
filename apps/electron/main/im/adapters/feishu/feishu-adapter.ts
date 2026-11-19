/**
 * 飞书 IM 通道适配器：官方 SDK WebSocket 长连接（免公网回调）。
 *
 * - 接收：EventDispatcher 订阅 im.message.receive_v1 → 归一为 InboundMessage；
 *   事件处理器立即返回（平台有时限），实际处理由路由层的按聊天串行队列承担。
 * - 发送：租户 token + /open-apis/im/v1/messages（有入站 message_id 时走 reply）。
 * - 状态：SDK 无 onReady 回调，轮询底层 WebSocket readyState 判定连接就绪；
 *   isConnecting === false 视为重连耗尽。
 * - typing：对入站消息加/删 OnIt reaction（尽力而为）。
 */
import type {
  ImChannelAdapter,
  ImChannelRuntimeConfig,
  ImChannelStatus,
  ImInboundMessage,
  ImOutboundTarget,
} from "../../types";
import { getFeishuCredential } from "../../router";
import { logInfo, logWarn } from "../../../logging";
import { logImRaw } from "../../raw-log";
import {
  getTenantAccessToken,
  openApiBase,
  type FeishuDomain,
} from "./feishu-auth";
import { parseFeishuInbound } from "./feishu-parse";

const READY_POLL_MS = 100;
const READY_TIMEOUT_MS = 20_000;
const SEND_TIMEOUT_MS = 15_000;
const TEXT_CHUNK_MAX = 3_800;

interface LarkWsClient {
  start(params: { eventDispatcher: unknown }): Promise<void>;
  close(): void;
  isConnecting?: boolean;
  wsConfig?: { getWSInstance?(): { readyState?: number } | null };
}

interface LarkModule {
  EventDispatcher: new (params?: Record<string, unknown>) => {
    register(handlers: Record<string, (data: unknown) => Promise<unknown> | unknown>): unknown;
  };
  WSClient: new (params: {
    appId: string;
    appSecret: string;
    domain?: string;
    loggerLevel?: string;
  }) => LarkWsClient;
  Domain: { Feishu: string; Lark: string };
  LoggerLevel: { info: string };
}

function isRecordLike(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function splitText(text: string, max: number): string[] {
  const normalized = text.replace(/\r\n|\r/g, "\n");
  if (normalized.length <= max) return [normalized];
  const chunks: string[] = [];
  let rest = normalized;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < Math.floor(max * 0.6)) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks.filter((c) => c.length > 0);
}

export class FeishuAdapter implements ImChannelAdapter {
  readonly platform = "feishu" as const;
  readonly channelId: string;

  private cfg: ImChannelRuntimeConfig | null = null;
  private running = false;
  private generation = 0;
  private statusSnapshot: ImChannelStatus = { state: "unbound" };
  private ws: LarkWsClient | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  /** 连接后的健康巡检（SDK 内部重连时状态会短暂断开） */
  private healthTimer: NodeJS.Timeout | null = null;
  /** typing reaction：chatId → { messageId, reactionId } */
  private typing = new Map<string, { messageId: string; reactionId: string }>();
  /** 本应用机器人自身 open_id（群聊 mention 精确匹配；best-effort，取不到回退类型判断） */
  private botOpenId = "";
  /** botOpenId 对应的凭据键（appId:domain）：换绑后旧请求晚到不能污染新实例 */
  private botOpenIdCred = "";

  constructor(channelId: string) {
    this.channelId = channelId;
  }

  async start(
    cfg: ImChannelRuntimeConfig,
    sink: (msg: ImInboundMessage) => void,
  ): Promise<void> {
    if (this.running) return;
    const appId = cfg.credentials.appId?.trim() ?? "";
    const appSecret = cfg.credentials.appSecret?.trim() ?? "";
    const domain: FeishuDomain = cfg.credentials.domain === "lark" ? "lark" : "feishu";
    if (!appId || !appSecret) {
      this.setStatus({ state: "unbound" });
      return;
    }
    this.cfg = cfg;
    this.running = true;
    const gen = ++this.generation;
    this.setStatus({ state: "connecting" });
    void this.connect(gen, sink, { appId, appSecret, domain });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.generation += 1;
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // 已断开时 close 可能抛错，忽略
      }
    }
    this.typing.clear();
    this.botOpenId = "";
    this.botOpenIdCred = "";
    // 清空凭据副本：解绑后残留实例不得再用旧的 appSecret 发送
    this.cfg = null;
    this.setStatus({ state: "unbound" });
  }

  status(): ImChannelStatus {
    return this.statusSnapshot;
  }

  async sendText(target: ImOutboundTarget, text: string): Promise<void> {
    const cred = this.readCredential();
    if (!cred.appId || !cred.appSecret) throw new Error("飞书通道尚未绑定");
    const token = await getTenantAccessToken(cred);
    const chunks = splitText(text, TEXT_CHUNK_MAX);
    for (const chunk of chunks) {
      await this.sendChunk(cred.domain, token, target, chunk);
    }
  }

  /** best-effort「正在处理」提示：对入站消息加/删 OnIt reaction */
  async setTyping(target: ImOutboundTarget, on: boolean): Promise<void> {
    try {
      const messageId =
        typeof target.replyContext === "string" ? target.replyContext : "";
      if (!messageId) return;
      const cred = this.readCredential();
      if (!cred.appId || !cred.appSecret) return;
      const token = await getTenantAccessToken(cred);
      const existing = this.typing.get(target.chatId);
      if (!on) {
        if (!existing) return;
        this.typing.delete(target.chatId);
        await fetch(
          `${openApiBase(cred.domain)}/open-apis/im/v1/messages/${encodeURIComponent(existing.messageId)}/reactions/${encodeURIComponent(existing.reactionId)}`,
          {
            method: "DELETE",
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          },
        ).catch(() => undefined);
        return;
      }
      if (existing) return; // 已有点亮的 reaction，幂等
      const resp = await fetch(
        `${openApiBase(cred.domain)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ reaction_type: { emoji_type: "OnIt" } }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        },
      );
      if (!resp.ok) return;
      const payload = (await resp.json()) as {
        data?: { reaction_id?: string };
      };
      const reactionId = payload?.data?.reaction_id;
      if (reactionId) {
        this.typing.set(target.chatId, { messageId, reactionId });
      }
    } catch {
      // 尽力而为：typing 失败不影响主链路
    }
  }

  /* ------------------------------ 内部 ------------------------------ */

  private alive(gen: number): boolean {
    return this.running && gen === this.generation;
  }

  private readCredential(): { appId: string; appSecret: string; domain: FeishuDomain } {
    const cfg = this.cfg?.credentials;
    if (cfg?.appId && cfg.appSecret) {
      return {
        appId: cfg.appId,
        appSecret: cfg.appSecret,
        domain: cfg.domain === "lark" ? "lark" : "feishu",
      };
    }
    // 适配器未 start 时退回 kv 凭据（测试消息/重启竞态路径）
    return getFeishuCredential(this.channelId);
  }

  /**
   * 取本应用机器人 open_id（群聊 @ 精确匹配）。
   * 端点不是 SDK 类型的一部分，响应形状也随版本变化：best-effort 解析
   * bot.open_id / data.bot.open_id / data.open_id，失败就回退 mentioned_type。
   */
  private async ensureBotOpenId(
    gen: number,
    cred: {
      appId: string;
      appSecret: string;
      domain: FeishuDomain;
    },
  ): Promise<void> {
    const credKey = `${cred.appId}:${cred.domain}`;
    if (this.botOpenId && this.botOpenIdCred === credKey) return;
    try {
      const token = await getTenantAccessToken(cred);
      const resp = await fetch(`${openApiBase(cred.domain)}/open-apis/bot/v3/info`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!resp.ok) {
        logWarn(
          `[im/feishu] bot info HTTP ${resp.status} channel=${this.channelId}（群 @ 回退 mentioned_type）`,
        );
        return;
      }
      const payload = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
      const data = isRecordLike(payload.data) ? payload.data : null;
      const bot =
        (isRecordLike(payload.bot) ? payload.bot : null) ??
        (data && isRecordLike(data.bot) ? data.bot : null);
      const openId =
        (bot && typeof bot.open_id === "string" ? bot.open_id : "") ||
        (data && typeof data.open_id === "string" ? data.open_id : "");
      if (!openId) {
        logWarn(
          `[im/feishu] bot info missing open_id channel=${this.channelId}（群 @ 回退 mentioned_type）`,
        );
        return;
      }
      // 换绑/停用后旧请求晚到：只接受仍属于当前代际与凭据的结果
      if (openId && this.alive(gen) && this.cfg?.credentials.appId === cred.appId) {
        this.botOpenId = openId;
        this.botOpenIdCred = credKey;
      }
    } catch (e: unknown) {
      logWarn(
        `[im/feishu] bot info failed channel=${this.channelId}: ${e instanceof Error ? e.message : String(e)}（群 @ 回退 mentioned_type）`,
      );
    }
  }

  private setStatus(s: ImChannelStatus): void {
    const prev = this.statusSnapshot;
    const prevMessage = "message" in prev ? prev.message : undefined;
    const nextMessage = "message" in s ? s.message : undefined;
    if (prev.state === s.state && prevMessage === nextMessage) return;
    this.statusSnapshot = s;
    this.cfg?.onStatus(s);
  }

  private async connect(
    gen: number,
    sink: (msg: ImInboundMessage) => void,
    cred: { appId: string; appSecret: string; domain: FeishuDomain },
  ): Promise<void> {
    let Lark: LarkModule;
    try {
      Lark = (await import("@larksuiteoapi/node-sdk")) as unknown as LarkModule;
    } catch (e: unknown) {
      this.fail(gen, `飞书 SDK 加载失败：${e instanceof Error ? e.message : e}`);
      return;
    }
    if (!this.alive(gen)) return;

    // 群聊 @ 判定：取本应用 bot 的 open_id 精确匹配；取不到时群消息 fail-closed。
    // 事件处理器不能 await（飞书有时限）：bot 身份未就绪的群消息先挂到
    // botInfoReady 上，取到后重解析一次，避免连接后第一秒的 @ 被静默丢掉。
    const botInfoReady = this.ensureBotOpenId(gen, cred);

    try {
      const dispatcher = new Lark.EventDispatcher({});
      dispatcher.register({
        "im.message.receive_v1": (data: unknown) => {
          if (!this.alive(gen)) return Promise.resolve();
          try {
            logImRaw("feishu", data);
            const deliver = (draft: ReturnType<typeof parseFeishuInbound>) => {
              if (!draft) return;
              logInfo(
                `[im/feishu] inbound channel=${this.channelId} chat=${draft.chatId.slice(0, 8)}… len=${draft.text.length}`,
              );
              sink({
                platform: "feishu",
                channelId: this.channelId,
                ...draft,
              });
            };
            const draft = parseFeishuInbound(data, { botOpenId: this.botOpenId });
            if (draft?.chatType === "group" && !this.botOpenId) {
              void botInfoReady
                .then(() => {
                  if (!this.alive(gen)) return;
                  deliver(parseFeishuInbound(data, { botOpenId: this.botOpenId }));
                })
                .catch(() => undefined);
              return Promise.resolve();
            }
            deliver(draft);
          } catch (e: unknown) {
            logWarn(
              `[im/feishu] inbound parse failed: ${e instanceof Error ? e.message : e}`,
            );
          }
          return Promise.resolve();
        },
        // 自己加的 typing reaction 也会推回来：注册空处理器避免 SDK 持续告警
        "im.message.reaction.created_v1": () => Promise.resolve(),
      });

      const ws = new Lark.WSClient({
        appId: cred.appId,
        appSecret: cred.appSecret,
        domain: cred.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
        loggerLevel: Lark.LoggerLevel.info,
      });
      this.ws = ws;
      void ws.start({ eventDispatcher: dispatcher }).catch((e: unknown) => {
        if (!this.alive(gen)) return;
        this.fail(gen, `飞书长连接启动失败：${e instanceof Error ? e.message : e}`);
      });
      this.pollReady(gen, ws);
    } catch (e: unknown) {
      this.fail(gen, `飞书长连接初始化失败：${e instanceof Error ? e.message : e}`);
    }
  }

  /** SDK 无 onReady：轮询底层 WebSocket 状态，就绪→connected，超时/重连耗尽→error */
  private pollReady(gen: number, ws: LarkWsClient): void {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const tick = (): void => {
      if (!this.alive(gen)) return;
      const readyState = ws.wsConfig?.getWSInstance?.()?.readyState;
      if (readyState === 1) {
        this.setStatus({ state: "connected" });
        logInfo(`[im/feishu] connected channel=${this.channelId}`);
        this.watchHealth(gen, ws);
        return;
      }
      if (ws.isConnecting === false) {
        this.fail(gen, "飞书长连接重连耗尽");
        return;
      }
      if (Date.now() > deadline) {
        this.fail(gen, "飞书长连接超时");
        return;
      }
      this.readyTimer = setTimeout(tick, READY_POLL_MS);
      this.readyTimer.unref?.();
    };
    this.readyTimer = setTimeout(tick, READY_POLL_MS);
    this.readyTimer.unref?.();
  }

  /** 连接后巡检：SDK 自动重连期间状态点要如实反映（不再永远显示已连接） */
  private watchHealth(gen: number, ws: LarkWsClient): void {
    const tick = (): void => {
      if (!this.alive(gen)) return;
      const readyState = ws.wsConfig?.getWSInstance?.()?.readyState;
      if (readyState === 1) {
        // 重连恢复：状态点回到已连接（构造时只置过一次，之后要靠巡检回写）
        if (this.statusSnapshot.state !== "connected") {
          this.setStatus({ state: "connected" });
          logInfo(`[im/feishu] reconnected channel=${this.channelId}`);
        }
        return;
      }
      if (ws.isConnecting === false) {
        this.fail(gen, "飞书长连接重连耗尽");
        return;
      }
      this.setStatus({ state: "connecting", message: "连接中断，正在重连…" });
    };
    this.healthTimer = setInterval(tick, 5_000);
    this.healthTimer.unref?.();
  }

  private fail(gen: number, message: string): void {
    if (!this.alive(gen)) return;
    this.running = false;
    this.generation += 1;
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // ignore
    }
    logWarn(`[im/feishu] ${message} (channel=${this.channelId})`);
    this.setStatus({ state: "error", message });
  }

  /** 发送一段文本：优先回复入站消息（线程锚定）；回复失效（230011）回退为新消息 */
  private async sendChunk(
    domain: FeishuDomain,
    token: string,
    target: ImOutboundTarget,
    text: string,
  ): Promise<void> {
    const replyTo =
      typeof target.replyContext === "string" && target.replyContext
        ? target.replyContext
        : "";
    try {
      await this.postChunk(domain, token, target, text, replyTo);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // 230011 = 被回复的消息已不存在/不可回复：改发一条普通消息，避免整条回复丢失
      if (replyTo && msg.includes("code=230011")) {
        logWarn(`[im/feishu] reply target gone, fallback to new message (channel=${this.channelId})`);
        await this.postChunk(domain, token, target, text, "");
        return;
      }
      throw e;
    }
  }

  private async postChunk(
    domain: FeishuDomain,
    token: string,
    target: ImOutboundTarget,
    text: string,
    replyTo: string,
  ): Promise<void> {
    // 非回复路径按 id 前缀选择 receive_id_type：oc_ = chat_id，其余（ou_ 等）= open_id
    const receiveIdType = target.chatId.startsWith("oc_") ? "chat_id" : "open_id";
    const url = replyTo
      ? `${openApiBase(domain)}/open-apis/im/v1/messages/${encodeURIComponent(replyTo)}/reply`
      : `${openApiBase(domain)}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`;
    const body = {
      ...(replyTo ? {} : { receive_id: target.chatId }),
      msg_type: "text",
      content: JSON.stringify({ text }),
    };
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const payload = (await resp.json().catch(() => ({}))) as {
      code?: number;
      msg?: string;
      error?: { log_id?: string };
      data?: { message_id?: string };
    };
    const code = typeof payload.code === "number" ? payload.code : 0;
    if (!resp.ok || code !== 0) {
      throw new Error(
        `飞书发送失败：HTTP ${resp.status} code=${code} ${payload.msg ?? ""}${
          payload.error?.log_id ? ` log_id=${payload.error.log_id}` : ""
        }`.trim(),
      );
    }
  }
}
