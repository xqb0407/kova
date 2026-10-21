/**
 * 目标完成证据台账（本地文件，非 vendored）。
 *
 * 目标模式的完成判定不能只靠模型自由文本：模型可以写一段完美但编造的证据。
 * 这一层把「本次目标内真实发生过的工具调用」记成台账，goal_complete 交上来的
 * refs 必须能在台账里找到对应记录，文件类证据还要核对当前内容哈希。
 *
 * 三条纪律：
 * - 只匹配、不执行模型给的命令（重跑命令既慢又有副作用）；
 * - 台账号码只记本次目标内的调用，换目标/清除时整体丢弃；
 * - 重启后从 JSONL 回放（目标 startedSeq/startedAt 之后的行），回放失败就要求
 *   模型重新验证，绝不静默放行。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AfterToolCallContext } from "@earendil-works/pi-agent-core";
import { logErr } from "../log";
import { sessionPath } from "../storage/storage";
import type { Running } from "../types";
import {
  isGoalToolName,
  type Goal,
  type GoalEvidenceRef,
} from "./goal-state";

/** 单次目标最多保留的工具证据条数（防长目标把内存撑大） */
const MAX_GOAL_EVIDENCE_ENTRIES = 500;
/** 文件哈希上限：超过这个大小只记路径，校验退化为 mtime */
const MAX_HASH_BYTES = 10 * 1024 * 1024;
/** 每个标准最多接受的 refs 条数 */
const MAX_REFS_PER_CRITERION = 8;

export type GoalEvidenceEntry = {
  toolCallId: string;
  toolName: string;
  at: number;
  isError: boolean;
  command?: string;
  path?: string;
  exitCode?: number;
  /** write/edit 成功后的文件内容哈希（大文件缺省） */
  contentHash?: string;
};

export type EvidenceRefResult = {
  ref: GoalEvidenceRef;
  ok: boolean;
  manual?: boolean;
  detail?: string;
  error?: string;
};

export type EvidenceVerification = {
  ok: boolean;
  results: EvidenceRefResult[];
  verifiedCount: number;
  manualCount: number;
  errors: string[];
};

/** threadId -> 本次目标的工具证据台账 */
const ledgers = new Map<string, GoalEvidenceEntry[]>();
/** threadId -> 是否有一个需要记录证据的目标（换目标/清除时撤销） */
const active = new Set<string>();

/** 新建/替换目标：清空旧台账，开始记录 */
export function clearGoalEvidence(threadId: string): void {
  ledgers.set(threadId, []);
  active.add(threadId);
}

/** 目标被清除/线程销毁：连标记一起删 */
export function dropGoalEvidence(threadId: string): void {
  ledgers.delete(threadId);
  active.delete(threadId);
}

export function getGoalEvidence(threadId: string): readonly GoalEvidenceEntry[] {
  return ledgers.get(threadId) ?? [];
}

/** 线程键改绑：台账随目标一起挪到新 threadId */
export function migrateGoalEvidence(oldThreadId: string, newThreadId: string): void {
  const list = ledgers.get(oldThreadId);
  if (list) ledgers.set(newThreadId, list);
  ledgers.delete(oldThreadId);
  if (active.delete(oldThreadId)) active.add(newThreadId);
}

function pushEntry(threadId: string, entry: GoalEvidenceEntry): void {
  const list = ledgers.get(threadId) ?? [];
  list.push(entry);
  if (list.length > MAX_GOAL_EVIDENCE_ENTRIES) {
    list.splice(0, list.length - MAX_GOAL_EVIDENCE_ENTRIES);
  }
  ledgers.set(threadId, list);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hashFile(path: string): string | undefined {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > MAX_HASH_BYTES) return undefined;
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

/** 写入后记账用异步版本：不阻塞工具结果链路；校验侧仍用同步版本（一次性） */
async function hashFileAsync(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_HASH_BYTES) return undefined;
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return undefined;
  }
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/gu, " ");
}

function resolveInsideWorkspace(cwd: string, target: string): string | undefined {
  const abs = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
  const rel = relative(cwd, abs);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return abs;
  return undefined;
}

/**
 * afterToolCall 钩子：记录一条工具结果。只在本线程有活跃目标时记录。
 *
 * 失败调用也记（isError=true）：它们能证明「试过但没成」，而且不能让模型用
 * 一次失败的命令冒充成功。目标工具自身不记——它们是对账动作，不是工作证据。
 */
