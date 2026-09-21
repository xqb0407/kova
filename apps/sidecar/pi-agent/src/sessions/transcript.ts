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
import type { Message } from "@earendil-works/pi-ai";
import { projectToolResult, type ProjectableContentBlock } from "../tools/image-parts";
import { sessionPath } from "../storage/storage";
import { sessionGet, sessionRename, sessionTouch } from "../storage/hostdb";
import { getModels } from "../model/model-catalog";
import { stripDirectiveTokens, summarizeSessionTitle } from "./session-title-summarize";
import { logErr } from "../log";
import type { Running, UIMessage } from "../types";

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

/** 转录文件一次遍历的结果（迭代 4：消息行与压缩检查点行同遍分流，
 * get_history 不再读两遍文件） */
export type TranscriptScan = {
  messages: { seq: number; ui: UIMessage | null; agent: Message }[];
  compactions: CompactionRow[];
};

/** 单遍扫描 JSONL：撕裂尾行容忍；消息行按 seq 去重（保留最后一次出现）
 * 并按 seq 排序——旧版持久化 bug 会把同一批消息重复 append，避免历史
 * 重建/会话恢复携带重复消息；未知行类型/缺 seq 跳过，向前兼容。 */
export function scanTranscript(sessionId: string): TranscriptScan {
  const file = sessionPath(sessionId);
  if (!existsSync(file)) return { messages: [], compactions: [] };
  const bySeq = new Map<number, { ui: UIMessage | null; agent: Message }>();
  const compactions: CompactionRow[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (typeof row?.seq !== "number") continue;
      if (row.type === "message" && row.agent) {
        bySeq.set(row.seq, { ui: row.ui ?? null, agent: row.agent });
      } else if (
        row.type === "compaction" &&
        typeof row.summary === "string" &&
        typeof row.throughSeq === "number"
      ) {
        compactions.push(row as CompactionRow);
      }
    } catch {
      // 撕裂尾行：忽略
    }
  }
  const messages = [...bySeq.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seq, row]) => ({ seq, ...row }));
  return { messages, compactions };
}

/** 从 JSONL 读全部消息行（跳过撕裂尾行；ui 可为 null；返回带 seq 供恢复端按边界过滤）。
 * 去重/排序语义见 scanTranscript。 */
export function readTranscript(
  sessionId: string,
): { seq: number; ui: UIMessage | null; agent: Message }[] {
  return scanTranscript(sessionId).messages;
}

/** 读最后一条压缩检查点行（无检查点返回 undefined） */
export function readCompaction(sessionId: string): CompactionRow | undefined {
  return scanTranscript(sessionId).compactions.at(-1);
}

