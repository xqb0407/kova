"use client";

import { useAuiState } from "@assistant-ui/react";

/**
 * 挂起交互台账（审批卡 / 提问卡 / 侧边栏徽标）的查询键 = 当前主线程的 pi sessionId。
 *
 * 台账按**线上 sessionId** 记账（data-toolApproval / data-question chunk 行的
 * sessionId 字段，见 pi-interactions），而 `threads.mainThreadId` 对本会话新建的
 * 线程恒为 `__LOCALID_` 草稿 id——只有刷新后恢复的线程才两者同值（core
 * reconcileInitializedThread 保留原 mapping id，详见
 * docs/pi-runtime-migration-notes.md §chk5）。直接拿 mainThreadId 查台账，对
 * 「本会话新建的会话」永远 miss：提问卡不上屏、composer 的互斥判断落空、审批卡
 * 不出现，而侧边栏（用行 remoteId 查）却正常——同一个台账两种键的典型症状。
 *
 * 取线程列表项上 initialize 落定的 remoteId（= sessionId）：它由框架状态承载，
 * 必然晚于 adapter.initialize 的登记返回、又必然早于任何挂起交互到达（sidecar
 * 要先有会话才谈得上挂起等答），因此没有「登记晚于读取」的竞态。不能用
 * piSessionIdForThread + pi:session-bound 事件：createThread 在 dispatchEvent
 * 之后才由 usePiRuntime 写 piSessionRegistry，事件监听里读到的仍是未登记的值，
 * 之后不会再触发第二次。
 *
 * 未发送草稿的 remoteId 为 undefined —— 此时不可能有挂起交互，调用方按无挂起
 * 处理即可。
 */
export function useInteractionSessionId(): string | undefined {
  return useAuiState((s) => {
    const mainThreadId = s.threads.mainThreadId;
    if (!mainThreadId) return undefined;
    return s.threads.threadItems.find((item) => item.id === mainThreadId)
      ?.remoteId;
  });
}
