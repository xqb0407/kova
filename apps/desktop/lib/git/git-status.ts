"use client";

import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@/desktop-bridge/event";
import { isDesktop } from "@/lib/desktop-env";
import {
  gitProbe,
  gitStatus,
  type GitProbe,
  type GitStatusInfo,
} from "@/lib/git/git";
import { whenWorkspacePersisted } from "@/lib/workspace/workspace-store";

/**
 * git 状态缓存 store（形态仿 lib/pi-todo.ts 的 useSyncExternalStore）：
 * - probe 全局一次（git 是否安装）；status 按 cwd 缓存（null = 非 git 仓库）
 * - 失效时机（MVP 不做文件 watcher，见设计 §3）：
 *   "git-changed" 事件（Rust 写命令回推）、窗口聚焦、agent 运行结束
 *   （pi-transport 调 refreshGitStatus）
 * - 刷新语义（对齐 VS Code SCM 的体感）：**stale-while-revalidate**——重拉期间
 *   旧结果继续可见（不再清缓存换 loading 态），新结果回来原地替换；并发触发
 *   合并不排队（在途撞上只记一次"还脏"，当前这次完成后补拉一次），保证最后一次
 *   写命令的状态最终可见，且勾选一个文件不会引起列表清空重建。
 */

let probe: GitProbe | null = null;
let probeInflight: Promise<GitProbe> | null = null;
/** cwd → 状态；缺键 = 未加载，null 值 = 非 git 仓库（或 git 不可用） */
const cache = new Map<string, GitStatusInfo | null>();
const loading = new Set<string>();
/** 在途期间又触发了刷新：当前完成后补拉一次（合并 N 次触发为 1 次尾随） */
const pendingRefresh = new Set<string>();
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

/** git 可用性探测（进程内缓存一次）；非 桌面壳 恒不可用 */
export async function ensureGitProbe(): Promise<GitProbe> {
  if (probe) return probe;
  if (!isDesktop()) {
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

/** 拉取/刷新某 cwd 的 git 状态（在途合并 + 尾随补拉；结果无论新旧都触发订阅） */
export function refreshGitStatus(cwd: string | null | undefined): void {
  if (!cwd || !isDesktop()) return;
  if (loading.has(cwd)) {
    pendingRefresh.add(cwd);
    return;
  }
  loading.add(cwd);
  notify();
  // 先等 workspace 的 kv 写入落库再发查询：Rust 侧 resolve_workspace 用 kv
  // "workspace" 校验 cwd，而选目录时 kv_set（主线程同步命令）与这里的
  // git_status（异步命令）几乎同时发出、并行执行。status 若抢跑读到旧值会得
  // cwd-not-allowed 并被缓存成 null——非仓库目录的 null 是终态不会重试，
  // 胶囊要等到下次失效（聚焦/git-changed）才出现，表现为"出现得很慢"。
  whenWorkspacePersisted()
    .then(() => gitStatus(cwd))
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
      // 在途期间被顶掉的触发，完成后再来一次（最后一次写命令的状态最终可见）
      if (pendingRefresh.delete(cwd)) refreshGitStatus(cwd);
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

/**
 * 回焦时的整批重拉：排到空闲再跑。
 *
 * 回焦那一帧本来就要做合并触发的渲染与布局（见 pi-runtime 的合并刷新），
 * 每个缓存 cwd 各发一次 git status（主进程 spawn + IPC + 结果回包各 bump 一次
 * 订阅）挤进同一帧只会把首帧顶成一次长任务。语义不变——每个缓存 cwd 仍会
 * 重拉一遍，只是晚一两帧到。
 */
function refreshAllCachedWhenIdle(): void {
  const run = () => {
    for (const cwd of [...cache.keys()]) {
      // 不清缓存：旧结果继续可见（SWR），刷新完成原地替换
      refreshGitStatus(cwd);
      for (const cb of changedCallbacks) cb(cwd);
    }
  };
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(run, { timeout: 1500 });
    return;
  }
  setTimeout(run, 200);
}

async function wireEvents(): Promise<void> {
  if (wired || typeof window === "undefined") return;
  wired = true;
  if (isDesktop()) {
    try {
      await listen<{ cwd: string }>("git-changed", (event) => {
        const cwd = event.payload?.cwd;
        // 不清缓存：panel 勾选暂存这类自触发回声不再造成"列表清空重建"
        refreshGitStatus(cwd);
        for (const cb of changedCallbacks) cb(cwd);
      });
    } catch {
      // 事件不可用不影响功能（聚焦刷新仍在）
    }
  }
  window.addEventListener("focus", refreshAllCachedWhenIdle);
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
    // probe 与 status 并行首发：胶囊显隐只取决于 status，git 不可用时
    // git_status 自身报错（resolve_workspace 的 ensure_git）→ 缓存 null，
    // 与串行走完 probe 再拉 status 殊途同归，省掉一个串在中间的 invoke 往返
    void ensureGitProbe();
    if (!cache.has(cwd)) refreshGitStatus(cwd);
  }, [cwd]);
  return view;
}
