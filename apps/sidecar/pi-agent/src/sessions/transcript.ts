/**
 * 会话正文持久化：JSONL 转录文件 + SQLite 索引表维护。
 *   JSONL 首行 {"type":"header",...}；消息行 {"type":"message","seq":n,"ui":UIMessage|null,"agent":Message}
 *   压缩检查点行 {"type":"compaction","seq":n,...}（context.ts 的 checkpoint，摘要+边界+generation）；
 *   每条 agent 消息都写一行（含 toolResult），ui 字段是 text/reasoning 快照可为 null；
 *   前端历史（含工具部件）由 historyToUiMessages 从 agent 行重建（压缩不删历史行）；
 *   seq 是文件内单调编号（消息行与检查点行共用，见 Running.jsonlSeq）。
 *   挂起交互行 {"type":"pending_interaction",interaction}/
 *   {"type":"interaction_resolved",interactionId,...}（§4，queue_state 同款不占 seq）：
 *   scanTranscript 配对出未结算清单，get_history/list_pending 据此回放挂起卡。
 *   上下文设定行（§6 M4 上游对齐，同样不占 seq，last-wins 回放）：
 *   {"type":"model_change",provider,modelId,timestamp}/
 *   {"type":"thinking_level_change",thinkingLevel,timestamp}/
 *   {"type":"session_info",name,timestamp}——模型/思考档位/会话名的转录内
 *   真值（SQLite 偏好行与 title 列退为投影，旧会话无行时仍按旧路径回落）；
 *   字段名与上游 coding-agent session-format v3 逐字一致（线性子集，不取
 *   树位 id/parentId，§11 决策 4）。header 行加性 `parentSession`（fork 溯源）。
 *   读端跳过撕裂尾行，append 中途崩溃不影响已有内容。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { HistoryWindowMeta, PendingInteraction } from "pi-protocol";
import {
  AUTO_CONTINUE_PREFIX,
  isAutoContinueMessage,
  isAutoContinueText,
  isGoalInternalMessage,
  isWorkflowContinueText,
  isGoalInternalText,
} from "pi-protocol";
import { normalizeLoadedGoal, type Goal } from "../goal/goal-state";
import type { Message } from "@earendil-works/pi-ai";
import { projectToolResult, type ProjectableContentBlock } from "../tools/image-parts";
import { sessionPath } from "../storage/storage";
import { sessionGet, sessionRename, sessionTouch } from "../storage/hostdb";
import { emitThreadEvent } from "../protocol/thread-events";
import { sendSessionsChanged } from "../protocol/stream";
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

/* --------------------- 内容块形状归一（畸形块的唯一闸口） ---------------------
 * 一条 {type:"text"}（text 缺失，JSON 里就是没有这个键）的块会毒死整条会话：
 * 它一旦进了 state.messages，每次请求前的上下文估算（pi-ai estimate.js 的
 * block.text.length）就抛 TypeError，模型请求根本发不出去；历史重建路径上的
 * block.text.trim() 同理，一条脏行让 get_history 整个失败。JSON.stringify 会把
 * undefined 字段直接抹掉，所以脏块一旦落盘，文件里看起来只是"少了个字段"，
 * 事后极难定位。
 *
 * 归一化放在三个点各过一遍（都是幂等的）：
 *   1. 落盘前（persist）——脏块从此不写进文件；
 *   2. 读回重建前（scanTranscript）——存量脏数据照样能打开；
 *   3. 恢复模型上下文前（projectRestoreContext）——旧会话续聊不被毒。
 */

/** 占位文本：说明发生了什么、当前能否继续，不编造内容 */
const MALFORMED_BLOCK_NOTE =
  "[malformed content block: this block was missing its required field and has been " +
  "repaired during session load. Treat it as no output; the underlying tool result was lost.]";

type AnyBlock = { type?: unknown } & Record<string, unknown>;

