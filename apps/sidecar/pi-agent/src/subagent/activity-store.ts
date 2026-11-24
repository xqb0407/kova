/**
 * 子代理活动持久化（回放版）：把 delegate 的活动流边干边落到
 * <sessionsDir>/subagents/<delegationId>.jsonl，sidecar 重启后可完整回读。
 *
 * 设计（见 docs/subagent-activity-persistence-design.md）：
 * - 每行一条记录：首行 meta（委派身份），其后是 SubagentActivityItem 原样条目；
 * - 写盘器做「合并 + 批量」：相邻同 (kind,id) 的 delta 先合并再写（token 级不逐条落盘），
 *   攒够 250ms / 64 条 / 32KB 才刷一次；终态（status）强制同步刷——报告永不丢；
 * - 入队是同步内存操作、刷盘失败只记日志，绝不阻塞 agent 主循环（同 trace/otlp 纪律）；
 * - 回读：无终态记录的委派判为 interrupted（进程没了、没跑完）。
 *
 * 不做续跑：本模块只负责"能回放"，不负责恢复执行链。
 */
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { logErr } from "../log";
import { subagentPath, subagentsDirPath } from "../storage/storage";
import type {
  DelegationRecord,
  SubagentActivityItem,
  SubagentHistoryMessage,
  SubagentRunStatus,
} from "../types";
import { normalizeSubagentHistory } from "./history";

/** 刷盘节流：距上次刷盘超过此值即写 */
const FLUSH_INTERVAL_MS = 250;
/** 单批条目上限 */
const FLUSH_MAX_LINES = 64;
/** 单批字节上限 */
const FLUSH_MAX_BYTES = 32 * 1024;
/** 单文件体积护栏（同 trace：超限截尾保留末尾 1MB） */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const TRIM_KEEP_BYTES = 1024 * 1024;
/** 活动文件保留上限（对齐 delegation.ts 的 MAX_RETAINED_DELEGATIONS） */
const MAX_ACTIVITY_FILES = 50;

/** 每轮历史快照的独立文件后缀（与活动流分家：活动流截尾会连 meta 一起裁掉） */
const HISTORY_SUFFIX = ".history.json";

/** 文件里的一行：首行 meta + 之后的 item；终态附一条 transcript（resume 用） */
type ActivityFileLine =
  | {
      t: "meta";
      delegationId: string;
      agentName: string;
      modelId: string;
      description?: string;
      startedAt: number;
      /** 父会话三要素（resume 按需物化父会话；重启后回读仍可续聊） */
      ownerSession?: { sessionId: string; threadId: string; cwd: string };
    }
  | { t: "item"; item: SubagentActivityItem }
  | { t: "transcript"; messages: SubagentHistoryMessage[] }
  /** UHP backend: latest external response id (resume continuation). */
  | { t: "external"; responseId: string };

type DelegationWriter = {
  /** 已合并、待刷盘的行 */
  pending: ActivityFileLine[];
  timer: ReturnType<typeof setTimeout> | null;
  /** 待刷字节估算（增量累加，不做全量重算） */
  bytes: number;
};

const writers = new Map<string, DelegationWriter>();

const isDelta = (
  item: SubagentActivityItem,
): item is Extract<SubagentActivityItem, { kind: "thinking" | "text" }> =>
  (item.kind === "thinking" || item.kind === "text") && item.op === "delta";

/** 超限时截尾保留末尾 1MB（从其后第一个换行起，丢掉可能撕裂的半行）。
 *  首行 meta 必须保留：裁掉它等于让整个委派从磁盘上消失（回读按 meta 认身份）。 */
function trimIfOversize(file: string): void {
  const st = statSync(file);
  if (st.size <= MAX_FILE_BYTES) return;
  const buf = readFileSync(file);
  const firstNl = buf.indexOf(0x0a);
  const head =
    firstNl >= 0 && buf.subarray(0, firstNl).includes('"t":"meta"')
      ? buf.subarray(0, firstNl + 1)
      : Buffer.alloc(0);
  const tail = buf.subarray(Math.max(0, buf.length - TRIM_KEEP_BYTES));
  const nl = tail.indexOf(0x0a);
  writeFileSync(file, Buffer.concat([head, nl >= 0 ? tail.subarray(nl + 1) : tail]));
}

