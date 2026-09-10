/**
 * 会话正文持久化：JSONL 转录文件 + SQLite 索引表维护。
 *   JSONL 首行 {"type":"header",...}；消息行 {"type":"message","seq":n,"ui":UIMessage|null,"agent":Message}
 *   压缩检查点行 {"type":"compaction","seq":n,...}（context.ts 的 checkpoint，摘要+边界+generation）；
 *   每条 agent 消息都写一行（含 toolResult），ui 字段是 text/reasoning 快照可为 null；
 *   前端历史（含工具部件）由 historyToUiMessages 从 agent 行重建（压缩不删历史行）；
 *   seq 是文件内单调编号（消息行与检查点行共用，见 Running.jsonlSeq）。
 *   读端跳过撕裂尾行，append 中途崩溃不影响已有内容。
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { sessionPath } from "./storage";
import { sessionGet, sessionRename, sessionTouch } from "./hostdb";
import { getModels } from "./model-catalog";
import { summarizeSessionTitle } from "./session-title-summarize";
import { logErr } from "./log";
import type { Running, UIMessage } from "./types";

/** 压缩检查点行（与模型上下文的投射解耦：恢复端只需要最后一条） */
export type CompactionRow = {
  seq: number;
  summary: string;
  /** 压缩前的估计上下文 token 数 */
  tokensBefore: number;
  /** 检查点覆盖到的最后一条行的 seq：其后的消息行构成压缩后保留上下文 */
  throughSeq: number;
  createdAt: string;
  /** 不透明扩展位：generation 计数器与 strategy 藏在这里（PI-Desktop 同设计） */
  details?: unknown;
};

/** 从 JSONL 读全部消息行（跳过撕裂尾行；ui 可为 null；返回带 seq 供恢复端按边界过滤）。
 * 旧版持久化 bug 会把同一批消息重复 append，同一 seq 可能出现多行：
 * 按 seq 去重（保留最后一次出现）并按 seq 排序，避免历史重建/会话恢复
 * 携带重复消息。 */
export function readTranscript(
  sessionId: string,
): { seq: number; ui: UIMessage | null; agent: Message }[] {
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
  return [...bySeq.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seq, row]) => ({ seq, ...row }));
}

/** 扫描全部压缩检查点行（文件序；撕裂尾行容忍同 readTranscript） */
function scanCompactionRows(sessionId: string): CompactionRow[] {
  const file = sessionPath(sessionId);
  if (!existsSync(file)) return [];
  const rows: CompactionRow[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (
        row?.type === "compaction" &&
        typeof row.seq === "number" &&
        typeof row.summary === "string" &&
        typeof row.throughSeq === "number"
      ) {
        rows.push(row as CompactionRow);
      }
    } catch {
      // 撕裂尾行：忽略
    }
  }
  return rows;
}

/** 读最后一条压缩检查点行（无检查点返回 undefined） */
export function readCompaction(sessionId: string): CompactionRow | undefined {
  return scanCompactionRows(sessionId).at(-1);
}

/** 读全部压缩检查点行（get_history 用：把每次压缩的分隔线重建回消息流） */
export function readAllCompactions(sessionId: string): CompactionRow[] {
  return scanCompactionRows(sessionId);
}