/** 单个块的形状校验：合法的原样返回，非法的换成可读的 text 块或丢弃 */
function normalizeBlock(block: AnyBlock): AnyBlock | null {
  if (!block || typeof block !== "object") return null;
  switch (block.type) {
    case "text":
      return typeof block.text === "string"
        ? block
        : { type: "text", text: MALFORMED_BLOCK_NOTE };
    case "thinking":
      return typeof block.thinking === "string"
        ? block
        : { type: "text", text: MALFORMED_BLOCK_NOTE };
    case "image":
      // data 缺失不会崩，但会序列化成 data:image/png;base64,undefined 发给
      // provider（必然 400），所以整块丢掉而不是补一个假图
      return typeof block.data === "string" && block.data.length > 0
        ? block
        : null;
    case "toolCall":
      return typeof block.name === "string" ? block : null;
    default:
      return block;
  }
}

/** 消息 content 归一：字符串原样；块数组逐块校验，非法块降级/丢弃。
 *  一块都没动时返回**原数组**（引用不变）——调用方据此判定「无需重建对象」，
 *  正常会话（无畸形块）因此零分配、零对象 churn。 */
export function normalizeMessageContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return [];
  let changed = false;
  const out: AnyBlock[] = [];
  for (const raw of content) {
    const block = normalizeBlock(raw as AnyBlock);
    if (block === null || block !== raw) changed = true;
    if (block !== null) out.push(block);
  }
  return changed ? out : content;
}

/** 消息级归一：返回新对象（不改原对象，避免污染运行中的 state.messages） */
export function normalizeMessage<T>(message: T): T {
  const msg = message as { role?: unknown; content?: unknown };
  if (!msg || typeof msg !== "object" || !("content" in msg)) return message;
  const content = normalizeMessageContent(msg.content);
  if (content === msg.content) return message;
  return { ...msg, content } as T;
}

/** 批量归一（重建/恢复入口用；幂等，形状已对的原样返回） */
export function normalizeMessages<T>(messages: readonly T[]): T[] {
  return messages.map((m) => normalizeMessage(m));
}

/** 转录文件一次遍历的结果（迭代 4：消息行与压缩检查点行同遍分流，
 * get_history 不再读两遍文件；M2：挂起交互行配对出未结算清单，§4） */
export type TranscriptScan = {
  messages: { seq: number; ui: UIMessage | null; agent: Message }[];
  compactions: CompactionRow[];
  /** 未结算挂起交互（发起行 − 结算行，按发起顺序）；重启/驱逐后回放挂起卡的事实源 */
  pending: PendingInteraction[];
  /** §6 M4 回放结果（对齐上游 getSessionContextSettings）：转录设定行的
   *  last-wins 值；null = 无行（旧会话回落 SQLite 偏好镜像/全局选择） */
  model: { provider: string; modelId: string } | null;
  thinkingLevel: string | null;
  /** 最后一次 session_info 行的 name（"" = 显式清名）；null = 从未命名 */
  name: string | null;
};

/** 单遍扫描 JSONL：撕裂尾行容忍；消息行按 seq 去重（保留最后一次出现）
 * 并按 seq 排序——旧版持久化 bug 会把同一批消息重复 append，避免历史
 * 重建/会话恢复携带重复消息；未知行类型/缺 seq 跳过，向前兼容。
 * 交互行不占 seq 号段（queue_state 同款），在 seq 门槛前先分流配对。 */
export function scanTranscript(sessionId: string): TranscriptScan {
  const file = sessionPath(sessionId);
  if (!existsSync(file))
    return { messages: [], compactions: [], pending: [], model: null, thinkingLevel: null, name: null };
  const bySeq = new Map<number, { ui: UIMessage | null; agent: Message }>();
  const compactions: CompactionRow[] = [];
  const pendingById = new Map<string, PendingInteraction>();
  let model: TranscriptScan["model"] = null;
  let thinkingLevel: string | null = null;
  let name: string | null = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.type === "pending_interaction") {
        const it = row.interaction as PendingInteraction | undefined;
        if (it && typeof it.interactionId === "string" && typeof it.kind === "string") {
          pendingById.set(it.interactionId, it);
        }
        continue;
      }
      if (row?.type === "interaction_resolved") {
        if (typeof row.interactionId === "string") {
          pendingById.delete(row.interactionId);
        }
        continue;
      }
      // 上下文设定行（§6 M4）：last-wins 回放；形状不符的旧行/坏行忽略
      if (row?.type === "model_change") {
        if (typeof row.provider === "string" && typeof row.modelId === "string") {
          model = { provider: row.provider, modelId: row.modelId };
        }
        continue;
      }
      if (row?.type === "thinking_level_change") {
        if (typeof row.thinkingLevel === "string") thinkingLevel = row.thinkingLevel;
        continue;
      }
      if (row?.type === "session_info") {
        if (typeof row.name === "string") name = row.name;
        continue;
      }
      if (typeof row?.seq !== "number") continue;
      if (row.type === "message" && row.agent) {
        bySeq.set(row.seq, { ui: row.ui ?? null, agent: normalizeMessage(row.agent) });
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
  return { messages, compactions, pending: [...pendingById.values()], model, thinkingLevel, name };
}

