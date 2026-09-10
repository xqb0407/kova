/**
 * 会话正文持久化：JSONL 转录文件 + SQLite 索引表维护。
 *   JSONL 首行 {"type":"header",...}；消息行 {"type":"message","seq":n,"ui":UIMessage,"agent":Message}
 *   读端跳过撕裂尾行，append 中途崩溃不影响已有内容。
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import { db, sessionPath } from "./storage";
import type { Running, UIMessage } from "./types";

/** 从 JSONL 读全部消息行（跳过撕裂尾行） */
export function readTranscript(
  sessionId: string,
): { ui: UIMessage; agent: Message }[] {
  const file = sessionPath(sessionId);
  if (!existsSync(file)) return [];
  const out: { ui: UIMessage; agent: Message }[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.type === "message" && row.ui && row.agent) {
        out.push({ ui: row.ui, agent: row.agent });
      }
      // 未知行类型直接跳过，向前兼容
    } catch {
      // 撕裂尾行：忽略
    }
  }
  return out;
}

/** pi-ai Message -> UIMessage（给前端历史渲染；转换范围：text/reasoning） */
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
  return null; // toolResult 等不进前端历史
}

/** agent_end 后把新增消息增量 append 到 JSONL，并维护索引表 */
export function persist(run: Running) {
  const messages = run.agent.state.messages;
  if (messages.length <= run.persistedSeq) return;
  const file = sessionPath(run.sessionId);
  const lines: string[] = [];
  for (let i = run.persistedSeq; i < messages.length; i++) {
    const agent = messages[i] as Message;
    const ui = toUiMessage(agent, i);
    if (!ui) continue;
    lines.push(JSON.stringify({ type: "message", seq: i, ui, agent }));
  }
  if (lines.length) appendFileSync(file, lines.join("\n") + "\n");
  run.persistedSeq = messages.length;

  const now = new Date().toISOString();
  const first = messages[0] as Message | undefined;
  const firstText =
    first && first.role === "user"
      ? typeof first.content === "string"
        ? first.content
        : (first.content.find((c) => c.type === "text")?.text ?? "")
      : "";
  db.query(
    "UPDATE pi_sessions SET updated_at = ?, " +
      "title = CASE WHEN title = '' THEN ? ELSE title END, " +
      "first_message = CASE WHEN first_message = '' THEN ? ELSE first_message END " +
      "WHERE id = ?",
  ).run(now, firstText.slice(0, 60), firstText, run.sessionId);
}
