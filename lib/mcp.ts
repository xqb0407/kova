"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  piRequest,
  type PiMcpServerEntry,
  type PiMcpServerStatus,
  type PiMcpServersResponse,
} from "@/lib/pi-bridge";
import { getWorkspace } from "@/lib/workspace-store";

/**
 * MCP 服务器（设置 → MCP）：前端镜像 store。
 * 事实源在 sidecar——三层配置（系统 ~/.xulux/mcp.json / 工作区 .mcp.json / 工作区
 * 覆盖 .xulux/mcp.json）+ kv 里的启停开关；这里只做清单镜像与变更动作。
 * 所有变更命令的应答都是刷新后的清单（含连接状态），改后即见；连接池热重载由
 * sidecar 完成（配置变更/禁用即断连），网关工具下一轮调用即用新配置。
 */
export type McpServerEntry = PiMcpServerEntry;
export type McpServerStatus = PiMcpServerStatus;

/** 编辑器表单载荷（字段与 sidecar mcp-config 的 McpDraft 对齐） */
export type McpServerDraft = {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  lifecycle?: "lazy" | "eager" | "keep-alive";
  idleTimeout?: number;
  approveTools?: string[];
};

export type McpSnapshot = {
  loading: boolean;
  error: string | null;
  servers: McpServerEntry[];
  /** 本次清单对应的工作区 cwd */
  workspaceCwd: string | null;
  /** 加载诊断（坏文件/坏条目等），不致命 */
  diagnostics: string[];
};

const EMPTY: McpSnapshot = {
  loading: false,
  error: null,
  servers: [],
  workspaceCwd: null,
  diagnostics: [],
};

let current: McpSnapshot = EMPTY;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function fromResponse(res: PiMcpServersResponse): McpSnapshot {
  return {
    loading: false,
    error: null,
    servers: res.servers,
    workspaceCwd: res.workspaceCwd,
    diagnostics: res.diagnostics,
  };
}

/** 拉取清单（sidecar 不可用则保持旧镜像并记录错误） */
export async function refreshMcpServers(cwd?: string | null): Promise<void> {
  current = { ...current, loading: true };
  emit();
  try {
    const res = await piRequest<PiMcpServersResponse>({
      type: "list_mcp_servers",
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
    const res = await piRequest<PiMcpServersResponse>(payload);
    current = fromResponse(res);
    emit();
  } catch (err) {
    current = {
      ...current,
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    };
    emit();
    throw err;
  }
}

/** 保存（新建/编辑）。name 传编辑前的原名（改名时 sidecar 清旧条目） */
export function saveMcpServer(args: {
  layer: "system" | "workspace";
  cwd?: string | null;
  name?: string;
  definition: McpServerDraft;
}): Promise<void> {
  return mutate({
    type: "save_mcp_server",
    layer: args.layer,
    ...(args.cwd ? { cwd: args.cwd } : {}),
    ...(args.name ? { name: args.name } : {}),
    definition: args.definition,
  });
}

export function deleteMcpServer(
  layer: "system" | "workspace",
  name: string,
  cwd?: string | null,
): Promise<void> {
  return mutate({
    type: "delete_mcp_server",
    layer,
    name,
    ...(cwd ? { cwd } : {}),
  });
}

export function setMcpServerEnabled(
  layer: "system" | "workspace",
  name: string,
  enabled: boolean,
  cwd?: string | null,
): Promise<void> {
  return mutate({
    type: "set_mcp_server_enabled",
    layer,
    name,
    enabled,
    ...(cwd ? { cwd } : {}),
  });
}

/** 测试连接：强制重新握手，返回单台状态（不改变清单，状态由调用方展示） */
export async function testMcpServer(
  layer: "system" | "workspace",
  name: string,
  cwd?: string | null,
): Promise<PiMcpServerStatus> {
  const res = await piRequest<{
    type: "mcp_server_test";
    status: PiMcpServerStatus;
  }>({
    type: "test_mcp_server",
    layer,
    name,
    ...(cwd ? { cwd } : {}),
  });
  // 测试后的状态写入镜像，行徽章即时反映
  current = {
    ...current,
    servers: current.servers.map((s) => (s.name === name ? { ...s, status: res.status } : s)),
  };
  emit();
  return res.status;
}

/** 订阅清单快照；cwd 变化时自动重取（工作区层随所选工作区呈现） */
export function useMcpServers(cwd: string | null): McpSnapshot {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => current,
    () => EMPTY,
  );
  const lastCwd = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastCwd.current === cwd) return;
    lastCwd.current = cwd;
    void refreshMcpServers(cwd);
  }, [cwd]);
  return snapshot;
}

// client bundle 加载即按当前工作区水合（SSR 端返回空快照，不请求）
if (typeof window !== "undefined") void refreshMcpServers(getWorkspace());
