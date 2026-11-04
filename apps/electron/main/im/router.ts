/**
 * IM 路由器（平台无关核心）：入站消息 → 访问控制 → 绑定解析 → prompt 下发；
 * sidecar 无 id 帧回程按会话队列聚合，agent_end 结算后经适配器回 IM。
 *
 * 绑定模型：im_binding 表把 (platform, channel_id, chat_id) 持久映射到
 * session_id —— 同一聊天永远路由到同一会话（连续对话），/new 解绑重建。
 * 回程聚合：订阅 pi-agent 的无 id 帧流（setImRouterTap），thread_event 的
 * message_update 增量累积到该会话聚合队列的队首，agent_end（带
 * stopReason/errorMessage）结算队首 —— get_history(tail) 取最终 assistant
 * 文本回复（聚合文本仅兜底）；aborted 不回复，error 回错误摘要。
 */
import { getDb, kvDelete, kvGet, kvSet } from "../store";
import { logInfo, logWarn } from "../logging";
import { decrypt, encrypt } from "../secret";
import * as pi from "../pi-agent";
import { checkInboundAccess } from "./access";
import { getImAdapter } from "./registry";
import type { ImInboundMessage, ImOutboundTarget, ImPlatform } from "./types";

const IM_CHANNELS_KV_KEY = "im_channels";
const REPLY_MAX_CHARS = 4000;

/** 首次建立绑定时的一次性引导：用户否则不知道 /new 等命令的存在 */
const WELCOME_HINT = [
  "已连接 Kova 助手 ✅",
  "直接发消息即可对话，我会在这个会话里持续回复。",
  "",
  "常用命令：",
  "/new  开启新对话（换话题时用）",
  "/clear  压缩当前上下文",
  "/stop  停止当前任务",
].join("\n");

/** 幂等建表：绑定/owner 两张表在命令初始化与删除路径都要先确保存在
 *  （惰性建表曾导致"新装→建 Bot→删除"炸 no such table）。 */
export function ensureImTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS im_binding (
        platform    TEXT NOT NULL,
        channel_id  TEXT NOT NULL,
        chat_id     TEXT NOT NULL,
        sender_id   TEXT NOT NULL DEFAULT '',
        session_id  TEXT NOT NULL,
        strategy    TEXT NOT NULL DEFAULT 'per-chat',
        pinned      INTEGER NOT NULL DEFAULT 0,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (platform, channel_id, chat_id)
    );
    CREATE TABLE IF NOT EXISTS im_owner (
        channel_id TEXT PRIMARY KEY,
        sender_id  TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    );`);
}

/* ------------------------------ 通道配置（kv JSON） ------------------------------ */

export interface ImChannelConfig {
  id: string;
  name: string;
  platform: string;
  enabled: boolean;
  /** 单会话模式钉住的桌面会话；null=每聊天自动新建 */
  pinnedSessionId: string | null;
  /** 新建会话工作目录；null=应用默认 */
  cwd: string | null;
  /** 回复颗粒度：standard=助手正文（默认）；full=正文+工具调用摘要；digest=一句话摘要；live=思考/工具进度实时推送 */
  replyDetail: "standard" | "full" | "digest" | "live";
  /** 思考深度（侧车 thinking 档位）：IM 会话默认 off，live 档会自动开 low */
  thinkingLevel: "off" | "low" | "medium" | "high";
  createdAt: number;
}

export function listChannelConfigs(): ImChannelConfig[] {
  try {
    const raw = kvGet(IM_CHANNELS_KV_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 存量配置可能缺新字段（旧版本写入）：读时归一一遍，保证下游类型契约
    return (parsed as ImChannelConfig[]).map((c) => ({
      ...c,
      replyDetail: normalizeReplyDetail(c.replyDetail),
      thinkingLevel: normalizeThinkingLevel(c.thinkingLevel),
    }));
  } catch {
    return [];
  }
}

const REPLY_DETAIL_VALUES: ImChannelConfig["replyDetail"][] = [
  "standard",
  "full",
  "digest",
  "live",
];

function normalizeReplyDetail(raw: unknown): ImChannelConfig["replyDetail"] {
  return REPLY_DETAIL_VALUES.includes(raw as ImChannelConfig["replyDetail"])
    ? (raw as ImChannelConfig["replyDetail"])
    : "standard";
}

const THINKING_LEVEL_VALUES: ImChannelConfig["thinkingLevel"][] = [
  "off",
  "low",
  "medium",
  "high",
];

function normalizeThinkingLevel(raw: unknown): ImChannelConfig["thinkingLevel"] {
  return THINKING_LEVEL_VALUES.includes(raw as ImChannelConfig["thinkingLevel"])
    ? (raw as ImChannelConfig["thinkingLevel"])
    : "off";
}

export function saveChannelConfig(patch: Partial<ImChannelConfig> & { platform?: string; name?: string }): ImChannelConfig {
  const list = listChannelConfigs();
  const id = patch.id ?? `im-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const existing = list.find((c) => c.id === id);
  const next: ImChannelConfig = {
    id,
    name: patch.name ?? existing?.name ?? "IM Bot",
    platform: patch.platform ?? existing?.platform ?? "wechat",
    enabled: patch.enabled ?? existing?.enabled ?? true,
    pinnedSessionId: patch.pinnedSessionId !== undefined ? patch.pinnedSessionId : (existing?.pinnedSessionId ?? null),
    cwd: patch.cwd !== undefined ? patch.cwd : (existing?.cwd ?? null),
    replyDetail: normalizeReplyDetail(patch.replyDetail ?? existing?.replyDetail),
    thinkingLevel: normalizeThinkingLevel(patch.thinkingLevel ?? existing?.thinkingLevel),
    createdAt: existing?.createdAt ?? Date.now(),
  };
  const merged = existing ? list.map((c) => (c.id === id ? next : c)) : [...list, next];
  kvSet(IM_CHANNELS_KV_KEY, JSON.stringify(merged));
  return next;
}

