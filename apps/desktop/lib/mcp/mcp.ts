"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  piRequest,
  type PiMcpAuditEvent,
  type PiMcpAuditLogResponse,
  type PiMcpAuthStarted,
  type PiMcpLogLine,
  type PiMcpPromptResponse,
  type PiMcpPromptsResponse,
  type PiMcpResourceContentResponse,
  type PiMcpResourcesResponse,
  type PiMcpServerEntry,
  type PiMcpServerIcon,
  type PiMcpServerStatus,
  type PiMcpServersResponse,
  type PiMcpSecretEnvBinding,
} from "@/lib/pi/pi-bridge";
import type {
  McpCapabilityFlags,
  McpPromptMeta,
  McpResourceMeta,
  McpResourceTemplateMeta,
} from "pi-protocol";
import type { PiMcpAuthFrame } from "@/lib/pi/pi-channel";
import { getWorkspace, getWorkspaceSource } from "@/lib/workspace/workspace-store";

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
export type McpResource = McpResourceMeta;
export type McpResourceTemplate = McpResourceTemplateMeta;
export type McpPrompt = McpPromptMeta;
export type McpCapabilities = McpCapabilityFlags;

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
  /** 工具白名单（Connector 安装时预置；授权面收窄） */
  enabledTools?: string[];
  /** Connector 目录身份（Connectors 市场安装时写入） */
  connectorId?: string;
};

export type McpSnapshot = {
  loading: boolean;
  /** 至少成功拿到过一次该 cwd 的完整清单（首屏/失效芯片判断用） */
  loaded: boolean;
  error: string | null;
  servers: McpServerEntry[];
  /** layer "plugin" 条目（MCP 设置页只读分组；`/` 菜单与插件详情消费） */
  pluginServers: McpServerEntry[];
  /** 本次清单对应的工作区 cwd */
  workspaceCwd: string | null;
  /** 加载诊断（坏文件/坏条目等），不致命 */
  diagnostics: string[];
};

const EMPTY: McpSnapshot = {
  loading: false,
  loaded: false,
  error: null,
  servers: [],
  pluginServers: [],
  workspaceCwd: null,
  diagnostics: [],
};

// 清单按 cwd 分桶：设置页可以浏览与当前会话不同的工作区，共用一个 snapshot
// 会互相覆盖（连接器面板看到设置页正在浏览的目录的服务器）。key = cwd ?? ""。
const snapshots = new Map<string, McpSnapshot>();
// 每个 cwd 的请求代次：慢的 list/reconcile 响应不能覆盖后发的请求结果。
const snapshotSeq = new Map<string, number>();
const listeners = new Set<() => void>();

const keyOf = (cwd?: string | null): string => cwd ?? "";

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function bumpSnapshotSeq(key: string): number {
  const seq = (snapshotSeq.get(key) ?? 0) + 1;
  snapshotSeq.set(key, seq);
  return seq;
}

/** 把单台服务器的最新状态写回两个清单：连接器/设置页按层分桶，插件行的
 *  状态只住 pluginServers，漏掉就会永远显示「未连接」 */
function patchServerStatus(
  list: McpServerEntry[],
  name: string,
  status: PiMcpServerStatus,
): McpServerEntry[] {
  return list.map((s) => (s.name === name ? { ...s, status } : s));
}

function fromResponse(res: PiMcpServersResponse): McpSnapshot {
  return {
    loading: false,
    loaded: true,
    error: null,
    servers: res.servers,
    pluginServers: res.pluginServers ?? [],
    workspaceCwd: res.workspaceCwd,
    diagnostics: res.diagnostics,
  };
}

/** 把单台服务器的最新状态写回它所属 cwd 的清单（常规 + 插件两个数组） */
function patchSnapshotStatus(
  cwd: string | null | undefined,
  name: string,
  status: PiMcpServerStatus,
): void {
  const key = keyOf(cwd);
  const snap = snapshots.get(key) ?? EMPTY;
  snapshots.set(key, {
    ...snap,
    servers: patchServerStatus(snap.servers, name, status),
    pluginServers: patchServerStatus(snap.pluginServers, name, status),
  });
  emit();
}

