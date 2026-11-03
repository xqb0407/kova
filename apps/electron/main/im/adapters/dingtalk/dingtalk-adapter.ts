/**
 * 钉钉 IM 通道适配器：Stream 模式长连接（官方 dingtalk-stream SDK）。
 *
 * - 接收：registerCallbackListener(TOPIC_ROBOT) → 归一 → sink，并立即
 *   socketCallBackResponse ACK（未 ACK 会在 60s 内重推）。
 * - 发送：优先用入站 sessionWebhook 回复（1.5h 有效），配合 SDK 的
 *   getAccessToken 换取 x-acs-dingtalk-access-token。
 * - 连接：connect() 后轮询 client.connected 判定就绪；断线由 SDK 自动重连，
 *   巡检期间状态如实显示。
 */
import type {
  ImChannelAdapter,
  ImChannelRuntimeConfig,
  ImChannelStatus,
  ImInboundMessage,
  ImOutboundTarget,
} from "../../types";
import { getDingTalkCredential } from "../../router";
import { logInfo, logWarn } from "../../../logging";
import { parseDingTalkRobotMessage } from "./dingtalk-parse";

const READY_POLL_MS = 100;
const READY_TIMEOUT_MS = 20_000;
const HEALTH_INTERVAL_MS = 5_000;
const SEND_TIMEOUT_MS = 15_000;
const TEXT_CHUNK_MAX = 2_000;

interface DWClientLike {
  connected: boolean;
  registerCallbackListener(
    topic: string,
    cb: (res: { headers: { messageId: string }; data: string }) => void | Promise<void>,
  ): unknown;
  connect(): void;
  disconnect(): void;
  getAccessToken(): Promise<string>;
  socketCallBackResponse(messageId: string, result: unknown): void;
}

interface DingTalkModuleShape {
  DWClient: new (opts: {
    clientId: string;
    clientSecret: string;
    debug?: boolean;
  }) => DWClientLike;
  TOPIC_ROBOT: string;
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

export class DingTalkAdapter implements ImChannelAdapter {
  readonly platform = "dingtalk" as const;
  readonly channelId: string;

  private cfg: ImChannelRuntimeConfig | null = null;
  private running = false;
  private generation = 0;
  private statusSnapshot: ImChannelStatus = { state: "unbound" };
  private client: DWClientLike | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  /** 最近一次入站会话 webhook（chatId → sessionWebhook）：
   *  测试消息/无 replyContext 的发送用它兜底（webhook 约 1.5h 有效） */
  private webhooks = new Map<string, string>();
  /** 停止后的僵尸重连守卫：SDK 在 close 时已排入的重连定时器不受
   *  disconnect() 影响（且 _connect 会重置 userDisconnect），
   *  这里在停止后一段时间内反复 disconnect 兜底关掉迟到的连接。
   *  用集合保存：快速 stop→start 时旧守卫继续跑，不会漏掉旧连接。 */
  private disposeGuards = new Set<NodeJS.Timeout>();

  constructor(channelId: string) {
    this.channelId = channelId;
  }

  async start(
    cfg: ImChannelRuntimeConfig,
    sink: (msg: ImInboundMessage) => void,
  ): Promise<void> {
    if (this.running) return;
    const clientId = cfg.credentials.clientId?.trim() ?? "";
    const clientSecret = cfg.credentials.clientSecret?.trim() ?? "";
    if (!clientId || !clientSecret) {
      this.setStatus({ state: "unbound" });
      return;
    }
    this.cfg = cfg;
    this.running = true;
    const gen = ++this.generation;
    this.setStatus({ state: "connecting" });
    void this.connect(gen, sink, { clientId, clientSecret });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.generation += 1;
    this.clearTimers();
    const client = this.client;
    this.client = null;
    try {
      client?.disconnect();
    } catch {
      // 已断开时忽略
    }
    if (client) this.startDisposeGuard(client);
    this.webhooks.clear();
    // 清空凭据副本：解绑后残留实例不得再用旧 secret 发送
    this.cfg = null;
    this.setStatus({ state: "unbound" });
  }

