"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { piRequest, type PiSubagentEntry, type PiSubagentPending, type PiSubagentScope, type PiSubagentsResponse } from "@/lib/pi-bridge";
import { getWorkspace } from "@/lib/workspace-store";

/**
 * 子智能体（设置 → 子智能体）：前端镜像 store。
 * 事实源在 sidecar——三层 YAML 定义（内置/系统/工作区）+ kv 里的开关与工作区信任；
 * 这里只做清单镜像与变更动作。所有变更命令的应答都是刷新后的清单，改后即见；
 * 活动会话的工具组热重载由 sidecar 完成，下一个 turn 生效。
 */
export type SubagentEntry = PiSubagentEntry;
export type SubagentPending = PiSubagentPending;
export type SubagentScope = PiSubagentScope;

/** 表单/原文两种保存载荷共用的草稿形状 */
export type SubagentDraft = {
  name: string;
  description: string;
  tools: string[];
  maxTurns?: number;
  model?: string;
  prompt: string;
};

export type SubagentsSnapshot = {
  loading: boolean;
  error: string | null;
  agents: SubagentEntry[];
  /** 工作区发现但未信任的定义（待批准） */
  pendingWorkspace: SubagentPending[];
  trustedWorkspace: boolean;
  /** 本次清单对应的工作区 cwd */
  workspaceCwd: string | null;
  /** 加载诊断（坏文件等），不致命 */
  diagnostics: string[];
};

const EMPTY: SubagentsSnapshot = {
  loading: false,
  error: null,
  agents: [],
  pendingWorkspace: [],
  trustedWorkspace: false,
  workspaceCwd: null,
  diagnostics: [],
};

let current: SubagentsSnapshot = EMPTY;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function fromResponse(res: PiSubagentsResponse): SubagentsSnapshot {
  return {
    loading: false,
    error: null,
    agents: res.agents,
    pendingWorkspace: res.pendingWorkspace,
    trustedWorkspace: res.trustedWorkspace,
    workspaceCwd: res.workspaceCwd,
    diagnostics: res.diagnostics,
  };
}

function fail(err: unknown): never {
  current = { ...current, loading: false, error: err instanceof Error ? err.message : String(err) };
  emit();
  throw err;
}

/** 拉取清单（sidecar 不可用则保持旧镜像并记录错误） */
export async function refreshSubagents(cwd?: string | null): Promise<void> {
  current = { ...current, loading: true };
  emit();
  try {
    const res = await piRequest<PiSubagentsResponse>({
      type: "list_subagents",
      ...(cwd ? { cwd } : {}),
    });
    current = fromResponse(res);
    emit();
  } catch (err) {
    current = { ...current, loading: false, error: err instanceof Error ? err.message : String(err) };
    emit();
  }
}

/** 变更命令统一出口：应答即新清单 */
async function mutate(payload: Record<string, unknown>): Promise<void> {
  try {
    const res = await piRequest<PiSubagentsResponse>(payload);
    current = fromResponse(res);
    emit();
  } catch (err) {
    fail(err);
  }
}

/** 保存（新建/编辑）。raw 为 YAML 原文模式；name 传编辑前的原名（改名时 sidecar 清旧文件） */
export function saveSubagent(args: {
  scope: "system" | "workspace";
  cwd?: string | null;
  name?: string;
  definition?: SubagentDraft;
  raw?: string;
}): Promise<void> {
  return mutate({
    type: "save_subagent",
    scope: args.scope,
    ...(args.cwd ? { cwd: args.cwd } : {}),
    ...(args.name ? { name: args.name } : {}),
    ...(args.raw !== undefined ? { raw: args.raw } : { definition: args.definition }),
  });
}

export function deleteSubagent(
  scope: "system" | "workspace",
  name: string,
  cwd?: string | null,
): Promise<void> {
  return mutate({
    type: "delete_subagent",
    scope,
    name,
    ...(cwd ? { cwd } : {}),
  });
}

export function setSubagentEnabled(
  scope: SubagentScope,
  name: string,
  enabled: boolean,
  cwd?: string | null,
): Promise<void> {
  return mutate({
    type: "set_subagent_enabled",
    scope,
    name,
    enabled,
    ...(cwd ? { cwd } : {}),
  });
}

export function setWorkspaceTrust(cwd: string, trusted: boolean): Promise<void> {
  return mutate({ type: "set_workspace_trust", cwd, trusted });
}

/** 订阅清单快照；cwd 变化时自动重取（工作区层随所选工作区呈现） */
export function useSubagents(cwd: string | null): SubagentsSnapshot {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => current,
    () => EMPTY,
  );
  const lastCwd = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastCwd.current === cwd) return;
    lastCwd.current = cwd;
    void refreshSubagents(cwd);
  }, [cwd]);
  return snapshot;
}

// client bundle 加载即按当前工作区水合（SSR 端返回空快照，不请求）
if (typeof window !== "undefined") void refreshSubagents(getWorkspace());
