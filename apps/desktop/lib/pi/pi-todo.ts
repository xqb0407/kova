"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi/pi-bridge";
import { piSessionRegistry } from "@/lib/pi/pi-thread-adapter";

/**
 * 任务清单 store（sidecar todo 工具的 per-thread 快照镜像，形态同 pi-session-mode）：
 * - 事实源在 sidecar（todo.ts 的 per-thread 槽，事件溯源回放恢复）
 * - prompt 流里的 data-todo chunk 经 pi-transport 拦截进来（不进消息流）
 * - 切线程/刷新用 get_todo_state 水合；面板渲染在 components/agent-thread/agent-panel
 */
export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";

export type TodoTask = {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: TodoStatus;
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
};

export type TodoSnapshot = { tasks: TodoTask[]; nextId: number };

const EMPTY_SNAPSHOT: TodoSnapshot = { tasks: [], nextId: 1 };

const snapshots = new Map<string, TodoSnapshot>();
const listeners = new Set<() => void>();
/** 水合请求去重（同线程在途只留一个） */
const inflight = new Set<string>();
/** 用户手动关闭过面板的线程：data-todo 实时活动会重新打开（水合不算活动） */
const dismissed = new Set<string>();

function notify() {
  for (const l of listeners) l();
}

function setSnapshot(threadId: string, snap: TodoSnapshot) {
  snapshots.set(threadId, snap);
  notify();
}

function validTask(raw: unknown): raw is TodoTask {
  const t = raw as Partial<TodoTask>;
  return (
    typeof t?.id === "number" &&
    typeof t.subject === "string" &&
    (t.status === "pending" ||
      t.status === "in_progress" ||
      t.status === "completed" ||
      t.status === "deleted")
  );
}

function applyTodoSnapshot(
  threadId: string,
  data: unknown,
  reopen: boolean,
): void {
  if (!data || typeof data !== "object") return;
  const d = data as Partial<TodoSnapshot>;
  if (!Array.isArray(d.tasks)) return;
  if (typeof d.nextId !== "number" || !Number.isFinite(d.nextId)) return;
  if (reopen && dismissed.delete(threadId)) notify();
  setSnapshot(threadId, {
    tasks: d.tasks.filter(validTask),
    nextId: d.nextId,
  });
}

/** 消费 prompt 流里的 data-todo chunk（pi-transport 调用）：AI 活动会重新打开面板 */
export function applyTodoChunk(threadId: string, data: unknown): void {
  applyTodoSnapshot(threadId, data, true);
}

/** 订阅当前线程的任务清单快照 */
export function useThreadTodos(threadId: string | undefined): TodoSnapshot {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (threadId ? (snapshots.get(threadId) ?? EMPTY_SNAPSHOT) : EMPTY_SNAPSHOT),
    () => EMPTY_SNAPSHOT,
  );
}

/** 线程切换/重进时向 sidecar 取水合快照（失败静默：面板只是没有清单）。
 *  水合不算 AI 活动：用户关过的面板回到该线程时保持关闭。 */
export function fetchTodoState(threadId: string): void {
  if (inflight.has(threadId)) return;
  inflight.add(threadId);
  const sessionId = piSessionRegistry.get(threadId);
  piRequest<{ type: "todo_state"; tasks: unknown[]; nextId: number }>({
    type: "get_todo_state",
    threadId,
    ...(sessionId ? { sessionId } : {}),
  })
    .then((res) => {
      applyTodoSnapshot(threadId, { tasks: res.tasks, nextId: res.nextId }, false);
    })
    .catch(() => {})
    .finally(() => inflight.delete(threadId));
}

/* ------------------------- 手动开合（临时视图态） ------------------------- */

/** 用户关闭面板：清单仍在，只是收敛成药丸 */
export function dismissTodos(threadId: string): void {
  dismissed.add(threadId);
  notify();
}

/** 用户点药丸重新展开 */
export function reopenTodos(threadId: string): void {
  if (dismissed.delete(threadId)) notify();
}

/** 订阅当前线程面板是否被手动关闭 */
export function useTodosDismissed(threadId: string | undefined): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (threadId ? dismissed.has(threadId) : false),
    () => false,
  );
}