/** 读全部压缩检查点行（文件序） */
export function readAllCompactions(sessionId: string): CompactionRow[] {
  return scanTranscript(sessionId).compactions;
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

/**
 * 长度截断自动续跑的注入消息哨兵前缀（见 context.makeAutoContinueMessage）。
 * UI 双面不可见：直播流上 user 消息本就不发 chunk；历史投影在下边 toUiMessage
 * 里按前缀返回 null（行仍落盘，ui 为 null，与 toolResult 行同机制）。
 */
export const AUTO_CONTINUE_PREFIX = "[[auto-continue]] ";

export function isAutoContinueText(text: string): boolean {
  return text.startsWith(AUTO_CONTINUE_PREFIX);
}

/**
 * 用户消息 content → UIMessage parts：text 合并（原语义）+ image content 回显为
 * file part（data URL）。直播侧 composer 附件就是以 file part 进 user UIMessage
 * 的，历史重建同形——刷新前后渲染相同（「刷新后 = 直播」构造性保证）。
 * 纯图片无文字也返回消息（parts 非空即有效）；完全无内容返回 null。
 */
function userUiParts(
  msg: Extract<Message, { role: "user" }>,
): { text: string; parts: UIMessage["parts"] } | null {
  const content =
    typeof msg.content === "string"
      ? [{ type: "text" as const, text: msg.content }]
      : msg.content;
  const parts: UIMessage["parts"] = [];
  const text = content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  if (text.trim()) parts.push({ type: "text", text });
  let imgSeq = 0;
  for (const c of content) {
    if (c.type !== "image") continue;
    imgSeq += 1;
    // 转录是落盘 JSON，历史行可能来自旧格式/残缺数据：mimeType 缺失兜底 png
    const mime = c.mimeType || "image/png";
    const ext = mime.split("/")[1] ?? "png";
    parts.push({
      type: "file",
      mediaType: mime,
      filename: `image-${imgSeq}.${ext === "jpeg" ? "jpg" : ext}`,
      url: `data:${mime};base64,${c.data}`,
    });
  }
  return parts.length ? { text, parts } : null;
}

/** pi-ai Message -> UIMessage（ui 字段快照；转换范围：text/reasoning/用户图片） */
export function toUiMessage(msg: Message, seq: number): UIMessage | null {
  if (msg.role === "user") {
    const up = userUiParts(msg);
    if (!up) return null;
    if (isAutoContinueText(up.text)) return null;
    return { id: `msg-${seq}`, role: "user", parts: up.parts };
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
    // 中止的残缺回复：补「已停止」分隔线 part（与直播流 data-stopped 同构，
    // 刷新后标记不丢）
    if (msg.stopReason === "aborted") {
      parts.push({
        type: "data-stopped",
        id: "stopped",
        data: {},
      } as UIMessage["parts"][number]);
    }
    if (!parts.length) return null;
    return { id: `msg-${seq}`, role: "assistant", parts };
  }
  return null; // toolResult 等不产生独立 UI 消息
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
      summary: row.summary,
    },
  } as UIMessage["parts"][number];
}

