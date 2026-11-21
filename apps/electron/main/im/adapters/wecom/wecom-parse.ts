/**
 * 企业微信智能机器人长连接消息归一（纯函数，可单测）。
 * 帧结构：{ headers:{req_id}, body:{ msgid, msgtype, chattype, from:{userid}, chatid?, text? } }
 * 支持单聊与群聊文本；非文本丢弃。
 *
 * 官方长连接文档（developer.work.weixin.qq.com/document/path/101463）明确：
 * 用户在群聊中 @机器人 或向机器人发送单聊消息时才会推送 aibot_msg_callback；
 * chatid 仅群聊返回。因此群聊按「已 @」处理，并剥离正文开头的 `@机器人名`
 * （若平台保留）。企微没有独立的 mention 字段。
 */
import { stripLeadingGroupMention } from "../../group";

type Record0 = Record<string, unknown>;

export interface WeComInboundDraft {
  chatType: "p2p" | "group";
  chatId: string;
  senderId: string;
  text: string;
  /** 群聊是否 @ 了本机器人；p2p 不填 */
  mentioned?: boolean;
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
  let text = readString(textObj, "content").trim();

  // chattype "single" | "group"；缺失时用 chatid 推断（SDK 约定 chatid 仅群聊返回）。
  // 不能一律按单聊兼容：群帧缺 chattype 会被 owner 门放行，绕过群聊开关。
  const chatTypeRaw = readString(body, "chattype");
  if (chatTypeRaw && chatTypeRaw !== "single" && chatTypeRaw !== "group") {
    return null;
  }
  const chatid = readString(body, "chatid");
  const chatType =
    chatTypeRaw === "group" || (!chatTypeRaw && chatid) ? "group" : "p2p";
  if (chatType === "group") text = stripLeadingGroupMention(text);
  if (!text) return null;

  const from = isRecord(body.from) ? body.from : null;
  const senderId = readString(from, "userid");
  const botId = readString(body, "aibotid");
  // 机器人自身回环（群聊回复若被 SDK 当入站帧推回，绝不能再次触发）
  if (botId && senderId && botId === senderId) return null;
  // 群聊必须有群 chatid；缺了宁可丢弃，不能回落成发送者 id（会变成每人一个会话）
  if (chatType === "group" && !chatid) return null;
  // 单聊没有 chatid，用发送者 userid 作为会话锚点；群聊用群 chatid
  const chatId = chatid || senderId;
  const msgId = readString(body, "msgid");
  if (!senderId || !chatId) return null;

  return {
    chatType,
    chatId,
    senderId,
    text,
    ...(chatType === "group" ? { mentioned: true } : {}),
    ...(msgId ? { eventId: msgId, messageId: msgId } : {}),
    replyContext: frame,
  };
}