/**
 * 历史分页窗（§6，ZCode rowsWindow 的对应物；游标 = 消息行 seq）：
 * beforeSeq 取「严格早于游标」的尾部 tail 条；两者皆缺 = 全量（旧端不破）。
 * 单遍全扫后在输出上截尾——compaction/交互行本就要求全遍，行数远小于体量。
 * hasMore = 窗口之前还有消息行；空窗 first/last 为 null。
 */
export function windowTranscriptMessages<T extends { seq: number }>(
  messages: T[],
  opts: { tail?: number; beforeSeq?: number },
): { window: T[]; meta: HistoryWindowMeta } {
  const tail = Number.isInteger(opts.tail) ? Math.max(0, opts.tail as number) : undefined;
  const beforeSeq = Number.isInteger(opts.beforeSeq) ? (opts.beforeSeq as number) : undefined;
  if (tail === undefined && beforeSeq === undefined) {
    const first = messages[0];
    const last = messages[messages.length - 1];
    return {
      window: messages,
      meta: { firstSeq: first?.seq ?? null, lastSeq: last?.seq ?? null, hasMore: false },
    };
  }
  const eligible =
    beforeSeq === undefined ? messages : messages.filter((m) => m.seq < beforeSeq);
  const window = tail === undefined ? eligible : eligible.slice(Math.max(0, eligible.length - tail));
  const first = window[0];
  const last = window[window.length - 1];
  return {
    window,
    meta: {
      firstSeq: first?.seq ?? null,
      lastSeq: last?.seq ?? null,
      hasMore: eligible.length > window.length,
    },
  };
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

/* ---------------- 上下文设定行（§6 M4 上游对齐） ----------------
 * 行事件溯源、不占 seq（queue_state/pending_interaction 同款机制）：变更点
 * 追加一行，scanTranscript 单遍 last-wins 回放。timestamp 对齐上游条目字段
 * （ISO 串，读端不用，纯溯源留档）。 */

function appendSettingRow(sessionId: string, row: Record<string, unknown>): void {
  appendFileSync(sessionPath(sessionId), JSON.stringify(row) + "\n");
}

/** 换模型：set_model 会话定靶时落该会话一行（与偏好投影同步；绝不广播落行——会把各会话自身选择盖成同一个） */
export function appendModelChangeRow(
  sessionId: string,
  provider: string,
  modelId: string,
): void {
  appendSettingRow(sessionId, {
    type: "model_change",
    provider,
    modelId,
    timestamp: new Date().toISOString(),
  });
}

/** 思考档位变更：set_thinking 逐驻留会话落行（档位恢复 = 行回放，替代"只有全局"） */
export function appendThinkingLevelChangeRow(
  sessionId: string,
  level: string,
): void {
  appendSettingRow(sessionId, {
    type: "thinking_level_change",
    thinkingLevel: level,
    timestamp: new Date().toISOString(),
  });
}

/* ------------------------------- goal 状态行 ------------------------------- */

/**
 * 目标状态行：每次目标变更（设定/续跑结算/暂停/完成/清除）追加一行，
 * scanTranscript 单遍 last-wins 回放。与 queue_state 同款「不占 seq 的事件溯源」
 * 形态——目标状态是派生盘面而非模型消息，不该混进消息 seq 序列。
 *
 * goal 字段可为 null（清除）。与 queue_state 不同，清除必须也落行：目标停在
 * 「已完成」和「被用户清掉」在回放上要区分得开，否则重启后 UI 会把一个早就
 * 收工的目标重新当成进行中显示。
 */
export function appendGoalStateRow(
  sessionId: string,
  goal: Goal | null,
): void {
  appendSettingRow(sessionId, {
    type: "goal_state",
    goal: goal ?? null,
    timestamp: new Date().toISOString(),
  });
}

/**
 * 从转录回放目标状态（无行 = 无目标）。
 * 畸形行不抛：normalizeLoadedGoal 整条判废，调用方按「无目标」处理——比让一条
 * 撕裂行把整个会话恢复链带崩划算。
 */
export function readGoalState(sessionId: string): Goal | undefined {
  const file = sessionPath(sessionId);
  if (!existsSync(file)) return undefined;
  let restored: Goal | undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"goal_state"')) continue;
    try {
      const row = JSON.parse(line) as { type?: string; goal?: unknown };
      if (row.type !== "goal_state") continue;
      restored = row.goal == null ? undefined : normalizeLoadedGoal(row.goal, Date.now());
    } catch {
      /* 撕裂行：保留上一份有效状态 */
    }
  }
  return restored;
}

