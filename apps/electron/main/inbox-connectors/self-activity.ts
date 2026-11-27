/**
 * 本端写操作（评论/PR 动作）的短期标记。
 *
 * 写完评论/动作后平台数据会变化，同步可能把条目重新标未读。这里记录
 * provider+key 与写入时间，只在「写入之后开始的那一轮同步」里下发一次；
 * 该轮推送成功后立即消费，避免持续压制后续别人发来的回复。
 */
const TTL_MS = 5 * 60 * 1000;
type SelfActivity = { writtenAt: number; expiresAt: number };
const activity = new Map<string, Map<string, SelfActivity>>();

function prune(now: number): void {
  for (const [provider, keys] of activity) {
    for (const [key, entry] of keys) {
      if (entry.expiresAt <= now) keys.delete(key);
    }
    if (keys.size === 0) activity.delete(provider);
  }
}

export function recordInboxSelfActivity(provider: string, key: string): void {
  const normalized = key.trim();
  if (!normalized) return;
  const now = Date.now();
  prune(now);
  let keys = activity.get(provider);
  if (!keys) {
    keys = new Map();
    activity.set(provider, keys);
  }
  keys.set(normalized.slice(0, 300), {
    writtenAt: now,
    expiresAt: now + TTL_MS,
  });
}

/**
 * 取「在 startedAt 之前写入」的 key。startedAt 是本轮拉取的开始时间：
 * 写入前就已经在飞的轮询即使随后才推送，也不会被当成写后同步。
 */
export function selfActivityKeysFor(
  provider: string,
  startedAt = Date.now(),
): string[] {
  prune(Date.now());
  const entries = activity.get(provider);
  if (!entries) return [];
  // 与 inbox_external_sync.keepReadKeys 的 max(50) 对齐，避免大批量写操作
  // 把整个同步请求打回 invalid。
  return [...entries]
    .filter(([, entry]) => entry.writtenAt <= startedAt)
    .map(([key]) => key)
    .slice(-50);
}

/** 推送成功后消费 key；下一轮同步不再继续压制未读。 */
export function consumeInboxSelfActivity(
  provider: string,
  keys: readonly string[],
): void {
  const entries = activity.get(provider);
  if (!entries) return;
  for (const key of keys) entries.delete(key);
  if (entries.size === 0) activity.delete(provider);
}

/** 测试缝 */
export function resetInboxSelfActivityForTest(): void {
  activity.clear();
}
