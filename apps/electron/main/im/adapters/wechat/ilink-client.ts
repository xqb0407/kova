/**
 * 微信 iLink Bot 轻量客户端。
 *
 * 协议事实双源核对：腾讯官方 @tencent-weixin/openclaw-weixin（MIT）源码 +
 * 本项目早期已验证可用的同协议接入实现（services/bots/providers/weixin*）。
 * 校准要点：
 * - 基址固定 https://ilinkai.weixin.qq.com；登录后可用 confirmed 下发的 baseurl
 * - 扫码/状态为 **GET**（iLink-App-ClientVersion: "1"），状态响应可能包在 data 下、
 *   状态值可能是数字（0/1/2/3/4）
 * - token 请求头：content-type / AuthorizationType / Authorization / X-WECHAT-UIN
 *   （另附官方 App-Id 头，兼容两种服务端校验）
 * - 请求体附 base_info {channel_version}
 * - getupdates 超时 90s、QR 状态 30s，超时按正常控制流返回空态
 * - 入站消息字段有嵌套（msg/message）与多种别名，统一在此归一
 * - 发送正文换行统一 CRLF（平台客户端对 LF 处理不一致，多行会折叠）
 */
import { randomInt, randomUUID } from "node:crypto";

import { logWarn } from "../../../logging";

import type {
  IlinkMessage,
  IlinkMessageItem,
  IlinkQrcodeResp,
  IlinkQrcodeStatusResp,
} from "./ilink-protocol";

/** 固定登录/默认 API 基址 */
export const ILINK_QR_BASE_URL = "https://ilinkai.weixin.qq.com";
export const ILINK_DEFAULT_BASE_URL = ILINK_QR_BASE_URL;

/** 通道协议版本（与已验证接入实现一致） */
const CHANNEL_VERSION = "2.0.0";
const BOT_AGENT = "Kova";
/** 官方渠道的 ilink_appid；GET 扫码路径使用 ClientVersion: "1" */
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = "1";

const QR_TIMEOUT_MS = 30_000;
const QR_STATUS_TIMEOUT_MS = 30_000;
const LONG_POLL_TIMEOUT_MS = 90_000;
const API_TIMEOUT_MS = 15_000;

/* ------------------------------ 通用工具 ------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function readString(record: Record<string, unknown> | null | undefined, key: string): string {
  const v = record?.[key];
  return typeof v === "string" ? v : "";
}

function readNumber(record: Record<string, unknown> | null | undefined, key: string): number | null {
  const v = record?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readNumberOrString(record: Record<string, unknown> | null | undefined, key: string): string {
  const v = record?.[key];
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

function readObject(record: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const v = record?.[key];
  return isRecord(v) ? v : null;
}

/** 响应可能包一层 data：{ret, data: {...}} → 合并为扁平对象 */
function unwrapData(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  const data = readObject(payload, "data");
  return data ? { ...payload, ...data } : payload;
}

/** 底层网络错误 → 可读文案 */
function describeFetchError(e: unknown): Error {
  if (e instanceof Error) {
    if (e.name === "AbortError" || e.name === "TimeoutError") return new Error("iLink 请求超时");
    if (/fetch failed/i.test(e.message)) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      const detail = cause?.code ?? cause?.message ?? "网络不可达";
      return new Error(`iLink 接口请求失败（${detail}）`);
    }
    return e;
  }
  return new Error(String(e));
}

function joinUrl(baseUrl: string, endpoint: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(endpoint, base).toString();
}

function randomWechatUin(): string {
  return Buffer.from(String(randomInt(0, 0x1_0000_0000)), "utf8").toString("base64");
}

/** 同文案只告警一次（typing 等尽力而为路径，不刷日志） */
const warnedKeys = new Set<string>();
function logWarnOnce(key: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  logWarn(`[im/wechat] ${key}`);
}

function getHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
    "iLink-App-Id": ILINK_APP_ID,
  };
  if (token?.trim()) {
    Object.assign(headers, {
      "content-type": "application/json",
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${token.trim()}`,
      "X-WECHAT-UIN": randomWechatUin(),
    });
  } else {
    headers["content-type"] = "application/json";
  }
  return headers;
}

async function fetchJson(
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<{ payload: Record<string, unknown>; timeout: boolean }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: ac.signal });
    if (!resp.ok) throw new Error(`iLink HTTP ${resp.status}`);
    return { payload: unwrapData(await resp.json()), timeout: false };
  } catch (e: unknown) {
    if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) {
      return { payload: {}, timeout: true };
    }
    throw describeFetchError(e);
  } finally {
    clearTimeout(timer);
  }
}

function assertOk(payload: Record<string, unknown>, label: string): void {
  const ret = readNumber(payload, "ret");
  const errcode = readNumber(payload, "errcode");
  if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)) {
    const msg = readString(payload, "errmsg") || readString(payload, "message") || `ret=${ret ?? ""} errcode=${errcode ?? ""}`;
    throw new Error(`${label}失败：${msg}`.trim());
  }
}

/** 数字/字符串状态 → 统一词表（iLink 拼写 "scaned" 保留，由调用方归一） */
function normalizeWireStatus(raw: unknown): string {
  if (typeof raw === "number") {
    if (raw === 0) return "wait";
    if (raw === 1) return "scaned";
    if (raw === 2) return "confirmed";
    if (raw === 3 || raw === 4) return "expired";
    return "wait";
  }
  if (typeof raw === "string" && raw) return raw.toLowerCase();
  return "wait";
}

/* ------------------------------ 入站消息归一 ------------------------------ */

function readTextFromItem(item: Record<string, unknown>): string {
  const textItem = readObject(item, "text_item");
  return (
    readString(textItem, "text") ||
    readString(item, "text") ||
    readString(item, "content")
  );
}

/** 把平台原始消息（可能嵌套 msg/message）归一成 IlinkMessage */
function normalizeMessage(raw: Record<string, unknown>): IlinkMessage | null {
  const inner = readObject(raw, "msg") ?? readObject(raw, "message");
  const src = inner ? { ...inner, ...raw } : raw;

  const type = readNumber(src, "message_type") ?? readNumber(src, "type");
  if (type === 2) return null; // BOT 自身回环

  const itemsRaw = Array.isArray(src.item_list)
    ? src.item_list
    : Array.isArray(inner?.item_list)
      ? inner.item_list
      : [];
  const item_list: IlinkMessageItem[] = [];
  const texts: string[] = [];
  for (const it of itemsRaw) {
    if (!isRecord(it)) continue;
    const itemType = readNumber(it, "type") ?? readNumber(it, "item_type") ?? undefined;
    const text = readTextFromItem(it);
    item_list.push({ type: itemType, text_item: text ? { text } : undefined });
    if (text) texts.push(text);
  }
  const text =
    texts.join("\n").trim() ||
    readString(src, "text") ||
    readString(src, "content") ||
    readString(inner, "text") ||
    readString(inner, "content");

  const chatId =
    readString(src, "from_user_id") ||
    readString(src, "from_user") ||
    readString(src, "user_id") ||
    readString(src, "userId") ||
    readString(readObject(src, "from"), "id") ||
    readString(readObject(src, "sender"), "id");

  const messageId =
    readNumberOrString(src, "message_id") ||
    readString(src, "msgid") ||
    readString(src, "msgId") ||
    readString(src, "id") ||
    readNumberOrString(inner, "message_id");

  const contextToken =
    readString(src, "context_token") ||
    readString(src, "contextToken") ||
    readString(inner, "context_token");

  const createTime =
    readNumber(src, "create_time_ms") ??
    readNumber(inner, "create_time_ms") ??
    readNumber(src, "create_time") ??
    undefined;

  if (!text || !chatId) return null;

  return {
    from_user_id: chatId,
    // 平台 id 可能是 64 位整数：保持原始字符串，避免 Number 精度丢失
    message_id: messageId || undefined,
    message_type: type ?? 1,
    message_state: readNumber(src, "message_state") ?? undefined,
    create_time_ms: createTime,
    context_token: contextToken || undefined,
    item_list,
    text,
  } as IlinkMessage & { text: string };
}

/* ------------------------------ Client ------------------------------ */

export interface IlinkGetUpdatesResult {
  buf: string;
  messages: IlinkMessage[];
  /** 业务码：0=正常；-14=会话暂停期（token 仍有效，官方语义为暂停 1h 后自动恢复） */
  ret: number;
}

export class IlinkClient {
  constructor(
    private readonly opts: { botToken?: string; baseUrl?: string } = {},
  ) {}

  private get baseUrl(): string {
    return (this.opts.baseUrl?.trim() || ILINK_DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  private get token(): string {
    return this.opts.botToken?.trim() ?? "";
  }

  /** 长轮询收消息；客户端超时返回空列表（正常控制流） */
  async getUpdates(getUpdatesBuf: string): Promise<IlinkGetUpdatesResult> {
    if (!this.token) throw new Error("wechat bot not bound");
    let res: { payload: Record<string, unknown>; timeout: boolean };
    try {
      res = await fetchJson(
        joinUrl(this.baseUrl, "ilink/bot/getupdates"),
        {
          method: "POST",
          headers: getHeaders(this.token),
          body: JSON.stringify({
            get_updates_buf: getUpdatesBuf,
            base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
          }),
        },
        LONG_POLL_TIMEOUT_MS,
      );
    } catch (e) {
      // 网络错误交给上层做状态与退避
      throw e;
    }
    if (res.timeout) return { buf: getUpdatesBuf, messages: [], ret: 0 };
    const p = res.payload;
    // 业务码不在这里抛错：-14（会话暂停期）是正常控制流，由上层精确处理
    const ret = readNumber(p, "ret") ?? readNumber(p, "errcode") ?? 0;
    if (ret !== 0) {
      return {
        buf: getUpdatesBuf,
        messages: [],
        ret,
        errmsg: readString(p, "errmsg"),
      } as IlinkGetUpdatesResult & { errmsg?: string };
    }
    const buf =
      readString(p, "get_updates_buf") ||
      readString(p, "buf") ||
      readString(p, "next_buf") ||
      getUpdatesBuf;
    const rawList = Array.isArray(p.msgs)
      ? p.msgs
      : Array.isArray(p.messages)
        ? p.messages
        : Array.isArray(p.updates)
          ? p.updates
          : Array.isArray(p.items)
            ? p.items
            : Array.isArray(p.list)
              ? p.list
              : isRecord(p.msgs)
                ? [p.msgs]
                : [];
    const messages: IlinkMessage[] = [];
    for (const raw of rawList) {
      if (!isRecord(raw)) continue;
      const msg = normalizeMessage(raw);
      if (msg) messages.push(msg);
    }
    const result: IlinkGetUpdatesResult = { buf, messages, ret: 0 };
    return result;
  }

  /** 发送文本消息；contextToken 原样回传（协议要求 echo） */
  async sendText(input: { toUserId: string; text: string; contextToken?: string }): Promise<void> {
    if (!this.token) throw new Error("wechat bot not bound");
    // 平台客户端对 LF 处理不一致：多行统一 CRLF
    const text = input.text.replace(/\r\n|\r|\n/g, "\r\n");
    const res = await fetchJson(
      joinUrl(this.baseUrl, "ilink/bot/sendmessage"),
      {
        method: "POST",
        headers: getHeaders(this.token),
        body: JSON.stringify({
          msg: {
            from_user_id: "",
            to_user_id: input.toUserId,
            client_id: `kova-weixin-${randomUUID()}`,
            message_type: 2,
            message_state: 2,
            ...(input.contextToken ? { context_token: input.contextToken } : {}),
            item_list: [{ type: 1, text_item: { text } }],
          },
          base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
        }),
      },
      API_TIMEOUT_MS,
    );
    if (res.timeout) throw new Error("iLink 发送超时");
    assertOk(res.payload, "发送消息");
  }

  /**
   * 发送/取消「对方正在输入」状态。需先 getconfig 换 typing_ticket；
   * status: 1=开始输入，2=取消。失败静默（状态提示是尽力而为）。
   */
  async sendTyping(input: {
    toUserId: string;
    ticket: string;
    on: boolean;
  }): Promise<void> {
    if (!this.token) return;
    try {
      const res = await fetchJson(
        joinUrl(this.baseUrl, "ilink/bot/sendtyping"),
        {
          method: "POST",
          headers: getHeaders(this.token),
          // 官方 SendTypingReq 只有 ilink_user_id/typing_ticket/status 三个字段
          body: JSON.stringify({
            ilink_user_id: input.toUserId,
            typing_ticket: input.ticket,
            status: input.on ? 1 : 2,
            base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
          }),
        },
        10_000,
      );
      if (res.timeout) return;
      const ret = readNumber(res.payload, "ret") ?? readNumber(res.payload, "errcode") ?? 0;
      if (ret !== 0) {
        logWarnOnce(`sendtyping ret=${ret}`);
      }
    } catch {
      // 尽力而为
    }
  }

  /** 取 typing_ticket（getconfig；含 context_token 时按会话换票） */
  async getTypingTicket(input: {
    toUserId: string;
    contextToken?: string;
  }): Promise<string | null> {
    if (!this.token) return null;
    try {
      const res = await fetchJson(
        joinUrl(this.baseUrl, "ilink/bot/getconfig"),
        {
          method: "POST",
          headers: getHeaders(this.token),
          body: JSON.stringify({
            ilink_user_id: input.toUserId,
            ...(input.contextToken ? { context_token: input.contextToken } : {}),
            base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
          }),
        },
        10_000,
      );
      if (res.timeout) return null;
      const ret = readNumber(res.payload, "ret") ?? readNumber(res.payload, "errcode") ?? 0;
      if (ret !== 0) return null;
      return readString(res.payload, "typing_ticket") || null;
    } catch {
      return null;
    }
  }

  /** 优雅停机通知：告知服务端本通道下线，避免长轮询断开被判为异常 */
  async notifyStop(): Promise<void> {
    if (!this.token) return;
    try {
      await fetchJson(
        joinUrl(this.baseUrl, "ilink/bot/msg/notifystop"),
        {
          method: "POST",
          headers: getHeaders(this.token),
          body: JSON.stringify({ base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT } }),
        },
        5_000,
      );
    } catch {
      // 尽力而为：退出路径上的通知失败无需处理
    }
  }

  /* ------------------------------ 扫码登录（无 token） ------------------------------ */

  /**
   * 取绑定二维码：优先 GET（已验证接入路径），失败回落 POST（官方 SDK 路径）。
   * qrcode_img_content 是二维码内容串（URL），不是图片字节。
   */
  static async getQrcode(): Promise<IlinkQrcodeResp> {
    const endpoint = "ilink/bot/get_bot_qrcode?bot_type=3";
    let payload: Record<string, unknown> | null = null;
    try {
      const res = await fetchJson(
        joinUrl(ILINK_QR_BASE_URL, endpoint),
        { method: "GET", headers: getHeaders() },
        QR_TIMEOUT_MS,
      );
      if (!res.timeout) {
        assertOk(res.payload, "获取二维码");
        payload = res.payload;
      }
    } catch {
      payload = null; // 回落 POST
    }
    if (!payload) {
      const res = await fetchJson(
        joinUrl(ILINK_QR_BASE_URL, endpoint),
        {
          method: "POST",
          headers: getHeaders(),
          body: JSON.stringify({ local_token_list: [] }),
        },
        QR_TIMEOUT_MS,
      );
      if (res.timeout) throw new Error("iLink 请求超时");
      assertOk(res.payload, "获取二维码");
      payload = res.payload;
    }
    const qrcode = readString(payload, "qrcode") || readString(payload, "qr_code");
    const content =
      readString(payload, "qrcode_img_content") || readString(payload, "qrcode_url") || qrcode;
    if (!qrcode) throw new Error("二维码票据为空");
    return { qrcode, qrcode_img_content: content };
  }

  /**
   * 查询扫码状态（30s 长轮询，超时按 wait 处理）。
   * 状态值统一成字符串词表；token/botId/baseurl 做别名兜底。
   */
  static async getQrcodeStatus(input: {
    qrcode: string;
    baseUrl?: string;
    verifyCode?: string;
  }): Promise<IlinkQrcodeStatusResp> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(input.qrcode)}`;
    if (input.verifyCode) {
      endpoint += `&verify_code=${encodeURIComponent(input.verifyCode)}`;
    }
    const res = await fetchJson(
      joinUrl(input.baseUrl || ILINK_QR_BASE_URL, endpoint),
      { method: "GET", headers: getHeaders() },
      QR_STATUS_TIMEOUT_MS,
    );
    if (res.timeout) return { status: "wait" };
    const p = res.payload;
    assertOk(p, "查询扫码状态");
    const status = normalizeWireStatus(p.status ?? p.qrcode_status ?? p.qr_status);
    return {
      status,
      bot_token: readString(p, "bot_token") || readString(p, "token") || undefined,
      ilink_bot_id: readString(p, "ilink_bot_id") || readString(p, "bot_id") || undefined,
      baseurl: readString(p, "baseurl") || readString(p, "base_url") || undefined,
      ilink_user_id: readString(p, "ilink_user_id") || undefined,
      redirect_host: readString(p, "redirect_host") || undefined,
    };
  }
}

/** 入站方向过滤辅助（客户端已滤 BOT；保留给上层兜底） */
export function isUserMessage(msg: IlinkMessage): boolean {
  return msg.message_type !== 2;
}
