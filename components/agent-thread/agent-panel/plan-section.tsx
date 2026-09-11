"use client";

import { useEffect, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  TodoList,
  type TodoItem,
} from "@/components/custom-ui/todo-list";
import { fetchTodoState, useThreadTodos } from "@/lib/pi-todo";

/**
 * 计划区块:agent 任务清单(todo 工具快照驱动,data-todo chunk 实时更新 +
 * 切线程 get_todo_state 水合)。原 composer 上方 TodoPanel 的映射逻辑迁移至此:
 * in_progress 优先显示 activeForm;deleted 墓碑不展示;blockedBy 中未完成前置
 * 在右侧标 #id;空清单整块隐藏。composer 浮层的药丸/手动关闭态不再保留,
 * 面板折叠即隐藏入口。
 */
export const PlanSection: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const snap = useThreadTodos(threadId ?? undefined);

  useEffect(() => {
    if (threadId) fetchTodoState(threadId);
  }, [threadId]);

  const visible = snap.tasks.filter((t) => t.status !== "deleted");
  if (visible.length === 0) return null;

  const openIds = new Set(
    visible.filter((t) => t.status !== "completed").map((t) => t.id),
  );
  const items: TodoItem[] = visible.map((t) => {
    const blockers = (t.blockedBy ?? []).filter(
      (id) => id !== t.id && openIds.has(id),
    );
    return {
      id: String(t.id),
      title:
        t.status === "in_progress" && t.activeForm ? t.activeForm : t.subject,
      status:
        t.status === "in_progress"
          ? "in-progress"
          : t.status === "completed"
            ? "completed"
            : "pending",
      detail:
        blockers.length > 0
          ? `⛓ ${blockers.map((id) => `#${id}`).join(",")}`
          : undefined,
    };
  });

  return (
    <TodoList
      items={items}
      title="计划"
      className="bg-card/40"
      maxHeight={320}
    />
  );
};