export function deleteChannelConfig(id: string): void {
  ensureImTables();
  const cfg = listChannelConfigs().find((c) => c.id === id);
  const merged = listChannelConfigs().filter((c) => c.id !== id);
  kvSet(IM_CHANNELS_KV_KEY, JSON.stringify(merged));
  getDb().prepare("DELETE FROM im_binding WHERE channel_id = ?1").run(id);
  getDb().prepare("DELETE FROM im_owner WHERE channel_id = ?1").run(id);
  clearChannelCredential((cfg?.platform ?? "wechat") as string, id);
}

/* ------------------------------ 凭据 ------------------------------ */

export function getWechatCredential(channelId: string): { botToken: string; botId: string; baseUrl: string } {
  const enc = kvGet(`im.wechat.token.${channelId}`);
  if (!enc) return { botToken: "", botId: "", baseUrl: "" };
  const dec = decrypt(enc);
  if (!dec.ok) return { botToken: "", botId: "", baseUrl: "" };
  try {
    const parsed = JSON.parse(dec.value) as { botToken?: string; botId?: string; baseUrl?: string };
    return { botToken: parsed.botToken ?? "", botId: parsed.botId ?? "", baseUrl: parsed.baseUrl ?? "" };
  } catch {
    return { botToken: "", botId: "", baseUrl: "" };
  }
}

export function setWechatCredential(channelId: string, cred: { botToken: string; botId: string; baseUrl?: string }): void {
  kvSet(
    `im.wechat.token.${channelId}`,
    encrypt(JSON.stringify({ botToken: cred.botToken, botId: cred.botId, baseUrl: cred.baseUrl ?? "" })),
  );
}

/* ------------------------------ 飞书凭据 ------------------------------ */

export type FeishuDomain = "feishu" | "lark";

export interface FeishuCredential {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
}

export function getFeishuCredential(channelId: string): FeishuCredential {
  const enc = kvGet(`im.feishu.credential.${channelId}`);
  const empty: FeishuCredential = { appId: "", appSecret: "", domain: "feishu" };
  if (!enc) return empty;
  const dec = decrypt(enc);
  if (!dec.ok) return empty;
  try {
    const parsed = JSON.parse(dec.value) as Partial<FeishuCredential>;
    return {
      appId: typeof parsed.appId === "string" ? parsed.appId : "",
      appSecret: typeof parsed.appSecret === "string" ? parsed.appSecret : "",
      domain: parsed.domain === "lark" ? "lark" : "feishu",
    };
  } catch {
    return empty;
  }
}

export function setFeishuCredential(channelId: string, cred: FeishuCredential): void {
  kvSet(
    `im.feishu.credential.${channelId}`,
    encrypt(
      JSON.stringify({
        appId: cred.appId,
        appSecret: cred.appSecret,
        domain: cred.domain === "lark" ? "lark" : "feishu",
      }),
    ),
  );
}

/* ------------------------------ 钉钉 / 企业微信凭据 ------------------------------ */

export interface DingTalkCredential {
  clientId: string;
  clientSecret: string;
}

export function getDingTalkCredential(channelId: string): DingTalkCredential {
  const enc = kvGet(`im.dingtalk.credential.${channelId}`);
  const empty: DingTalkCredential = { clientId: "", clientSecret: "" };
  if (!enc) return empty;
  const dec = decrypt(enc);
  if (!dec.ok) return empty;
  try {
    const parsed = JSON.parse(dec.value) as Partial<DingTalkCredential>;
    return {
      clientId: typeof parsed.clientId === "string" ? parsed.clientId : "",
      clientSecret: typeof parsed.clientSecret === "string" ? parsed.clientSecret : "",
    };
  } catch {
    return empty;
  }
}

export function setDingTalkCredential(channelId: string, cred: DingTalkCredential): void {
  kvSet(
    `im.dingtalk.credential.${channelId}`,
    encrypt(JSON.stringify({ clientId: cred.clientId, clientSecret: cred.clientSecret })),
  );
}

export interface WeComCredential {
  botId: string;
  secret: string;
}

export function getWeComCredential(channelId: string): WeComCredential {
  const enc = kvGet(`im.wecom.credential.${channelId}`);
  const empty: WeComCredential = { botId: "", secret: "" };
  if (!enc) return empty;
  const dec = decrypt(enc);
  if (!dec.ok) return empty;
  try {
    const parsed = JSON.parse(dec.value) as Partial<WeComCredential>;
    return {
      botId: typeof parsed.botId === "string" ? parsed.botId : "",
      secret: typeof parsed.secret === "string" ? parsed.secret : "",
    };
  } catch {
    return empty;
  }
}

export function setWeComCredential(channelId: string, cred: WeComCredential): void {
  kvSet(
    `im.wecom.credential.${channelId}`,
    encrypt(JSON.stringify({ botId: cred.botId, secret: cred.secret })),
  );
}

/* ------------------------------ 平台凭据通用入口 ------------------------------ */

/** 按平台解析适配器启动所需的凭据（Manager 唯一入口，避免平台分支散落） */
export function getChannelCredentials(
  platform: string,
  channelId: string,
): Record<string, string> {
  if (platform === "feishu") {
    const c = getFeishuCredential(channelId);
    return { appId: c.appId, appSecret: c.appSecret, domain: c.domain };
  }
  if (platform === "dingtalk") {
    const c = getDingTalkCredential(channelId);
    return { clientId: c.clientId, clientSecret: c.clientSecret };
  }
  if (platform === "wecom") {
    const c = getWeComCredential(channelId);
    return { botId: c.botId, secret: c.secret };
  }
  const c = getWechatCredential(channelId);
  return { botToken: c.botToken, botId: c.botId, baseUrl: c.baseUrl };
}