  status(): ImChannelStatus {
    return this.statusSnapshot;
  }

  async sendText(target: ImOutboundTarget, text: string): Promise<void> {
    const cred = this.readCredential();
    if (!cred.clientId || !cred.clientSecret) throw new Error("钉钉通道尚未绑定");
    const webhook =
      (typeof target.replyContext === "string" && target.replyContext) ||
      this.webhooks.get(target.chatId) ||
      "";
    if (!webhook) {
      throw new Error("钉钉回复缺少会话 webhook，请让用户先在钉钉里发一条消息");
    }
    const client = this.getOrCreateClient(cred);
    const token = await client.getAccessToken();
    const chunks = splitText(text, TEXT_CHUNK_MAX);
    for (const chunk of chunks) {
      await this.postWebhook(webhook, token, chunk);
    }
  }

  /* ------------------------------ 内部 ------------------------------ */

  private alive(gen: number): boolean {
    return this.running && gen === this.generation;
  }

  private readCredential(): { clientId: string; clientSecret: string } {
    const cfg = this.cfg?.credentials;
    if (cfg?.clientId && cfg.clientSecret) {
      return { clientId: cfg.clientId, clientSecret: cfg.clientSecret };
    }
    return getDingTalkCredential(this.channelId);
  }

  private getOrCreateClient(cred: { clientId: string; clientSecret: string }): DWClientLike {
    if (this.client) return this.client;
    // 未 start 的路径（如测试消息）：惰性建一个只用于取 token 的客户端
    const mod = requireDingTalkModule();
    return new mod.DWClient({ clientId: cred.clientId, clientSecret: cred.clientSecret });
  }

  private setStatus(s: ImChannelStatus): void {
    const prev = this.statusSnapshot;
    const prevMessage = "message" in prev ? prev.message : undefined;
    const nextMessage = "message" in s ? s.message : undefined;
    if (prev.state === s.state && prevMessage === nextMessage) return;
    this.statusSnapshot = s;
    this.cfg?.onStatus(s);
  }

