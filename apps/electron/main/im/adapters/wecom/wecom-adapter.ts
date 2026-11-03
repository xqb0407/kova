/**
 * 企业微信 IM 通道适配器：智能机器人长连接（官方 @wecom/aibot-node-sdk）。
 *
 * - 连接：WSClient({botId, secret}) → connect()；SDK 内置认证/心跳/指数退避重连。
 * - 接收：message.text 事件 → 归一 → sink；原始帧作为 replyContext 供后续回复
 *   （长连接回复需透传回调帧里的 req_id）。
 * - 发送：优先 reply(frame)；无帧时（测试消息等）用最近一次入站帧兜底。
 * - 状态：authenticated → connected；disconnected/reconnecting → 重连提示；
 *   error → error。
 */
import type {
  ImChannelAdapter,
  ImChannelRuntimeConfig,
  ImChannelStatus,
  ImInboundMessage,
  ImOutboundTarget,
} from "../../types";
import { getWeComCredential } from "../../router";
import { logInfo, logWarn } from "../../../logging";
import { parseWeComFrame } from "./wecom-parse";

const READY_TIMEOUT_MS = 20_000;
const MAX_CACHED_FRAMES = 100;

interface WsClientLike {
  connect(): unknown;
  disconnect(): void;
  isConnected?: boolean;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
  /**
   * 长连接普通回复必须走 stream 协议（msgtype:"stream" + finish=true），
   * 纯 text 消息体只用于欢迎语（replyWelcome），服务端不接收。
   */
  replyStream(
    frame: unknown,
    streamId: string,
    content: string,
    finish?: boolean,
  ): Promise<unknown>;
}

interface AiBotModuleShape {
  WSClient: new (opts: {
    botId: string;
    secret: string;
    maxReconnectAttempts?: number;
  }) => WsClientLike;
  /** 官方推荐的流式消息 ID 生成器（stream-<uuid>） */
  generateReqId?: (prefix: string) => string;
}

export class WeComAdapter implements ImChannelAdapter {
  readonly platform = "wecom" as const;
  readonly channelId: string;