/** 拉取清单（sidecar 不可用则保持该 cwd 的旧镜像并记录错误） */
export async function refreshMcpServers(cwd?: string | null): Promise<void> {
  const key = keyOf(cwd);
  const seq = bumpSnapshotSeq(key);
  const prev = snapshots.get(key) ?? EMPTY;
  snapshots.set(key, { ...prev, loading: true });
  emit();
  try {
    const res = await piRequest<PiMcpServersResponse>({
      type: "list_mcp_servers",
      ...(cwd ? { cwd } : {}),
    });
    if (snapshotSeq.get(key) !== seq) return;
    snapshots.set(key, fromResponse(res));
    emit();
  } catch (err) {
    if (snapshotSeq.get(key) !== seq) return;
    snapshots.set(key, {
      ...(snapshots.get(key) ?? EMPTY),
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    });
    emit();
  }
}

// 同一 cwd 的 reconcile 去重：workspace 切换时 setWorkspace 与各 useMcpServers
// 实例可能同时触发，重复 applyConfig 没有意义。
const inflightReconciles = new Map<string, Promise<void>>();

/**
 * workspace 切换后重调连接池：以新 cwd 的启用集合做 diff，断开不再属于当前
 * 工作区的服务器。与 refresh 的区别是它会真的改连接池（list 只读），所以只在
 * 当前 workspace 变化时调用；设置页浏览其它目录仍走 refresh。
 */
