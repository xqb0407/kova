"use client";

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/tauri";

/**
 * Rust 侧 git 命令（src-tauri/src/git.rs）的 invoke 封装 + Tauri 门控。
 * 网页端（远程 WS）没有本地 FS：读类接口整体返回 null（等同"git 不可用"），
 * 写类接口直接 reject；UI 据此静默降级，不弹错。
 *
 * 错误约定（Rust 侧字符串前缀）：
 *   no-git / not-repo / cwd-not-allowed / no-checkpoint / apply-conflict / …
 * 用 gitErrorCode() 分类；除 not-repo（读类归一为 null）外均向上抛。
 */

export type GitProbe = { available: boolean; version: string | null };

export type GitFileStatus = "A" | "M" | "D" | "R" | "C" | "?" | "U";

export type GitFileEntry = {
  path: string;
  oldPath: string | null;
  status: GitFileStatus;
  /** 索引侧（X 位）有变更 = 已暂存 */
  staged: boolean;
};

export type GitLastCommit = {
  hash: string;
  short: string;
  time: number;
  subject: string;
};

export type GitStatusInfo = {
  branch: string;
  detached: boolean;
  unborn: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileEntry[];
  dirty: number;
  lastCommit: GitLastCommit | null;
};

export type GitDiffFile = GitFileEntry & {
  added: number;
  removed: number;
  binary: boolean;
  patch: string;
};

export type GitDiffResult = { files: GitDiffFile[]; truncated: boolean };

export type GitLogEntry = {
  hash: string;
  short: string;
  time: number;
  author: string;
  subject: string;
};

/** 提交图谱的 ref 标签（Rust 侧解析 --decorate=full 得到） */
export type GitGraphRef = {
  name: string;
  kind: "head" | "branch" | "remote" | "tag";
};

export type GitGraphEntry = {
  hash: string;
  parents: string[];
  refs: GitGraphRef[];
  author: string;
  time: number;
  subject: string;
};

export type GitBranches = {
  current: string | null;
  detached: boolean;
  branches: { name: string; current: boolean; upstream: string | null }[];
};

export type GitErrorCode =
  | "no-git"
  | "not-repo"
  | "cwd-not-allowed"
  | "no-checkpoint"
  | "apply-conflict"
  | "web";

export function gitErrorCode(err: unknown): GitErrorCode | null {
  const msg =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : String(err);
  for (const code of [
    "no-git",
    "not-repo",
    "cwd-not-allowed",
    "no-checkpoint",
    "apply-conflict",
  ] as const) {
    if (msg.startsWith(code)) return code;
  }
  return null;
}

/** not-repo 归一为 null（UI 的"非仓库"态）；其余错误继续抛 */
function swallowNotRepo(err: unknown): null {
  if (gitErrorCode(err) === "not-repo" || gitErrorCode(err) === "no-git") {
    return null;
  }
  throw err;
}

const NOT_ON_WEB = "web: git is desktop-only";

export async function gitProbe(): Promise<GitProbe> {
  if (!isTauri()) return { available: false, version: null };
  try {
    return await invoke<GitProbe>("git_probe");
  } catch {
    return { available: false, version: null };
  }
}

/** null = 非 git 仓库 / git 不可用 / 网页端 */
export async function gitStatus(cwd: string): Promise<GitStatusInfo | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<GitStatusInfo>("git_status", { cwd });
  } catch (err) {
    return swallowNotRepo(err);
  }
}

/** opts.checkpoint：对比检查点（本次 agent 运行），否则对比 HEAD */
export async function gitDiff(
  cwd: string,
  opts?: { checkpoint?: string },
): Promise<GitDiffResult | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<GitDiffResult>("git_diff", {
      cwd,
      checkpoint: opts?.checkpoint ?? null,
    });
  } catch (err) {
    return swallowNotRepo(err);
  }
}

export async function gitShow(
  cwd: string,
  reference: string,
  path: string,
): Promise<{ content: string; truncated: boolean; binary: boolean } | null> {
  if (!isTauri()) return null;
  try {
    return await invoke("git_show", { cwd, reference, path });
  } catch (err) {
    return swallowNotRepo(err);
  }
}

/** 读工作区（未提交）文件内容；diff 分隔条展开补水用。非仓库/读不到返回 null */
export async function gitWorktreeRead(
  cwd: string,
  path: string,
): Promise<{ content: string; truncated: boolean; binary: boolean } | null> {
  if (!isTauri()) return null;
  try {
    return await invoke("git_worktree_read", { cwd, path });
  } catch (err) {
    return swallowNotRepo(err);
  }
}

export async function gitLog(
  cwd: string,
  limit = 50,
): Promise<GitLogEntry[] | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<GitLogEntry[]>("git_log", { cwd, limit });
  } catch (err) {
    return swallowNotRepo(err);
  }
}

/** 拓扑序提交图谱（含本地/远端分支）；非仓库返回 null */
export async function gitLogGraph(
  cwd: string,
  limit = 200,
): Promise<GitGraphEntry[] | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<GitGraphEntry[]>("git_log_graph", { cwd, limit });
  } catch (err) {
    return swallowNotRepo(err);
  }
}

/** 运行前快照；非仓库/无 git 时返回 null（静默跳过检查点功能） */
export async function gitCheckpointCreate(
  cwd: string,
  tag: string,
): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const r = await invoke<{ hash: string }>("git_checkpoint_create", {
      cwd,
      tag,
    });
    return r.hash;
  } catch (err) {
    const code = gitErrorCode(err);
    if (code === "not-repo" || code === "no-git" || code === "cwd-not-allowed") {
      return null;
    }
    throw err;
  }
}

export async function gitCheckpointDiff(
  cwd: string,
  hash: string,
): Promise<GitDiffResult | null> {
  return gitDiff(cwd, { checkpoint: hash });
}

/** 撤销回快照；冲突（用户手改导致 patch 对不上）reject，前缀 apply-conflict */
export async function gitCheckpointRestore(
  cwd: string,
  hash: string,
): Promise<boolean> {
  if (!isTauri()) throw NOT_ON_WEB;
  await invoke("git_checkpoint_restore", { cwd, hash });
  return true;
}

/** on=true 暂存 / false 取消暂存；paths 为空 = 全部 */
export async function gitStage(
  cwd: string,
  paths: string[],
  on: boolean,
): Promise<void> {
  if (!isTauri()) throw NOT_ON_WEB;
  await invoke("git_stage", { cwd, paths, on });
}

export async function gitCommit(
  cwd: string,
  message: string,
): Promise<string> {
  if (!isTauri()) throw NOT_ON_WEB;
  const r = await invoke<{ hash: string }>("git_commit", { cwd, message });
  return r.hash;
}

export async function gitBranches(cwd: string): Promise<GitBranches | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<GitBranches>("git_branches", { cwd });
  } catch (err) {
    return swallowNotRepo(err);
  }
}

export async function gitCheckout(
  cwd: string,
  name: string,
  create: boolean,
): Promise<void> {
  if (!isTauri()) throw NOT_ON_WEB;
  await invoke("git_checkout", { cwd, name, create });
}
