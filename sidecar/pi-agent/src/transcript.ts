/**
 * 会话正文持久化：JSONL 转录文件 + SQLite 索引表维护。
 *   JSONL 首行 {"type":"header",...}；消息行 {"type":"message","seq":n,"ui":UIMessage|null,"agent":Message}
 *   每条 agent 消息都写一行（含 toolResult），ui 字段是 text/reasoning 快照可为 null；
 *   前端历史（含工具部件）由 historyToUiMessages 从 agent 行重建。
 *   读端跳过撕裂尾行，append 中途崩溃不影响已有内容。
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { sessionPath } from "./storage";
import { sessionTouch } from "./hostdb";
import type { Running, UIMessage } from "./types";

/** 从 JSONL 读全部消息行（跳过撕裂尾行；ui 可为 null）。
 * 旧版持久化 bug 会把同一批消息重复 append，同一 seq 可能出现多行：
 * 按 seq 去重（保留最后一次出现）并按 seq 排序，避免历史重建/会话恢复
 * 携带重复消息。 */
export function readTranscript(
  sessionId: string,
): { ui: UIMessage | null; agent: Message }[] {
  const file = sessionPath(sessionId);
  if (!existsSync(file)) return [];
  const bySeq = new Map<number, { ui: UIMessage | null; agent: Message }>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.type === "message" && row.agent && typeof row.seq === "number") {
        bySeq.set(row.seq, { ui: row.ui ?? null, agent: row.agent });
      }
      // 未知行类型/缺 seq 直接跳过，向前兼容
    } catch {
      // 撕裂尾行：忽略
    }
  }
  return [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
}

/** pi-ai Message -> UIMessage（ui 字段快照；转换范围：text/reasoning） */
export function toUiMessage(msg: Message, seq: number): UIMessage | null {
  if (msg.role === "user") {
    const text =
      typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n");
    if (!text.trim()) return null;
    return { id: `msg-${seq}`, role: "user", parts: [{ type: "text", text }] };
  }
  if (msg.role === "assistant") {
    const parts: UIMessage["parts"] = [];
    for (const c of msg.content) {
      if (c.type === "text" && c.text.trim()) {
        parts.push({ type: "text", text: c.text });
      } else if (c.type === "thinking" && c.thinking.trim()) {
        parts.push({ type: "reasoning", text: c.thinking, state: "done" });
      }
    }
    if (!parts.length) return null;
    return { id: `msg-${seq}`, role: "assistant", parts };
  }
  return null; // toolResult 等不产生独立 UI 消息
}

/** 工具结果输出文本（与 stream.ts 的 live 输出保持一致：只取 text 内容） */
function toolResultOutput(msg: ToolResultMessage): string {
  return (msg.content ?? [])
    .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
    .join("\n");
}

/**
 * 从持久化的 agent 消息重建前端历史（含工具部件，get_history 用）。
 * assistant.toolCall → `tool-${name}` part（input-available）；后续 toolResult
 * 按 toolCallId 回填 output（output-available），与 live 流的 chunk 形状一致，
 * 刷新前后渲染相同。toolCallId 匹配不到的 toolResult 直接忽略。
 */
export function historyToUiMessages(rows: { agent: Message }[]): UIMessage[] {
  type ToolPart = {
    type: string;
    toolCallId: string;
    state: "input-available" | "output-available";
    input?: unknown;
    output?: unknown;
  };
  const messages: UIMessage[] = [];
  const openTools = new Map<string, ToolPart>();
  for (let i = 0; i < rows.length; i++) {
    const msg = rows[i].agent;
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("\n");
      if (!text.trim()) continue;
      messages.push({ id: `msg-${i}`, role: "user", parts: [{ type: "text", text }] });
      continue;
    }
    if (msg.role === "assistant") {
      const parts: UIMessage["parts"] = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text.trim()) {
          parts.push({ type: "text", text: c.text });
        } else if (c.type === "thinking" && c.thinking.trim()) {
          parts.push({ type: "reasoning", text: c.thinking, state: "done" });
        } else if (c.type === "toolCall") {
          const part: ToolPart = {
            type: `tool-${c.name}`,
            toolCallId: c.id,
            state: "input-available",
            input: c.arguments ?? {},
          };
          parts.push(part as UIMessage["parts"][number]);
          openTools.set(c.id, part);
        }
      }
      if (!parts.length) continue;
      messages.push({ id: `msg-${i}`, role: "assistant", parts });
      continue;
    }
    if (msg.role === "toolResult") {
      const part = openTools.get(msg.toolCallId);
      if (part) {
        part.state = "output-available";
        part.output = toolResultOutput(msg);
      }
    }
  }
  return messages;
}

/** agent_end 后把新增消息增量 append 到 JSONL，并维护索引表（经 hostdb 数据访问层） */
export async function persist(run: Running): Promise<void> {
  const messages = run.agent.state.messages;
  if (messages.length <= run.persistedSeq) return;
  const file = sessionPath(run.sessionId);
  const lines: string[] = [];
  for (let i = run.persistedSeq; i < messages.length; i++) {
    const agent = messages[i] as Message;
    // 每条 agent 消息都落盘（含纯工具调用与 toolResult）：恢复模型上下文需要完整
    // 的 toolCall/toolResult 对，前端历史重建也需要工具部件
    const ui = toUiMessage(agent, i);
    lines.push(JSON.stringify({ type: "message", seq: i, ui, agent }));
  }
  if (lines.length) appendFileSync(file, lines.join("\n") + "\n");
  run.persistedSeq = messages.length;

  const first = messages[0] as Message | undefined;
  const firstText =
    first && first.role === "user"
      ? typeof first.content === "string"
        ? first.content
        : (first.content.find((c) => c.type === "text")?.text ?? "")
      : "";
  await sessionTouch(run.sessionId, firstText.slice(0, 60), firstText);
}