/** 平台是否已完成绑定（必填凭据齐备） */
export function isChannelBoundByCredential(platform: string, channelId: string): boolean {
  if (platform === "feishu") {
    const c = getFeishuCredential(channelId);
    return Boolean(c.appId.trim() && c.appSecret.trim());
  }
  if (platform === "dingtalk") {
    const c = getDingTalkCredential(channelId);
    return Boolean(c.clientId.trim() && c.clientSecret.trim());
  }
  if (platform === "wecom") {
    const c = getWeComCredential(channelId);
    return Boolean(c.botId.trim() && c.secret.trim());
  }
  return Boolean(getWechatCredential(channelId).botToken);
}

/** 清理平台凭据（删除通道 / 解绑共用） */
export function clearChannelCredential(platform: string, channelId: string): void {
  if (platform === "feishu") {
    kvDelete(`im.feishu.credential.${channelId}`);
    return;
  }
  if (platform === "dingtalk") {
    kvDelete(`im.dingtalk.credential.${channelId}`);
    return;
  }
  if (platform === "wecom") {
    kvDelete(`im.wecom.credential.${channelId}`);
    return;
  }
  kvDelete(`im.wechat.token.${channelId}`);
  // 游标是账号作用域的：换号后旧游标会让新账号的增量漏读
  kvDelete(`im.wechat.cursor.${channelId}`);
}

/* ------------------------------ 思考档位 ------------------------------ */

/** 通道的所有绑定会话（改思考档位时逐一会话下发） */
function listChannelSessionIds(channelId: string): string[] {
  ensureImTables();
  const rows = getDb()
    .prepare("SELECT DISTINCT session_id FROM im_binding WHERE channel_id = ?1")
    .all(channelId) as { session_id: string }[];
  return rows.map((r) => r.session_id);
}

/** 下发单会话思考档位（off 也显式下发：覆盖会话历史档位） */
export async function applyThinkingLevel(
  sessionId: string,
  level: ImChannelConfig["thinkingLevel"],
): Promise<void> {
  try {
    await pi.piRequest({
      payload: { type: "set_thinking", sessionId, level },
      timeoutMs: 10_000,
    });
  } catch (e: unknown) {
    logWarn(
      `[im/router] set_thinking failed session=${sessionId.slice(0, 8)}…: ${e instanceof Error ? e.message : e}`,
    );
  }
}

/** 配置变更时把新档位应用到该通道的全部已绑定会话 */
export async function applyThinkingToChannel(
  channelId: string,
  level: ImChannelConfig["thinkingLevel"],
): Promise<void> {
  for (const sid of listChannelSessionIds(channelId)) {
    await applyThinkingLevel(sid, level);
  }
}

/* ------------------------------ 绑定表 ------------------------------ */

export function getBinding(platform: string, channelId: string, chatId: string): { sessionId: string; pinned: boolean } | null {
  ensureImTables();
  const row = getDb()
    .prepare("SELECT session_id, pinned FROM im_binding WHERE platform = ?1 AND channel_id = ?2 AND chat_id = ?3")
    .get(platform, channelId, chatId) as { session_id: string; pinned: number } | undefined;
  return row ? { sessionId: row.session_id, pinned: Number(row.pinned) !== 0 } : null;
}

export function setBinding(input: {
  platform: string;
  channelId: string;
  chatId: string;
  senderId: string;
  sessionId: string;
  pinned: boolean;
}): void {
  ensureImTables();
  getDb()
    .prepare(
      `INSERT INTO im_binding(platform, channel_id, chat_id, sender_id, session_id, strategy, pinned, updated_at)
       VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(platform, channel_id, chat_id) DO UPDATE SET
         sender_id = excluded.sender_id, session_id = excluded.session_id,
         strategy = excluded.strategy, pinned = excluded.pinned, updated_at = excluded.updated_at`,
    )
    .run(
      input.platform,
      input.channelId,
      input.chatId,
      input.senderId,
      input.sessionId,
      input.pinned ? "pin" : "per-chat",
      input.pinned ? 1 : 0,
      Date.now(),
    );
}

export function deleteBinding(platform: string, channelId: string, chatId: string): void {
  ensureImTables();
  getDb()
    .prepare("DELETE FROM im_binding WHERE platform = ?1 AND channel_id = ?2 AND chat_id = ?3")
    .run(platform, channelId, chatId);
}

/* ------------------------------ 回程聚合 ------------------------------ */

/**
 * 每个被 IM 关注的会话一条聚合队列。
 * 帧形状事实（sidecar stream.ts/thread-events.ts 已核实）：
 * - chunk 流是 { id: requestId, chunk: {type,...} } 包装，顶层无 sessionId；
 * - thread_event 帧才有顶层 sessionId；文本增量在
 *   event.assistantMessageEvent（type="text_delta"，pi-ai 下划线命名，
 *   delta 字段）；
 * - agent_end 事件带 stopReason/errorMessage —— 与桌面端同语义的结算信号
 *   （aborted 不提醒、error 走错误分支）。
 * 因此：文本只从 thread_event 累积（chunk 流是遗留并行流，同内容，避免双计）；
 * 结算只认 agent_end。注意 sidecar 按线程串行执行 turn、IM 消息却可能连发：
 * 聚合必须按会话排队（FIFO），agent_end 依次结算队首——否则第 1 轮的
 * agent_end 会把第 2 轮刚登记的聚合结掉，回复错位且第 2 轮丢回复。
 */
