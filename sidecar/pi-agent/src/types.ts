/** 跨模块共享类型 */
import type { Agent } from "@earendil-works/pi-agent-core";
import type * as ai from "ai";

/** AI SDK UI 消息类型（协议流与 JSONL 持久化都用它） */
export type UIMessage = ai.UIMessage;
export type UIMessageChunk = ai.UIMessageChunk;

/** 自定义端点的模型规格（custom_providers.models JSON 数组元素） */
export type CustomModelSpec = {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

/** 自定义提供商支持的接口格式 */
export type CustomApiKind =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages";

/** 会话列表项（给前端渲染列表用） */
export type SessionSummary = {
  sessionId: string; // 会话 id（索引表主键 / JSONL 文件名）
  name?: string;
  firstMessage: string;
  messageCount: number;
  modified: string; // ISO
  cwd: string;
};

/** threadId 对应的活动会话（每个前端线程一个 Agent 实例） */
export type Running = {
  agent: Agent;
  sessionId: string;
  cwd: string;
  persistedSeq: number; // 已写入 JSONL 的消息数
};
