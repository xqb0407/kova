"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  piRequest,
  type PiMarketplaceEntry,
  type PiPluginComponentEntry,
  type PiPluginEntry,
  type PiPluginOpAccepted,
  type PiPluginsResponse,
} from "@/lib/pi-bridge";
import { getWorkspace } from "@/lib/workspace-store";

/**
 * 插件系统（插件市场 → 管理）：前端镜像 store。
 * 事实源在 sidecar plugins.ts——市场登记与目录缓存、安装物化（cache）与四条
 * 合并链的插件层；这里只做清单镜像与变更动作。插件级开关/卸载/安装后 sidecar
 * 会做四链热重载（skills 系统提示词重组 + MCP 连接池 diff + 子智能体重排，
 * hooks 本就实时读取），改后即见。
 *
 * 耗时操作（添加市场 / 刷新 / 安装，git clone 可能长达数十秒）走"受理 + 自发
 * plugin_op_result 帧"模式：piRequest 立即返回 opId，结果帧经通道订阅回流
 * （挂起期 UI 显示 in-flight 状态，重复点击被 pending 集合挡住）。
 */

export type PluginEntry = PiPluginEntry;
export type MarketplaceEntry = PiMarketplaceEntry;
export type PluginComponentEntry = PiPluginComponentEntry;

export type PluginsSnapshot = {
  loading: boolean;
  error: string | null;
  plugins: PluginEntry[];
  workspaceCwd: string | null;
};

export type MarketplacesSnapshot = {
  loading: boolean;
  error: string | null;
  marketplaces: MarketplaceEntry[];
};

const EMPTY_PLUGINS: PluginsSnapshot = {
  loading: false,
  error: null,
  plugins: [],
  workspaceCwd: null,
};

const EMPTY_MARKETPLACES: MarketplacesSnapshot = {
  loading: false,
  error: null,
  marketplaces: [],
};

let pluginsCurrent: PluginsSnapshot = EMPTY_PLUGINS;
let marketplacesCurrent: MarketplacesSnapshot = EMPTY_MARKETPLACES;
const pluginsListeners = new Set<() => void>();
const marketplacesListeners = new Set<() => void>();

function emitPlugins() {
  for (const listener of pluginsListeners) listener();
}

function emitMarketplaces() {
  for (const listener of marketplacesListeners) listener();
}

function subscribePlugins(listener: () => void) {
  pluginsListeners.add(listener);
  return () => pluginsListeners.delete(listener);
}

function subscribeMarketplaces(listener: () => void) {
  marketplacesListeners.add(listener);
  return () => marketplacesListeners.delete(listener);
}

