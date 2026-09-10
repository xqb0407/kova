"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi-bridge";
import { piSessionRegistry } from "@/lib/pi-thread-adapter";

/**
 * 逐工具审批（bash/write/edit 执行前等用户确认，sidecar modes.ts 的 approvalBeforeToolCall）。
 * - 事实源在 sidecar：prompt 流里的 data-toolApproval chunk 推送审批请求（见 pi-transport 的 tap）
 * - 用户点击批准/拒绝 → tool_confirm 请求-响应 → 本地移除卡片
 * - turn 结束（finish chunk）时清空该线程残留审批，覆盖 abort/异常路径
 */

export type PendingToolApprovalView = {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
};

/** threadId -> 挂起审批列表（先进先出展示） */
const pending = new Map<string, PendingToolApprovalView[]>();
/** getSnapshot 必须返回稳定引用：无审批时共享同一空数组，否则 useSyncExternalStore 会无限循环 */
const EMPTY: PendingToolApprovalView[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

/** 消费 prompt 流里的 data-toolApproval chunk（pi-transport 调用） */
export function applyToolApprovalChunk(threadId: string, data: unknown): void {
  if (!data || typeof data !== "object") return;
  const d = data as Partial<PendingToolApprovalView>;
  if (typeof d.approvalId !== "string" || typeof d.toolName !== "string") return;
  const list = pending.get(threadId) ?? [];
  if (list.some((a) => a.approvalId === d.approvalId)) return;
  pending.set(threadId, [
    ...list,
    {
      approvalId: d.approvalId,
      toolCallId: String(d.toolCallId ?? ""),
      toolName: d.toolName,
      input: d.input ?? null,
    },
  ]);
  notify();
}

/** turn 结束清空该线程的挂起审批（abort/异常的兜底出口） */
export function clearToolApprovals(threadId: string): void {
  if (!pending.get(threadId)?.length) return;
  pending.set(threadId, []);
  notify();
}

/** 订阅当前线程的挂起审批列表 */
export function usePendingToolApprovals(threadId: string | undefined): PendingToolApprovalView[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (threadId ? (pending.get(threadId) ?? EMPTY) : EMPTY),
    () => EMPTY,
  );
}

type ToolConfirmResponse = { type: "tool_confirmed"; approvalId: string };

/** 结算审批：approved = 放行执行；false = 拦截（模型收到 blocked 工具结果） */
export async function confirmToolApproval(
  threadId: string,
  approvalId: string,
  approved: boolean,
): Promise<void> {
  const sessionId = piSessionRegistry.get(threadId);
  try {
    await piRequest<ToolConfirmResponse>({
      type: "tool_confirm",
      approvalId,
      approved,
      threadId,
      ...(sessionId ? { sessionId } : {}),
    });
  } finally {
    // 请求失败（审批已被 abort 清理等）也移除卡片，避免悬挂
    const list = pending.get(threadId);
    if (list?.some((a) => a.approvalId === approvalId)) {
      pending.set(
        threadId,
        list.filter((a) => a.approvalId !== approvalId),
      );
      notify();
    }
  }
}
