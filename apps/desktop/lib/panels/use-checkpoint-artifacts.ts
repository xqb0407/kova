"use client";

import { useEffect, useMemo, useState } from "react";
import {
  gitCheckpointFiles,
  type GitCheckpointFile,
} from "@/lib/git/git";
import {
  checkpointFilesToCandidates,
  mergeArtifactCandidates,
  type ArtifactCandidate,
} from "@/lib/panels/artifacts";

/**
 * checkpoint diff 兜底：接住 bash/脚本/MCP/插件写出、正文没提到的文件。
 *
 * 用 name-status 而不是完整 diff（后者每个文件都带 patch），并按 hash 缓存；
 * 产物页签一次可能有多个检查点，限制 4 个并发 git 进程。
 */

export type CheckpointArtifactRequest = {
  hash: string;
  turnStartMs: number;
  orderBase: number;
};

const CACHE_MAX = 20;
const CONCURRENCY = 4;
const fileCache = new Map<string, GitCheckpointFile[]>();
const pending = new Map<string, Promise<GitCheckpointFile[]>>();

function cacheKey(cwd: string, hash: string): string {
  return `${cwd}\u0000${hash}`;
}

function trimCache(): void {
  while (fileCache.size > CACHE_MAX) {
    const oldest = fileCache.keys().next().value;
    if (oldest === undefined) break;
    fileCache.delete(oldest);
  }
}

async function loadCheckpointFiles(
  cwd: string,
  hash: string,
): Promise<GitCheckpointFile[]> {
  const key = cacheKey(cwd, hash);
  const cached = fileCache.get(key);
  if (cached) {
    // LRU：命中后移到队尾
    fileCache.delete(key);
    fileCache.set(key, cached);
    return cached;
  }
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const request = gitCheckpointFiles(cwd, hash)
    .then((files) => {
      const result = files ?? [];
      fileCache.set(key, result);
      trimCache();
      return result;
    })
    .finally(() => {
      pending.delete(key);
    });
  pending.set(key, request);
  return request;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await fn(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function useCheckpointArtifactCandidates(
  cwd: string | null,
  requests: readonly CheckpointArtifactRequest[],
): ArtifactCandidate[] {
  // requests 由调用方 useMemo 构造；这里只依赖语义 key，避免数组身份变化重跑。
  const key = useMemo(
    () =>
      JSON.stringify(
        requests.map((request) => [
          request.hash,
          request.turnStartMs,
          request.orderBase,
        ]),
      ),
    [requests],
  );
  const [state, setState] = useState<{
    key: string;
    candidates: ArtifactCandidate[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!cwd || requests.length === 0) {
      setState({ key, candidates: [] });
      return;
    }
    void mapWithConcurrency(requests, CONCURRENCY, async (request) => {
      const files = await loadCheckpointFiles(cwd, request.hash);
      return checkpointFilesToCandidates({
        cwd,
        files,
        turnStartMs: request.turnStartMs,
        orderBase: request.orderBase,
      });
    }).then(
      (groups) => {
        if (cancelled) return;
        setState({
          key,
          candidates: mergeArtifactCandidates(groups.flat(), 100),
        });
      },
      () => {
        if (!cancelled) setState({ key, candidates: [] });
      },
    );
    return () => {
      cancelled = true;
    };
    // requests 的内容已编码进 key；不要把数组身份放进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, key]);

  return state?.key === key ? state.candidates : [];
}

/** 测试/切换 workspace 用 */
export function clearCheckpointArtifactCache(): void {
  fileCache.clear();
  pending.clear();
}