  private clearTimers(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private async connect(
    gen: number,
    sink: (msg: ImInboundMessage) => void,
    cred: { clientId: string; clientSecret: string },
  ): Promise<void> {
    let mod: DingTalkModuleShape;
    try {
      mod = requireDingTalkModule();
    } catch (e: unknown) {
      this.fail(gen, `钉钉 SDK 加载失败：${e instanceof Error ? e.message : e}`);
      return;
    }
    if (!this.alive(gen)) return;

    try {
      const client = new mod.DWClient({
        clientId: cred.clientId,
        clientSecret: cred.clientSecret,
      });
      this.client = client;
      client.registerCallbackListener(mod.TOPIC_ROBOT, (res) => {
        if (!this.alive(gen)) return;
        try {
          const parsed: unknown = JSON.parse(res.data);
          const draft = parseDingTalkRobotMessage(parsed);
          if (draft) {
            // 缓存会话 webhook：测试消息与无 replyContext 路径的兜底
            if (typeof draft.replyContext === "string" && draft.replyContext) {
              if (this.webhooks.size >= 100) {
                const oldest = this.webhooks.keys().next().value;
                if (oldest !== undefined) this.webhooks.delete(oldest);
              }
              this.webhooks.set(draft.chatId, draft.replyContext);
            }
            logInfo(
              `[im/dingtalk] inbound channel=${this.channelId} chat=${draft.chatId.slice(0, 8)}… len=${draft.text.length}`,
            );
            sink({ platform: "dingtalk", channelId: this.channelId, ...draft });
          }
        } catch (e: unknown) {
          logWarn(
            `[im/dingtalk] inbound parse failed: ${e instanceof Error ? e.message : e}`,
          );
        } finally {
          // 快速 ACK：不 ACK 服务端 60s 内会重推
          try {
            client.socketCallBackResponse(res.headers.messageId, {});
          } catch {
            // 尽力而为
          }
        }
      });
      client.connect();
      this.pollReady(gen, client);
    } catch (e: unknown) {
      this.fail(gen, `钉钉长连接初始化失败：${e instanceof Error ? e.message : e}`);
    }
  }

  private pollReady(gen: number, client: DWClientLike): void {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const tick = (): void => {
      if (!this.alive(gen)) return;
      if (client.connected) {
        this.setStatus({ state: "connected" });
        logInfo(`[im/dingtalk] connected channel=${this.channelId}`);
        this.watchHealth(gen, client);
        return;
      }
      if (Date.now() > deadline) {
        this.fail(gen, "钉钉长连接超时（请检查 Client ID / Secret 与机器人 Stream 模式）");
        return;
      }
      this.readyTimer = setTimeout(tick, READY_POLL_MS);
      this.readyTimer.unref?.();
    };
    this.readyTimer = setTimeout(tick, READY_POLL_MS);
    this.readyTimer.unref?.();
  }

  private watchHealth(gen: number, client: DWClientLike): void {
    const tick = (): void => {
      if (!this.alive(gen)) return;
      if (client.connected) {
        if (this.statusSnapshot.state !== "connected") {
          this.setStatus({ state: "connected" });
          logInfo(`[im/dingtalk] reconnected channel=${this.channelId}`);
        }
        return;
      }
      this.setStatus({ state: "connecting", message: "连接中断，正在重连…" });
    };
    this.healthTimer = setInterval(tick, HEALTH_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  private fail(gen: number, message: string): void {
    if (!this.alive(gen)) return;
    this.running = false;
    this.generation += 1;
    this.clearTimers();
    const client = this.client;
    this.client = null;
    try {
      client?.disconnect();
    } catch {
      // ignore
    }
    if (client) this.startDisposeGuard(client);
    logWarn(`[im/dingtalk] ${message} (channel=${this.channelId})`);
    this.setStatus({ state: "error", message });
  }

  /** 停止后 6 秒内持续 disconnect：覆盖 SDK 已排入的 1s 重连定时器与在飞连接 */
  private startDisposeGuard(client: DWClientLike): void {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      try {
        client.disconnect();
      } catch {
        // ignore
      }
      if (ticks >= 6) {
        clearInterval(timer);
        this.disposeGuards.delete(timer);
      }
    }, 1_000);
    timer.unref?.();
    this.disposeGuards.add(timer);
  }

  private async postWebhook(webhook: string, token: string, text: string): Promise<void> {
    const resp = await fetch(webhook, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-acs-dingtalk-access-token": token,
      },
      body: JSON.stringify({ msgtype: "text", text: { content: text } }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const payload = (await resp.json().catch(() => ({}))) as {
      errcode?: number;
      errmsg?: string;
    };
    const code = typeof payload.errcode === "number" ? payload.errcode : 0;
    if (!resp.ok || code !== 0) {
      throw new Error(
        `钉钉发送失败：HTTP ${resp.status} errcode=${code} ${payload.errmsg ?? ""}`.trim(),
      );
    }
  }
}

/** 动态加载 dingtalk-stream（兼容 CJS/ESM 两种导出形态） */
let cachedModule: DingTalkModuleShape | null = null;
function requireDingTalkModule(): DingTalkModuleShape {
  if (cachedModule) return cachedModule;
  // 同步 require：适配器方法在运行期调用，不必 async；external 保证运行时解析
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const raw = require("dingtalk-stream") as {
    DWClient?: DingTalkModuleShape["DWClient"];
    TOPIC_ROBOT?: string;
    default?: DingTalkModuleShape;
  };
  const DWClient = raw.DWClient ?? raw.default?.DWClient;
  const TOPIC_ROBOT = raw.TOPIC_ROBOT ?? raw.default?.TOPIC_ROBOT;
  if (!DWClient || !TOPIC_ROBOT) {
    throw new Error("dingtalk-stream 模块导出不完整");
  }
  cachedModule = { DWClient, TOPIC_ROBOT };
  return cachedModule;
}
