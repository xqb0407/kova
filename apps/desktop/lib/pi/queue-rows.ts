/**
 * 队列条行合并：把「已并入」ghost 行按原队列下标插回真实队列行。
 *
 * 背景：并入受理后 sidecar 会立刻把条目从队列摘掉，但注入的 user 消息要等
 * 下一个模型边界才上屏。队列条用 ghost 行在这段空窗里保留确认。连续并入
 * 多条时每一条都有自己的 ghost（不能被后一条覆盖），所以这里按各自记录的
 * 原下标依次插回；条目已经回到队列（注入未被回应、被回收）时不重复插入。
 */
export type QueueGhost<T extends { id: string }> = {
  item: T;
  /** 点击并入时该条目在队列里的下标 */
  index: number;
};

export type QueueRowModel<T extends { id: string }> = {
  item: T;
  /** true = 已并入确认行（不在真实队列里，不可拖动/操作） */
  ghost: boolean;
};

export function mergeQueueRows<T extends { id: string }>(
  items: readonly T[],
  ghosts: readonly QueueGhost<T>[],
): QueueRowModel<T>[] {
  const rows: QueueRowModel<T>[] = items.map((item) => ({ item, ghost: false }));
  const live = new Set(items.map((item) => item.id));
  const pending = ghosts
    .filter((ghost) => !live.has(ghost.item.id))
    .slice()
    .sort((a, b) => a.index - b.index);
  for (const ghost of pending) {
    const at = Math.min(Math.max(ghost.index, 0), rows.length);
    rows.splice(at, 0, { item: ghost.item, ghost: true });
  }
  return rows;
}