/** 会话命名行：rename 命令与智能标题共用的落盘面 */
export function appendSessionInfoRow(sessionId: string, name: string): void {
  appendSettingRow(sessionId, {
    type: "session_info",
    name,
    timestamp: new Date().toISOString(),
  });
}

/**
 * 工作流运行状态的瘦身投影行(无各步结果文本——全量在 .kova/workflows/<runId>.json,
 * 见 workflow/journal.ts)。形状由调用方(workflow 门面)归一,这里只管存取:
 * goal_state 行的形状守卫在 transcript 里是为了复用 Goal 类型守卫,工作流的本体
 * 在独立文件里,判废逻辑跟着本体走,不在这重复一份。
 */
export function appendWorkflowStateRow(sessionId: string, run: unknown | null): void {
  appendSettingRow(sessionId, {
    type: "workflow_state",
    run: run ?? null,
    timestamp: new Date().toISOString(),
  });
}

/** 从转录回放工作流运行(最后一行胜出;无行 = 无运行)。返回原始 JSON,判废在门面 */
export function readWorkflowStateRow(sessionId: string): unknown | undefined {
  const file = sessionPath(sessionId);
  if (!existsSync(file)) return undefined;
  let restored: unknown | undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"workflow_state"')) continue;
    try {
      const row = JSON.parse(line) as { type?: string; run?: unknown };
      if (row.type !== "workflow_state") continue;
      restored = row.run == null ? undefined : row.run;
    } catch {
      /* 撕裂行:保留上一份有效状态 */
    }
  }
  return restored;
}

/**
 * 撤回单条已落盘的转录行（按 seq，幂等；只删第一处命中）。
 *
 * 使用面很窄：**只服务「并入（steer）未获回应回收」**——注入即真实 user 行
 * 落转录，但那条轮次始终没回应用户，回收把它塞回队列重发时必须连同这条行
 * 一起撤回，否则同一内容既有气泡（已并入徽标）又在队列条，重发还再落一条
 * 同文行（前端两条同文气泡，删队列行也撤不回）。常规截断走 truncate_session
 * （它连审计与 run 驱逐一起做），这里只做单行撤回，不动 run。
 *
 * 返回被移除的消息行数（0 = 行不在文件里，调用方无需修正计数）。
 */
export function removeTranscriptRow(sessionId: string, seq: number): number {
  const file = sessionPath(sessionId);
  if (!existsSync(file)) return 0;
  const lines = readFileSync(file, "utf8").split("\n");
  const kept: string[] = [];
  let removed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (removed === 0) {
      let rowSeq: unknown;
      try {
        rowSeq = (JSON.parse(line) as { seq?: unknown }).seq;
      } catch {
        kept.push(line); // 坏行/撕裂尾行原样保留
        continue;
      }
      if (rowSeq === seq) {
        removed = 1;
        continue;
      }
    }
    kept.push(line);
  }
  if (!removed) return 0;
  writeFileSync(file, kept.length ? kept.join("\n") + "\n" : "");
  return removed;
}

/** 改名统一入口：先落 session_info 行（转录真值），再同步索引 title 列（投影）。
 *  行在前 = 崩溃窗口内真值不落后于投影；投影缺位（hostdb 未就绪）则整体抛给调用方。 */
export async function setSessionName(sessionId: string, name: string): Promise<void> {
  appendSessionInfoRow(sessionId, name);
  await sessionRename(sessionId, name);
}

