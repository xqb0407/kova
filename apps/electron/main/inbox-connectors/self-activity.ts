/**
 * 本端写操作（评论/PR 动作）的短期标记。
 *
 * 写完评论后平台 updatedAt 会变化，下一次同步会把条目重新标未读；这里把
 * 刚写过的 provider+key 记一段时间，随同步快照带给 sidecar，让其强制标记
 * 已读，避免自己的操作把收件箱顶回未读。
 */
const TTL_MS = 5 * 60 * 1000;
const activity = new Map<string, Map<string, number>>();

function prune(now: number): void {
  for (const [provider, keys] of activity) {
    for (const [key, expiresAt] of keys) {
      if (expiresAt <= now) keys.delete(key);
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
  keys.set(normalized.slice(0, 300), now + TTL_MS);
}

export function selfActivityKeysFor(provider: string): string[] {
  const keys = activity.get(provider);
  if (!keys) return [];
  prune(Date.now());
  // 与 inbox_external_sync.keepReadKeys 的 max(50) 对齐，避免大批量写操作
  // 把整个同步请求打回 invalid。
  return [...(activity.get(provider)?.keys() ?? [])].slice(-50);
}

/** 测试缝 */
export function resetInboxSelfActivityForTest(): void {
  activity.clear();
}
