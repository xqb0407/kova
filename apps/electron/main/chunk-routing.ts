/**
 * pi-chunk-batch 的按窗口裁剪规则（纯函数，便于单测）。
 *
 * 多会话并发时，后台会话的逐 token `message_update` 不必跨进程送到完全不
 * 看它的窗口。裁剪只碰这一种高频重行：起止/收尾/状态旁路行都承载语义，
 * 必须保持全窗口可达；未登记观看集合的窗口按全量处理（兼容只读消费者）。
 */

/** 合帧行：`heavy` + `sid` 同时具备时才允许裁剪 */
export type ChunkBatchLine = { l: string; sid?: string | null; heavy?: boolean };

/** 观看集合归一：渲染层上报值不可信，非数组/非字符串/空串一律丢弃 */
export function normalizeWatchedIds(ids: unknown): Set<string> {
  return new Set(
    Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [],
  );
}

/**
 * 裁出该窗口应收到的行。`watched` 为 undefined 表示窗口未登记过观看集合，
 * 返回全部行（与引入裁剪前的广播行为一致）。
 */
export function routeChunkLines(
  lines: readonly ChunkBatchLine[],
  watched: Set<string> | undefined,
): { l: string }[] {
  const payload: { l: string }[] = [];
  for (const line of lines) {
    if (watched && line.heavy && line.sid && !watched.has(line.sid)) continue;
    payload.push({ l: line.l });
  }
  return payload;
}
