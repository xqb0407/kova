"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  piRequest,
  type PiKnowledgeSource,
  type PiSubagentEntry,
  type PiSubagentMemoryMode,
  type PiSubagentScope,
  type PiSubagentsResponse,
} from "@/lib/pi/pi-bridge";
import { getWorkspace } from "@/lib/workspace/workspace-store";

/**
 * 子智能体（设置 → 子智能体）：前端镜像 store。
 * 事实源在 sidecar——三层 YAML 定义（内置/系统/工作区）+ kv 里的开关与工作区信任；
 * 这里只做清单镜像与变更动作。所有变更命令的应答都是刷新后的清单，改后即见；
 * 活动会话的工具组热重载由 sidecar 完成，下一个 turn 生效。
 */
export type SubagentEntry = PiSubagentEntry;
export type SubagentScope = PiSubagentScope;
export type { PiKnowledgeSource, PiSubagentMemoryMode };

/**
 * 旧版 sidecar 的回落工具目录（应答缺 grantableTools 时的兜底）。
 * 与引入能力模型前的六个内置工具一致——UI 不会因为 sidecar 没升级而白屏。
 */
export const FALLBACK_GRANTABLE_TOOLS = [
  "read",
  "glob",
  "grep",
  "bash",
  "edit",
  "write",
] as const;

/** 表单/原文两种保存载荷共用的草稿形状 */
export type SubagentDraft = {
  name: string;
  description: string;
  tools: string[];
  maxTurns?: number;
  model?: string;
  prompt: string;
  /** 技能白名单（按名）；空 = 该子代理看不到任何技能 */
  skills?: string[];
  /** MCP 服务器白名单；空 = 够不到任何 MCP 服务器 */
  mcpServers?: string[];
  /** 声明式知识源 */
  knowledge?: PiKnowledgeSource[];
  /** 记忆档位；不传 = 无记忆（不跟随主记忆的全局开关） */
  memory?: PiSubagentMemoryMode;
};

export type SubagentsSnapshot = {
  loading: boolean;
  error: string | null;
  agents: SubagentEntry[];
  /** scope "plugin" 条目（子智能体设置页不渲染；`@` 提及与插件详情消费） */
  pluginAgents: SubagentEntry[];
  /** 本次清单对应的工作区 cwd */
  workspaceCwd: string | null;
  /** 加载诊断（坏文件等），不致命 */
  diagnostics: string[];
  /** 可授予工具目录（sidecar 事实源）；旧版 sidecar 缺省时 UI 回落旧 6 项 */
  grantableTools: string[];
};

const EMPTY: SubagentsSnapshot = {
  loading: false,
  error: null,
  agents: [],
  pluginAgents: [],
  workspaceCwd: null,
  diagnostics: [],
  grantableTools: [...FALLBACK_GRANTABLE_TOOLS],
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
    pluginAgents: res.pluginAgents ?? [],
    workspaceCwd: res.workspaceCwd,
    diagnostics: res.diagnostics,
    // 旧 sidecar 应答没有这个字段：回落旧 6 项，UI 不白屏
    grantableTools: res.grantableTools?.length
      ? res.grantableTools
      : [...FALLBACK_GRANTABLE_TOOLS],
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
  pluginId?: string,
): Promise<void> {
  return mutate({
    type: "set_subagent_enabled",
    scope,
    name,
    enabled,
    ...(pluginId ? { pluginId } : {}),
    ...(cwd ? { cwd } : {}),
  });
}

/**
 * 设模型覆盖（"provider/modelId"）。落 sidecar 的 kv 而不是定义文件——内置与插件
 * 两层永不落盘，只有覆盖这条路能让它们选模型；空串清除覆盖（回落会话模型）。
 */
export function setSubagentModel(
  scope: SubagentScope,
  name: string,
  model: string,
  cwd?: string | null,
  pluginId?: string,
): Promise<void> {
  return mutate({
    type: "set_subagent_model",
    scope,
    name,
    model,
    ...(pluginId ? { pluginId } : {}),
    ...(cwd ? { cwd } : {}),
  });
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