/** 拉取已装插件清单 */
export async function refreshPlugins(cwd?: string | null): Promise<void> {
  pluginsCurrent = { ...pluginsCurrent, loading: true };
  emitPlugins();
  try {
    const res = await piRequest<PiPluginsResponse>({
      type: "list_plugins",
      ...(cwd ? { cwd } : {}),
    });
    pluginsCurrent = {
      loading: false,
      error: null,
      plugins: res.plugins,
      workspaceCwd: res.workspaceCwd,
    };
  } catch (err) {
    pluginsCurrent = {
      ...pluginsCurrent,
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  emitPlugins();
}

/** 拉取市场登记 + 目录 */
export async function refreshMarketplaces(): Promise<void> {
  marketplacesCurrent = { ...marketplacesCurrent, loading: true };
  emitMarketplaces();
  try {
    const res = await piRequest<{ type: "marketplaces"; marketplaces: MarketplaceEntry[] }>({
      type: "list_marketplaces",
    });
    marketplacesCurrent = {
      loading: false,
      error: null,
      marketplaces: res.marketplaces,
    };
  } catch (err) {
    marketplacesCurrent = {
      ...marketplacesCurrent,
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  emitMarketplaces();
}

function applyPluginsData(data: { plugins?: PluginEntry[]; workspaceCwd?: string | null }) {
  if (data.plugins) {
    pluginsCurrent = {
      ...pluginsCurrent,
      loading: false,
      error: null,
      plugins: data.plugins,
      workspaceCwd: data.workspaceCwd ?? pluginsCurrent.workspaceCwd,
    };
  }
}

function applyMarketplacesData(data: { marketplaces?: MarketplaceEntry[] }) {
  if (data.marketplaces) {
    marketplacesCurrent = {
      ...marketplacesCurrent,
      loading: false,
      error: null,
      marketplaces: data.marketplaces,
    };
  }
}

// ---------------------------------------------------------------------------
// 变更动作（同步命令：应答即新清单）
// ---------------------------------------------------------------------------

/** 插件级开关：sidecar 全链路热重载后返回新清单 */
export async function setPluginEnabled(
  pluginId: string,
  enabled: boolean,
  cwd?: string | null,
): Promise<void> {
  const res = await piRequest<PiPluginsResponse>({
    type: "set_plugin_enabled",
    pluginId,
    enabled,
    ...(cwd ? { cwd } : {}),
  });
  applyPluginsData(res);
  emitPlugins();
}

/** 卸载：删物化目录 + 清开关残留 */
export async function uninstallPlugin(
  pluginId: string,
  cwd?: string | null,
): Promise<void> {
  const res = await piRequest<PiPluginsResponse>({
    type: "uninstall_plugin",
    pluginId,
    ...(cwd ? { cwd } : {}),
  });
  applyPluginsData(res);
  emitPlugins();
}

/** 批量开关：逐个走既有协议消息（每次触发四链热重载；插件量小，正确性优先） */
export async function setPluginsEnabledBatch(
  ids: string[],
  enabled: boolean,
  cwd?: string | null,
): Promise<void> {
  for (const id of ids) await setPluginEnabled(id, enabled, cwd);
}

/** 批量卸载：同上，逐个走既有消息 */
export async function uninstallPluginsBatch(
  ids: string[],
  cwd?: string | null,
): Promise<void> {
  for (const id of ids) await uninstallPlugin(id, cwd);
}

/** 组件级开关（scope/layer="plugin" 时 sidecar 要求 pluginId）；应答清单不含插件条目，仅刷新镜像 */
export async function setPluginComponentEnabled(
  kind: "skill" | "mcp" | "subagent",
  pluginId: string,
  name: string,
  enabled: boolean,
  cwd?: string | null,
): Promise<void> {
  if (kind === "skill") {
    await piRequest({
      type: "set_skill_enabled",
      scope: "plugin",
      pluginId,
      name,
      enabled,
      ...(cwd ? { cwd } : {}),
    });
  } else if (kind === "mcp") {
    await piRequest({
      type: "set_mcp_server_enabled",
      layer: "plugin",
      pluginId,
      name,
      enabled,
      ...(cwd ? { cwd } : {}),
    });
  } else {
    await piRequest({
      type: "set_subagent_enabled",
      scope: "plugin",
      pluginId,
      name,
      enabled,
      ...(cwd ? { cwd } : {}),
    });
  }
  await refreshPlugins(cwd);
}

/** 移除市场登记（不卸载已装插件）。marketplaceId 字段传市场身份——
 *  "id" 会被传输层注入的请求 id 覆盖（mgr-pi-*），sidecar 端将拿到错误值 */
export async function removeMarketplace(marketplaceId: string): Promise<void> {
  await piRequest({ type: "remove_marketplace", marketplaceId });
  await refreshMarketplaces();
}

// ---------------------------------------------------------------------------
// 耗时操作（受理 + plugin_op_result 自发帧）
// ---------------------------------------------------------------------------

type PendingOp = { opId: string; op: PendingOpKind; startedAt: number; key?: string };
type PendingOpKind = "add_marketplace" | "refresh_marketplace" | "install_plugin";

const pendingOps = new Map<string, PendingOp>();
let pendingList: PendingOp[] = [];
const pendingListeners = new Set<() => void>();

function emitPending() {
  pendingList = [...pendingOps.values()];
  for (const listener of pendingListeners) listener();
}

function subscribePending(listener: () => void) {
  pendingListeners.add(listener);
  return () => pendingListeners.delete(listener);
}

/** 挂起中的操作（按钮 loading / 防重复点击） */
export function getPendingOps(): PendingOp[] {
  return pendingList;
}

export function isPluginOpPending(op: PendingOpKind, key?: string): boolean {
  return pendingList.some(
    (p) => p.op === op && (!key || p.key === key),
  );
}

function registerPending(op: PendingOpKind, opId: string, key?: string): void {
  pendingOps.set(opId, { opId, op, startedAt: Date.now(), ...(key ? { key } : {}) });
  emitPending();
}

async function requestOp(
  op: PendingOpKind,
  payload: Record<string, unknown>,
  key?: string,
): Promise<string> {
  const res = await piRequest<PiPluginOpAccepted>(payload);
  registerPending(op, res.opId, key);
  return res.opId;
}

/** 添加市场（本地目录或 Git 仓库） */
export function addMarketplace(args: {
  type: "directory" | "git";
  path?: string;
  repo?: string;
}): Promise<string> {
  const key = args.type === "git" ? args.repo : args.path;
  return requestOp(
    "add_marketplace",
    { type: "add_marketplace", mtype: args.type, ...(args.repo ? { repo: args.repo } : {}), ...(args.path ? { path: args.path } : {}) },
    key,
  );
}

/** 刷新市场（git 重新浅克隆；directory 重读目录） */
export function refreshMarketplace(marketplaceId: string): Promise<string> {
  return requestOp(
    "refresh_marketplace",
    { type: "refresh_marketplace", marketplaceId },
    marketplaceId,
  );
}

/** 安装/更新插件 */
export function installPlugin(marketplaceId: string, name: string): Promise<string> {
  return requestOp(
    "install_plugin",
    { type: "install_plugin", marketplaceId, name, ...(getWorkspace() ? { cwd: getWorkspace() } : {}) },
    `${marketplaceId}:${name}`,
  );
}

// ---------------------------------------------------------------------------
// 自发帧回流（同 automation-live 模式：通道缺能力静默降级）
// ---------------------------------------------------------------------------

let watchStarted = false;
let frameHandler: ((frame: { opId: string; op: string; ok: boolean; errorText?: string }) => void) | null = null;

/** 插件详情/市场页可注册帧回调（如操作完成后跳详情、错误弹窗）；返回注销函数 */
export function setPluginOpHandler(
  cb: ((frame: { opId: string; op: string; ok: boolean; errorText?: string }) => void) | null,
): void {
  frameHandler = cb;
}

function handleFrame(frame: { opId: string; op: string; ok: boolean; errorText?: string; plugins?: PluginEntry[]; marketplaces?: MarketplaceEntry[]; workspaceCwd?: string | null }) {
  pendingOps.delete(frame.opId);
  emitPending();
  if (frame.ok) {
    applyPluginsData(frame);
    applyMarketplacesData(frame);
    emitPlugins();
    emitMarketplaces();
  }
  frameHandler?.(frame);
}

/** 挂载一次（首个 usePlugins/useMarketplaces 订阅者触发）；幂等 */
function ensureFrameWatch(): void {
  if (watchStarted || typeof window === "undefined") return;
  watchStarted = true;
  void (async () => {
    const { getPiChannel } = await import("@/lib/pi-channel");
    const channel = getPiChannel();
    if (!channel.subscribePluginOps) return;
    const teardown = await channel.subscribePluginOps(handleFrame);
    // 通道切换/重连场景不做特殊处理：帧丢失时用户手动刷新即可（低频操作）
    void teardown;
  })();
}

// ---------------------------------------------------------------------------
// React 绑定
// ---------------------------------------------------------------------------

/** 订阅已装插件快照；cwd 变化时自动重取（组件级开关随所选工作区呈现） */
export function usePlugins(cwd: string | null): PluginsSnapshot {
  const snapshot = useSyncExternalStore(
    subscribePlugins,
    () => pluginsCurrent,
    () => EMPTY_PLUGINS,
  );
  const lastCwd = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    ensureFrameWatch();
    if (lastCwd.current === cwd) return;
    lastCwd.current = cwd;
    void refreshPlugins(cwd);
  }, [cwd]);
  return snapshot;
}

/** 订阅市场快照（含目录） */
export function useMarketplaces(): MarketplacesSnapshot {
  const snapshot = useSyncExternalStore(
    subscribeMarketplaces,
    () => marketplacesCurrent,
    () => EMPTY_MARKETPLACES,
  );
  useEffect(() => {
    ensureFrameWatch();
    void refreshMarketplaces();
  }, []);
  return snapshot;
}

/** 订阅挂起操作（按钮 loading） */
export function usePendingOps(): PendingOp[] {
  return useSyncExternalStore(
    subscribePending,
    () => pendingList,
    () => EMPTY_PENDING,
  );
}

const EMPTY_PENDING: PendingOp[] = [];

// client bundle 加载即水合（SSR 端返回空快照，不请求）
if (typeof window !== "undefined") {
  void refreshPlugins(getWorkspace());
  void refreshMarketplaces();
}
