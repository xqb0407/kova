"use client";

import { useEffect, useRef, useState } from "react";
import { listen } from "@/desktop-bridge/event";
import { isDesktop } from "@/lib/desktop-env";
import {
  getLibraryRootInfo,
  useLibraryRoot,
} from "@/lib/workspace/library-root";
import {
  libraryFileMetaListSafe,
  type LibraryFileMeta,
} from "@/lib/workspace/library-note-meta";
import {
  knowledgeRefsRecent,
  libraryScan,
  type LibraryScanEntry,
} from "@/lib/workspace/library-files";
import { rankLibraryEntries } from "knowledge-core";

export { rankLibraryEntries };

/**
 * 资料库检索索引（引用到对话的 @ 选择器 / + 菜单 picker 共用一份数据源）：
 * `library_scan`（文件清单，名字过滤，mtime 倒序）+ `library_file_meta`
 * （标题/标签）合并打分。
 *
 * 排序约定（与选择器的分组一致）：
 * - 无关键词：笔记（.md/.knote）在前、其余文件在后，各自按修改时间倒序——最近在
 *   写的笔记最容易要引用；
 * - 有关键词：标题命中 > tag 命中 > 文件名 > rel 路径，同分按修改时间。
 */

export interface LibraryIndexEntry extends LibraryScanEntry {
  /** 元数据标题（无记录为空串；展示回退 name） */
  title: string;
  tags: string[];
  /** 最近一次被任务使用（knowledge_refs）；无记录为 0 */
  lastUsed?: number;
}

export interface LibrarySearchResult {
  entries: LibraryIndexEntry[];
  truncated: boolean;
  rootMissing: boolean;
}

const EMPTY: LibrarySearchResult = {
  entries: [],
  truncated: false,
  rootMissing: false,
};

/** 空关键词结果的短缓存：@ 每次挂载/切会话都拉一次，巨型库不必反复全扫。
 *  必须带 root：换资料库位置后旧根的条目不能拿来拼新根的路径（引用会错文件）。 */
const RECENT_TTL_MS = 15_000;
let recentCache: {
  at: number;
  root: string;
  result: LibrarySearchResult;
} | null = null;

export function invalidateLibraryIndex(): void {
  recentCache = null;
}

/**
 * 资料库检索：清单 + 元数据合并后**在渲染层过滤/打分**。
 *
 * 关键：scan 必须拉全量（query=""）——主进程的 library_scan 只按文件名匹配，
 * 只命中标签/派生标题的查询会在扫描阶段被滤掉。最多 500 条，picker 有防抖，
 * 代价可接受。fresh = 跳过空关键词缓存（picker 打开/变更后重拉时用）。
 */
export async function searchLibrary(
  query: string,
  opts?: { fresh?: boolean; under?: string },
): Promise<LibrarySearchResult> {
  const root = getLibraryRootInfo()?.root ?? null;
  const exists = getLibraryRootInfo()?.exists ?? false;
  if (!isDesktop() || !root || !exists) return EMPTY;
  const needle = query.trim().toLowerCase();
  const under = opts?.under?.trim() || undefined;
  // under 是作用域参数，不进空关键词缓存（同一根下不同 KB 的结果不同）
  if (!needle && !under && !opts?.fresh && recentCache?.root === root) {
    return recentCache.result;
  }
  const [scan, meta, usage] = await Promise.all([
    libraryScan({ query: "", ...(under ? { under } : {}) }),
    libraryFileMetaListSafe(root),
    needle
      ? Promise.resolve([] as { path: string; lastTs: number }[])
      : knowledgeRefsRecent({
          source: "library",
          scopeId: root,
          limit: 200,
        }).catch(() => []),
  ]);
  const lastUsed = new Map(usage.map((row) => [row.path, row.lastTs]));
  const metaByRel = new Map<string, LibraryFileMeta>(
    meta.entries.filter((e) => !e.missing).map((e) => [e.rel, e]),
  );
  const entries: LibraryIndexEntry[] = scan.entries.map((entry) => {
    const m = metaByRel.get(entry.rel);
    return {
      ...entry,
      title: m?.title ?? "",
      tags: m?.tags ?? [],
      lastUsed: lastUsed.get(entry.rel) ?? 0,
    };
  });
  const result: LibrarySearchResult = {
    entries: rankLibraryEntries(entries, needle),
    truncated: scan.truncated,
    rootMissing: meta.rootMissing,
  };
  if (!needle && !under) recentCache = { at: Date.now(), root, result };
  return result;
}

/** 最近资料库条目（@ 选择器用）：挂载/根变化拉取；watcher 变更防抖重拉 */
export function useRecentLibraryEntries(): {
  entries: LibraryIndexEntry[];
  loading: boolean;
  truncated: boolean;
  rootMissing: boolean;
} {
  const info = useLibraryRoot();
  const root = info?.root ?? null;
  const exists = info?.exists ?? false;
  const [state, setState] = useState<{
    entries: LibraryIndexEntry[];
    loading: boolean;
    truncated: boolean;
    rootMissing: boolean;
  }>({ entries: [], loading: false, truncated: false, rootMissing: false });
  /** 根/可用性变化才失效缓存；同一根下 composer 重挂载可复用 15s 缓存 */
  const lastRootKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const rootKey = `${root ?? ""}\u0000${exists}`;
    if (lastRootKeyRef.current !== rootKey) {
      lastRootKeyRef.current = rootKey;
      invalidateLibraryIndex();
    }
    if (!isDesktop() || !root || !exists) {
      setState({
        entries: [],
        loading: false,
        truncated: false,
        rootMissing: Boolean(root) && !exists,
      });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    searchLibrary("")
      .then((r) => {
        if (alive) {
          setState({
            entries: r.entries,
            loading: false,
            truncated: r.truncated,
            rootMissing: r.rootMissing,
          });
        }
      })
      .catch(() => {
        if (alive) setState((s) => ({ ...s, loading: false }));
      });
    return () => {
      alive = false;
    };
  }, [root, exists]);

  // watcher 变更：失效缓存并防抖重拉（同一次批量删除只重拉一次）
  useEffect(() => {
    if (!isDesktop() || !root) return;
    let alive = true;
    let off: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refetch = () => {
      invalidateLibraryIndex();
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (!alive) return;
        void searchLibrary("", { fresh: true }).then((r) => {
          if (alive) {
            setState({
              entries: r.entries,
              loading: false,
              truncated: r.truncated,
              rootMissing: r.rootMissing,
            });
          }
        });
      }, 500);
    };
    void listen("library:changed", refetch).then((un) => {
      if (!alive) un();
      else off = un;
    });
    return () => {
      alive = false;
      off?.();
      if (timer) clearTimeout(timer);
    };
  }, [root]);

  return state;
}
