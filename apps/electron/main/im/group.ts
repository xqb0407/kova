/**
 * 群聊策略与文案（纯函数，便于单测）。
 *
 * 群聊与私聊的边界：
 * - 群消息只在通道显式开启「允许群聊」且本机器人被 @ 时进入路由；默认群内
 *   权限为 owner（仅私聊 owner 可用），可在通道配置里显式改成 all。
 *   群消息**不经过 owner 门**（owner 只属于私聊，群成员不能被 bootstrap 成 owner）。
 * - 一个群 = 一个共享会话（chatId = 群 id），提示词前缀带发言人，让模型能
 *   区分"谁在说话"；群内历史对全体成员可见，这是共享会话的既有语义。
 * - 工具审批在群里只允许发起人结算：避免任意群成员替别人的破坏性操作点允许。
 */
import type { ImInboundMessage } from "./types";

/** 群内可用范围：owner = 只有私聊 owner 可用；all = 群内所有成员可用 */
export type ImGroupAccess = "owner" | "all";

/** 群消息被拒但值得告知用户的原因（仅用于 明确 @ 过 Bot 的消息） */
export type GroupDenyReason = "group-disabled" | "no-owner" | "not-owner";

export interface GroupAccessPolicy {
  groupEnabled: boolean;
  groupAccess?: ImGroupAccess;
  /** 私聊 owner（im_owner 表）；owner 模式下缺失即拒绝 */
  ownerId?: string | null;
}

export const GROUP_WELCOME_HINT = [
  "已连接 Kova 助手 ✅",
  "在群里 @我 提问即可，这个群有独立的共享会话。",
  "",
  "常用命令：",
  "/new  开启新话题",
  "/clear  压缩当前上下文",
  "/stop  停止当前任务",
  "",
  "需要你确认的操作会以文字消息发来，回复时请 @我。",
].join("\n");

/**
 * 群聊准入：通道开关 + 必须 @ 本机器人 + 群内可用范围。
 * 默认 owner-only：群成员不能仅凭被拉进群就驱动本机助手（需要 owner 先私聊
 * 建立身份，或在详情页显式改成「所有群成员」）。
 */
export function groupAccessAllowed(
  msg: ImInboundMessage,
  policy: GroupAccessPolicy,
): boolean {
  if (msg.chatType !== "group") return false;
  if (!policy.groupEnabled || msg.mentioned !== true) return false;
  if ((policy.groupAccess ?? "owner") === "all") return true;
  return Boolean(policy.ownerId) && policy.ownerId === msg.senderId;
}

/**
 * 群消息被拒、且用户明确 @ 了 Bot 时，返回值得回一条提示的原因：
 * - group-disabled：群聊开关没开；
 * - no-owner：开了群聊但还没私聊 owner；
 * - not-owner：当前仅 owner 可用，发言者不是 owner。
 * 未 @ 的消息返回 null（飞书开了全量群权限时不能逐条回复，避免刷屏）。
 */
export function groupDenyReason(
  msg: ImInboundMessage,
  policy: GroupAccessPolicy,
): GroupDenyReason | null {
  if (msg.chatType !== "group" || msg.mentioned !== true) return null;
  if (!policy.groupEnabled) return "group-disabled";
  if ((policy.groupAccess ?? "owner") === "all") return null;
  if (!policy.ownerId) return "no-owner";
  return policy.ownerId === msg.senderId ? null : "not-owner";
}

/** 发言人展示名：优先平台昵称（压空白/截断），否则脱敏 id（前缀 6 + 尾 4） */
export function senderDisplayName(
  senderId: string,
  senderName?: string,
): string {
  const name = senderName
    ?.replace(/[\[\]\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  if (name) return name;
  if (senderId.length <= 10) return senderId;
  return `${senderId.slice(0, 6)}…${senderId.slice(-4)}`;
}

/** 群聊 prompt 前缀：让模型知道当前是群里谁在提问 */
export function formatGroupPrompt(msg: ImInboundMessage): string {
  return `[群聊 · ${senderDisplayName(msg.senderId, msg.senderName)}] ${msg.text}`;
}

/**
 * 剥离群聊正文里的前导 @机器人 标记。
 * 钉钉/企微的群文本可能保留 `@机器人名 你好` 或 `@机器人名，你好`；只剥离开头
 * 一个 mention（遇到空白/中英文标点即停），用户正文里对其它人的 @ 保持原样。
 * 注意不能用 `^@\S+`：中文没有空格，会把整句一起吃掉。
 */
export function stripLeadingGroupMention(text: string): string {
  return text
    .replace(/^@[^\s，,。.!！?？:：]{1,40}[\s，,。.!！?？:：]*/u, "")
    .trim();
}

/** 群内审批结算权：私聊不限制；群聊只允许发起该任务的人结算 */
export function canSettleGroupApproval(input: {
  chatType: "p2p" | "group";
  requesterId: string;
  senderId: string;
}): boolean {
  return input.chatType !== "group" || input.requesterId === input.senderId;
}
