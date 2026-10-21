"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  piRequest,
  type PiMcpAuditEvent,
  type PiMcpAuditLogResponse,
  type PiMcpAuthStarted,
  type PiMcpLogLine,
  type PiMcpServerEntry,
  type PiMcpServerIcon,
  type PiMcpServerStatus,
  type PiMcpServersResponse,
  type PiMcpSecretEnvBinding,
} from "@/lib/pi/pi-bridge";
import type { PiMcpAuthFrame } from "@/lib/pi/pi-channel";
import { getWorkspace } from "@/lib/workspace/workspace-store";

/**
 * MCP 服务器（设置 → MCP）：前端镜像 store。
 * 事实源在 sidecar——三层配置（系统 ~/.kova/mcp.json / 工作区 .mcp.json / 工作区
 * 覆盖 .kova/mcp.json）+ kv 里的启停开关；这里只做清单镜像与变更动作。
 * 所有变更命令的应答都是刷新后的清单（含连接状态），改后即见；连接池热重载由
 * sidecar 完成（配置变更/禁用即断连），网关工具下一轮调用即用新配置。
 */
export type McpServerEntry = PiMcpServerEntry;
export type McpServerStatus = PiMcpServerStatus;
export type McpServerIcon = PiMcpServerIcon;
export type McpLogLine = PiMcpLogLine;
export type McpSecretEnvBinding = PiMcpSecretEnvBinding;

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
  callTimeout?: number;
  approveTools?: string[];
};

export type McpSnapshot = {
  loading: boolean;
  error: string | null;
  servers: McpServerEntry[];
  /** layer "plugin" 条目（MCP 设置页不渲染；`/` 菜单与插件详情消费） */
  pluginServers: McpServerEntry[];
  /** 本次清单对应的工作区 cwd */
  workspaceCwd: string | null;
  /** 加载诊断（坏文件/坏条目等），不致命 */
  diagnostics: string[];
};

