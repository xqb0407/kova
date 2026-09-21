"use client";

import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@/lib/tauri";
import {
  gitProbe,
  gitStatus,
  type GitProbe,
  type GitStatusInfo,
} from "@/lib/git/git";

/**
 * git 状态缓存 store（形态仿 lib/pi-todo.ts 的 useSyncExternalStore）：
 * - probe 全局一次（git 是否安装）；status 按 cwd 缓存（null = 非 git 仓库）
 * - 失效时机（MVP 不做文件 watcher，见设计 §3）：
 *   "git-changed" 事件（Rust 写命令回推）、窗口聚焦、agent 运行结束
 *   （pi-transport 调 refreshGitStatus）
 */

let probe: GitProbe | null = null;
let probeInflight: Promise<GitProbe> | null = null;
/** cwd → 状态；缺键 = 未加载，null 值 = 非 git 仓库（或 git 不可用） */
const cache = new Map<string, GitStatusInfo | null>();
const loading = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let wired = false;

function notify() {
  version += 1;
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** git 可用性探测（进程内缓存一次）；非 Tauri 恒不可用 */
export async function ensureGitProbe(): Promise<GitProbe> {
  if (probe) return probe;
  if (!isTauri()) {
    probe = { available: false, version: null };
    notify();
    return probe;
  }
  probeInflight ??= gitProbe().then((p) => {
    probe = p;
    probeInflight = null;
    notify();
    return p;
  });
  return probeInflight;
}

/** 拉取/刷新某 cwd 的 git 状态（在途去重；结果无论新旧都触发订阅） */
export function refreshGitStatus(cwd: string | null | undefined): void {
  if (!cwd || !isTauri() || loading.has(cwd)) return;
  loading.add(cwd);
  notify();
  gitStatus(cwd)
    .then((s) => {
      cache.set(cwd, s);
    })
    .catch(() => {
      // 读类错误（含 cwd-not-allowed）按"无状态"处理，UI 静默
      cache.set(cwd, null);
    })
    .finally(() => {
      loading.delete(cwd);
      notify();
    });
}

/** 事件/聚焦订阅：任一失效时机都收敛到这里接 */
const changedCallbacks = new Set<(cwd: string) => void>();

/** 订阅 "git-changed"（Rust 写命令完成回推）；返回退订函数 */
export function onGitChanged(cb: (cwd: string) => void): () => void {
  changedCallbacks.add(cb);
  wireEvents();
  return () => changedCallbacks.delete(cb);
}

async function wireEvents(): Promise<void> {
  if (wired || typeof window === "undefined") return;
  wired = true;
  if (isTauri()) {
    try {
      await listen<{ cwd: string }>("git-changed", (event) => {
        const cwd = event.payload?.cwd;
        cache.delete(cwd);
        refreshGitStatus(cwd);
        for (const cb of changedCallbacks) cb(cwd);
      });
    } catch {
      // 事件不可用不影响功能（聚焦刷新仍在）
    }
  }
  window.addEventListener("focus", () => {
    for (const cwd of [...cache.keys()]) {
      cache.delete(cwd);
      refreshGitStatus(cwd);
      for (const cb of changedCallbacks) cb(cwd);
    }
  });
}

export type GitView = {
  probe: GitProbe | null;
  status: GitStatusInfo | null;
  loading: boolean;
};

const NO_PROBE_VIEW: GitView = { probe: null, status: null, loading: false };
const memo = new Map<string, { version: number; value: GitView }>();

function getView(cwd: string | null): GitView {
  if (!cwd) return NO_PROBE_VIEW;
  const hit = memo.get(cwd);
  if (hit && hit.version === version) return hit.value;
  const value: GitView = {
    probe,
    status: cache.get(cwd) ?? null,
    loading: loading.has(cwd) || probe === null,
  };
  memo.set(cwd, { version, value });
  return value;
}

/**
 * 订阅当前 workspace 的 git 状态。挂载即触发 probe → status 首拉；
 * cwd 变化（切 workspace）重新拉取。status 非 null 即"可用 git 功能"。
 */
export function useGitStatus(cwd: string | null): GitView {
  const view = useSyncExternalStore(
    subscribe,
    () => getView(cwd),
    () => NO_PROBE_VIEW,
  );
  useEffect(() => {
    void wireEvents();
    if (!cwd) return;
    let alive = true;
    void ensureGitProbe().then((p) => {
      if (!alive || !p.available) return;
      if (!cache.has(cwd)) refreshGitStatus(cwd);
    });
    return () => {
      alive = false;
    };
  }, [cwd]);
  return view;
}
