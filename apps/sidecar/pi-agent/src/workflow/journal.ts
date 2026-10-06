/**
 * 工作流运行记录的落盘(设计文档 §4.2/§4.6):
 * - `<cwd>/.kova/workflows/<runId>.json`:全量快照(含各步结果)——runner 的
 *   journal 事实源。整字段替换、最后胜出(queue-v2 语义),原子写(临时文件 +
 *   rename)。崩溃/重启后 resume 据此重算指纹:done 且指纹一致的步骤免费回放。
 * - 转录 workflow_state 行(瘦身投影,无结果文本)由 transcript.ts 落,是
 *   get_workflow_state 的水合源——与 goal_state 行同一条通路。
 *
 * 与 delegation 活动文件同族:放工作区 .kova 下,与 .kova/plans、.kova/subagents
 * 同一目录约定。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isWorkflowRun,
  type WorkflowRun,
} from "./plan-state";

/** 终态运行记录的保留上限(最旧先弃;非终态永不弃) */
const MAX_RETAINED_RUN_FILES = 50;

function workflowsDir(cwd: string): string {
  return join(cwd, ".kova", "workflows");
}

function runFilePath(cwd: string, runId: string): string {
  // runId 由 sidecar 生成(wf-<ts36>-<uuid8>),这里再挡一层路径注入
  const safe = runId.replace(/[^A-Za-z0-9_-]/g, "");
  return join(workflowsDir(cwd), `${safe || "run"}.json`);
}

/** 原子写:临时文件 + rename,避免进程死在半写时留下撕裂 JSON */
export function writeRunFile(cwd: string, run: WorkflowRun): void {
  try {
    const dir = workflowsDir(cwd);
    mkdirSync(dir, { recursive: true });
    const file = runFilePath(cwd, run.id);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(run), "utf8");
    renameSync(tmp, file);
  } catch (err) {
    // 落盘失败不阻断运行:内存里的事实还在,下一次步骤结算会再写一遍。
    // 与 commitGoal 的「落盘失败不阻断」同一取舍
    logRunFileError("write", err);
  }
}

/** 读回完整运行记录(恢复/resume 用)。畸形文件按不存在处理,不抛。 */
export function readRunFile(cwd: string, runId: string): WorkflowRun | undefined {
  try {
    const file = runFilePath(cwd, runId);
    if (!existsSync(file)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isWorkflowRun(parsed) ? parsed : undefined;
  } catch (err) {
    logRunFileError("read", err);
    return undefined;
  }
}

/**
 * 目录级清理:终态且超出保留上限的最旧记录先删。正在跑/暂停的记录由调用方的
 * isActive 判定保护(delegation 的 pruneActivityFiles 同款形状)。
 */
export function pruneRunFiles(cwd: string, isActive: (runId: string) => boolean): void {
  try {
    const dir = workflowsDir(cwd);
    if (!existsSync(dir)) return;
    type Entry = { runId: string; file: string; endedAt: number; terminal: boolean };
    const entries: Entry[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
      const file = join(dir, name);
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (!isWorkflowRun(parsed)) continue;
        const terminal = parsed.status === "complete" || parsed.status === "failed";
        entries.push({ runId: parsed.id, file, endedAt: parsed.updatedAt, terminal });
      } catch {
        /* 撕裂文件:留着,下次写同名 runId 时会被原子写覆盖 */
      }
    }
    const terminalSorted = entries
      .filter((e) => e.terminal && !isActive(e.runId))
      .sort((a, b) => a.endedAt - b.endedAt);
    const excess = terminalSorted.length - MAX_RETAINED_RUN_FILES;
    for (const entry of terminalSorted.slice(0, Math.max(0, excess))) {
      try {
        unlinkSync(entry.file);
      } catch {
        /* 单个删不掉(被占用等)不影响其余清理 */
      }
    }
  } catch (err) {
    logRunFileError("prune", err);
  }
}

function logRunFileError(op: string, err: unknown): void {
  // 延迟 import 会造成循环;用 console 走 sidecar 的日志兜底即可(log.ts 的
  // logErr 也只是包装 console + 文件)。落盘层不该把调用方拖进日志依赖
  console.warn(`[workflow] run file ${op} failed:`, err instanceof Error ? err.message : String(err));
}
