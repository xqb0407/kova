/**
 * todo 工具注册层（移植 rpiv-todo 的 todo.ts 外壳，形态仿 question-tools.ts）：
 * - per-thread 状态槽（对应 rpiv 的 per-session slot；会话隔离天然由 threadId 成立）
 * - execute 提交快照后经 sendEventChunk 推 data-todo chunk，实时刷新 composer
 *   上方 TodoPanel；无活跃请求时静默丢弃（面板靠 get_todo_state 水合兜底）
 * - replayTodoFromMessages：重启/压缩后从转录的 todo toolResult.details 里
 *   回放最后一个全量快照（事件溯源，零额外落盘）
 * 工具语义/校验/envelope 全部在 todo-state.ts。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { sendEventChunk } from "./stream";
import {
  applyTaskMutation,
  buildTodoResult,
  EMPTY_TODO_STATE,
  TODO_TOOL_NAME,
  TodoParamsSchema,
  type Task,
  type TaskAction,
  type TaskMutationParams,
  type TaskState,
} from "./todo-state";

/** threadId -> 当前任务清单（rpiv store.ts 的 per-session slot 等价物） */
const todoStates = new Map<string, TaskState>();

export function getTodoState(threadId: string): TaskState {
  return todoStates.get(threadId) ?? EMPTY_TODO_STATE;
}

/** 会话删除/线程销毁时回收槽位 */
export function clearTodoState(threadId: string): void {
  todoStates.delete(threadId);
}

/** 快照卫生：形状坏掉的任务条目过滤掉（历史 JSONL 行可能被撕裂） */
function sanitizeTasks(raw: unknown): Task[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Task[] = [];
  for (const item of raw) {
    const t = item as Partial<Task>;
    if (
      typeof t?.id === "number" &&
      typeof t.subject === "string" &&
      (t.status === "pending" ||
        t.status === "in_progress" ||
        t.status === "completed" ||
        t.status === "deleted")
    ) {
      out.push(t as Task);
    }
  }
  return out;
}

/**
 * 回放恢复（resolveSession 恢复分支调用）：扫消息里 todo 的 toolResult，
 * 取最后一个合法 details 快照回填槽位。找不到快照就保持空清单——
 * 与 rpiv 一致：宁可不显示，不造出来。
 */
export function replayTodoFromMessages(
  threadId: string,
  messages: readonly unknown[],
): void {
  let restored: TaskState | undefined;
  for (const m of messages) {
    const msg = m as {
      role?: string;
      toolName?: string;
      details?: { tasks?: unknown; nextId?: unknown };
    };
    if (msg?.role !== "toolResult" || msg.toolName !== TODO_TOOL_NAME)
      continue;
    const tasks = sanitizeTasks(msg.details?.tasks);
    const nextId = msg.details?.nextId;
    if (tasks && typeof nextId === "number" && Number.isFinite(nextId))
      restored = { tasks, nextId };
  }
  if (restored) todoStates.set(threadId, restored);
}

/** 回给模型的工具说明（rpiv description 原文，指导段进系统提示词） */
const TODO_DESCRIPTION =
  "Manage a task list for tracking multi-step progress. Actions: create " +
  "(new task), update (change status/fields/dependencies), list (all " +
  "tasks, optionally filtered by status), get (single task details), " +
  "delete (tombstone), clear (reset all). Status: pending -> in_progress " +
  "-> completed, plus deleted tombstone. Use this to plan and track " +
  "multi-step work like research, design, and implementation.";

/**
 * todo 工具（agent 模式工具目录挂载，见 tools.ts / modes.ts）。
 * 返回 {content, details}：details 即全量快照，transcript 落盘后供回放。
 */
export function buildTodoTool(threadId: string): AgentTool {
  return {
    name: TODO_TOOL_NAME,
    label: "Todo",
    description: TODO_DESCRIPTION,
    parameters: TodoParamsSchema,
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ) {
      const p = params as TaskMutationParams & { action: TaskAction };
      const current = todoStates.get(threadId) ?? EMPTY_TODO_STATE;
      const result = applyTaskMutation(current, p.action, p);
      todoStates.set(threadId, result.state);
      // 面板实时刷新（无活跃 prompt 请求时 sendEventChunk 自行丢弃，
      // 下次水合走 get_todo_state）
      sendEventChunk(threadId, {
        type: "data-todo",
        data: { tasks: result.state.tasks, nextId: result.state.nextId },
      });
      return buildTodoResult(p.action, p, result.state, result.op);
    },
  } as unknown as AgentTool;
}