export async function recordGoalToolResult(
  run: Pick<Running, "threadId" | "cwd">,
  context: AfterToolCallContext,
): Promise<void> {
  if (!active.has(run.threadId)) return;
  const toolName = context.toolCall.name;
  if (!toolName || isGoalToolName(toolName)) return;
  const args =
    context.args && typeof context.args === "object" && !Array.isArray(context.args)
      ? (context.args as Record<string, unknown>)
      : {};
  const command =
    toolName === "bash" ? stringArg(args, "command") : undefined;
  const path = stringArg(args, "file_path") ?? stringArg(args, "path");
  const details = context.result?.details;
  const exitCode =
    details && typeof details === "object"
      ? numberOrUndefined((details as Record<string, unknown>).exitCode)
      : undefined;
  const contentHash =
    !context.isError && (toolName === "write" || toolName === "edit") && path
      ? await hashFileAsync(resolve(run.cwd, path))
      : undefined;
  pushEntry(run.threadId, {
    toolCallId: context.toolCall.id,
    toolName,
    at: Date.now(),
    isError: context.isError,
    ...(command ? { command } : {}),
    ...(path ? { path } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(contentHash ? { contentHash } : {}),
  });
}

/* --------------------------- 重启回放 --------------------------- */

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

type ReplayCall = { name: string; args: Record<string, unknown> };

/**
 * 从会话 JSONL 回放目标证据。
 *
 * 两遍扫描：先建 toolCallId → (name,args)，再把 goal.startedSeq/startedAt 之后的
 * toolResult 行折成台账条目。撕裂行跳过；整体失败只记日志并留下空台账。
 */
export function restoreGoalEvidence(threadId: string, sessionId: string, goal: Goal): void {
  clearGoalEvidence(threadId);
  let lines: string[];
  try {
    const file = sessionPath(sessionId);
    if (!existsSync(file)) return;
    lines = readFileSync(file, "utf8").split("\n");
  } catch (err) {
    logErr("goal-evidence: read transcript failed:", err);
    return;
  }
  const calls = new Map<string, ReplayCall>();
  const rows: Array<{ seq: number; agent: Record<string, unknown> }> = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as {
        type?: unknown;
        seq?: unknown;
        agent?: unknown;
      };
      if (row.type !== "message" || !row.agent || typeof row.agent !== "object") continue;
      const seq = numberOrUndefined(row.seq) ?? 0;
      const agent = row.agent as Record<string, unknown>;
      rows.push({ seq, agent });
      if (agent.role !== "assistant" || !Array.isArray(agent.content)) continue;
      for (const block of agent.content) {
        const b = block as {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          arguments?: unknown;
        } | null;
        if (b?.type !== "toolCall" || typeof b.id !== "string" || typeof b.name !== "string") {
          continue;
        }
        const args =
          b.arguments && typeof b.arguments === "object" && !Array.isArray(b.arguments)
            ? (b.arguments as Record<string, unknown>)
            : {};
        calls.set(b.id, { name: b.name, args });
      }
    } catch {
      /* 撕裂行：跳过 */
    }
  }

  const startedSeq = goal.startedSeq;
  const startedAt = goal.startedAt;
  for (const { seq, agent } of rows) {
    if (startedSeq !== undefined && seq < startedSeq) continue;
    if (agent.role !== "toolResult") continue;
    if (startedSeq === undefined) {
      const at = parseTimestamp(agent.timestamp);
      if (at !== undefined && at < startedAt) continue;
    }
    const toolCallId = typeof agent.toolCallId === "string" ? agent.toolCallId : "";
    const toolName =
      typeof agent.toolName === "string" ? agent.toolName : calls.get(toolCallId)?.name;
    if (!toolCallId || !toolName) continue;
    const call = calls.get(toolCallId);
    const args = call?.args ?? {};
    const command = toolName === "bash" ? stringArg(args, "command") : undefined;
    const path = stringArg(args, "file_path") ?? stringArg(args, "path");
    const details = agent.details;
    const exitCode =
      details && typeof details === "object"
        ? numberOrUndefined((details as Record<string, unknown>).exitCode)
        : undefined;
    pushEntry(threadId, {
      toolCallId,
      toolName,
      at: parseTimestamp(agent.timestamp) ?? Date.now(),
      isError: agent.isError === true,
      ...(command ? { command } : {}),
      ...(path ? { path } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    });
  }
}

/* --------------------------- 引用校验 --------------------------- */

/** 宽松解析模型交来的 refs；非法项记进 errors，由调用方拒绝 */
export function normalizeEvidenceRefs(raw: unknown): {
  refs: GoalEvidenceRef[];
  errors: string[];
} {
  if (raw === undefined || raw === null) return { refs: [], errors: [] };
  if (!Array.isArray(raw)) {
    return { refs: [], errors: ["refs must be an array"] };
  }
  const refs: GoalEvidenceRef[] = [];
  const errors: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push("each ref must be an object");
      continue;
    }
    const r = entry as Record<string, unknown>;
    if (r.kind === "command" && typeof r.command === "string" && r.command.trim()) {
      refs.push({ kind: "command", command: r.command.trim(), expect: "success" });
    } else if (
      r.kind === "file" &&
      typeof r.path === "string" &&
      r.path.trim() &&
      (r.expect === undefined || r.expect === "exists" || r.expect === "modified")
    ) {
      refs.push({
        kind: "file",
        path: r.path.trim(),
        expect: r.expect === "modified" ? "modified" : "exists",
      });
    } else if (r.kind === "tool" && typeof r.tool === "string" && r.tool.trim()) {
      refs.push({
        kind: "tool",
        tool: r.tool.trim(),
        ...(typeof r.path === "string" && r.path.trim() ? { path: r.path.trim() } : {}),
      });
    } else if (r.kind === "manual" && typeof r.note === "string" && r.note.trim()) {
      refs.push({ kind: "manual", note: r.note.trim() });
    } else {
      errors.push(
        'invalid ref: expected {kind:"command"|"file"|"tool"|"manual", ...}',
      );
    }
    if (refs.length >= MAX_REFS_PER_CRITERION) break;
  }
  return { refs, errors };
}