interface ReplyAggregate {
  platform: string;
  channelId: string;
  sessionId: string;
  target: ImOutboundTarget;
  textParts: string[];
  timer: NodeJS.Timeout;
  /** 本通道的回复颗粒度快照（登记时取，结算时用） */
  replyDetail: ImChannelConfig["replyDetail"];
  /** live 档：思考增量缓冲 + 上次进度推送时间（节流用） */
  liveThinking: string[];
  lastLiveSentAt: number;
  /** prompt requestId：chunk 流错误/收尾帧按 id 精确归属（thread_event 无此字段） */
  requestId: string;
  /** 本轮是否已经发过正文/错误（finish 兜底时避免重复发送） */
  sentAny: boolean;
  /** 错误文案是否已经发过（message_end 与 error chunk 可能同时携带） */
  errorSent: boolean;
  /** 出站串行链：多条 assistant 消息的正文/思考必须按序发出 */
  sendChain: Promise<void>;
}
const pendingReplies = new Map<string, ReplyAggregate[]>();
/** requestId → 所属聚合（chunk 错误帧即时归因；随聚合同生共死） */
const pendingByRequest = new Map<string, { sessionId: string; agg: ReplyAggregate }>();
const REPLY_SETTLE_TIMEOUT_MS = 10 * 60_000;

/** 取队首（当前正在执行的那一轮） */
function headAggregate(sessionId: string): ReplyAggregate | undefined {
  return pendingReplies.get(sessionId)?.[0];
}

function removeAggregate(sessionId: string, agg: ReplyAggregate): void {
  clearTimeout(agg.timer);
  pendingByRequest.delete(agg.requestId);
  const queue = pendingReplies.get(sessionId);
  if (!queue) return;
  const next = queue.filter((a) => a !== agg);
  if (next.length === 0) pendingReplies.delete(sessionId);
  else pendingReplies.set(sessionId, next);
}

/** 清空该会话全部待结算聚合（/stop、/new、通道删除） */
function clearPendingReplies(sessionId: string): void {
  const queue = pendingReplies.get(sessionId);
  if (!queue) return;
  for (const agg of queue) {
    clearTimeout(agg.timer);
    pendingByRequest.delete(agg.requestId);
  }
  pendingReplies.delete(sessionId);
}

/** pi-agent 无 id 帧旁路：thread_event 文本累积 + 按颗粒度选点回传 */
export function handleAgentFrame(parsed: Record<string, unknown>): void {
  const chunk = parsed.chunk as Record<string, unknown> | undefined;
  const chunkId = typeof parsed.id === "string" ? parsed.id : null;

  // chunk 收尾帧（{id: requestId, chunk:{type:"finish"}}）：本轮**精确结算**。
  // thread_event 的 agent_end 不带 requestId，只能按队首猜归属——同会话排队
  // 两条消息时，第一条的 agent_end 会把第二条的聚合错结（回复丢失）。
  if (chunk?.type === "finish" && chunkId) {
    const entry = pendingByRequest.get(chunkId);
    if (!entry) return;
    const { sessionId, agg } = entry;
    removeAggregate(sessionId, agg);
    if (agg.replyDetail === "live") {
      // live 正文已逐条发出：收尾只冲刷残余思考并取消 typing
      enqueueSend(agg, async () => {
        await flushLiveThinking(agg);
        await setTypingSafe(agg, false);
      });
      return;
    }
    // digest 需要整轮总结（错误话已发过就不总结失败轮）；
    // standard/full 若本轮一个字都没发过（纯工具轮）才用历史兜底，已发过不重复
    if (agg.replyDetail === "digest" ? !agg.errorSent : !agg.sentAny) {
      void deliverAggregate(agg, null);
    }
    return;
  }

  // chunk 流错误帧（{id: requestId, chunk:{type:"error"}}）：按 requestId 归因，
  // 立刻给 IM 回错误并清聚合——否则要空等 10 分钟结算超时。
  if (chunk?.type === "error" && chunkId) {
    const entry = pendingByRequest.get(chunkId);
    if (!entry) return;
    const { sessionId, agg } = entry;
    removeAggregate(sessionId, agg);
    const errText =
      typeof chunk.errorText === "string" && chunk.errorText
        ? chunk.errorText
        : "处理出错";
    // 会话已被桌面端删除/失效：解绑，让下一条消息自动新建会话（自愈闭环）
    if (/not found|session[^\n]*(not|invalid|missing)|unknown session/i.test(errText)) {
      deleteBinding(agg.platform, agg.channelId, agg.target.chatId);
    }
    // message_end 的错误分支可能已经发过同一错误，避免重复
    if (!agg.errorSent) {
      void sendViaChannel(agg.channelId, agg.target, `处理出错：${errText}`);
    }
    return;
  }

  const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : null;
  if (!sessionId) return;
  if (parsed.type !== "thread_event") return;

  const event = parsed.event as Record<string, unknown> | undefined;
  if (!event) return;

  const head = headAggregate(sessionId);
  if (!head) return; // 非 IM 发起的轮次（桌面/自动化），不关心

  if (event.type === "message_update") {
    const ev = event.assistantMessageEvent as Record<string, unknown> | undefined;
    // pi-ai 事件用下划线（text_delta / thinking_delta）；chunk 流用连字符。
    // 这里两种都认，防底层改名时聚合静默失效。
    const isTextDelta = ev?.type === "text_delta" || ev?.type === "text-delta";
    if (isTextDelta && typeof ev?.delta === "string" && ev.delta) {
      head.textParts.push(ev.delta);
      return;
    }
    // live 档：思考增量按节流窗口聚合成「进度短消息」推送（其他档位静默）
    const isThinkingDelta =
      ev?.type === "thinking_delta" || ev?.type === "reasoning-delta";
    if (
      head.replyDetail === "live" &&
      isThinkingDelta &&
      typeof ev?.delta === "string" &&
      ev.delta
    ) {
      pushLiveThinking(head, ev.delta);
    }
    return;
  }

  // live 档：工具执行进度即时推送（开始一行、失败一行）
  if (event.type === "tool_execution_start" && head.replyDetail === "live") {
    const toolName = typeof event.toolName === "string" ? event.toolName : "工具";
    pushLiveProgress(head, `🔧 ${toolName}…`);
    return;
  }
  if (
    event.type === "tool_execution_end" &&
    head.replyDetail === "live" &&
    event.isError === true
  ) {
    pushLiveProgress(head, `⚠️ 上一步执行失败，正在调整…`);
    return;
  }

  if (event.type === "message_end") {
    // 注意：message_end 对 user（初始消息回放）与 toolResult 消息同样触发
    // （pi-agent-core agent-loop），它们无 stopReason 且无 assistant 文本——
    // 必须先按 role 过滤，否则工具一执行完就会误处理。
    const message = event.message as Record<string, unknown> | undefined;
    if (message?.role !== "assistant") return;
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
    if (stopReason === "aborted") return;
    const text = assistantTextOfMessage(message);
    const errorMessage =
      stopReason === "error" && typeof message.errorMessage === "string"
        ? message.errorMessage
        : null;

    // 关键：聚合**不在 message_end 摘除**，统一由 finish 帧精确结算。
    // 提前摘除会让同一会话排队中的下一条消息被本轮 agent_end 错结。
    // 错误先于档位分支：digest 也要把错误带回 IM（否则错误被静默吞掉）
    if (errorMessage) {
      head.sentAny = true;
      head.errorSent = true;
      if (head.replyDetail === "live") {
        enqueueSend(head, async () => {
          await flushLiveThinking(head);
          await deliverText(head, text, errorMessage, false);
        });
      } else {
        void deliverText(head, text, errorMessage, false);
      }
      return;
    }
    if (head.replyDetail === "digest") return; // 等 finish 帧整轮总结
    if (!text) return;
    head.sentAny = true;
    const isIntermediate = stopReason === "toolUse";
    if (head.replyDetail === "live") {
      // 思考只在最终一条冲刷：工具轮的思考并进下一轮，一个回合一条 💭
      enqueueSend(head, async () => {
        if (!isIntermediate) await flushLiveThinking(head);
        await deliverText(head, text, null, isIntermediate);
      });
    } else {
      void deliverText(head, text, null, isIntermediate);
    }
    return;
  }

  if (event.type === "agent_end") {
    const stopReason = typeof event.stopReason === "string" ? event.stopReason : undefined;
    if (stopReason === "aborted") {
      // 用户停止（桌面端 /stop 或 IM /stop）：取消 typing 并清空该会话队列；
      // 正常收尾一律走 chunk finish（带 requestId，能精确归属到某一轮）
      const queue = pendingReplies.get(sessionId) ?? [];
      for (const agg of queue) {
        if (agg.replyDetail === "live") void setTypingSafe(agg, false);
      }
      clearPendingReplies(sessionId);
    }
  }
}

