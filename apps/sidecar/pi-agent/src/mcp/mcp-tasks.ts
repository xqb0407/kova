/**
 * MCP Tasks adapter（M2.1）：SDK `client.experimental.tasks` 的唯一入口。
 *
 * experimental API 可能随 SDK 升级变化——本文件之外不许 import 该模块。分流
 * 决策在 mcp-tools.executeCall：`taskSupport === "required"` 必走 task；
 * "optional" 只在服务器声明了 tasks 能力且工具被标记为长任务（描述含提示或
 * 调用方显式要求）时走；缺省 = 普通 call。
 *
 * 生命周期：
 * - callToolStream 消费 taskCreated/taskStatus/result/error，进度经回调上抛；
 * - 调用方拿到最终 CallToolResult（与普通 call 同形），或 turn 结束任务仍在跑
 *   时的「pending」信封（taskId + tool，模型下一轮用 task_status/task_result 查）；
 * - cancelTask 由 Stop（AbortSignal）与 inbox/协议命令共用。
 */
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Task } from "@modelcontextprotocol/sdk/types.js";
import type { McpToolMeta } from "./mcp-cache";
import {
  dropMcpTask,
  getMcpTask,
  listMcpTasksForThread,
  settleMcpTask,
  upsertMcpTask,
  updateMcpTaskStatus,
  type McpTaskRecord,
} from "./mcp-task-store";
import { recordMcpAudit } from "./mcp-audit";
import { logErr } from "../log";

export type McpTaskProgress = (task: Task) => void;

export type McpTaskOutcome =
  | { kind: "result"; result: unknown }
  /** turn 结束任务仍在跑：模型拿 taskId 下轮查询 */
  | { kind: "pending"; taskId: string; record: McpTaskRecord }
  | { kind: "error"; message: string };

/** 该工具是否应该走 task 调用（分流决策单点） */
export function shouldUseTask(
  tool: McpToolMeta,
  capabilities: { tasks?: boolean },
): boolean {
  if (tool.taskSupport !== "required" && tool.taskSupport !== "optional") return false;
  return capabilities.tasks === true;
}

/**
 * 以 task 形态调用工具。必须 already-connected（entry.client 由 manager 传入）。
 * ttl/pollInterval 交由服务器声明；进度每条都上抛（调用方节流）。
 */
export async function callToolViaTask(args: {
  client: Client;
  server: string;
  tool: string;
  toolArgs: Record<string, unknown>;
  threadId: string;
  sessionId?: string;
  signal?: AbortSignal;
  onProgress?: McpTaskProgress;
}): Promise<McpTaskOutcome> {
  const { client, server, tool, toolArgs, threadId, signal, onProgress } = args;
  try {
    const stream = client.experimental.tasks.callToolStream(
      { name: tool, arguments: toolArgs },
      CallToolResultSchema,
      { signal },
    );
    for await (const message of stream) {
      switch (message.type) {
        case "taskCreated": {
          recordMcpAudit({
            at: Date.now(),
            server,
            kind: "task_start",
            ok: true,
            detail: `${tool} → ${message.task.taskId}`,
          });
          upsertMcpTask({
            taskId: message.task.taskId,
            server,
            tool,
            threadId,
            ...(args.sessionId ? { sessionId: args.sessionId } : {}),
            createdAt: Date.now(),
            status: message.task.status,
            ...(message.task.statusMessage
              ? { statusMessage: message.task.statusMessage }
              : {}),
            ttl: message.task.ttl ?? null,
          });
          onProgress?.(message.task);
          break;
        }
        case "taskStatus": {
          const record = updateMcpTaskStatus(
            server,
            message.task.taskId,
            message.task.status,
            message.task.statusMessage,
          );
          onProgress?.(message.task);
          // 服务器取消/失败且流提前结束：这里只记账，终态由 result/error 分支结算
          if (record && message.task.status === "cancelled") {
            recordMcpAudit({
              at: Date.now(),
              server,
              kind: "task_cancel",
              ok: true,
              detail: message.task.taskId,
            });
          }
          break;
        }
        case "result": {
          // 两种返回形态：
          // a) 最终 CallToolResult（无 task 字段）——任务已同步完成；
          // b) CreateTaskResult 包装（task 字段）——服务器先交任务句柄：
          //    未完成 → pending 信封；已完成 → 立即经 tasks/result 取回真实结果。
          const result = message.result as {
            task?: { taskId?: string; status?: string; statusMessage?: string; ttl?: number | null };
            content?: unknown;
          };
          const embedded = result.task;
          if (embedded?.taskId) {
            upsertMcpTask({
              taskId: embedded.taskId,
              server,
              tool,
              threadId,
              ...(args.sessionId ? { sessionId: args.sessionId } : {}),
              createdAt: Date.now(),
              status: embedded.status ?? "working",
              ...(embedded.statusMessage ? { statusMessage: embedded.statusMessage } : {}),
              ttl: embedded.ttl ?? null,
            });
            recordMcpAudit({
              at: Date.now(),
              server,
              kind: "task_start",
              ok: true,
              detail: `${tool} → ${embedded.taskId}`,
            });
            if (embedded.status && embedded.status !== "completed") {
              const pendingRecord = getMcpTask(server, embedded.taskId) ?? {
                taskId: embedded.taskId,
                server,
                tool,
                threadId,
                ...(args.sessionId ? { sessionId: args.sessionId } : {}),
                createdAt: Date.now(),
                status: embedded.status,
                ...(embedded.statusMessage ? { statusMessage: embedded.statusMessage } : {}),
                ttl: embedded.ttl ?? null,
              };
              return { kind: "pending", taskId: embedded.taskId, record: pendingRecord };
            }
            // 已完成包装：content 通常为空，真实结果经 tasks/result 取回
            const fetched = await client.experimental.tasks.getTaskResult(
              embedded.taskId,
              CallToolResultSchema,
              { signal },
            );
            settleMcpTask(server, embedded.taskId);
            recordMcpAudit({
              at: Date.now(),
              server,
              kind: "task_done",
              ok: true,
              detail: embedded.taskId,
            });
            return { kind: "result", result: fetched };
          }
          const taskId = currentTaskId(server, tool, threadId);
          if (taskId) {
            settleMcpTask(server, taskId);
            recordMcpAudit({
              at: Date.now(),
              server,
              kind: "task_done",
              ok: true,
              detail: taskId,
            });
          }
          return { kind: "result", result: message.result };
        }
        case "error": {
          const taskId = currentTaskId(server, tool, threadId);
          if (taskId) settleMcpTask(server, taskId);
          return {
            kind: "error",
            message: message.error.message || "MCP task failed",
          };
        }
      }
    }
    // 流正常关闭但没有 result/error：任务仍在服务器侧跑（call-now/fetch-later）。
    const taskId = currentTaskId(server, tool, threadId);
    if (!taskId) {
      return { kind: "error", message: "MCP task stream ended without a task id" };
    }
    const record = getMcpTask(server, taskId);
    if (!record) {
      return { kind: "error", message: "MCP task record missing after stream end" };
    }
    return { kind: "pending", taskId, record };
  } catch (err) {
    if (signal?.aborted) {
      return { kind: "error", message: "MCP task aborted by stop request" };
    }
    const message = err instanceof Error ? err.message : String(err);
    logErr(`mcp task ${server}/${tool}:`, message);
    return { kind: "error", message };
  }
}