/** 落盘一批待写行（同步）；失败只记日志，绝不抛回调用方 */
function flush(delegationId: string): void {
  const w = writers.get(delegationId);
  if (!w) return;
  if (w.timer) {
    clearTimeout(w.timer);
    w.timer = null;
  }
  if (w.pending.length === 0) return;
  const lines = w.pending;
  w.pending = [];
  w.bytes = 0;
  try {
    const file = subagentPath(delegationId);
    mkdirSync(dirname(file), { recursive: true });
    try {
      trimIfOversize(file);
    } catch {
      // 首写/不可 stat：跳过护栏尽力而为（同 trace.writeRunRecord）
    }
    appendFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  } catch (err) {
    logErr("activity-store: write failed:", err);
  }
}

function scheduleFlush(delegationId: string): void {
  const w = writers.get(delegationId);
  if (!w || w.timer) return;
  w.timer = setTimeout(() => {
    w.timer = null;
    flush(delegationId);
  }, FLUSH_INTERVAL_MS);
  // 定时器不阻进程退出
  (w.timer as { unref?: () => void }).unref?.();
}

/** 委派开始时登记：立刻把 meta 行落盘（身份信息不随活动流丢） */
export function openDelegationActivity(record: DelegationRecord): void {
  if (writers.has(record.delegationId)) return;
  try {
    subagentsDirPath();
  } catch {
    // 存储未就绪（测试/早期启动）：不登记 writer，后续追加自然 no-op
    return;
  }
  writers.set(record.delegationId, { pending: [], timer: null, bytes: 0 });
  const w = writers.get(record.delegationId)!;
  const meta: ActivityFileLine = {
    t: "meta",
    delegationId: record.delegationId,
    agentName: record.agentName,
    modelId: record.modelId,
    ...(record.description ? { description: record.description } : {}),
    ...(record.ownerSession ? { ownerSession: record.ownerSession } : {}),
    startedAt: record.startedAt,
  };
  w.pending.push(meta);
  flush(record.delegationId);
}

/** 追加一条活动：合并相邻同源 delta；终态立即刷盘；其余按节流/水位刷 */
export function appendDelegationActivity(
  delegationId: string,
  item: SubagentActivityItem,
): void {
  const w = writers.get(delegationId);
  if (!w) return;

  const last = w.pending[w.pending.length - 1];
  if (
    isDelta(item) &&
    last?.t === "item" &&
    last.item.kind === item.kind &&
    isDelta(last.item) &&
    last.item.id === item.id
  ) {
    // 同源续写：原地合并增量（回放语义不变，前端 reducer 一视同仁）
    const merged: SubagentActivityItem = {
      ...last.item,
      delta: (last.item.delta ?? "") + (item.delta ?? ""),
      at: item.at,
    };
    w.pending[w.pending.length - 1] = { t: "item", item: merged };
    w.bytes += item.delta?.length ?? 0;
  } else {
    w.pending.push({ t: "item", item });
    w.bytes += JSON.stringify(item).length;
  }

  // status 一律同步刷盘：running 是 resume 开始的标记（必须抢在进程再次
  // 被杀前落盘），终态则刷完收摊（该委派不会再有活动）。
  if (item.kind === "status") {
    flush(delegationId);
    if (item.status !== "running") writers.delete(delegationId);
    return;
  }
  if (w.pending.length >= FLUSH_MAX_LINES || w.bytes >= FLUSH_MAX_BYTES) {
    flush(delegationId);
    return;
  }
  scheduleFlush(delegationId);
}

/** 强制刷盘（测试/收尾用） */
export function flushDelegationActivity(delegationId: string): void {
  flush(delegationId);
}

/** UHP backend: persist the latest previous_response_id so resume survives restart. */
export function appendDelegationExternalResponseId(
  delegationId: string,
  responseId: string,
): void {
  const w = writers.get(delegationId);
  if (!w) return;
  w.pending.push({ t: "external", responseId });
  flush(delegationId);
}

