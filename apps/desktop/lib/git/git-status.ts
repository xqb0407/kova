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
import { getWorkspace, whenWorkspacePersisted } from "@/lib/workspace/workspace-store";

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

/**
 * cwd → 状态。
 * - 缺键 = 未加载；
 * - status = null + ok = true：确认「不是 git 仓库 / git 不可用」，是终态；
 * - ok = false：本次查询失败（典型是选中目录抢在 kv 落库前 / 当前 workspace
 *   为空时的 cwd-not-allowed）。失败不能和「非仓库」共用 null 终态——否则一次
 *   瞬时失败会被 `useGitStatus` 的 cache.has 守卫永久跳过，Git 胶囊要等到下次
 *   聚焦/agent 轮末刷新才出现（新建工作区后胶囊消失、聊过一轮又出现）。
 */
type CachedStatus = { status: GitStatusInfo | null; ok: boolean };
const cache = new Map<string, CachedStatus>();
const loading = new Set<string>();
/** 在途期间又触发了刷新：当前完成后补拉一次（合并 N 次触发为 1 次尾随） */
const pendingRefresh = new Set<string>();
/**
 * 失败后自动尾随重试一次（每个目录每轮失败只补一次）。
 * 典型失效：选目录这两拍里 workspace store 还没切到该目录，第一次查询必中
 * cwd-not-allowed；等一拍再拉即可恢复，不必等用户下次聚焦/重新选中。
 * 成功一次后清掉标记，后续再失败还能再补。
 */
const failureRetried = new Set<string>();
/** 对应 cwd 的尾随重试 timer（成功/手动刷新后取消，避免多余查询） */
const failureRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const FAILURE_RETRY_MS = 1_200;
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

function clearFailureRetry(cwd: string): void {
  const timer = failureRetryTimers.get(cwd);
  if (!timer) return;
  clearTimeout(timer);
  failureRetryTimers.delete(cwd);
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
  // cwd-not-allowed——这里仍要等 kv，但真正兜底的是失败态缓存：万一仍失败，
  // 下次挂载/切回该目录会重拉，而不是被当成「非仓库」永久静默。
  whenWorkspacePersisted()
    .then(() => gitStatus(cwd))
    .then((s) => {
      cache.set(cwd, { status: s, ok: true });
      failureRetried.delete(cwd);
      // 手动刷新/尾随重试已成功：取消尚未触发的补拉，避免多打一次 git status
      clearFailureRetry(cwd);
    })
    .catch(() => {
      // 读类错误（含 cwd-not-allowed）记成失败而不是 null 终态：
      // 当前 workspace 还没切到 cwd（或 kv 被新对话清空）时查询必然失败，
      // 但这不是「该目录不是仓库」。保留失败标记让 useGitStatus 在下次
      // 挂载/切回该目录时重拉，避免 Git 胶囊被一次抢跑失败长期隐藏。
      // 旧结果保留（SWR）：背景刷新失败不该把已显示的胶囊瞬间抹掉。
      const prev = cache.get(cwd);
      cache.set(cwd, { status: prev?.status ?? null, ok: false });
      // 同一轮失败只自动补一次；仍失败就交给挂载/切回/聚焦等显式时机。
      if (!failureRetried.has(cwd)) {
        failureRetried.add(cwd);
        failureRetryTimers.set(
          cwd,
          setTimeout(() => {
            failureRetryTimers.delete(cwd);
            refreshGitStatus(cwd);
          }, FAILURE_RETRY_MS),
        );
      }
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
    // 没有当前 workspace 时所有 git 查询都会被主进程的 resolveWorkspace 拒绝
    //（kv workspace 为空）：既不会成功，还会把每个缓存目录都刷成失败态。
    // 直接跳过，等用户重新选中目录后再由 useGitStatus 按需拉取。
    // 判空放在 idle 回调里：聚焦到 idle 之间用户可能已经选了目录。
    if (!getWorkspace()) return;
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

/**
 * 模块级 focus 监听（HMR 安全）：本模块每次热更新都会重新求值，旧模块注册的
 * 监听不会自动摘除。用 window 上的固定槽位替换上一份，避免开发期监听叠加
 * （每次聚焦重复刷新，旧闭包还可能引用已失效的符号 → ReferenceError）。
 *
 * 生产只求值一次，等价于直接 addEventListener；SSR 不挂 window。
 */
type GitFocusWindow = Window & {
  __kovaGitStatusFocusHandler?: () => void;
};

function wireFocusListener(): void {
  // 测试/SSR 会垫一个只有少量字段的假 window：不能假设 addEventListener 存在，
  // 否则模块求值直接抛错，连带拖垮所有 import 本模块的测试文件。
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return;
  }
  const w = window as GitFocusWindow;
  if (w.__kovaGitStatusFocusHandler) {
    window.removeEventListener("focus", w.__kovaGitStatusFocusHandler);
  }
  w.__kovaGitStatusFocusHandler = refreshAllCachedWhenIdle;
  window.addEventListener("focus", w.__kovaGitStatusFocusHandler);
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
}

// 不在 wireEvents 里注册：那要等某个组件 effect 首次跑，HMR 求值时不会触发，
// 旧监听便一直留着。模块求值即替换，热更新也能收敛到一份。
wireFocusListener();

export type GitView = {
  probe: GitProbe | null;
  status: GitStatusInfo | null;
  loading: boolean;
  /** 目录不可用的原因（会话目录/当前 workspace 被删或移走）。此时 status
   *  同时为 null，避免胶囊等消费者把空状态当成"仓库、0 个改动"。 */
  missing: "cwd" | "workspace" | null;
};

const NO_PROBE_VIEW: GitView = {
  probe: null,
  status: null,
  loading: false,
  missing: null,
};
const memo = new Map<string, { version: number; value: GitView }>();

function getView(cwd: string | null): GitView {
  if (!cwd) return NO_PROBE_VIEW;
  const hit = memo.get(cwd);
  if (hit && hit.version === version) return hit.value;
  const raw = cache.get(cwd)?.status ?? null;
  const missing = raw?.missing ?? null;
  const value: GitView = {
    probe,
    status: missing ? null : raw,
    loading: loading.has(cwd) || probe === null,
    missing,
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
    // 失败态（ok=false）也要重拉：一次 cwd-not-allowed 不能变成永久“非仓库”。
    // 重新选中该工作区/重新挂载胶囊时正好是重试时机。
    const cached = cache.get(cwd);
    if (!cached || !cached.ok) refreshGitStatus(cwd);
  }, [cwd]);
  return view;
}
