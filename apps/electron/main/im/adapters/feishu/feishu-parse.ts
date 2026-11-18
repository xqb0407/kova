/**
 * 飞书入站消息归一（纯函数，可单测）。
 * 兼容 SDK 可能把 event 摊平到顶层；支持私聊与群聊文本/富文本，
 * 机器人自身消息丢弃；群聊必须能判定到「本机器人被 @」才标记 mentioned。
 *
 * 官方事件结构（/document/server-docs/im-v1/message/events/receive）：
 * - message.chat_type：p2p | group（示例即为 group 样例）；
 * - message.mentions[]：{ key:"@_user_1", id:{union_id,user_id,open_id},
 *   mentioned_type:"user"|"bot", name, tenant_key }；
 * - 文档注意事项明确「重复推送用 message_id 去重，不要依赖 event_id」，
 *   我们的 dedupKey 同时带 messageId 优先，符合该口径。
 */

type Record0 = Record<string, unknown>;

export interface FeishuInboundDraft {
  chatType: "p2p" | "group";
  chatId: string;
  senderId: string;
  text: string;
  /** 群聊是否 @ 了本机器人；p2p 不填。router 据此做群准入 */
  mentioned?: boolean;
  eventId?: string;
  messageId?: string;
  /** 平台私有回复凭据：入站 message_id（回复接口锚点） */
  replyContext?: string;
}

export interface FeishuParseOptions {
  /** 应用机器人自身的 open_id（/open-apis/bot/v3/info）；能取到时精确匹配 mention */
  botOpenId?: string;
}

function isRecord(v: unknown): v is Record0 {
  return typeof v === "object" && v !== null;
}

function readString(r: Record0 | null | undefined, key: string): string {
  const v = r?.[key];
  return typeof v === "string" ? v : "";
}

function parseJsonRecord(raw: unknown): Record0 | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 富文本 post 的正文提取：兼容 {zh_cn:{...}} 本地化包装与直接 {title, content} */
function extractPostText(content: Record0): string {
  let body: Record0 | null = null;
  for (const key of ["zh_cn", "en_us", "ja_jp"]) {
    const localized = content[key];
    if (isRecord(localized)) {
      body = localized;
      break;
    }
  }
  if (!body && (Array.isArray(content.content) || typeof content.title === "string")) {
    body = content;
  }
  if (!body) return "";

  const lines: string[] = [];
  const title = readString(body, "title").trim();
  if (title) lines.push(title);
  const blocks = body.content;
  if (!Array.isArray(blocks)) return lines.join("\n").trim();
  for (const line of blocks) {
    if (!Array.isArray(line)) continue;
    const parts: string[] = [];
    for (const node of line) {
      if (!isRecord(node)) continue;
      const tag = readString(node, "tag");
      if (tag === "text" || tag === "a" || tag === "code_block") {
        const text = readString(node, "text");
        if (text) parts.push(text);
      } else if (tag === "at") {
        // mention 占位统一剥离，正文不保留 @_user_x
        continue;
      }
    }
    if (parts.length > 0) lines.push(parts.join(""));
  }
  return lines.join("\n").trim();
}

/** 剥离 @_user_x / @_all 之类的 mention 占位与多余空白 */
export function stripFeishuMentions(text: string): string {
  return text
    .replace(/@_user_\d+/g, " ")
    .replace(/@_all/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+\n/g, "\n")
    .trim();
}

function readArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * 群消息是否 @ 了本机器人：必须精确匹配 bot open_id。
 * 拿不到 bot 身份时按“未 @”处理（fail-closed）——宁可群里不回，也不能在
 * 应用开了全量群消息权限时误响应其他 bot 的 @。
 * mention.id 是 user_id 结构（union_id/user_id/open_id 三键齐全），读 open_id。
 */
function mentionsBot(rawMentions: unknown, botOpenId?: string): boolean {
  if (!botOpenId) return false;
  return readArray(rawMentions).some((raw) => {
    if (!isRecord(raw)) return false;
    const id = isRecord(raw.id) ? raw.id : null;
    return readString(id, "open_id") === botOpenId;
  });
}

/**
 * 解析一条 im.message.receive_v1 事件。
 * 返回 null 表示不需要处理（机器人自身消息、未知 chat_type、非文本、缺关键字段）。
 * 群聊即使未 @ 也返回草稿（mentioned=false），由 access 层按通道开关拒绝。
 */
export function parseFeishuInbound(
  payload: unknown,
  options: FeishuParseOptions = {},
): FeishuInboundDraft | null {
  const root = isRecord(payload) ? payload : null;
  if (!root) return null;
  // SDK 不同版本可能把 event 摊平到顶层
  const event = isRecord(root.event) ? root.event : root;
  const message = isRecord(event.message) ? event.message : null;
  const sender = isRecord(event.sender) ? event.sender : null;
  if (!message || !sender) return null;

  // 机器人自身/其它应用的回环，直接丢弃
  if (readString(sender, "sender_type") === "app") return null;

  const rawChatType =
    readString(message, "chat_type") || readString(event, "chat_type");
  // 缺失/未知 chat_type 一律丢弃：不能默认成 p2p——群帧缺字段会被 owner 门放行，
  // 绕过群聊开关（宁可少回一条，也不能错开权限门）。
  if (rawChatType !== "p2p" && rawChatType !== "group") return null;
  const chatType = rawChatType;

  const msgType = readString(message, "message_type") || readString(message, "msg_type");
  const content = parseJsonRecord(message.content);
  let text = "";
  if (msgType === "text" && content) {
    text = readString(content, "text");
  } else if (msgType === "post" && content) {
    text = extractPostText(content);
  }
  text = stripFeishuMentions(text);
  if (!text) return null; // 图片/文件/卡片等本期不支持

  const senderIdObj = isRecord(sender.sender_id) ? sender.sender_id : null;
  const senderId =
    readString(senderIdObj, "open_id") ||
    readString(senderIdObj, "user_id") ||
    readString(senderIdObj, "union_id");
  const senderName =
    readString(sender, "sender_name") || readString(event, "sender_name");
  const chatId = readString(message, "chat_id") || readString(event, "open_chat_id");
  const messageId = readString(message, "message_id");
  if (!senderId || !chatId) return null;

  const mentioned =
    chatType === "group"
      ? mentionsBot(message.mentions ?? event.mentions, options.botOpenId)
      : undefined;

  return {
    chatType,
    chatId,
    senderId,
    text,
    ...(senderName ? { senderName } : {}),
    ...(mentioned !== undefined ? { mentioned } : {}),
    ...(messageId ? { eventId: messageId, messageId, replyContext: messageId } : {}),
  };
}