export function reconcileMcpConnections(
  cwd?: string | null,
): Promise<void> {
  // 只允许当前 workspace：快速切换 A→B 时，A 的迟到调用不应再把全局池切回 A。
  // 设置页浏览其它目录只走 refresh，不会走到这里。
  if (keyOf(cwd) !== keyOf(getWorkspace())) return Promise.resolve();

  const key = keyOf(cwd);
  const existing = inflightReconciles.get(key);
  if (existing) return existing;

  const flight = (async () => {
    const seq = bumpSnapshotSeq(key);
    const prev = snapshots.get(key) ?? EMPTY;
    snapshots.set(key, { ...prev, loading: true });
    emit();
    try {
      const res = await piRequest<PiMcpServersResponse>({
        type: "reload_mcp_connections",
        ...(cwd ? { cwd } : {}),
      });
      if (snapshotSeq.get(key) !== seq) return;
      snapshots.set(key, fromResponse(res));
      emit();
    } catch (err) {
      if (snapshotSeq.get(key) !== seq) return;
      snapshots.set(key, {
        ...(snapshots.get(key) ?? EMPTY),
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
      emit();
    }
  })().finally(() => {
    inflightReconciles.delete(key);
  });

  inflightReconciles.set(key, flight);
  return flight;
}

/** 变更命令统一出口：应答即新清单。超时走协议表（pi-protocol/timeouts）：
 *  这些命令都是本地配置写入 + 连接池 diff，用默认地板即可，别在这里写死数字。
 *  viewCwd 用于「命令本身没带 cwd（系统层），但调用方正在看某个工作区视图」：
 *  响应只含系统/插件层，不能整包覆盖该视图，需再拉一次该 cwd 的完整清单。 */
async function mutate(
  payload: Record<string, unknown>,
  viewCwd?: string | null,
): Promise<void> {
  try {
    const res = await piRequest<PiMcpServersResponse>(payload);
    const key = keyOf(res.workspaceCwd);
    bumpSnapshotSeq(key);
    snapshots.set(key, fromResponse(res));
    emit();
    const viewKey = viewCwd === undefined ? null : keyOf(viewCwd);
    if (viewKey !== null && viewKey !== key) {
      await refreshMcpServers(viewCwd);
    } else if (key === "" && viewKey === null) {
      // 系统层命令没带 cwd：active 工作区视图也需要感知（enable/删除是全局的）
      const active = getWorkspace();
      if (keyOf(active) !== key) void refreshMcpServers(active);
    }
  } catch (err) {
    const key = keyOf(
      viewCwd !== undefined
        ? viewCwd
        : typeof payload.cwd === "string"
          ? payload.cwd
          : null,
    );
    snapshots.set(key, {
      ...(snapshots.get(key) ?? EMPTY),
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    });
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
  /** 调用方正在看的工作区视图（编辑弹窗打开时的 cwd）；用于回写对应快照 */
  viewCwd?: string | null;
  name?: string;
  definition: McpServerDraft;
  secretEnv?: McpSecretEnvBinding[];
  secretBindingHash?: string;
}): Promise<void> {
  return mutate(
    {
      type: "save_mcp_server",
      layer: args.layer,
      ...(args.cwd ? { cwd: args.cwd } : {}),
      ...(args.name ? { name: args.name } : {}),
      definition: args.definition,
      ...(args.secretEnv !== undefined ? { secretEnv: args.secretEnv } : {}),
      ...(args.secretBindingHash ? { secretBindingHash: args.secretBindingHash } : {}),
    },
    args.viewCwd,
  );
}

export function deleteMcpServer(
  layer: "system" | "workspace",
  name: string,
  cwd?: string | null,
  viewCwd?: string | null,
): Promise<void> {
  return mutate(
    {
      type: "delete_mcp_server",
      layer,
      name,
      ...(cwd ? { cwd } : {}),
    },
    viewCwd,
  );
}

export function setMcpServerEnabled(
  layer: "system" | "workspace" | "plugin",
  name: string,
  enabled: boolean,
  cwd?: string | null,
  pluginId?: string,
  viewCwd?: string | null,
): Promise<void> {
  return mutate(
    {
      type: "set_mcp_server_enabled",
      layer,
      name,
      enabled,
      ...(pluginId ? { pluginId } : {}),
      ...(cwd ? { cwd } : {}),
    },
    viewCwd,
  );
}

/** 同一台服务器（layer + cwd + name）的握手去重：设置页与连接器面板可能同时
 *  点「连接」，两条 test_mcp_server 会各自先 disconnect 再握手，后一条会把
 *  前一条刚建的连接顶掉，最终一边成功一边回报 idle/backoff。共享同一个
 *  in-flight Promise，两个调用方都拿到同一份结果。 */
const inflightTests = new Map<string, Promise<PiMcpServerStatus>>();

/** 测试/连接：强制重新握手，返回单台状态（清单由本模块回写，调用方据状态提示）。
 *  「测试连接」与连接器面板里点「连接」同走这一条：sidecar 侧派活执行（不占
 *  其管理队列），应答最长 ~20s（连接 10s + 列工具 10s）。
 *  超时不传：协议表（pi-protocol/timeouts 的 test_mcp_server）已给足，写短只会白报超时。
 */
export function testMcpServer(
  layer: "system" | "workspace" | "plugin",
  name: string,
  cwd?: string | null,
): Promise<PiMcpServerStatus> {
  const key = `${layer}\u0000${cwd ?? ""}\u0000${name}`;
  const existing = inflightTests.get(key);
  if (existing) return existing;

  const flight = (async () => {
    const res = await piRequest<{
      type: "mcp_server_test";
      status: PiMcpServerStatus;
    }>({
      type: "test_mcp_server",
      layer,
      name,
      ...(cwd ? { cwd } : {}),
    });
    // 测试后的状态写入该 cwd 的镜像：settings 的常规行与插件行都能即时反映
    const key = keyOf(cwd);
    bumpSnapshotSeq(key);
    patchSnapshotStatus(cwd, name, res.status);
    return res.status;
  })().finally(() => {
    inflightTests.delete(key);
  });

  inflightTests.set(key, flight);
  return flight;
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
  // 受理时先把该行状态并入该 cwd 的镜像（connecting/backoff）；最终清单随结果帧整包并入
  const key = keyOf(cwd);
  bumpSnapshotSeq(key);
  patchSnapshotStatus(cwd, name, started.status);
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
 *  与 authorizeMcpServer 同理不走 mutate：失败单独呈现，不污染清单错误。
 *  viewCwd 用于系统层命令（不带 cwd）时回写调用方正在看的视图。 */
export async function revokeMcpServerAuth(
  name: string,
  cwd?: string | null,
  viewCwd?: string | null,
): Promise<void> {
  const res = await piRequest<PiMcpServersResponse>({
    type: "revoke_mcp_server_auth",
    name,
    ...(cwd ? { cwd } : {}),
  });
  const key = keyOf(res.workspaceCwd);
  bumpSnapshotSeq(key);
  snapshots.set(key, fromResponse(res));
  emit();
  const viewKey = viewCwd === undefined ? null : keyOf(viewCwd);
  if (viewKey !== null && viewKey !== key) await refreshMcpServers(viewCwd);
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

/** 拉取某台服务器的资源面（缓存优先；缺失才握手） */
export async function fetchMcpResources(
  name: string,
  cwd?: string | null,
): Promise<PiMcpResourcesResponse> {
  return piRequest<PiMcpResourcesResponse>({
    type: "list_mcp_resources",
    name,
    ...(cwd ? { cwd } : {}),
  });
}

/** 读取一个资源（sidecar 已做 8KB 截断/脱敏；二进制只回占位文本） */
export async function readMcpResource(
  name: string,
  uri: string,
  cwd?: string | null,
): Promise<PiMcpResourceContentResponse> {
  return piRequest<PiMcpResourceContentResponse>({
    type: "read_mcp_resource",
    name,
    uri,
    ...(cwd ? { cwd } : {}),
  });
}

/** 拉取某台服务器的 Prompt 清单（缓存优先；缺失才握手） */
export async function fetchMcpPrompts(
  name: string,
  cwd?: string | null,
): Promise<PiMcpPromptsResponse> {
  return piRequest<PiMcpPromptsResponse>({
    type: "list_mcp_prompts",
    name,
    ...(cwd ? { cwd } : {}),
  });
}

/** 取一条 Prompt；text 已按消息角色拼好，可直接插入输入框 */
export async function getMcpPrompt(
  name: string,
  prompt: string,
  args: Record<string, string> = {},
  cwd?: string | null,
): Promise<PiMcpPromptResponse> {
  return piRequest<PiMcpPromptResponse>({
    type: "get_mcp_prompt",
    name,
    prompt,
    args,
    ...(cwd ? { cwd } : {}),
  });
}

/** 订阅指定 cwd 的清单快照；当前工作区变化走连接池重调，设置页浏览
 *  其它目录只拉只读清单（不能动全局池）。 */
export function useMcpServers(cwd: string | null): McpSnapshot {
  const key = keyOf(cwd);
  const snapshot = useSyncExternalStore(
    subscribe,
    () => snapshots.get(key) ?? EMPTY,
    () => EMPTY,
  );
  const lastCwd = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastCwd.current === cwd) return;
    const prev = lastCwd.current;
    lastCwd.current = cwd;
    // 手动切工作区 / 清空：重调连接池（用户明确改变了作用域）。
    // 会话同步（source=session）只刷新清单，不打断后台线程正在跑的 MCP 调用；
    // 首次挂载也不重调——模块加载时的 hydrate 已经拉过清单。
    const active = cwd === getWorkspace();
    const source = getWorkspaceSource();
    if (
      active &&
      prev !== undefined &&
      (cwd === null || source === "user")
    ) {
      void reconcileMcpConnections(cwd);
    } else {
      void refreshMcpServers(cwd);
    }
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

/** 常驻订阅：帧自带刷新后的清单，整包并入它对应的 cwd 分桶（设置页浏览
 *  别的目录时也不会覆盖当前会话的视图），再回调订阅方。 */
function startAuthWatch(): void {
  if (authWatchStarted || typeof window === "undefined") return;
  authWatchStarted = true;
  void (async () => {
    try {
      const { getPiChannel } = await import("@/lib/pi/pi-channel");
      const channel = getPiChannel();
      if (!channel.subscribeMcpAuth) return;
      await channel.subscribeMcpAuth((frame) => {
        if (Array.isArray(frame.servers)) {
          const key = keyOf(frame.workspaceCwd);
          bumpSnapshotSeq(key);
          snapshots.set(key, {
            loading: false,
            loaded: true,
            error: null,
            servers: frame.servers,
            pluginServers: frame.pluginServers ?? [],
            workspaceCwd: frame.workspaceCwd ?? null,
            diagnostics: frame.diagnostics ?? [],
          });
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