  private cfg: ImChannelRuntimeConfig | null = null;
  private running = false;
  private generation = 0;
  private statusSnapshot: ImChannelStatus = { state: "unbound" };
  private ws: WsClientLike | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  /** 流式消息 ID 生成器（SDK 缺失时本地兜底） */
  private streamIdGenerator: () => string = () =>
    `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  /** 最近一次入站帧（chatId → frame）：测试消息/无 replyContext 时兜底 */
  private frames = new Map<string, unknown>();

  constructor(channelId: string) {
    this.channelId = channelId;
  }

  async start(
    cfg: ImChannelRuntimeConfig,
    sink: (msg: ImInboundMessage) => void,
  ): Promise<void> {
    if (this.running) return;
    const botId = cfg.credentials.botId?.trim() ?? "";
    const secret = cfg.credentials.secret?.trim() ?? "";
    if (!botId || !secret) {
      this.setStatus({ state: "unbound" });
      return;
    }
    this.cfg = cfg;
    this.running = true;
    const gen = ++this.generation;
    this.setStatus({ state: "connecting" });
    void this.connect(gen, sink, { botId, secret });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.generation += 1;
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.disconnect();
    } catch {
      // ignore
    }
    this.frames.clear();
    // 清空凭据副本：解绑后残留实例不得再用旧 secret 发送
    this.cfg = null;
    this.setStatus({ state: "unbound" });
  }

  status(): ImChannelStatus {
    return this.statusSnapshot;
  }

  async sendText(target: ImOutboundTarget, text: string): Promise<void> {
    const ws = this.ws;
    if (!ws) throw new Error("企业微信长连接未建立");
    const frame = target.replyContext ?? this.frames.get(target.chatId);
    if (!frame) {
      throw new Error("企业微信回复缺少回调帧，请让用户重新发一条消息");
    }
    // 单条 stream 回复（finish=true 即完整消息）。router 已把回复限制在
    // 4000 字符内，远低于平台 20480 字节上限；拆多条流反而语义不稳。
    await ws.replyStream(frame, this.streamIdGenerator(), text, true);
  }

  /* ------------------------------ 内部 ------------------------------ */

  private alive(gen: number): boolean {
    return this.running && gen === this.generation;
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
    cred: { botId: string; secret: string },
  ): Promise<void> {
    let mod: AiBotModuleShape;
    try {
      mod = await loadWeComModule();
    } catch (e: unknown) {
      this.fail(gen, `企业微信 SDK 加载失败：${e instanceof Error ? e.message : e}`);
      return;
    }
    if (!this.alive(gen)) return;

    try {
      const ws = new mod.WSClient({
        botId: cred.botId,
        secret: cred.secret,
        maxReconnectAttempts: 10,
      });
      this.ws = ws;
      if (mod.generateReqId) {
        const gen = mod.generateReqId;
        this.streamIdGenerator = () => gen("stream");
      }
      ws.on("authenticated", () => {
        if (!this.alive(gen)) return;
        this.setStatus({ state: "connected" });
        logInfo(`[im/wecom] connected channel=${this.channelId}`);
      });
      ws.on("disconnected", (reason) => {
        if (!this.alive(gen)) return;
        this.setStatus({
          state: "connecting",
          message: `连接中断，正在重连…${typeof reason === "string" && reason ? `（${reason}）` : ""}`,
        });
      });
      ws.on("reconnecting", () => {
        if (!this.alive(gen)) return;
        this.setStatus({ state: "connecting", message: "连接中断，正在重连…" });
      });
      ws.on("error", (err) => {
        if (!this.alive(gen)) return;
        logWarn(
          `[im/wecom] error: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.setStatus({
          state: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
      ws.on("message.text", (frame) => {
        if (!this.alive(gen)) return;
        try {
          const draft = parseWeComFrame(frame);
          if (!draft) return;
          // 缓存最近一帧：测试消息/主动回复没有 replyContext 时用它兜底
          if (this.frames.size >= MAX_CACHED_FRAMES) {
            const oldest = this.frames.keys().next().value;
            if (oldest !== undefined) this.frames.delete(oldest);
          }
          this.frames.set(draft.chatId, frame);
          logInfo(
            `[im/wecom] inbound channel=${this.channelId} chat=${draft.chatId.slice(0, 8)}… len=${draft.text.length}`,
          );
          sink({ platform: "wecom", channelId: this.channelId, ...draft });
        } catch (e: unknown) {
          logWarn(
            `[im/wecom] inbound parse failed: ${e instanceof Error ? e.message : e}`,
          );
        }
      });
      void Promise.resolve(ws.connect()).catch((e: unknown) => {
        if (!this.alive(gen)) return;
        this.fail(gen, `企业微信连接失败：${e instanceof Error ? e.message : e}`);
      });
      this.pollReady(gen, ws);
    } catch (e: unknown) {
      this.fail(gen, `企业微信连接初始化失败：${e instanceof Error ? e.message : e}`);
    }
  }

  /** 认证无回调兜底：20s 内未 authenticated 即报错 */
  private pollReady(gen: number, ws: WsClientLike): void {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const tick = (): void => {
      if (!this.alive(gen)) return;
      // 以 authenticated 事件置位的状态为准：连接建立但认证未完成时继续等
      if (this.statusSnapshot.state === "connected") return;
      if (Date.now() > deadline) {
        this.fail(gen, "企业微信长连接超时（请检查 BotID / Secret 与 API 模式）");
        return;
      }
      this.readyTimer = setTimeout(tick, 200);
      this.readyTimer.unref?.();
    };
    this.readyTimer = setTimeout(tick, 200);
    this.readyTimer.unref?.();
  }

  private fail(gen: number, message: string): void {
    if (!this.alive(gen)) return;
    this.running = false;
    this.generation += 1;
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.disconnect();
    } catch {
      // ignore
    }
    logWarn(`[im/wecom] ${message} (channel=${this.channelId})`);
    this.setStatus({ state: "error", message });
  }
}

/** 动态加载 @wecom/aibot-node-sdk（默认导出或具名导出两种形态） */
let cachedWeCom: AiBotModuleShape | null = null;
async function loadWeComModule(): Promise<AiBotModuleShape> {
  if (cachedWeCom) return cachedWeCom;
  const raw = (await import("@wecom/aibot-node-sdk")) as unknown as {
    WSClient?: AiBotModuleShape["WSClient"];
    generateReqId?: (prefix: string) => string;
    default?: AiBotModuleShape;
  };
  const WSClient = raw.WSClient ?? raw.default?.WSClient;
  if (!WSClient) throw new Error("@wecom/aibot-node-sdk 模块导出不完整");
  cachedWeCom = { WSClient, ...(raw.generateReqId ? { generateReqId: raw.generateReqId } : {}) };
  return cachedWeCom;
}