/**
 * 长度截断自动续跑的注入消息哨兵前缀（见 context.makeAutoContinueMessage）。
 * 常量与判定放 pi-protocol 契约层单源（thread_snapshot 直出不经过本文件的
 * UI 投影，桌面投影层按同一前缀过滤），这里 re-export 维持既有引用面。
 * UI 双面不可见：直播流上 user 消息本就不发 chunk；历史投影在下边 toUiMessage
 * 里按前缀返回 null（行仍落盘，ui 为 null，与 toolResult 行同机制）。
 */
export { AUTO_CONTINUE_PREFIX, isAutoContinueText };

/**
 * 「连续截断把续跑预算烧到头」的最终中止行判定：assistant 以 length 截断收场
 * 且该轮零 toolCall（agent/context.needsLengthContinuation 的同款盘面——此处
 * 不直接引用它，因为 context.ts 反向依赖本文件的哨兵常量），且下一行不是自动
 * 续跑注入。中途截断的下一行必是哨兵续跑行；预算耗尽/终局的下一行是普通
 * user 行或 EOF，天然区分。thread_snapshot 直出与 historyToUiMessages 据此补
 * 「任务已中止」标记，与直播 data-truncation-stopped chunk 同构（data-stopped
 * 的三路径同款）。
 */
export function isTruncationStoppedRow(
  row: { agent: Message },
  next?: { agent: Message },
): boolean {
  const m = row.agent as
    | { role?: string; stopReason?: string; content?: unknown }
    | undefined;
  if (!m || m.role !== "assistant" || m.stopReason !== "length") return false;
  if (!Array.isArray(m.content)) return false;
  if (
    (m.content as { type?: string }[]).some((c) => c?.type === "toolCall")
  ) {
    return false;
  }
  if (next) {
    const n = next.agent as { role?: string } | undefined;
    if (n?.role === "user" && (isAutoContinueMessage(n) || isGoalInternalMessage(n)))
      return false;
  }
  return true;
}

/**
 * 并入当前轮（steer）注入消息的哨兵前缀（注入点见 prompt-pipeline.steerIntoActiveRun）。
 * 注入即真实 user 消息落转录；历史重建按前缀识别，渲染带「已并入当前回复」标记
 * （与直播排队条徽标语义一致），避免刷新后被当成普通提问。模型侧前缀自解释，
 * 与 auto-continue 同款先例。
 */
export const STEER_PREFIX = "[[queued-steer]] ";

export function isSteeredText(text: string): boolean {
  return text.startsWith(STEER_PREFIX);
}

/**
 * 用户消息 content → UIMessage parts：text 合并（原语义）+ image content 回显为
 * file part（data URL）。直播侧 composer 附件就是以 file part 进 user UIMessage
 * 的，历史重建同形——刷新前后渲染相同（「刷新后 = 直播」构造性保证）。
 * 并入当前轮（steer）的注入消息：哨兵前缀剥掉，正文照常渲染，另补
 * data-steeredNote 标记 part（前端渲染「已并入当前回复」徽标）。
 * 纯图片无文字也返回消息（parts 非空即有效）；完全无内容返回 null。
 */
function userUiParts(
  msg: Extract<Message, { role: "user" }>,
  seq?: number,
): { text: string; parts: UIMessage["parts"] } | null {
  const content =
    typeof msg.content === "string"
      ? [{ type: "text" as const, text: msg.content }]
      : msg.content;
  const parts: UIMessage["parts"] = [];
  let text = content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const steered = isSteeredText(text);
  if (steered) text = text.slice(STEER_PREFIX.length);
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
  if (steered && seq !== undefined) {
    // 标记 part 不就地渲染（未注册 data UI），由 UserMessage 检测存在后
    // 在气泡上方渲染徽标（stopped-marker 同款机制）
    parts.unshift({
      type: "data-steeredNote",
      id: `steered-${seq}`,
      data: {},
    } as UIMessage["parts"][number]);
  }
  return parts.length ? { text, parts } : null;
}

/** 崩溃轮次的错误占位 part。
 *
 * 空 content 的 assistant 消息（stopReason "error"，由 setupErrorMessage 合成）
 * 以前会被 `if (!parts.length) return null` 整个丢掉：页面上什么都不渲染，
 * 刷新后连转录重建也跳过，崩溃轮次凭空消失；折叠面板里也是空的，展开什么都没有。
 * 补一个与直播流同名同形的 data-errorAttribution part（pi-transport 错误分支
 * enqueue 的就是它），两条路径共用同一个渲染出口。
 */