function verifyOne(
  threadId: string,
  cwd: string,
  ref: GoalEvidenceRef,
): EvidenceRefResult {
  const entries = ledgers.get(threadId) ?? [];
  if (ref.kind === "manual") {
    return {
      ref,
      ok: true,
      manual: true,
      detail: ref.note,
    };
  }
  if (ref.kind === "command") {
    const wanted = normalizeCommand(ref.command);
    const match = entries.find(
      (e) =>
        e.toolName === "bash" &&
        e.command !== undefined &&
        !e.isError &&
        (e.exitCode === undefined || e.exitCode === 0) &&
        normalizeCommand(e.command) === wanted,
    );
    if (match) {
      return { ref, ok: true, detail: `recorded successful command at ${new Date(match.at).toISOString()}` };
    }
    const recorded = [...new Set(entries.filter((e) => e.command).map((e) => e.command!))]
      .slice(-5)
      .map((c) => `"${c}"`);
    return {
      ref,
      ok: false,
      error:
        `no successful run of "${ref.command}" was recorded during this goal` +
        (recorded.length ? `; recorded commands: ${recorded.join(", ")}` : ""),
    };
  }
  if (ref.kind === "tool") {
    const wantedPath =
      ref.path === undefined ? undefined : resolveInsideWorkspace(cwd, ref.path);
    if (ref.path !== undefined && !wantedPath) {
      return { ref, ok: false, error: `tool path escapes the workspace: ${ref.path}` };
    }
    const match = entries.find(
      (e) =>
        !e.isError &&
        e.toolName === ref.tool &&
        (wantedPath === undefined ||
          (e.path !== undefined && resolveInsideWorkspace(cwd, e.path) === wantedPath)),
    );
    return match
      ? { ref, ok: true, detail: `recorded successful ${ref.tool} call` }
      : { ref, ok: false, error: `no successful ${ref.tool} call was recorded during this goal` };
  }
  // file
  const abs = resolveInsideWorkspace(cwd, ref.path);
  if (!abs) {
    return { ref, ok: false, error: `file path escapes the workspace: ${ref.path}` };
  }
  if (!existsSync(abs)) {
    return { ref, ok: false, error: `file does not exist: ${ref.path}` };
  }
  if (ref.expect !== "modified") {
    return { ref, ok: true, detail: "file exists" };
  }
  const write = [...entries]
    .reverse()
    .find(
      (e) =>
        !e.isError &&
        (e.toolName === "write" || e.toolName === "edit") &&
        e.path !== undefined &&
        resolveInsideWorkspace(cwd, e.path) === abs,
    );
  if (!write) {
    return {
      ref,
      ok: false,
      error: `no successful write/edit to ${ref.path} was recorded during this goal`,
    };
  }
  if (write.contentHash) {
    const current = hashFile(abs);
    if (current && current !== write.contentHash) {
      return {
        ref,
        ok: false,
        error: `file content no longer matches the recorded write: ${ref.path}`,
      };
    }
    return { ref, ok: true, detail: "file content matches the recorded write" };
  }
  try {
    const stat = statSync(abs);
    if (stat.mtimeMs >= write.at - 5_000) {
      return { ref, ok: true, detail: "file modified after the recorded write" };
    }
  } catch {
    /* 上面 existsSync 已通过，这里失败按不通过处理 */
  }
  return {
    ref,
    ok: false,
    error: `file does not look modified after the recorded write: ${ref.path}`,
  };
}

/**
 * 校验一组 refs。`ok` 只表示「没有失败项」；是否要求至少一条机器证据由调用方
 * 聚合（见 goal_complete 的 all-manual 拒绝）。
 */
export function verifyEvidenceRefs(
  threadId: string,
  cwd: string,
  refs: readonly GoalEvidenceRef[],
): EvidenceVerification {
  const results = refs.map((ref) => verifyOne(threadId, cwd, ref));
  const errors = results.filter((r) => !r.ok).map((r) => r.error ?? "evidence check failed");
  return {
    ok: errors.length === 0,
    results,
    verifiedCount: results.filter((r) => r.ok && !r.manual).length,
    manualCount: results.filter((r) => r.manual).length,
    errors,
  };
}
