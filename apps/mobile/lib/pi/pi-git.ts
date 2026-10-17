"use client";

/**
 * Git 变更（移动端）：sidecar 只读 git_status / git_diff 的镜像 store。
 *
 * 桌面端的 Git 面板走桌面壳本地 git；远程端（网页/手机）没有该能力，所以
 * sidecar 新增了两条只读命令（cwd 取会话绑定目录，客户端不能指定任意路径）。
 * 这里只负责：按会话拉状态、按文件拉 diff，并把快照做成可订阅的稳定引用。
 */
import { useEffect, useSyncExternalStore } from "react";
import {
  piRequest,
  type PiGitDiffResponse,
  type PiGitStatusResponse,
} from "@/lib/pi/pi-bridge";

export type GitFileStatus = {
  path: string;
  /** 展示用单字符：A/M/D/R/? */
  status: string;
  added: number;
  removed: number;
  untracked: boolean;
};

export type GitStatusSnapshot = {
  loading: boolean;
  /** false = 不是 git 仓库（或无 git）：面板显示空态而不是报错 */
  repo: boolean;
  branch: string | null;
  files: GitFileStatus[];
  truncated: boolean;
  error: string | null;
};

const EMPTY: GitStatusSnapshot = {
  loading: false,
  repo: false,
  branch: null,
  files: [],
  truncated: false,
  error: null,
};

const snapshots = new Map<string, GitStatusSnapshot>();
const listeners = new Set<() => void>();
/** 按会话在途去重：只按全局单例去重时，A 在飞会吞掉 B 的刷新，B 永远停在旧数据 */
const inflight = new Map<string, Promise<void>>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 拉取某会话的 git 状态（按会话在途去重；失败落进快照的 error 字段，卡片里可见） */
export async function refreshGitStatus(sessionId: string): Promise<void> {
  const pending = inflight.get(sessionId);
  if (pending) return pending;
  const prev = snapshots.get(sessionId) ?? EMPTY;
  snapshots.set(sessionId, { ...prev, loading: true });
  emit();
  const promise = piRequest<PiGitStatusResponse>({ type: "git_status", sessionId })
    .then((res) => {
      // 已 release（会话关闭）：别再把手里的结果写回快照表
      if (inflight.get(sessionId) !== promise) return;
      snapshots.set(sessionId, {
        loading: false,
        repo: res.repo === true,
        branch: res.branch ?? null,
        files: res.files ?? [],
        truncated: res.truncated === true,
        error: res.ok ? null : (res.errorText ?? "读取失败"),
      });
    })
    .catch((err) => {
      if (inflight.get(sessionId) !== promise) return;
      snapshots.set(sessionId, {
        loading: false,
        repo: false,
        branch: null,
        files: [],
        truncated: false,
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      // 同一会话可能已被新一轮刷新（release 后重开）接管，只清自己那一份
      if (inflight.get(sessionId) !== promise) return;
      inflight.delete(sessionId);
      emit();
    });
  inflight.set(sessionId, promise);
  return promise;
}

/** 会话关闭时释放快照与在途请求：快照表按会话键常驻，不释放会随访问过的会话无限增长 */
export function releaseGitStatus(sessionId: string): void {
  inflight.delete(sessionId);
  if (snapshots.delete(sessionId)) emit();
}

/** 读某会话的当前快照（无缓存时给稳定的空快照，供 useSyncExternalStore 使用） */
export function getGitStatusSnapshot(sessionId: string | undefined): GitStatusSnapshot {
  return sessionId ? (snapshots.get(sessionId) ?? EMPTY) : EMPTY;
}

/** 单文件 diff（按需拉取，不进 store：一次只看一个文件） */
export async function fetchGitDiff(
  sessionId: string,
  path: string,
): Promise<{ diff: string; untracked: boolean; truncated: boolean } | null> {
  try {
    const res = await piRequest<PiGitDiffResponse>({
      type: "git_diff",
      sessionId,
      path,
    });
    if (!res.ok) return null;
    return {
      diff: res.diff ?? "",
      untracked: res.untracked === true,
      truncated: res.truncated === true,
    };
  } catch {
    return null;
  }
}

export function useGitStatus(sessionId: string | undefined): GitStatusSnapshot {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => getGitStatusSnapshot(sessionId),
    () => EMPTY,
  );
  useEffect(() => {
    if (sessionId) void refreshGitStatus(sessionId);
  }, [sessionId]);
  return snapshot;
}
