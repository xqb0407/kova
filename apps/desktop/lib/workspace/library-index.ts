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
  libraryScan,
  type LibraryScanEntry,
} from "@/lib/workspace/library-files";

/**
 * 资料库检索索引（引用到对话的 @ 选择器 / + 菜单 picker 共用一份数据源）：
 * `library_scan`（文件清单，名字过滤，mtime 倒序）+ `library_file_meta`
 * （标题/标签）合并打分。
 *
 * 排序约定（与选择器的分组一致）：
 * - 无关键词：笔记（.md）在前、其余文件在后，各自按修改时间倒序——最近在
 *   写的笔记最容易要引用；
 * - 有关键词：标题命中 > tag 命中 > 文件名 > rel 路径，同分按修改时间。
 */

export interface LibraryIndexEntry extends LibraryScanEntry {
  /** 元数据标题（无记录为空串；展示回退 name） */
  title: string;
  tags: string[];
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

/** 空关键词结果的短缓存：@ 每次挂载/切会话都拉一次，巨型库不必反复全扫 */
const RECENT_TTL_MS = 15_000;
let recentCache: { at: number; result: LibrarySearchResult } | null = null;

export function invalidateLibraryIndex(): void {
  recentCache = null;
}

function isNoteEntry(rel: string): boolean {
  return /\.md$/iu.test(rel);
}

function scoreEntry(entry: LibraryIndexEntry, needle: string): number {
  if (entry.title.toLowerCase().includes(needle)) return 400;
  const tagNeedle = needle.replace(/^#/, "");
  if (entry.tags.some((tag) => tag.includes(tagNeedle))) return 300;
  if (entry.name.toLowerCase().includes(needle)) return 200;
  if (entry.rel.toLowerCase().includes(needle)) return 100;
  return 0;
}

/** 过滤 + 排序（导出供单测）：空 query 笔记优先 + 修改时间，非空按
 *  标题 > 标签 > 文件名 > rel 打分。 */
export function rankLibraryEntries(
  entries: LibraryIndexEntry[],
  query: string,
): LibraryIndexEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    const notes = entries.filter((e) => isNoteEntry(e.rel));
    const others = entries.filter((e) => !isNoteEntry(e.rel));
    return [...notes, ...others];
  }
  const scored = entries
    .map((entry) => ({ entry, score: scoreEntry(entry, needle) }))
    .filter((row) => row.score > 0);
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.entry.modified ?? "").localeCompare(a.entry.modified ?? ""),
  );
  return scored.map((row) => row.entry);
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
  opts?: { fresh?: boolean },
): Promise<LibrarySearchResult> {
  const root = getLibraryRootInfo()?.root ?? null;
  const exists = getLibraryRootInfo()?.exists ?? false;
  if (!isDesktop() || !root || !exists) return EMPTY;
  const needle = query.trim().toLowerCase();
  if (!needle && !opts?.fresh && recentCache) {
    return recentCache.result;
  }
  const [scan, meta] = await Promise.all([
    libraryScan({ query: "" }),
    libraryFileMetaListSafe(root),
  ]);
  const metaByRel = new Map<string, LibraryFileMeta>(
    meta.entries.filter((e) => !e.missing).map((e) => [e.rel, e]),
  );
  const entries: LibraryIndexEntry[] = scan.entries.map((entry) => {
    const m = metaByRel.get(entry.rel);
    return {
      ...entry,
      title: m?.title ?? "",
      tags: m?.tags ?? [],
    };
  });
  const result: LibrarySearchResult = {
    entries: rankLibraryEntries(entries, needle),
    truncated: scan.truncated,
    rootMissing: meta.rootMissing,
  };
  if (!needle) recentCache = { at: Date.now(), result };
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