/**
 * 把终态会话历史存档进活动文件（resume 的初始上下文）。
 * settleDelegation 在 status 之前调用；同步刷盘——resume 依赖它，绝不延迟。
 * 没登记 writer（存储未就绪/已收摊）时临时补开一个只写不登记的通道。
 */
export function appendDelegationTranscript(
  delegationId: string,
  messages: SubagentHistoryMessage[],
): void {
  let w = writers.get(delegationId);
  const detached = !w;
  if (!w) {
    try {
      subagentsDirPath();
    } catch {
      return;
    }
    w = { pending: [], timer: null, bytes: 0 };
    writers.set(delegationId, w);
  }
  const line: ActivityFileLine = { t: "transcript", messages };
  let bytes: number;
  try {
    bytes = JSON.stringify(line).length;
  } catch (err) {
    // 非 JSON 安全的工具结果：不写入历史，但不能让结算链崩掉
    logErr("activity-store: transcript serialize failed:", err);
    if (detached) writers.delete(delegationId);
    return;
  }
  w.pending.push(line);
  w.bytes += bytes;
  flush(delegationId);
  if (detached) writers.delete(delegationId);
}

/** 每轮历史快照的路径（独立文件，整份覆盖写） */
function historyPath(delegationId: string): string {
  return join(subagentsDirPath(), `${delegationId}${HISTORY_SUFFIX}`);
}

/**
 * 每轮结束覆盖写历史快照：进程被重启/崩溃打断时，resume 至少能拿到
 * 最后一个完整轮次的上下文（settle 的 transcript 行仍是终态权威存档）。
 * 独立文件而不是追加进活动流——活动流 5MB 截尾只能保留末尾 1MB，
 * 每轮追加一份全量历史会加速触发截尾。
 */
export function writeDelegationHistory(
  delegationId: string,
  messages: SubagentHistoryMessage[],
): void {
  if (!messages.length) return;
  try {
    const file = historyPath(delegationId);
    mkdirSync(dirname(file), { recursive: true });
    // 先写临时文件再 rename：回读永远不会看到半份 JSON
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(messages));
    renameSync(tmp, file);
  } catch (err) {
    logErr("activity-store: history write failed:", err);
  }
}

/** 短 id 前缀在活动文件里的唯一匹配（同 sidecar findDelegation 语义）；
 *  歧义或无匹配返回 undefined。完整 id 亦走此路（前缀即全等）。 */
export function findActivityFileId(idOrPrefix: string): string | undefined {
  if (idOrPrefix.length < 4) return undefined;
  let dir: string;
  try {
    dir = subagentsDirPath();
  } catch {
    return undefined;
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  let found: string | undefined;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    if (!id.startsWith(idOrPrefix)) continue;
    if (found) return undefined; // 歧义前缀不猜
    found = id;
  }
  return found;
}

/** 回读一个委派的活动文件（丢失/损坏/无 meta 返回 undefined）；
 *  无终态记录 → status = interrupted */
