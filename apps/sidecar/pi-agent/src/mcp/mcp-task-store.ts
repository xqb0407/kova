/**
 * MCP Tasks 元数据台账（M2.1）：跨 turn 的长任务记账。
 *
 * 事实源是服务器的 task 状态（getTask 轮询）；这里只记「我们发起过哪些 task、
 * 归属哪次调用」，让 turn 结束后模型还能用 task_status / task_result 找回结果，
 * Inbox 也能标注 stale。落盘 <sessionsDir>/mcp-tasks.json（PI_MCP_TASKS_PATH
 * 可覆盖，测试用）：单文件原子写，条目数有上限。
 *
 * 设计边界：
 * - 不在本地实现任务队列——task 的执行/进度/取消全是服务器侧行为；
 * - 进度走 data-mcpTask chunk 直播，重启后不回放进度（只剩终态）；
 * - 服务器不声明 tasks 能力时整个模块不参与分流。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { logErr } from "../log";

export type McpTaskRecord = {
  /** 服务器返回的 taskId（按服务器内唯一；本地键 = server + taskId） */
  taskId: string;
  server: string;
  tool: string;
  threadId: string;
  sessionId?: string;
  /** 发起时间（毫秒） */
  createdAt: number;
  /** 最近一次已知状态（working/input_required/completed/failed/cancelled） */
  status: string;
  statusMessage?: string;
  /** 服务器声明的保留期（毫秒；null = 未声明） */
  ttl: number | null;
  /** 已把结果回传给模型/用户（Inbox 据此不再挂待处理） */
  settled?: boolean;
};

const MAX_RECORDS = 200;

export function mcpTasksPath(): string {
  if (process.env.PI_MCP_TASKS_PATH) return process.env.PI_MCP_TASKS_PATH;
  const root = process.env.PI_SESSIONS_DIR;
  return join(root || join(homedir(), ".kova"), "mcp-tasks.json");
}

let records = new Map<string, McpTaskRecord>();
let loaded = false;

const keyOf = (server: string, taskId: string): string => `${server}\u0000${taskId}`;

function loadOnce(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!existsSync(mcpTasksPath())) return;
    const parsed = JSON.parse(readFileSync(mcpTasksPath(), "utf8")) as {
      version?: unknown;
      tasks?: unknown;
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) return;
    for (const raw of parsed.tasks) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Partial<McpTaskRecord>;
      if (
        typeof r.taskId !== "string" ||
        typeof r.server !== "string" ||
        typeof r.tool !== "string" ||
        typeof r.threadId !== "string" ||
        typeof r.createdAt !== "number" ||
        typeof r.status !== "string"
      ) {
        continue;
      }
      records.set(keyOf(r.server, r.taskId), {
        taskId: r.taskId,
        server: r.server,
        tool: r.tool,
        threadId: r.threadId,
        ...(typeof r.sessionId === "string" ? { sessionId: r.sessionId } : {}),
        createdAt: r.createdAt,
        status: r.status,
        ...(typeof r.statusMessage === "string" ? { statusMessage: r.statusMessage } : {}),
        ttl: r.ttl === null || typeof r.ttl === "number" ? r.ttl : null,
        ...(r.settled === true ? { settled: true } : {}),
      });
    }
  } catch (err) {
    logErr("mcp-tasks: load failed:", err instanceof Error ? err.message : String(err));
  }
}

function persist(): void {
  try {
    const path = mcpTasksPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ version: 1, tasks: [...records.values()] }),
      "utf8",
    );
  } catch (err) {
    logErr("mcp-tasks: persist failed:", err instanceof Error ? err.message : String(err));
  }
}

/** 记录/更新一条任务（握手后 callToolStream taskCreated 时落首条） */
export function upsertMcpTask(record: McpTaskRecord): void {
  loadOnce();
  records.set(keyOf(record.server, record.taskId), { ...record });
  // 超限裁最老：记账不是审计，量级有界即可
  if (records.size > MAX_RECORDS) {
    const sorted = [...records.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const doomed of sorted.slice(0, records.size - MAX_RECORDS)) {
      records.delete(keyOf(doomed.server, doomed.taskId));
    }
  }
  persist();
}

export function getMcpTask(server: string, taskId: string): McpTaskRecord | undefined {
  loadOnce();
  return records.get(keyOf(server, taskId));
}

/** 按 threadId 找未结算任务（Stop 清理 / Inbox 列表用） */
export function listMcpTasksForThread(threadId: string): McpTaskRecord[] {
  loadOnce();
  return [...records.values()]
    .filter((r) => r.threadId === threadId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function updateMcpTaskStatus(
  server: string,
  taskId: string,
  status: string,
  statusMessage?: string,
): McpTaskRecord | undefined {
  loadOnce();
  const key = keyOf(server, taskId);
  const record = records.get(key);
  if (!record) return undefined;
  // 已结算（含 cancelled）条目是终态：迟到的进度/轮询不回写。否则 settle 后
  // 一次无 statusMessage 的轮询会把终态状态/消息抹掉（statusMessage 在
  // undefined 时是 delete 语义，不是"不修改"）。
  if (record.settled || record.status === "cancelled") return record;
  record.status = status;
  if (statusMessage !== undefined) record.statusMessage = statusMessage.slice(0, 200);
  else if (record.statusMessage !== undefined) record.statusMessage = undefined;
  persist();
  return record;
}

export function settleMcpTask(server: string, taskId: string): McpTaskRecord | undefined {
  const record = updateMcpTaskStatus(server, taskId, "settled");
  if (record) record.settled = true;
  loadOnce();
  persist();
  return record;
}

/** 服务器已声明该 task 过期（ttl 已过或 getTask 404）：从台账摘除 */
export function dropMcpTask(server: string, taskId: string): boolean {
  loadOnce();
  const key = keyOf(server, taskId);
  if (!records.has(key)) return false;
  records.delete(key);
  persist();
  return true;
}

/** 测试钩子：清内存态（文件由测试自管） */
export function resetMcpTasksForTest(): void {
  records = new Map();
  loaded = false;
}
