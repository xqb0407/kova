/**
 * 会话索引缺行的统一处理。
 *
 * `thread_snapshot` 对索引里不存在的会话按设计抛 `session not found`（缺行即
 * not found，防止空快照被列表收编成幽灵行）。列表行的切换动作由 assistant-ui
 * 的 `ThreadListItemPrimitive.Trigger` 内部直接发起，调用方没有机会 catch；
 * 它使用的 `handleRuntimeAction` 只对带 silent 标记的错误不 `console.error`。
 *
 * 所以这里做两件事：
 * - 把缺行错误标成 silent，避免 dev overlay 每次点击陈旧行都糊一层报错；
 * - 广播一次缺行事件，让列表 reload 自愈（该行若已不在 sidecar 清单里就消失）。
 *
 * 注意：错误仍会抛出，`switchToThread` 的失败语义保持不变——上层回切逻辑靠
 * `not found` 文案清理过期指针，不能在这里吞掉。
 */

export const PI_THREAD_MISSING_EVENT = "pi:thread-missing";

/** assistant-ui 的跨包约定：带此 Symbol 的错误属于预期失效，不记日志 */
const SILENT_RUNTIME_ACTION = Symbol.for("assistant-ui.silent-runtime-action");

export function isSessionNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /session not found/i.test(message);
}

/**
 * aui 草稿线程 id（会话内新开的对话在刷新前恒为该前缀，见 pi-interactions）。
 * 这种 id 永远不是 sidecar sessionId：对它的 not found 只说明行已被列表淘汰
 * （适配器换代的窄竞态），绝不能据此清在飞登记——该 id 名下的登记可能属于
 * 一个仍在运行的真实会话，清掉会破坏刷新续流。
 */
export function isLocalThreadId(threadId: string): boolean {
  return threadId.startsWith("__LOCALID_");
}

/** 原地标记后返回同一对象，保留原始 message 供上层判别 */
export function markSilentRuntimeAction<T extends Error>(error: T): T {
  if (!(SILENT_RUNTIME_ACTION in error)) {
    Object.defineProperty(error, SILENT_RUNTIME_ACTION, {
      value: true,
      enumerable: false,
    });
  }
  return error;
}

/** 通知已挂载的会话列表：这个 id 已不存在，重新拉清单 */
export function notifyThreadMissing(threadId: string): void {
  if (typeof window === "undefined") return;
  // warn 而非 error：dev overlay 只收 error，留一条可检索的失效痕迹
  console.warn(`[pi-runtime] stale thread: ${threadId} (session not found)`);
  window.dispatchEvent(
    new CustomEvent<string>(PI_THREAD_MISSING_EVENT, { detail: threadId }),
  );
}
