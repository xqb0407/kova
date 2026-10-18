/**
 * 会话切换态判定（列表页 → 聊天页的路由参数）。
 *
 * 背景：`switchToThread` 要等目标运行时挂载完成后才更新 `mainThreadId`；
 * 列表页 push 时把目标 id 带过来，聊天页据此先渲染目标会话的壳，避免页面
 * 已经过去、内容却还停在刚才那个会话。
 *
 * 参数口径：
 * - `thread`：切到某个已有会话（本地 thread id）；
 * - `fresh=1 + from`：新建对话；`from` 是切换前的 mainThreadId。当前已经停在
 *   草稿会话时调用方不传 `from`（切换是 no-op，不需要壳）。
 */
export type ThreadSwitchParams = {
  thread?: string;
  fresh?: string;
  from?: string;
};

export function isThreadSwitchPending(
  params: ThreadSwitchParams,
  mainThreadId: string,
): boolean {
  if (typeof params.thread === "string") {
    return mainThreadId !== params.thread;
  }
  return (
    params.fresh === "1" &&
    typeof params.from === "string" &&
    mainThreadId === params.from
  );
}
