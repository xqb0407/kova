/**
 * 恢复日志（recovery journal）：sidecar 执行工具前把意图原子落盘，成功/失败
 * 后结行。进程崩溃 = 结行缺席；重启后 restore 链扫描未结尾行，把「上次执行
 * 被中断、可否安全重试」的确定信息带给 repairDanglingToolCalls 的文案分流。
 *
 * 定位是尽力而为的旁路（与 observeBgToolResult 同级）：任何写失败都不影响
 * 工具结果。崩溃语义就是「settle 缺席」——不需要真杀进程即可测。
 *
 * 文件： <sessionsDir>/recovery/<threadId>.jsonl，append-only。
 * 全部 settled（无 running 尾行）时清空文件；无任何行时删除文件。
 */
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { sessionsDirRoot } from "../storage/storage";
import { logErr } from "../log";

export type RecoveryState = "running" | "done" | "error";

export interface RecoveryEntry {
  seq: number;
  toolCallId: string;
  name: string;
  state: RecoveryState;
  timestamp: number;
}

// biome-ignore: 空接口占位（保留行形状文档）
interface JournalLine extends RecoveryEntry {
  /** 半行 JSON（写一半崩溃）容错：read 时丢弃非法行 */
}

let seqCounter = 0;

function journalDir(): string | null {
  const root = sessionsDirRoot();
  // storage 未初始化（sessionsDirRoot 为空串）时跳过：静默降级为无 journal，
  // 绝不能把 recovery/ 写进 cwd 相对路径
  return root ? path.join(root, "recovery") : null;
}

function journalPath(threadId: string): string {
  // 调用方（writeLine/scan/cleanup）已判空 journalDir
  return path.join(journalDir() as string, `${threadId}.jsonl`);
}

/** 剥 threadId 里的路径分隔符：threadId 来自协议，不信任其文件名安全性 */
function safeName(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
}


/** 在飞写 promise 尾巴：测试 flush 用（生产代码 fire-and-forget，不等待） */
let pendingWrites: Promise<void> = Promise.resolve();

async function ensureDir(): Promise<void> {
  // 不做进程级缓存：initStorage 可在测试里换根目录，每次写前都建（mkdir
  // recursive 对已存在目录是 no-op，代价可忽略）。调用前 writeLine 已判空。
  await mkdir(journalDir() as string, { recursive: true });
}

function writeLine(threadId: string, line: JournalLine): void {
  const dir = journalDir();
  if (!dir) return; // storage 未初始化：无 journal（fail-open）
  pendingWrites = pendingWrites
    .then(() => ensureDir())
    .then(() =>
      appendFile(journalPath(safeName(threadId)), `${JSON.stringify(line)}\n`, { encoding: "utf8" }),
    )
    .catch((error) => {
      logErr("recovery-journal write failed (ignored):", error);
    });
}

/** 测试辅助：等全部在飞写落盘（fire-and-forget 的竞态在测试里必须可控） */
export async function journalFlushForTest(): Promise<void> {
  await pendingWrites;
}

/**
 * 追加一行（fire-and-forget：任何失败只记日志，绝不影响工具结果）。
 * seq 进程内单调；跨进程（崩溃重启）靠 toolCallId 最新状态判定，不依赖 seq。
 */
export function journalToolStart(threadId: string, toolCallId: string, name: string): void {
  seqCounter += 1;
  writeLine(threadId, {
    seq: seqCounter,
    toolCallId,
    name,
    state: "running",
    timestamp: Date.now(),
  });
}

/** 结行：done（成功，含后台任务注册）或 error（抛错/取消/沙箱拒绝/预检拒绝） */
export function journalToolEnd(
  threadId: string,
  toolCallId: string,
  state: Extract<RecoveryState, "done" | "error">,
  name = "",
): void {
  seqCounter += 1;
  writeLine(threadId, {
    seq: seqCounter,
    toolCallId,
    name,
    state,
    timestamp: Date.now(),
  });
}

/**
 * 读一个 thread 的 journal，返回「最新状态为 running」的 toolCallId 集合。
 * 损坏行（半行 JSON）跳过；同 id 多行取文件序最后一行。恢复链在 repair 之前
 * 调用；文件不存在/不可读返回空集（fail-open）。
 */
export async function scanRunningToolCalls(threadId: string): Promise<ReadonlySet<string>> {
  if (!journalDir()) return new Set(); // storage 未初始化：无 journal
  let raw: string;
  try {
    raw = await readFile(journalPath(safeName(threadId)), "utf8");
  } catch {
    return new Set();
  }
  const lastState = new Map<string, RecoveryState>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as JournalLine;
      if (typeof entry.toolCallId === "string" && typeof entry.state === "string") {
        lastState.set(entry.toolCallId, entry.state);
      }
    } catch {
      /* 半行 JSON：写一半崩溃，跳过 */
    }
  }
  const running = new Set<string>();
  for (const [id, state] of lastState) {
    if (state === "running") running.add(id);
  }
  return running;
}

/**
 * 恢复消化：repair 已把文案补进转录后调用。清空已无 running 的文件；整个
 * journal 已无内容则删文件。失败只记日志（下轮 restore 再清一次也无害）。
 */
export async function cleanupRecovered(threadIds: readonly string[]): Promise<void> {
  for (const threadId of threadIds) {
    try {
      if (!journalDir()) continue; // storage 未初始化：无 journal 可清
      const remaining = await scanRunningToolCalls(threadId);
      if (remaining.size === 0) {
        await rm(journalPath(safeName(threadId)), { force: true });
      }
    } catch (error) {
      logErr("recovery-journal cleanup failed (ignored):", error);
    }
  }
}
