/**
 * 钉钉机器人消息归一（纯函数，可单测）。
 * 支持单聊与群聊文本；非文本、机器人自身消息丢弃。
 *
 * 群聊 @ 判定（官方文档 /document/dingstart/robot-receive-message）：
 * - `isInAtList` 是否在 @ 列表中；
 * - 载荷还带 `atUsers`（被 @ 人）与 `chatbotUserId`（加密的机器人 ID）；
 * 缺少 isInAtList 时用 atUsers 里的 dingtalkId 与 chatbotUserId 对比；
 * 两者都判不了就按未 @ 处理（fail-closed）。群正文开头的 `@机器人名` 会剥离。
 */
import { stripLeadingGroupMention } from "../../group";

type Record0 = Record<string, unknown>;

export interface DingTalkInboundDraft {
  chatType: "p2p" | "group";
  chatId: string;
  senderId: string;
  senderName?: string;
  text: string;
  /** 群聊是否 @ 了本机器人；p2p 不填 */
  mentioned?: boolean;
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

/** 群聊是否 @ 了本机器人：isInAtList 优先，其次 atUsers ∩ chatbotUserId，判不了按未 @ */
function mentionedBot(root: Record0): boolean {
  const atFlag = root.isInAtList;
  if (typeof atFlag === "boolean") return atFlag;
  if (typeof atFlag === "number") return atFlag !== 0;
  if (atFlag === "true" || atFlag === "1") return true;
  if (atFlag === "false" || atFlag === "0") return false;
  const botId = readString(root, "chatbotUserId");
  if (!botId) return false;
  const atUsers = Array.isArray(root.atUsers) ? root.atUsers : [];
  return atUsers.some(
    (user) => isRecord(user) && readString(user, "dingtalkId") === botId,
  );
}

/** 钉钉机器人回调（TOPIC_ROBOT）payload → 统一入站草稿 */
export function parseDingTalkRobotMessage(payload: unknown): DingTalkInboundDraft | null {
  const root = isRecord(payload) ? payload : null;
  if (!root) return null;

  // 仅文本
  if (readString(root, "msgtype") !== "text") return null;
  const textObj = isRecord(root.text) ? root.text : null;
  // 钉钉正文常带一个前导空格（" 你好"），去掉首尾空白
  let text = readString(textObj, "content").trim();

  // conversationType "1"=单聊，"2"=群聊（个别版本给 number）
  const rawConversationType = root.conversationType;
  const rawChatType =
    typeof rawConversationType === "number"
      ? String(rawConversationType)
      : readString(root, "conversationType");
  if (rawChatType !== "1" && rawChatType !== "2") return null;
  const chatType = rawChatType === "2" ? "group" : "p2p";
  if (chatType === "group") text = stripLeadingGroupMention(text);
  if (!text) return null;

  const chatId = readString(root, "conversationId");
  const senderId =
    readString(root, "senderStaffId") || readString(root, "senderId");
  const senderName = readString(root, "senderNick");
  const botUserId = readString(root, "chatbotUserId");
  // 机器人自身回环（防御：机器人 topic 通常只推用户消息）
  if (botUserId && senderId && botUserId === senderId) return null;

  const sessionWebhook = readString(root, "sessionWebhook");
  const msgId = readString(root, "msgId");
  if (!chatId || !senderId) return null;

  return {
    chatType,
    chatId,
    senderId,
    ...(senderName ? { senderName } : {}),
    text,
    ...(chatType === "group" ? { mentioned: mentionedBot(root) } : {}),
    ...(msgId ? { eventId: msgId, messageId: msgId } : {}),
    ...(sessionWebhook ? { replyContext: sessionWebhook } : {}),
  };
}
