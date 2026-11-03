/**
 * 飞书入站消息归一（纯函数，可单测）。
 * 兼容 SDK 可能把 event 摊平到顶层；只处理私聊文本/富文本，机器人自身消息与非私聊一律丢弃。
 */

type Record0 = Record<string, unknown>;

export interface FeishuInboundDraft {
  chatType: "p2p";
  chatId: string;
  senderId: string;
  text: string;
  eventId?: string;
  messageId?: string;
  /** 平台私有回复凭据：入站 message_id（回复接口锚点） */
  replyContext?: string;
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

/**
 * 解析一条 im.message.receive_v1 事件。
 * 返回 null 表示不需要处理（机器人自身消息、非私聊、非文本、缺关键字段）。
 */
export function parseFeishuInbound(payload: unknown): FeishuInboundDraft | null {
  const root = isRecord(payload) ? payload : null;
  if (!root) return null;
  // SDK 不同版本可能把 event 摊平到顶层
  const event = isRecord(root.event) ? root.event : root;
  const message = isRecord(event.message) ? event.message : null;
  const sender = isRecord(event.sender) ? event.sender : null;
  if (!message || !sender) return null;

  // 机器人自身/其它应用的回环，直接丢弃
  if (readString(sender, "sender_type") === "app") return null;

  const chatType = readString(message, "chat_type") || readString(event, "chat_type");
  if (chatType !== "p2p") return null; // 本期仅私聊

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
  const chatId = readString(message, "chat_id") || readString(event, "open_chat_id");
  const messageId = readString(message, "message_id");
  if (!senderId || !chatId) return null;

  return {
    chatType: "p2p",
    chatId,
    senderId,
    text,
    ...(messageId ? { eventId: messageId, messageId, replyContext: messageId } : {}),
  };
}