export function readDelegationActivity(delegationId: string):
  | {
      record: {
        delegationId: string;
        agentName: string;
        modelId: string;
        description?: string;
        externalResponseId?: string;
        status: SubagentRunStatus;
        startedAt: number;
        completedAt?: number;
        turns: number;
        toolCalls: number;
        report?: string;
        ownerSession?: { sessionId: string; threadId: string; cwd: string };
      };
      items: SubagentActivityItem[];
      /** 最后一次 transcript 存档（resume 初始上下文；无则不可续聊） */
      history?: SubagentHistoryMessage[];
    }
  | undefined {
  let raw: string;
  try {
    raw = readFileSync(subagentPath(delegationId), "utf8");
  } catch {
    return undefined;
  }
  let meta: Extract<ActivityFileLine, { t: "meta" }> | undefined;
  const items: SubagentActivityItem[] = [];
  let history: SubagentHistoryMessage[] | undefined;
  let externalResponseId: string | undefined;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let row: ActivityFileLine;
    try {
      row = JSON.parse(t) as ActivityFileLine;
    } catch {
      // 撕裂行跳过（同 readTraceRuns）
      continue;
    }
    if (row.t === "meta") meta = row;
    else if (row.t === "item") items.push(row.item);
    else if (row.t === "transcript" && Array.isArray(row.messages)) {
      history = normalizeSubagentHistory(row.messages);
    } else if (row.t === "external" && typeof row.responseId === "string") {
      externalResponseId = row.responseId;
    }
  }
  if (!meta) return undefined;
  // 终态 transcript 行缺失（运行被中断）→ 取最后一轮的中途快照
  if (!history?.length) {
    try {
      const parsed = JSON.parse(readFileSync(historyPath(delegationId), "utf8")) as unknown;
      if (Array.isArray(parsed) && parsed.length) {
        history = normalizeSubagentHistory(parsed as SubagentHistoryMessage[]);
      }
    } catch {
      // 没有中途存档（中断太早/旧版本）：保持不可续聊
    }
  }

  let status: SubagentRunStatus = "interrupted";
  let completedAt: number | undefined;
  let turns = 0;
  let toolCalls = 0;
  let report: string | undefined;
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    if (it.kind === "turn") turns = Math.max(turns, it.n);
    else if (it.kind === "tool" && it.op === "start") toolCalls += 1;
    else if (it.kind === "status") {
      // 文件里的 running = 当时正在跑、进程随后没了（resume 开始标记或
      // 首次启动未结算）→ 回读判 interrupted；旧报告不能当成当前结果。
      status = it.status === "running" ? "interrupted" : it.status;
      completedAt = it.status === "running" ? undefined : it.at;
      turns = it.turns;
      toolCalls = it.toolCalls;
      report = it.status === "running" ? undefined : it.report;
    }
  }
  return {
    record: {
      delegationId: meta.delegationId,
      agentName: meta.agentName,
      modelId: meta.modelId,
      description: meta.description,
      ...(externalResponseId ? { externalResponseId } : {}),
      status,
      startedAt: meta.startedAt,
      completedAt,
      turns,
      toolCalls,
      report,
      ...(meta.ownerSession ? { ownerSession: meta.ownerSession } : {}),
    },
    items,
    ...(history?.length ? { history } : {}),
  };
}

/** 目录级清理：文件数超上限时删最旧的（跳过仍在跑的委派）；
 *  启动与委派结算各调一次（重启后内存为空，必须扫盘）。 */
export function pruneActivityFiles(isRunning: (delegationId: string) => boolean): void {
  let dir: string;
  let names: string[];
  try {
    dir = subagentsDirPath();
    names = readdirSync(dir);
  } catch {
    // 存储未初始化（测试/早期启动）或目录不存在：无可清理，静默跳过
    return;
  }
  const entries: { id: string; full: string; mtime: number }[] = [];
  for (const name of names) {
    // 写到一半被杀留下的临时历史文件：没有 rename 成功就不是权威数据
    if (name.endsWith(`${HISTORY_SUFFIX}.tmp`)) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // 下轮再清
      }
      continue;
    }
    if (!name.endsWith(".jsonl")) continue;
    const full = join(dir, name);
    let mtime = 0;
    try {
      mtime = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    entries.push({ id: name.slice(0, -".jsonl".length), full, mtime });
  }
  const excess = entries.length - MAX_ACTIVITY_FILES;
  if (excess <= 0) return;
  entries.sort((a, b) => a.mtime - b.mtime);
  let removed = 0;
  for (const e of entries) {
    if (removed >= excess) break;
    if (isRunning(e.id)) continue;
    try {
      unlinkSync(e.full);
      try {
        unlinkSync(historyPath(e.id));
      } catch {
        // 没有中途快照是常态
      }
      removed += 1;
    } catch {
      // 删不掉就跳过（下轮再试）
    }
  }
}

/** 测试辅助：清空写盘器与定时器 */
export function resetActivityStoreForTest(): void {
  for (const w of writers.values()) {
    if (w.timer) clearTimeout(w.timer);
  }
  writers.clear();
}