/** 从 message_end 的 message 提取 assistant 正文 */
function assistantTextOfMessage(message: Record<string, unknown> | undefined): string {
  if (!message) return "";
  const content = Array.isArray(message.content) ? message.content : [];
  const texts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        texts.push(b.text);
      }
    }
  }
  return texts.join("\n").trim();
}

/** 直接发送一段已备好的文本（message_end 即时回传路径），带超长截断 */
async function deliverText(
  agg: ReplyAggregate,
  text: string,
  errorText: string | null,
  intermediate: boolean,
): Promise<void> {
  let reply = errorText ? `处理出错：${errorText}` : text;
  if (!errorText && !reply) return; // 无文本（纯工具消息）不发
  if (!errorText && intermediate) {
    reply = text ? `${text}\n\n（已回复，任务仍在继续执行…）` : text;
  }
  if (!reply) return;
  if (reply.length > REPLY_MAX_CHARS) {
    reply = `${reply.slice(0, REPLY_MAX_CHARS)}\n…（内容过长已截断，可在桌面端查看完整回复）`;
  }
  await sendViaChannel(agg.channelId, agg.target, reply);
}

/* ------------------------------ live 档进度推送 ------------------------------ */

const LIVE_PROGRESS_MIN_INTERVAL_MS = 4_000;
/** 思考缓冲上限（字符）：长思考只保留尾部，防内存无界增长 */
const LIVE_THINKING_MAX_CHARS = 4000;

/**
 * 思考增量只入缓冲、不在流中分段推送：同一段思考如果既被节流推送、
 * 又被正文前冲刷，会拆成两条消息（用户看到的"思考分了两段"）。
 * 实时感由 typing 状态承担；内容在 message_end 一次性冲刷（见 flush）。
 */
function pushLiveThinking(agg: ReplyAggregate, delta: string): void {
  agg.liveThinking.push(delta);
  if (agg.liveThinking.length > 200) {
    const joined = agg.liveThinking.join("");
    agg.liveThinking = [joined.slice(-LIVE_THINKING_MAX_CHARS)];
  }
}

/**
 * 把缓冲里的思考一次性发出（每条 assistant 消息一条）。
 * 在 assistant 正文回传前 / 整轮收尾时调用。
 */
async function flushLiveThinking(agg: ReplyAggregate): Promise<void> {
  const text = agg.liveThinking.join("").trim();
  agg.liveThinking = [];
  if (!text) return;
  const clipped = text.length > 300 ? `…${text.slice(-300)}` : text;
  await sendViaChannel(agg.channelId, agg.target, `💭 ${clipped}`);
}

/** 工具进度行（开始/失败）推送，4s 最小间隔防刷屏 */
function pushLiveProgress(agg: ReplyAggregate, line: string): void {
  const now = Date.now();
  if (now - agg.lastLiveSentAt < LIVE_PROGRESS_MIN_INTERVAL_MS) return;
  agg.lastLiveSentAt = now;
  enqueueSend(agg, () => sendViaChannel(agg.channelId, agg.target, line));
}

