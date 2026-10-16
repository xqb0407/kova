"use client";

import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@/desktop-bridge/event";
import { fsListDir, type FsDirListing } from "@/lib/workspace/fs";
import { isDesktop } from "@/lib/desktop-env";

/**
 * 文件树目录缓存 store（失效时机仿 lib/git-status.ts，不做文件 watcher）：
 * - 按 cwd+dir 缓存**单层**列目录结果（Rust fs_list_dir 的引用原样存放，
 *   命中即引用相等，渲染层靠版本号 useMemo 避免无谓重建树）；
 * - 内存上限：缓存目录数封顶 LRU_CAP，超出按插入序淘汰（近似 LRU，getDir
 *   命中会 touch 提升新近度），长会话浏览再多目录内存也不单调增长；
 * - 在途去重：同一目录并发 ensureDir 只发一次 IPC；
 * - 失效时机：窗口聚焦、"git-changed"（Rust 写命令回推）、agent 运行结束
 *   （pi-transport 调 refreshFileTree）。失效=删缓存条目并 bump 版本；
 *   重拉由视图侧驱动（见 useFileTreeDirs 的补水 effect），store 不主动拉，
 *   防止无人查看时白耗 IO。
 */

const LRU_CAP = 200;

const keyOf = (cwd: string, dir: string) => `${cwd}\u0000${dir}`;

/** dir → listing；Map 插入序作近似 LRU 序 */
const cache = new Map<string, FsDirListing>();
const loading = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let wired = false;

/**
 * bump 按帧合并：一次失效风暴（聚焦/git-changed 后 K 个可见目录并发补水，
 * 每个目录入列 + 回包各 notify 一次）若逐个同步广播，订阅视图会做 ~2K 次
 * 全树重建；合并到 rAF 回调后同一帧内的多次变更只触发一次版本 bump，
 * 渲染压力从 O(K·N) 降到每帧 O(N)。
 */
let notifyScheduled = false;
function flushNotify() {
  notifyScheduled = false;
  version += 1;
  for (const l of listeners) l();
}
function notify() {
  if (notifyScheduled) return;
  notifyScheduled = true;
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(flushNotify);
  } else {
    setTimeout(flushNotify, 16);
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * 确保某目录已缓存（未缓存且不在途才发 IPC）。fire-and-forget；
 * 失败按空目录缓存，避免每次版本 bump 对坏路径反复重拉。
 */
export function ensureDir(cwd: string, dir: string): void {
  if (!cwd || !isDesktop()) return;
  const key = keyOf(cwd, dir);
  if (cache.has(key) || loading.has(key)) return;
  loading.add(key);
  // 入列即 bump：展开的目录先显示"加载中…"占位，而不是"无法读取"闪一下
  notify();
  void fsListDir(cwd, dir).then((listing) => {
    loading.delete(key);
    setCached(key, listing ?? { entries: [], truncated: false });
    notify();
  });
}

function setCached(key: string, listing: FsDirListing) {
  cache.set(key, listing);
  while (cache.size > LRU_CAP) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** 命中则 touch（提升 LRU 新近度）。返回 null = 未缓存，视图侧决定补水 */
export function getDir(cwd: string, dir: string): FsDirListing | null {
  const key = keyOf(cwd, dir);
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

export function isDirLoading(cwd: string, dir: string): boolean {
  return loading.has(keyOf(cwd, dir));
}

/** 失效某 cwd 的全部目录缓存（cwd 传 null = 全部） */
export function refreshFileTree(cwd: string | null): void {
  let dirty = false;
  for (const key of [...cache.keys()]) {
    if (cwd === null || key.startsWith(`${cwd}\u0000`)) {
      cache.delete(key);
      dirty = true;
    }
  }
  if (dirty) notify();
}

function invalidateCwd(cwd: string) {
  // 只失效已缓存目录：在途结果照常落缓存（读到的即当前盘上状态，无竞态）
  refreshFileTree(cwd);
}

async function wireEvents(): Promise<void> {
  if (wired || typeof window === "undefined") return;
  wired = true;
  if (isDesktop()) {
    try {
      await listen<{ cwd: string }>("git-changed", (event) => {
        const cwd = event.payload?.cwd;
        if (cwd) invalidateCwd(cwd);
      });
    } catch {
      // 事件不可用不影响功能（聚焦/运行结束刷新仍在）
    }
  }
  window.addEventListener("focus", () => {
    for (const key of [...cache.keys()]) {
      invalidateCwd(key.slice(0, key.indexOf("\u0000")));
    }
  });
}

/** 订阅缓存版本：任一目录补水/失效都会 bump（引用稳定，无撕裂快照问题） */
export function useFileTreeVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
}

/** 挂载即接事件源（聚焦/git-changed 刷新）；与 git-status 的 wireEvents 同款 */
export function useFileTreeWiring(): void {
  useEffect(() => {
    void wireEvents();
  }, []);
}
