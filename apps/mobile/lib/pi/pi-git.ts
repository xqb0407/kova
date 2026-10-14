"use client";

/**
 * Git 变更（移动端）：sidecar 只读 git_status / git_diff 的镜像 store。
 *
 * 桌面端的 Git 面板走 Tauri 本地 git；远程端（网页/手机）没有该能力，所以
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
let inflight: Promise<void> | null = null;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 拉取某会话的 git 状态（在途去重；失败落进快照的 error 字段，卡片里可见） */
export async function refreshGitStatus(sessionId: string): Promise<void> {
  if (inflight) return inflight;
  const prev = snapshots.get(sessionId) ?? EMPTY;
  snapshots.set(sessionId, { ...prev, loading: true });
  emit();
  inflight = piRequest<PiGitStatusResponse>({ type: "git_status", sessionId })
    .then((res) => {
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
      inflight = null;
      emit();
    });
  return inflight;
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
    () => (sessionId ? (snapshots.get(sessionId) ?? EMPTY) : EMPTY),
    () => EMPTY,
  );
  useEffect(() => {
    if (sessionId) void refreshGitStatus(sessionId);
  }, [sessionId]);
  return snapshot;
}
