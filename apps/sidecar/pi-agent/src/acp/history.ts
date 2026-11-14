/**
 * session/load 历史回放：把 thread_snapshot 的原生 agent 消息翻译成 ACP
 * user_message_chunk / agent_message_chunk / agent_thought_chunk / tool_call。
 *
 * 用 thread_snapshot 而不是 get_history 的原因：
 * - 原生 assistant.toolCall 与 toolResult 能按 toolCallId 精确配对；
 * - get_history 的 UI part 是投影层形状，工具状态/压缩分隔线混在一起，
 *   再反推回 ACP 会多一层语义损失。
 */
import type * as acp from "@agentclientprotocol/sdk";
import { isAutoContinueText, isCapabilityReminderText, isGoalContinueText } from "pi-protocol";
import { toolKindFor, toolTitleFor, locationsForInput } from "./translate";

type SessionUpdate = acp.SessionNotification["update"];

const MAX_REPLAY_TEXT = 256 * 1024;
const MAX_REPLAY_IMAGE_BYTES = 2 * 1024 * 1024;

export type SnapshotMessage = {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  [key: string]: unknown;
};

export type HistoryReplayOptions = {
  sessionId: string;
  cwd: string;
  messages: readonly SnapshotMessage[];
  sendUpdate: (update: SessionUpdate) => void | Promise<void>;
};

function truncate(text: string, max = MAX_REPLAY_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: string }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

/** 用户侧的注入消息（自动续跑/目标/能力提醒/并入）不参与回放 */
function isInjectedUserText(text: string): boolean {
  return (
    isAutoContinueText(text) ||
    isGoalContinueText(text) ||
    isCapabilityReminderText(text) ||
    text.startsWith("[[queued-steer]] ")
  );
}

function imageBlocks(content: unknown): { data: string; mimeType: string }[] {
  if (!Array.isArray(content)) return [];
  const out: { data: string; mimeType: string }[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: string; data?: unknown; mimeType?: unknown };
    if (record.type !== "image" || typeof record.data !== "string") continue;
    const data = record.data.startsWith("data:")
      ? record.data.slice(record.data.indexOf(",") + 1)
      : record.data;
    if (!data) continue;
    if (Buffer.byteLength(data, "base64") > MAX_REPLAY_IMAGE_BYTES) continue;
    out.push({
      data,
      mimeType: typeof record.mimeType === "string" ? record.mimeType : "image/png",
    });
  }
  return out;
}

export async function replayHistory(opts: HistoryReplayOptions): Promise<void> {
  const announced = new Set<string>();
  const resultIds = new Set<string>();

  for (const message of opts.messages) {
    const role = message.role;
    if (role === "user") {
      const text = textOfContent(message.content);
      if (!text || isInjectedUserText(text)) continue;
      await opts.sendUpdate({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: truncate(text) },
      });
      for (const image of imageBlocks(message.content)) {
        await opts.sendUpdate({
          sessionUpdate: "user_message_chunk",
          content: { type: "image", data: image.data, mimeType: image.mimeType },
        });
      }
      continue;
    }

    if (role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const record = part as {
          type?: string;
          text?: unknown;
          thinking?: unknown;
          id?: unknown;
          name?: unknown;
          arguments?: unknown;
        };
        if (record.type === "text" && typeof record.text === "string" && record.text) {
          await opts.sendUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: truncate(record.text) },
          });
        } else if (record.type === "thinking" && typeof record.thinking === "string") {
          if (record.thinking) {
            await opts.sendUpdate({
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: truncate(record.thinking) },
            });
          }
        } else if (record.type === "toolCall" && typeof record.id === "string") {
          const toolName = typeof record.name === "string" ? record.name : "tool";
          const input = record.arguments ?? {};
          announced.add(record.id);
          await opts.sendUpdate({
            sessionUpdate: "tool_call",
            toolCallId: record.id,
            title: toolTitleFor(toolName, input),
            kind: toolKindFor(toolName, input),
            status: "pending",
            rawInput:
              input && typeof input === "object" ? (input as Record<string, unknown>) : undefined,
            locations: locationsForInput(input, opts.cwd),
          });
        }
      }
      continue;
    }

    if (role === "toolResult") {
      const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
      if (!toolCallId) continue;
      resultIds.add(toolCallId);
      const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
      if (!announced.has(toolCallId)) {
        announced.add(toolCallId);
        await opts.sendUpdate({
          sessionUpdate: "tool_call",
          toolCallId,
          title: toolTitleFor(toolName, {}),
          kind: toolKindFor(toolName, {}),
          status: "in_progress",
        });
      }
      const text = textOfContent(message.content);
      const content: acp.ToolCallContent[] = [];
      if (text) {
        content.push({
          type: "content",
          content: { type: "text", text: truncate(text) },
        });
      }
      for (const image of imageBlocks(message.content)) {
        content.push({
          type: "content",
          content: { type: "image", data: image.data, mimeType: image.mimeType },
        });
      }
      await opts.sendUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: message.isError === true ? "failed" : "completed",
        ...(content.length ? { content } : {}),
      });
      continue;
    }

    // compactionSummary / modelChange / bashExecution / branchSummary 等：
    // ACP 没有对应语义，跳过（上下文影响已体现在后续模型输入里）。
  }

  // 历史里没有结果的工具调用：明确收成失败，避免编辑器一直显示 pending
  for (const toolCallId of announced) {
    if (resultIds.has(toolCallId)) continue;
    await opts.sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "failed",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "No result recorded (the session ended before this tool returned).",
          },
        },
      ],
    });
  }
}