/**
 * 从持久化的 agent 消息重建前端历史（含工具部件，get_history 用）。
 * assistant.toolCall → `tool-${name}` part（input-available）；后续 toolResult
 * 按 toolCallId 回填 output（output-available），与 live 流的 chunk 形状一致，
 * 刷新前后渲染相同。toolCallId 匹配不到的 toolResult 直接忽略。
 * toolResult 的 image 块经共用投影 projectToolResult（image-parts.ts）重建为
 * data-image part，紧跟对应 tool part 之后——与 live 流的 chunk 顺序同构。
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
    state: "input-available" | "output-available" | "output-error";
    input?: unknown;
    output?: unknown;
    errorText?: unknown;
  };
  const messages: UIMessage[] = [];
  // 与 messages 平行：每条 UI 消息源行的 jsonl seq（独立分隔线消息用 -Infinity，
  // 永远视为「边界之前」，不会再当后续检查点的宿主）
  const srcSeqs: number[] = [];
  // host 存宿主消息的 parts 数组引用（同一数组对象已随消息入列，原位 splice 即生效）：
  // toolResult 的 data-image part 要插到对应 tool part 紧邻之后，与 live chunk 顺序同构
  const openTools = new Map<string, { part: ToolPart; host: UIMessage["parts"] }>();
  for (let i = 0; i < rows.length; i++) {
    const seq = rows[i].seq ?? i;
    const msg = rows[i].agent;
    if (msg.role === "user") {
      const up = userUiParts(msg);
      if (!up) continue;
      messages.push({ id: `msg-${i}`, role: "user", parts: up.parts });
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
          openTools.set(c.id, { part, host: parts });
        }
      }
      if (!parts.length) continue;
      messages.push({ id: `msg-${i}`, role: "assistant", parts });
      srcSeqs.push(seq);
      continue;
    }
    if (msg.role === "toolResult") {
      const entry = openTools.get(msg.toolCallId);
      if (entry) {
        // 与 live 流共用投影：output 文本（含超限占位行）+ data-image parts 逐字同构
        const toolName = entry.part.type.startsWith("tool-")
          ? entry.part.type.slice("tool-".length)
          : undefined;
        const { output, images } = projectToolResult(
          msg.content as ProjectableContentBlock[],
          { toolCallId: msg.toolCallId, toolName },
        );
        // 落盘的 isError 与 live 流的 tool-output-error chunk 同构（前端据此
        // 置 isError）：被拒/失败的工具调用刷新后仍判失败、不渲染产物卡。
        // 转录行一直带 isError（pi 库必填字段），旧会话回放同样生效
        if (msg.isError) {
          entry.part.state = "output-error";
          entry.part.errorText = output;
        } else {
          entry.part.state = "output-available";
          entry.part.output = output;
        }
        if (images.length) {
          // part 入列时同法 cast 过，按引用找回位置（ToolPart 与 UIMessagePart 结构不互容）
          const at = entry.host.indexOf(entry.part as UIMessage["parts"][number]);
          entry.host.splice(
            at + 1,
            0,
            ...images.map(
              (img) =>
                ({
                  type: "data-image",
                  id: img.id,
                  data: img.data,
                }) as UIMessage["parts"][number],
            ),
          );
        }
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
  // 芯片标记剥掉后再截断：兜底标题与 AI 总结输入都不带 :skill[...]{...} 噪音
  const cleanText = stripDirectiveTokens(firstText);
  const fallback = cleanText.slice(0, 60);

  // 标题守卫：仍是兜底串（或为空）才总结；手动改名（≠兜底串）永不覆盖。
  // 一并认旧版落盘的未剥芯片兜底串，让改动上线前的会话还能补智能标题
  const row = await sessionGet(run.sessionId);
  if (!row) return;
  if (row.title && row.title !== fallback && row.title !== firstText.slice(0, 60)) return;

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
    cleanText,
    replyText || undefined,
  );
  if (!title || title === fallback) return;
  try {
    await sessionRename(run.sessionId, title);
  } catch (err) {
    logErr("session title rename failed:", err);
  }
}

/** 把新增消息增量 append 到 JSONL，并维护索引表（经 hostdb 数据访问层）。
 * 调用时机：轮初用户消息进入 state 后先以 earlyUser 补录一条（刷新后
 * get_history 才能看到在飞轮次的用户消息——重挂只重放 assistant chunk 流，
 * 补不回这条气泡）；agent_end 收尾落其余消息。
 * seq 取 run.jsonlSeq（文件内单调，压缩后 state.messages 变短也不会撞号）；
 * run.persistedSeq 之前的 state 消息视为已入账（压缩后合成摘要头由 runCompaction
 * 一并跳过），这里只写增量。 */
export async function persist(
  run: Running,
  opts: { earlyUser?: boolean } = {},
): Promise<void> {
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
  // 迭代 4：本轮新落盘的消息行数随 touch 增量进索引表，list_sessions 不再扫文件。
  // 兜底标题剥掉指令芯片标记（first_message 列保持原文，仅标题清洗）
  await sessionTouch(
    run.sessionId,
    stripDirectiveTokens(firstText).slice(0, 60),
    firstText,
    lines.length,
  );

  // earlyUser：轮初补录还没有助手回复，此时总结标题会缺回答上下文，
  // 且每会话 one-shot 防抖会被白白消费——留给 agent_end 那次触发
  if (opts.earlyUser) return;

  // 首轮回复后的智能标题：fire-and-forget。pi-agent-core 的 run 要等 agent_end
  // 监听器 settle 才结束，若在此 await 标题 LLM 调用，finish chunk 会被推迟数秒
  // （前端表现为"正文完了还在转圈"）。one-shot 防抖在 maybeSummarizeSessionTitle
  // 内部（先占坑再调用），重复触发安全；失败静默
  void maybeSummarizeSessionTitle(run).catch((err) => {
    logErr("session title summarize trigger failed:", err);
  });
}