/** 出站串行：live 档一个回合内可能有多条消息（正文/思考/工具进度），
 *  异步发送若并发会打乱到达顺序（💭 插到正文后面），统一走聚合的链。 */
function enqueueSend(agg: ReplyAggregate, task: () => Promise<void>): void {
  agg.sendChain = agg.sendChain.then(task, task).catch(() => undefined);
}

/** typing 开关的安全包装：适配器不支持/未启动时静默 */
async function setTypingSafe(agg: ReplyAggregate, on: boolean): Promise<void> {
  try {
    const cfg = listChannelConfigs().find((c) => c.id === agg.channelId);
    if (!cfg) return;
    const adapter = getImAdapter(cfg.platform as ImPlatform, agg.channelId);
    await adapter?.setTyping?.(agg.target, on);
  } catch {
    // 尽力而为
  }
}

/** 结算回复：优先 get_history 取最终文本（流聚合可能缺帧），失败回落流聚合 */
async function deliverAggregate(agg: ReplyAggregate, errorText: string | null): Promise<void> {
  let reply = "";
  let historyMessages: { role?: string; parts?: unknown }[] | null = null;
  if (!errorText) {
    try {
      const line = await pi.piRequest({
        payload: { type: "get_history", sessionId: agg.sessionId, tail: 40 },
        timeoutMs: 15_000,
      });
      const parsed = JSON.parse(line) as {
        messages?: { role?: string; parts?: unknown }[];
      };
      historyMessages = parsed.messages ?? [];
      reply = extractLastAssistantText(historyMessages);
    } catch {
      reply = agg.textParts.join("");
    }
  }
  if (!reply && !errorText) reply = agg.textParts.join("");
  if (!reply && !errorText) return; // 无内容（纯工具轮）不回复
  if (errorText) {
    reply = `处理出错：${errorText}`;
  } else if (historyMessages) {
    reply = renderReplyByDetail(reply, historyMessages, agg.replyDetail);
  }
  if (reply.length > REPLY_MAX_CHARS) {
    reply = `${reply.slice(0, REPLY_MAX_CHARS)}\n…（内容过长已截断，可在桌面端查看完整回复）`;
  }
  await sendViaChannel(agg.channelId, agg.target, reply);
}

/**
 * 按颗粒度渲染回复：
 * - standard：仅助手正文（extractLastAssistantText 的结果原样）
 * - full：正文 + 该轮工具调用摘要行（工具名 + 失败标记），隐藏推理段
 * - digest：整轮压成一行（正文首行/前 80 字），长任务的速览
 */
function renderReplyByDetail(
  reply: string,
  messages: { role?: string; parts?: unknown }[],
  detail: ImChannelConfig["replyDetail"],
): string {
  if (detail === "standard") return reply;
  const lastAssistant = [...messages].reverse().find((m) => m?.role === "assistant");
  if (!lastAssistant) return reply;
  const parts = Array.isArray(lastAssistant.parts) ? lastAssistant.parts : [];

  const toolSummaries: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const type = typeof p.type === "string" ? p.type : "";
    if (!type.startsWith("tool-")) continue;
    const toolName = type.slice("tool-".length);
    const failed = p.state === "output-error";
    const input = p.input;
    let hint = "";
    if (input && typeof input === "object") {
      const obj = input as Record<string, unknown>;
      const cmd = typeof obj.cmd === "string" ? obj.cmd : typeof obj.command === "string" ? obj.command : "";
      const path = typeof obj.path === "string" ? obj.path : typeof obj.file_path === "string" ? obj.file_path : "";
      hint = cmd || path;
      if (hint.length > 60) hint = `${hint.slice(0, 60)}…`;
    }
    toolSummaries.push(`${failed ? "✗" : "·"} ${toolName}${hint ? ` ${hint}` : ""}`);
  }

  if (detail === "digest") {
    const firstLine = reply.split("\n").find((l) => l.trim()) ?? "";
    const digest = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
    const suffix = toolSummaries.length ? `（${toolSummaries.length} 次工具调用）` : "";
    return digest ? `${digest}${suffix}` : (toolSummaries.length ? `已完成（${toolSummaries.length} 次工具调用）` : "");
  }

  // full：正文 + 工具摘要附在末尾
  if (toolSummaries.length === 0) return reply;
  return `${reply}\n\n—— 工具调用 ——\n${toolSummaries.join("\n")}`;
}

/** 从 get_history 消息行提取最后一轮 assistant 文本 */
function extractLastAssistantText(messages: { role?: string; parts?: unknown }[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const parts = Array.isArray(m.parts) ? m.parts : [];
    const texts: string[] = [];
    for (const part of parts) {
      if (part && typeof part === "object" && (part as Record<string, unknown>).type === "text") {
        const t = (part as Record<string, unknown>).text;
        if (typeof t === "string") texts.push(t);
      }
    }
    const joined = texts.join("\n").trim();
    if (joined) return joined;
  }
  return "";
}

async function sendViaChannel(channelId: string, target: ImOutboundTarget, text: string): Promise<void> {
  const cfg = listChannelConfigs().find((c) => c.id === channelId);
  if (!cfg) return;
  const adapter = getImAdapter(cfg.platform as ImPlatform, channelId);
  if (!adapter) return;
  try {
    await adapter.sendText(target, text);
    logInfo(`[im/router] reply sent channel=${channelId} len=${text.length}`);
  } catch (e: unknown) {
    logWarn(`[im/router] reply failed channel=${channelId}: ${e instanceof Error ? e.message : e}`);
  }
}

/* ------------------------------ 最近入站目标 ------------------------------ */

