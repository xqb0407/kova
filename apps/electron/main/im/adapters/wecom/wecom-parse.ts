/**
 * 企业微信智能机器人长连接消息归一（纯函数，可单测）。
 * 帧结构：{ headers:{req_id}, body:{ msgid, msgtype, chattype, from:{userid}, chatid?, text? } }
 * 仅处理单聊文本；群聊、非文本一律丢弃。
 */

type Record0 = Record<string, unknown>;

export interface WeComInboundDraft {
  chatType: "p2p";
  chatId: string;
  senderId: string;
  text: string;
  eventId?: string;
  messageId?: string;
  /** 平台私有回复凭据：原始回调帧（reply 需透传 req_id） */
  replyContext?: unknown;
}

function isRecord(v: unknown): v is Record0 {
  return typeof v === "object" && v !== null;
}
function readString(r: Record0 | null | undefined, key: string): string {
  const v = r?.[key];
  return typeof v === "string" ? v : "";
}

export function parseWeComFrame(frame: unknown): WeComInboundDraft | null {
  const root = isRecord(frame) ? frame : null;
  if (!root) return null;
  const body = isRecord(root.body) ? root.body : root;

  // 仅文本
  if (readString(body, "msgtype") !== "text") return null;
  const textObj = isRecord(body.text) ? body.text : null;
  const text = readString(textObj, "content").trim();
  if (!text) return null;

  // 本期仅单聊：chattype "single" | "group"
  const chatTypeRaw = readString(body, "chattype");
  if (chatTypeRaw && chatTypeRaw !== "single") return null;

  const from = isRecord(body.from) ? body.from : null;
  const senderId = readString(from, "userid");
  // 单聊没有 chatid，用发送者 userid 作为会话锚点
  const chatId = readString(body, "chatid") || senderId;
  const msgId = readString(body, "msgid");
  if (!senderId || !chatId) return null;

  return {
    chatType: "p2p",
    chatId,
    senderId,
    text,
    ...(msgId ? { eventId: msgId, messageId: msgId } : {}),
    replyContext: frame,
  };
}