const EMPTY: McpSnapshot = {
  loading: false,
  error: null,
  servers: [],
  pluginServers: [],
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
    pluginServers: res.pluginServers ?? [],
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

/** 变更命令统一出口：应答即新清单。超时走协议表（pi-protocol/timeouts）：
 *  这些命令都是本地配置写入 + 连接池 diff，用默认地板即可，别在这里写死数字 */
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

/** 保存（新建/编辑）。name 传编辑前的原名（改名时 sidecar 清旧条目）。
 *
 *  secretEnv 只在编辑弹窗提交：空数组 = 解除绑定；服务端会把它和
 *  secretBindingHash（打开弹窗时的 configHash）比对，配置变了且没重新确认时
 *  不会把旧密钥续到新命令上。 */
export function saveMcpServer(args: {
  layer: "system" | "workspace";
  cwd?: string | null;
  name?: string;
  definition: McpServerDraft;
  secretEnv?: McpSecretEnvBinding[];
  secretBindingHash?: string;
}): Promise<void> {
  return mutate({
    type: "save_mcp_server",
    layer: args.layer,
    ...(args.cwd ? { cwd: args.cwd } : {}),
    ...(args.name ? { name: args.name } : {}),
    definition: args.definition,
    ...(args.secretEnv !== undefined ? { secretEnv: args.secretEnv } : {}),
    ...(args.secretBindingHash ? { secretBindingHash: args.secretBindingHash } : {}),
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
  layer: "system" | "workspace" | "plugin",
  name: string,
  enabled: boolean,
  cwd?: string | null,
  pluginId?: string,
): Promise<void> {
  return mutate({
    type: "set_mcp_server_enabled",
    layer,
    name,
    enabled,
    ...(pluginId ? { pluginId } : {}),
    ...(cwd ? { cwd } : {}),
  });
}

/** 测试连接：强制重新握手，返回单台状态（不改变清单，状态由调用方展示）。
 *  sidecar 侧派活执行（不占其管理队列），应答最长 ~20s（连接 10s + 列工具 10s）。
 *  超时不传：协议表（pi-protocol/timeouts 的 test_mcp_server）已给足，写短只会白报超时。
 */
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

/** OAuth 授权（http 服务器「授权」按钮）第一阶段：sidecar 起本地回调服务、
 *  生成授权链接并尝试拉起浏览器，受理应答带回授权链接。
 *  用户在浏览器里批准可能长达几分钟——那段时间不再占请求配对，结果经
 *  mcp_auth_result 自发帧回流（见 setMcpAuthHandler / 本模块的常驻订阅）。
 *  超时不传：协议表（pi-protocol/timeouts 的 authorize_mcp_server）只兜住
 *  「授权链接生成」这一步（侧车侧上限 30s + 通道余量），主进程配对自动再多等
 *  一层余量，让这里的错误是 sidecar 的明确原因而非本地悬空。
 *  刻意不走 mutate：授权失败不是「清单加载失败」，不写共享快照的 error。 */
export async function authorizeMcpServer(
  name: string,
  cwd?: string | null,
): Promise<PiMcpAuthStarted> {
  const started = await piRequest<PiMcpAuthStarted>({
    type: "authorize_mcp_server",
    name,
    ...(cwd ? { cwd } : {}),
  });
  // 受理时先把该行状态并入镜像（connecting/backoff）；最终清单随结果帧整包并入
  current = {
    ...current,
    servers: current.servers.map((s) => (s.name === name ? { ...s, status: started.status } : s)),
  };
  emit();
  return started;
}

/** MCP 观测审计事件（sidecar 落盘 JSONL，跨重启持久；只含元数据） */
export type McpAuditEvent = PiMcpAuditEvent;

/** 拉取审计事件：name 省略 = 全部服务器（全局视图）；时间升序返回，前端倒序展示。
 *  读的是本地文件，无需长超时。 */
export async function fetchMcpAuditLog(
  name?: string,
  limit = 200,
): Promise<McpAuditEvent[]> {
  const res = await piRequest<PiMcpAuditLogResponse>({
    type: "get_mcp_audit_log",
    ...(name ? { name } : {}),
    limit,
  });
  return res.events;
}

/** 拉取某台服务器的连接错误日志（sidecar 环形缓冲；按名字聚合，不分层）。
 *  日志在握手失败/传输错误时记录，跨断开保留——弹窗打开时取一次即可。 */
export async function fetchMcpServerLog(name: string): Promise<McpLogLine[]> {
  const res = await piRequest<{
    type: "mcp_server_log";
    name: string;
    lines: McpLogLine[];
  }>({
    type: "get_mcp_server_log",
    name,
  });
  return res.lines;
}

/** 取消 OAuth 授权：清掉该服务器 URL 的存量凭据并断开（只动授权，不删配置）。
 *  与 authorizeMcpServer 同理不走 mutate：失败单独呈现，不污染清单错误。 */
export async function revokeMcpServerAuth(name: string, cwd?: string | null): Promise<void> {
  const res = await piRequest<PiMcpServersResponse>({
    type: "revoke_mcp_server_auth",
    name,
    ...(cwd ? { cwd } : {}),
  });
  current = fromResponse(res);
  emit();
}

/** 单台服务器的工具清单条目（展开行时呈现） */
export type McpToolInfo = { name: string; description?: string };

/** 拉取某台服务器的工具清单：sidecar 优先元数据缓存（断开态也可读，同步返回），
 *  缺失才握手——懒服务器首次展开要等几秒。超时不传：协议表（get_mcp_server_tools）
 *  已按握手上限给足；sidecar 侧同样是派活执行，不占它的管理队列。 */
export async function fetchMcpServerTools(
  name: string,
  cwd?: string | null,
): Promise<McpToolInfo[]> {
  const res = await piRequest<{
    type: "mcp_server_tools";
    name: string;
    tools: McpToolInfo[];
  }>({ type: "get_mcp_server_tools", name, ...(cwd ? { cwd } : {}) });
  return res.tools;
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

// ---------------------------------------------------------------------------
// OAuth 授权结果帧（两段式第二阶段）
// ---------------------------------------------------------------------------

/** 授权页可注册结果回调（清「等待授权中」卡片、呈现失败原因）；传 null 注销 */
let authHandler: ((frame: PiMcpAuthFrame) => void) | null = null;
export function setMcpAuthHandler(cb: ((frame: PiMcpAuthFrame) => void) | null): void {
  authHandler = cb;
}

let authWatchStarted = false;

/** 常驻订阅：帧自带刷新后的清单，cwd 对得上就整包并入镜像（省一轮往返）；
 *  对不上（设置页正在看别的目录）只回调订阅方，由它按自己的 cwd 重拉。 */
function startAuthWatch(): void {
  if (authWatchStarted || typeof window === "undefined") return;
  authWatchStarted = true;
  void (async () => {
    try {
      const { getPiChannel } = await import("@/lib/pi/pi-channel");
      const channel = getPiChannel();
      if (!channel.subscribeMcpAuth) return;
      await channel.subscribeMcpAuth((frame) => {
        if (Array.isArray(frame.servers) && frame.workspaceCwd === current.workspaceCwd) {
          current = {
            loading: false,
            error: null,
            servers: frame.servers,
            pluginServers: frame.pluginServers ?? [],
            workspaceCwd: frame.workspaceCwd,
            diagnostics: frame.diagnostics ?? [],
          };
          emit();
        }
        authHandler?.(frame);
      });
      // 通道切换/重连不做特殊处理：结果帧丢失时用户在设置页手动刷新即可
    } catch {
      /* 通道不可用（非桌面环境）：授权页仍有受理应答与手动刷新兜底 */
    }
  })();
}

// client bundle 加载即按当前工作区水合（SSR 端返回空快照，不请求）+ 挂授权结果订阅
if (typeof window !== "undefined") {
  void refreshMcpServers(getWorkspace());
  startAuthWatch();
}