/** 每通道最近一次入站的发送目标（chatId + 平台私有回复凭据）。
 *  测试消息等「没有上下文」的发送复用它——owner 是 senderId，与平台回复锚点
 *  （钉钉 conversationId、飞书 chat_id 等）并不等价，直接拿 owner 拼目标会失败。 */
const lastInboundTargets = new Map<string, ImOutboundTarget>();

export function getLastInboundTarget(channelId: string): ImOutboundTarget | null {
  return lastInboundTargets.get(channelId) ?? null;
}

/** 丢弃通道的最近入站目标（解绑/重绑/平台切换/重置 owner）：
 *  旧目标属于旧账号或旧 owner，继续用它发消息会投给错误的人。 */
export function forgetLastInboundTarget(channelId: string): void {
  lastInboundTargets.delete(channelId);
}

function rememberInboundTarget(msg: ImInboundMessage): void {
  lastInboundTargets.set(msg.channelId, {
    chatId: msg.chatId,
    replyContext: msg.replyContext,
  });
}

/* ------------------------------ 入站路由 ------------------------------ */

/**
 * IM 会话的线程键：由 sessionId 派生且稳定不变。
 * 不传 threadId 会被侧车归到 "default" 线程——所有聊天共用一条串行链
 * （互相排队、/stop 也停不掉）；传每聊天不同的键又会对同一钉住会话反复
 * rebind。按会话派生是唯一同时满足并发隔离与稳定的选择。
 */
function imThreadId(sessionId: string): string {
  return `im:${sessionId}`;
}

/** 陌生人提示节流：同一聊天 10 分钟内最多提示一次（防刷屏/无意义回声） */
const strangerNoticeAt = new Map<string, number>();
const STRANGER_NOTICE_TTL_MS = 10 * 60_000;
function shouldNotifyStranger(msg: ImInboundMessage): boolean {
  const key = `${msg.channelId}:${msg.chatId}`;
  const now = Date.now();
  for (const [k, ts] of strangerNoticeAt) {
    if (now - ts > STRANGER_NOTICE_TTL_MS) strangerNoticeAt.delete(k);
  }
  const last = strangerNoticeAt.get(key);
  if (last !== undefined && now - last < STRANGER_NOTICE_TTL_MS) return false;
  strangerNoticeAt.set(key, now);
  return true;
}

/**
 * 入站串行化：平台可能批量推多条消息（同一 sink 批次里并发调用），
 * 若并发处理会在「绑定不存在」窗口内各自 new_session，导致双建会话、
 * 绑定被后者覆盖。按 (channel, chat) 串行，不同聊天仍并行。
 */
const inboundChains = new Map<string, Promise<void>>();

export function handleInbound(msg: ImInboundMessage): Promise<void> {
  const key = `${msg.channelId}:${msg.chatId}`;
  const prev = inboundChains.get(key) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => handleInboundInner(msg))
    // 单条失败只记录，不阻断该聊天的后续消息（适配器 sink 是 void 调用）
    .catch((e: unknown) => {
      logWarn(
        `[im/router] inbound failed channel=${msg.channelId}: ${e instanceof Error ? e.message : e}`,
      );
    });
  inboundChains.set(key, next);
  void next
    .finally(() => {
      if (inboundChains.get(key) === next) inboundChains.delete(key);
    })
    .catch(() => undefined);
  return next;
}