/** 该 thread 最近一次为该工具发起的 task id（同 server+tool+thread 维度） */
function currentTaskId(
  server: string,
  tool: string,
  threadId: string,
): string | undefined {
  // taskCreated 分支已 upsert；这里从台账里找最近一条匹配记录。
  // 直接扫内存台账（≤200 条），不值得维护额外的索引。
  const hit = listMcpTasksForThread(threadId).find(
    (r) => r.server === server && r.tool === tool,
  );
  return hit?.taskId;
}

/** 查询任务状态（mcp_task_status 协议命令与网关 task_status action 共用） */
export async function getTaskStatus(args: {
  client: Client;
  server: string;
  taskId: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; task: Task } | { ok: false; message: string }> {
  try {
    const task = await args.client.experimental.tasks.getTask(args.taskId, {
      signal: args.signal,
    });
    updateMcpTaskStatus(args.server, args.taskId, task.status, task.statusMessage);
    return { ok: true, task };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 404/过期：从台账摘除，Inbox 标 stale
    if (/not found|expired|unknown task/i.test(message)) {
      dropTask(args.server, args.taskId);
    }
    return { ok: false, message };
  }
}

/** 取结果（任务完成后）；失败信息原样回传 */
export async function getTaskResult(args: {
  client: Client;
  server: string;
  taskId: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; result: unknown } | { ok: false; message: string }> {
  try {
    const result = await args.client.experimental.tasks.getTaskResult(
      args.taskId,
      CallToolResultSchema,
      { signal: args.signal },
    );
    settleMcpTask(args.server, args.taskId);
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found|expired|unknown task/i.test(message)) {
      dropTask(args.server, args.taskId);
    }
    return { ok: false, message };
  }
}

/** 取消任务：协议命令与 Stop 兜底共用 */
export async function cancelTask(args: {
  client: Client;
  server: string;
  taskId: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; message?: string }> {
  try {
    await args.client.experimental.tasks.cancelTask(args.taskId, {
      signal: args.signal,
    });
    settleMcpTask(args.server, args.taskId);
    recordMcpAudit({
      at: Date.now(),
      server: args.server,
      kind: "task_cancel",
      ok: true,
      detail: args.taskId,
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found|expired|unknown task/i.test(message)) {
      dropTask(args.server, args.taskId);
      return { ok: true };
    }
    return { ok: false, message };
  }
}

function dropTask(server: string, taskId: string): void {
  dropMcpTask(server, taskId);
}

/**
 * Stop / 新 prompt 的兜底清理：该 thread 的未结算 task 全部向服务器发取消。
 * 连接走 mcpManager 单例（懒连接；服务器不可达/任务已过期时静默放弃，
 * 台账条目保留，等 TTL 或下次查询收敛）。fire-and-forget——Stop 路径
 * 绝不因网络等待而变慢。经动态 import 避免与 manager 的模块环。
 */
export function cancelPendingMcpTasks(threadId: string): void {
  const records = listMcpTasksForThread(threadId).filter(
    (r) => !r.settled && r.status !== "cancelled",
  );
  if (records.length === 0) return;
  void (async () => {
    const [{ mcpManager }, { loadMcpServers }] = await Promise.all([
      import("./mcp-manager"),
      import("./mcp-config"),
    ]);
    for (const record of records) {
      try {
        const { defs } = await loadMcpServers();
        const def = defs.find((d) => d.name === record.server);
        if (!def) continue;
        await mcpManager.taskCancel(def, record.taskId).catch(() => {});
      } catch {
        /* 服务器不可达：静默放弃 */
      }
    }
  })();
}