/** 追加一条压缩检查点行（runCompaction 落盘入口；seq 由调用方从 jsonlSeq 取） */
export function appendCompactionRow(
  sessionId: string,
  row: CompactionRow,
): void {
  appendFileSync(
    sessionPath(sessionId),
    JSON.stringify({ type: "compaction", ...row }) + "\n",
  );
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

/** 压缩检查点 -> data-compaction part（phase 固定 complete：历史里都是终态） */
function compactionDividerPart(row: CompactionRow) {
  const details = row.details as
    | { generation?: unknown; strategy?: unknown }
    | undefined;
  return {
    type: "data-compaction",
    id: `cmp-${row.seq}`,
    data: {
      phase: "complete",
      generation:
        typeof details?.generation === "number" ? details.generation : 1,
      tokensBefore: row.tokensBefore,
      summarized: details?.strategy !== "fresh_window",
    },
  } as UIMessage["parts"][number];
}

/**
 * 从持久化的 agent 消息重建前端历史（含工具部件，get_history 用）。
 * assistant.toolCall → `tool-${name}` part（input-available）；后续 toolResult
 * 按 toolCallId 回填 output（output-available），与 live 流的 chunk 形状一致，
 * 刷新前后渲染相同。toolCallId 匹配不到的 toolResult 直接忽略。
 *
 * compactions 提供时在消息流里重建「上下文已压缩」分隔线（刷新后 live 横幅
 * 不丢）：阈值/溢出压缩的宿主 = 边界后第一条 assistant 消息（与 live 流分隔线
 * 位于该轮回答气泡顶部一致）；其后无宿主（手动压缩的典型情形）则独立成一条
 * 仅含分隔线 part 的 assistant 消息，落在边界之后。
 */
export function historyToUiMessages(
  rows: { agent: Message; seq?: number }[],
  compactions: CompactionRow[] = [],
): UIMessage[] {
  type ToolPart = {
    type: string;
    toolCallId: string;
    state: "input-available" | "output-available";
    input?: unknown;
    output?: unknown;
  };
  const messages: UIMessage[] = [];
  // 与 messages 平行：每条 UI 消息源行的 jsonl seq（独立分隔线消息用 -Infinity，
  // 永远视为「边界之前」，不会再当后续检查点的宿主）
  const srcSeqs: number[] = [];
  const openTools = new Map<string, ToolPart>();
  for (let i = 0; i < rows.length; i++) {
    const seq = rows[i].seq ?? i;
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
      srcSeqs.push(seq);
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
      srcSeqs.push(seq);
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

  for (const cp of [...compactions].sort((a, b) => a.seq - b.seq)) {
    const part = compactionDividerPart(cp);
    let host = -1;
    for (let j = 0; j < messages.length; j++) {
      if (srcSeqs[j] > cp.throughSeq && messages[j].role === "assistant") {
        host = j;
        break;
      }
    }
    if (host >= 0) {
      messages[host].parts.unshift(part);
      continue;
    }
    let pos = messages.length;
    for (let j = 0; j < messages.length; j++) {
      if (srcSeqs[j] > cp.throughSeq) {
        pos = j;
        break;
      }
    }
    messages.splice(pos, 0, {
      id: `cmp-${cp.seq}`,
      role: "assistant",
      parts: [part],
    });
    srcSeqs.splice(pos, 0, -Infinity);
  }
  return messages;
}

/** 标题总结防抖：每会话只尝试一次（进程内）；手动改名后不再覆盖 */
const titleSummarized = new Set<string>();
/** 标题总结测试 seam（transcript.test 注入假实现） */
export const titleSummarizeHook: {
  fn?: typeof summarizeSessionTitle;
} = {};

/**
 * 首轮回复完成后异步生成智能标题（PI-Desktop triggerAutoTitleSummarization 同设计）：
 * 仅当索引标题仍是 prompt 兜底（= first_message 截断串）时触发——手动改名后
 * 标题不再等于兜底串，自然跳过；one-shot 独立请求不进会话上下文；失败静默保留
 * fallback。每会话进程内只尝试一次（防抖 Set）。
 */
export async function maybeSummarizeSessionTitle(run: Running): Promise<void> {
  if (titleSummarized.has(run.sessionId)) return;
  const messages = run.agent.state.messages;
  const firstUser = messages.find((m) => m.role === "user") as Message | undefined;
  if (!firstUser) return;
  const firstText =
    typeof firstUser.content === "string"
      ? firstUser.content
      : (firstUser.content.find((c) => c.type === "text")?.text ?? "");
  if (!firstText.trim()) return;
  const fallback = firstText.slice(0, 60);

  // 标题守卫：仍是兜底串（或为空）才总结；手动改名（≠兜底串）永不覆盖
  const row = await sessionGet(run.sessionId);
  if (!row) return;
  if (row.title && row.title !== fallback) return;

  // 首条非错误/中止的助手回复文本（错误回复生成标题会误导）
  const firstAssistant = messages.find(
    (m) =>
      m.role === "assistant" &&
      (m as { stopReason?: string }).stopReason !== "error" &&
      (m as { stopReason?: string }).stopReason !== "aborted",
  ) as Extract<Message, { role: "assistant" }> | undefined;
  const replyText = firstAssistant
    ? firstAssistant.content
        .filter(
          (c): c is { type: "text"; text: string } =>
            c.type === "text" && typeof c.text === "string",
        )
        .map((c) => c.text)
        .join("\n")
    : "";

  titleSummarized.add(run.sessionId);
  const model = run.agent.state.model;
  if (!model) return;
  const title = await (titleSummarizeHook.fn ?? summarizeSessionTitle)(
    getModels().streamSimple.bind(getModels()),
    model,
    firstText,
    replyText || undefined,
  );
  if (!title || title === fallback) return;
  try {
    await sessionRename(run.sessionId, title);
  } catch (err) {
    logErr("session title rename failed:", err);
  }
}

/** agent_end 后把新增消息增量 append 到 JSONL，并维护索引表（经 hostdb 数据访问层）。
 * seq 取 run.jsonlSeq（文件内单调，压缩后 state.messages 变短也不会撞号）；
 * run.persistedSeq 之前的 state 消息视为已入账（压缩后合成摘要头由 runCompaction
 * 一并跳过），这里只写增量。 */
export async function persist(run: Running): Promise<void> {
  const messages = run.agent.state.messages;
  if (messages.length <= run.persistedSeq) return;
  const file = sessionPath(run.sessionId);
  const lines: string[] = [];
  for (let i = run.persistedSeq; i < messages.length; i++) {
    const agent = messages[i] as Message;
    // 每条 agent 消息都落盘（含纯工具调用与 toolResult）：恢复模型上下文需要完整
    // 的 toolCall/toolResult 对，前端历史重建也需要工具部件
    const seq = run.jsonlSeq++;
    const ui = toUiMessage(agent, seq);
    lines.push(JSON.stringify({ type: "message", seq, ui, agent }));
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

  // 首轮回复后的智能标题（异步、防抖、失败静默；不阻塞索引维护）
  try {
    await maybeSummarizeSessionTitle(run);
  } catch (err) {
    logErr("session title summarize trigger failed:", err);
  }
}
