"use client";

/**
 * 主线程会话键（pi sessionId）的纯换算：per-session store / sidecar 查询共用。
 *
 * `threads.mainThreadId` 对本会话新建的线程恒为 `__LOCALID_` 草稿 id（只有
 * 刷新恢复的线程才与 sessionId 同值，见 pi-thread-adapter 命名空间注释）；
 * 而写入侧（ThreadController / prompt / thread_event / 检查点 store）一律按
 * sessionId 记账。读取侧必须先换出线程列表项 initialize 落定的 remoteId
 * （= sessionId），否则新建会话里永远 miss。
 *
 * 纯函数放这里是为了可单测：组件侧用 useMainSessionId（pi-interaction-session）
 * 包一层 useAuiState。
 */
export type MainSessionIdState = {
  threads: {
    mainThreadId?: string;
    threadItems: readonly { id: string; remoteId?: string }[];
  };
};

/** 未初始化草稿 / 线程项缺失 → undefined（此时还没有可查询的会话） */
export function mainSessionIdOf(
  state: MainSessionIdState,
): string | undefined {
  const mainThreadId = state.threads.mainThreadId;
  if (!mainThreadId) return undefined;
  return state.threads.threadItems.find((item) => item.id === mainThreadId)
    ?.remoteId;
}