async function handleInboundInner(msg: ImInboundMessage): Promise<void> {
  // 通道有效性先于一切门控：已删除/已禁用的通道不建 owner、不建绑定、不回复
  const cfg = listChannelConfigs().find((c) => c.id === msg.channelId);
  if (!cfg || !cfg.enabled) return;

  const decision = checkInboundAccess(msg);
  if (decision === "dedup") return;
  if (decision === "deny") {
    // 陌生人私聊：固定提示（按聊天节流，防刷屏）；群聊静默
    if (msg.chatType === "p2p" && shouldNotifyStranger(msg)) {
      await sendViaChannel(msg.channelId, { chatId: msg.chatId, replyContext: msg.replyContext },
        "你好，该助手暂未对你的账号开放。请联系 Bot 主人确认。");
    }
    return;
  }

  // 记录最近入站目标（测试消息兜底；命令消息也记录，证明通道可达）
  rememberInboundTarget(msg);

  // IM 内命令：先于 agent 处理
  const command = parseSlashCommand(msg.text);
  if (command) {
    await runCommand(msg, cfg, command);
    return;
  }

  // 绑定解析：命中即用；未命中按策略建会话
  let binding = getBinding(msg.platform, msg.channelId, msg.chatId);
  let justBound = false;
  const pinned = cfg.pinnedSessionId;
  if (!binding && pinned) {
    // 单会话模式：钉住会话，首条消息落绑定
    setBinding({
      platform: msg.platform,
      channelId: msg.channelId,
      chatId: msg.chatId,
      senderId: msg.senderId,
      sessionId: pinned,
      pinned: true,
    });
    binding = { sessionId: pinned, pinned: true };
    justBound = true;
  }
  if (!binding) {
    try {
      const line = await pi.piRequest({
        payload: {
          type: "new_session",
          threadId: `im-${msg.platform}-${msg.channelId}-${msg.chatId}`,
          ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
        },
        timeoutMs: 30_000,
      });
      const created = JSON.parse(line) as { sessionId?: string };
      if (!created.sessionId) throw new Error("new_session 未返回 sessionId");
      setBinding({
        platform: msg.platform,
        channelId: msg.channelId,
        chatId: msg.chatId,
        senderId: msg.senderId,
        sessionId: created.sessionId,
        pinned: false,
      });
      binding = { sessionId: created.sessionId, pinned: false };
      justBound = true;
      logInfo(`[im/router] session bound channel=${msg.channelId} chat=${msg.chatId.slice(0, 8)}… session=${created.sessionId}`);
    } catch (e: unknown) {
      logWarn(`[im/router] new_session failed: ${e instanceof Error ? e.message : e}`);
      await sendViaChannel(msg.channelId, { chatId: msg.chatId, replyContext: msg.replyContext },
        "会话创建失败，请稍后重试。");
      return;
    }
  }

  const sessionId = binding.sessionId;
  // requestId 是 finish/error 帧精确归属的键，必须全局唯一：
  // 平台 message_id 可能按会话递增（不同聊天可能撞号），加随机后缀兜底
  const requestId = `im-${msg.messageId ?? Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // 新绑定：把通道配置的思考档位落到该会话（IM 会话不走桌面端默认档）
  if (justBound) {
    await applyThinkingLevel(sessionId, cfg.thinkingLevel);
  }
  // 首次绑定：先发一次引导（命令用法），再投递本条消息
  if (justBound) {
    await sendViaChannel(
      msg.channelId,
      { chatId: msg.chatId, replyContext: msg.replyContext },
      WELCOME_HINT,
    );
  }
  // 排入该会话的聚合队列（FIFO）：sidecar 串行执行，agent_end 依序结算
  const agg: ReplyAggregate = {
    platform: msg.platform,
    channelId: msg.channelId,
    sessionId,
    target: { chatId: msg.chatId, replyContext: msg.replyContext },
    textParts: [],
    timer: setTimeout(() => {
      // 结算超时兜底：把该条从队列摘除（不让会话永久卡住）
      const queue = pendingReplies.get(sessionId);
      if (!queue?.includes(agg)) return;
      removeAggregate(sessionId, agg);
      if (cfg.replyDetail === "live") {
        // live 档正文已逐条发出：超时只收尾（冲刷残余思考 + 取消 typing），
        // 不能再走 deliverAggregate 重发一遍最后一条正文
        enqueueSend(agg, async () => {
          await flushLiveThinking(agg);
          await setTypingSafe(agg, false);
        });
        return;
      }
      // digest 超时仍给整轮总结；standard/full 只在从未发过内容时兜底
      if (cfg.replyDetail === "digest" || !agg.sentAny) {
        void deliverAggregate(agg, null);
      }
    }, REPLY_SETTLE_TIMEOUT_MS),
    replyDetail: cfg.replyDetail,
    liveThinking: [],
    lastLiveSentAt: 0,
    requestId,
    sentAny: false,
    errorSent: false,
    sendChain: Promise.resolve(),
  };
  agg.timer.unref?.();
  try {
    // 先写入 sidecar，成功后再登记聚合：登记顺序与 sidecar 的实际执行顺序
    // 严格一致（钉住同一会话的多个聊天并发投递时，队首归属不会错位）。
    // 响应帧是 stdout 宏任务，晚于本次同步登记，不存在"帧到了还没登记"。
    await pi.piPrompt({
      requestId,
      text: msg.text,
      sessionId,
      threadId: imThreadId(sessionId),
    });
    const queue = pendingReplies.get(sessionId) ?? [];
    queue.push(agg);
    pendingReplies.set(sessionId, queue);
    pendingByRequest.set(requestId, { sessionId, agg });
    // live 档：投递成功即刻点亮「正在输入」
    if (cfg.replyDetail === "live") {
      void setTypingSafe(agg, true);
    }
  } catch (e: unknown) {
    clearTimeout(agg.timer);
    logWarn(`[im/router] prompt failed: ${e instanceof Error ? e.message : e}`);
    await sendViaChannel(msg.channelId, { chatId: msg.chatId, replyContext: msg.replyContext },
      "消息投递失败，请稍后重试。");
  }
}

/* ------------------------------ IM 内命令 ------------------------------ */

type SlashCommand = { name: "new" | "clear" | "stop"; args: string };

const KNOWN_COMMANDS = new Set(["new", "clear", "stop"]);

/** 只拦截已知命令：以 / 开头的普通文本（如路径 "/etc/hosts 是什么"）
 *  必须原样交给 agent，不能被误判成命令吞掉 */
function parseSlashCommand(text: string): SlashCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([a-z][\w-]*)(?:@[^\s]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const name = (match[1] ?? "").toLowerCase();
  if (!KNOWN_COMMANDS.has(name)) return null;
  return { name: name as SlashCommand["name"], args: (match[2] ?? "").trim() };
}

async function runCommand(
  msg: ImInboundMessage,
  cfg: ImChannelConfig,
  command: SlashCommand,
): Promise<void> {
  const reply = async (text: string) =>
    sendViaChannel(cfg.id, { chatId: msg.chatId, replyContext: msg.replyContext }, text);
  switch (command.name) {
    case "new": {
      const binding = getBinding(msg.platform, cfg.id, msg.chatId);
      if (binding) clearPendingReplies(binding.sessionId);
      deleteBinding(msg.platform, cfg.id, msg.chatId);
      await reply("已开启新对话，下一条消息将在全新会话中进行。");
      return;
    }
    case "clear": {
      const binding = getBinding(msg.platform, cfg.id, msg.chatId);
      if (binding) {
        try {
          await pi.piRequest({
            payload: { type: "compact", sessionId: binding.sessionId },
            timeoutMs: 60_000,
          });
          await reply("当前会话上下文已压缩。");
        } catch {
          await reply("上下文压缩失败，请稍后重试。");
        }
      } else {
        await reply("当前还没有进行中的对话。");
      }
      return;
    }
    case "stop": {
      const binding = getBinding(msg.platform, cfg.id, msg.chatId);
      if (!binding) {
        await reply("当前还没有进行中的对话。");
        return;
      }
      clearPendingReplies(binding.sessionId);
      await pi.piAbort({ threadId: imThreadId(binding.sessionId) });
      await reply("已停止当前任务。");
      return;
    }
  }
}
