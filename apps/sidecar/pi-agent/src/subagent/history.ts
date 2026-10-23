/**
 * 子代理历史存档的序列化/兼容归一（resume 初始上下文）。
 *
 * 两个约束：
 * 1. 新存档必须保留 `toolResult` 的 `toolCallId/toolName` 以及消息的其余顶层
 *    字段——只存 role+content 会让续聊请求出现"没有 id 的 tool 消息"，OpenAI
 *    兼容端点直接拒绝。
 * 2. 旧存档（本模块引入前落盘的 role+content 形态）无法把 toolResult 配回
 *    toolCall；保留任何一边都是非法序列。整体退化成纯文本对话：丢工具细节，
 *    但至少能续聊，而不是一发送就报 provider 错误。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SubagentHistoryMessage } from "../types";

/** 活动流/内存消息 → 可落盘的历史条目（保留全部顶层字段，丢了 tool 配对必炸） */
export function toSubagentHistory(
  messages: readonly AgentMessage[],
): SubagentHistoryMessage[] {
  const out: SubagentHistoryMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ ...message, content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      out.push({ ...message, content: message.content });
      continue;
    }
    if (message.role === "toolResult") {
      // 运行时畸形条目（没有 toolCallId）不写入：它无法与任何调用配对
      if (typeof message.toolCallId !== "string" || typeof message.toolName !== "string") {
        continue;
      }
      out.push({
        ...message,
        content: message.content,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
      });
    }
  }
  return out;
}

/** 旧存档检测：toolResult 缺 toolCallId（本模块之前的 role+content 形态） */
function isLegacyHistory(messages: readonly SubagentHistoryMessage[]): boolean {
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role !== "toolResult") continue;
    const id = (message as { toolCallId?: unknown }).toolCallId;
    if (typeof id !== "string" || !id) return true;
  }
  return false;
}

/**
 * 历史归一：新存档原样返回；旧存档剥掉 toolCall/toolResult，只留文本对话。
 * 回读（activity-store）与构造初始上下文（SubagentRun）两侧都调用，幂等。
 */
export function normalizeSubagentHistory(
  messages: readonly SubagentHistoryMessage[],
): SubagentHistoryMessage[] {
  if (!isLegacyHistory(messages)) return [...messages];
  const out: SubagentHistoryMessage[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    // toolResult 已失去配对键，单独保留没有意义
    if (message.role === "toolResult") continue;
    if (message.role === "assistant") {
      const content = Array.isArray(message.content)
        ? message.content.filter(
            (part) => (part as { type?: unknown }).type !== "toolCall",
          )
        : message.content;
      // 纯工具调用的 assistant 行剥完就空了，留着只会制造空消息
      if (Array.isArray(content) && content.length === 0) continue;
      out.push({
        ...message,
        content,
        ...((message as { stopReason?: unknown }).stopReason === "toolUse"
          ? { stopReason: "stop" }
          : {}),
      });
      continue;
    }
    out.push(message);
  }
  return out;
}