function assistantErrorPart(
  msg: Extract<Message, { role: "assistant" }>,
): UIMessage["parts"][number] {
  const message =
    typeof (msg as { errorMessage?: unknown }).errorMessage === "string"
      ? ((msg as { errorMessage: string }).errorMessage || "").slice(0, 600)
      : "本回合因错误中断";
  return {
    type: "data",
    name: "errorAttribution",
    id: "errorAttribution",
    data: {
      code: "turn_error",
      source: "runtime",
      retryable: false,
      message,
    },
  } as unknown as UIMessage["parts"][number];
}

/** assistant 消息的收尾标记：错误轮补占位、其余照旧；返回 parts 是否该成消息 */
function finishAssistantParts(
  parts: UIMessage["parts"],
  msg: Extract<Message, { role: "assistant" }>,
): boolean {
  // 中止的残缺回复：补「已停止」分隔线 part（与直播流 data-stopped 同构，
  // 刷新后标记不丢）
  if (msg.stopReason === "aborted") {
    parts.push({
      type: "data-stopped",
      id: "stopped",
      data: {},
    } as UIMessage["parts"][number]);
  }
  // 崩溃轮次：错误占位 part 也保证「零内容轮」仍是一条可见消息，而不是消失
  if (msg.stopReason === "error") {
    parts.push(assistantErrorPart(msg));
  }
  return parts.length > 0;
}

