/**
 * 钉钉机器人消息归一（纯函数，可单测）。
 * 仅处理单聊文本；群聊、非文本、机器人自身消息一律丢弃。
 */

type Record0 = Record<string, unknown>;

export interface DingTalkInboundDraft {
  chatType: "p2p";
  chatId: string;
  senderId: string;
  text: string;
  eventId?: string;
  messageId?: string;
  /** 平台私有回复凭据：会话 webhook（1.5h 内有效） */
  replyContext?: string;
}

function isRecord(v: unknown): v is Record0 {
  return typeof v === "object" && v !== null;
}
function readString(r: Record0 | null | undefined, key: string): string {
  const v = r?.[key];
  return typeof v === "string" ? v : "";
}

/** 钉钉机器人回调（TOPIC_ROBOT）payload → 统一入站草稿 */
export function parseDingTalkRobotMessage(payload: unknown): DingTalkInboundDraft | null {
  const root = isRecord(payload) ? payload : null;
  if (!root) return null;

  // 仅文本
  if (readString(root, "msgtype") !== "text") return null;
  const textObj = isRecord(root.text) ? root.text : null;
  // 钉钉正文常带一个前导空格（" 你好"），去掉首尾空白
  const text = readString(textObj, "content").trim();
  if (!text) return null;

  // 本期仅单聊：conversationType "1"=单聊，"2"=群聊
  if (readString(root, "conversationType") !== "1") return null;

  const chatId = readString(root, "conversationId");
  const senderId =
    readString(root, "senderStaffId") || readString(root, "senderId");
  const botUserId = readString(root, "chatbotUserId");
  // 机器人自身回环（防御：机器人 topic 通常只推用户消息）
  if (botUserId && senderId && botUserId === senderId) return null;

  const sessionWebhook = readString(root, "sessionWebhook");
  const msgId = readString(root, "msgId");
  if (!chatId || !senderId) return null;

  return {
    chatType: "p2p",
    chatId,
    senderId,
    text,
    ...(msgId ? { eventId: msgId, messageId: msgId } : {}),
    ...(sessionWebhook ? { replyContext: sessionWebhook } : {}),
  };
}
