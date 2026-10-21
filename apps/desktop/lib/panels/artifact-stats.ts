"use client";

import { fsStatMany, type FsStatEntry } from "@/lib/workspace/fs";

/**
 * 产物卡的 Host stat 缓存。
 *
 * 60s TTL + 100 条 LRU：同一轮/相邻轮反复提到同一路径时不重复 IPC；
 * 正负结果都缓存，模型在长回答里反复提一个不存在的路径也不会打爆远程/metadata。
 * 非桌面端 fsStatMany 返回 null，调用方据此走“不校验”的降级路径。
 */
const STAT_TTL_MS = 60_000;
const STAT_CACHE_MAX_ENTRIES = 100;
const STAT_BATCH_LIMIT = 20;

type CachedStat = FsStatEntry & { expiresAt: number };

const cache = new Map<string, CachedStat>();

function cacheKey(cwd: string, path: string): string {
  return `${cwd}\u0000${path}`;
}

function readCached(cwd: string, path: string): FsStatEntry | undefined {
  const key = cacheKey(cwd, path);
  const cached = cache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  // LRU：命中后移到队尾
  cache.delete(key);
  cache.set(key, cached);
  return cached;
}

function writeCached(cwd: string, entry: FsStatEntry): void {
  const now = Date.now();
  for (const [key, cached] of cache) {
    if (cached.expiresAt <= now) cache.delete(key);
  }
  const key = cacheKey(cwd, entry.path);
  cache.delete(key);
  cache.set(key, { ...entry, expiresAt: now + STAT_TTL_MS });
  while (cache.size > STAT_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * 批量取 stat。返回 null = 当前环境没有 Host stat（web/dev-preview），
 * 调用方应跳过存在性过滤而不是把所有候选判死。
 */
export async function statArtifactPaths(
  cwd: string,
  paths: readonly string[],
): Promise<Map<string, FsStatEntry> | null> {
  const unique = [...new Set(paths)];
  if (unique.length === 0) return new Map();

  const result = new Map<string, FsStatEntry>();
  const missing: string[] = [];
  for (const path of unique) {
    const cached = readCached(cwd, path);
    if (cached) result.set(path, cached);
    else missing.push(path);
  }

  if (missing.length > 0) {
    let supported = true;
    for (let offset = 0; offset < missing.length; offset += STAT_BATCH_LIMIT) {
      const batch = missing.slice(offset, offset + STAT_BATCH_LIMIT);
      const entries = await fsStatMany(cwd, batch);
      if (entries === null) {
        supported = false;
        break;
      }
      const byPath = new Map(entries.map((entry) => [entry.path, entry]));
      for (const path of batch) {
        const entry = byPath.get(path) ?? { path, exists: false };
        writeCached(cwd, entry);
        result.set(path, entry);
      }
    }
    if (!supported) return null;
  }

  return result;
}

/** 测试/切换 workspace 时清空；生产上由 TTL 自然淘汰。 */
export function clearArtifactStatCache(): void {
  cache.clear();
}