/** pi-ai Message -> UIMessage（ui 字段快照；转换范围：text/reasoning/用户图片） */
export function toUiMessage(msg: Message, seq: number): UIMessage | null {
  if (msg.role === "user") {
    const up = userUiParts(msg, seq);
    if (!up) return null;
    if (isAutoContinueText(up.text)) return null;
    // 目标模式的内部注入（自动续跑 / 预算收尾）同款隐藏：它们是系统给模型的
    // 指令，不是用户说过的话，渲染出来会让对话流里全是用户没发过的文本
    if (isGoalInternalText(up.text)) return null;
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
    if (!finishAssistantParts(parts, msg)) return null;
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
 * 不丢）：以 checkpoint 落盘序 cp.seq（与消息 seq 共用单调编号）分流边界后
 * 消息——seq < cp.seq 的（轮中途压缩时已在转录）越过去挂线到首条 assistant
 * 顶部（与 live 分隔线位于该轮回答气泡顶部一致）；seq >= cp.seq 的（压缩
 * checkpoint 落盘后用户新发言）绝不越过，独立分隔线消息插在它之前——与 live
 * 流（线在压缩完成瞬间出现，其后消息都在线下方）保持同构。
 */
export function historyToUiMessages(
  rows: { agent: Message; seq?: number }[],
  compactions: CompactionRow[] = [],
  opts?: { reachesSessionEnd?: boolean },
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
    // 消息 id 用 seq 而不是行下标：分页窗（beforeSeq 往后翻）里两窗的下标都从
    // 0 起、下标 id 必撞号，seq 会话内唯一（§6）。时间戳（ms）随 metadata 下发，
    // 前端折算每轮耗时（用户行≈轮初、assistant 行≈轮末）
    const metadata = msg.timestamp !== undefined ? { createdAt: msg.timestamp } : undefined;
    if (msg.role === "user") {
      const up = userUiParts(msg, seq);
      if (!up) continue;
      // 长度截断自动续跑的注入消息（与 toUiMessage 同口径按前缀隐藏）：
      // 历史重建不该把它渲染成用户提问
      if (isAutoContinueText(up.text)) continue;
      // 目标模式内部注入（自动续跑 / 预算收尾）同口径隐藏
      if (isGoalInternalText(up.text)) continue;
      // 工作流交付注入(前缀判定,pi-protocol 单源):内部指令不进用户气泡
      if (isWorkflowContinueText(up.text)) continue;
      messages.push({ id: `msg-${seq}`, role: "user", parts: up.parts, metadata });
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
      // 最终中止标记（与直播 data-truncation-stopped chunk 同构，data-stopped
      // 三路径同款）：连续截断把续跑预算烧到头的那一轮。窗口末行的下一行在
      // 窗外，仅当调用方确认窗口触及会话末尾时才允许判「无续跑」，防分页窗
      // 恰好切在截断行与哨兵行之间造成误标。
      const next = i + 1 < rows.length ? rows[i + 1] : undefined;
      if (
        (next !== undefined || opts?.reachesSessionEnd !== false) &&
        isTruncationStoppedRow(rows[i], next)
      ) {
        parts.push({
          type: "data-truncation-stopped",
          id: "truncation-stopped",
          data: {},
        } as UIMessage["parts"][number]);
      }
      if (!finishAssistantParts(parts, msg)) continue;
      messages.push({ id: `msg-${seq}`, role: "assistant", parts, metadata });
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
      if (srcSeqs[j] <= cp.throughSeq) continue;
      // 边界后消息按与 checkpoint 落盘序（cp.seq 与消息 seq 共用单调编号）分流：
      // - seq < cp.seq：checkpoint 落盘前已在转录（轮中途压缩的常见情形，
      //   live 线在该轮回答顶部）→ 越过 user 消息找首条 assistant 挂线
      // - seq >= cp.seq：checkpoint 落盘后新增（压缩后用户先发言）→ 线绝不
      //   越过——live 线在压缩完成瞬间出现，其后消息不可能排在线上方
      if (srcSeqs[j] >= cp.seq) break;
      if (messages[j].role === "assistant") {
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
      if (srcSeqs[j] >= cp.seq) {
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
    // 行 + 投影双写（§6 M4）：转录里的 session_info 是真值，索引 title 是投影
    await setSessionName(run.sessionId, title);
    // 与 rename_session 同事件：智能标题落盘后即刻广播，前端顶栏/侧边栏的
    // 实时标题不必等整表 reload（列表快照里的 title 只在 list() 时刷新）
    emitThreadEvent(run.sessionId, { type: "session_info_changed", name: title });
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
  // 本 run 此前从未落过盘 = 会话首条消息即将可见（list_sessions 过滤
  // messageCount>0）；落盘后广播 updated，让其它端把这条新会话刷进列表
  const wasEmpty = run.persistedSeq === 0;
  const file = sessionPath(run.sessionId);
  const lines: string[] = [];
  for (let i = run.persistedSeq; i < messages.length; i++) {
    const agent = messages[i] as Message;
    // leading system 消息不落盘（0.99 起提示词进转录）：恢复时由
    // initialState.systemPrompt 重建并 unshift，落盘反而会让恢复链拿到
    // 过期提示词（热换只改内存首条，已落盘的旧行不会重写）
    if ((agent as { role?: string }).role === "system") continue;
    // 每条 agent 消息都落盘（含纯工具调用与 toolResult）：恢复模型上下文需要完整
    // 的 toolCall/toolResult 对，前端历史重建也需要工具部件
    const seq = run.jsonlSeq++;
    // 并入（steer）注入的行登记 seq：轮末「未获回应回收」要按它把这条行从
    // 转录与内存上下文里撤回（见 reconcileUnansweredSteers）——同一内容不能
    // 既留一条气泡又回队重发。身份比较（对象引用）与 findUnansweredSteers 同款
    const steerEntry = run.steerEntries?.find((entry) => entry.message === agent);
    if (steerEntry) steerEntry.seq = seq;
    // 归一后再落盘：脏块（text/data 缺失）在文件里只是"少个字段"，事后无法
    // 定位，且每次请求前的上下文估算都会撞上它——绝不能写进去
    const safe = normalizeMessage(agent);
    const ui = toUiMessage(safe, seq);
    lines.push(JSON.stringify({ type: "message", seq, ui, agent: safe }));
  }
  if (lines.length) appendFileSync(file, lines.join("\n") + "\n");
  run.persistedSeq = messages.length;

  // 0.99 起首条是 leading system 消息：标题取第一条 user 消息（行为同旧版，
  // 旧版转录首条即 user）
  const first = messages.find((m) => (m as { role?: string }).role === "user") as
    | Message
    | undefined;
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
  // 首条消息落盘 = 会话进入清单可见集合（messageCount 0→>0）：广播一次，
  // 之后每轮 persist 不再发（wasEmpty 按 run 代际判，恢复的 run 起点非 0）
  if (wasEmpty && lines.length) sendSessionsChanged("updated", run.sessionId);

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
