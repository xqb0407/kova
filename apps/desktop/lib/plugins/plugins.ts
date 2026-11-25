"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  piRequest,
  type PiMarketplaceEntry,
  type PiMarketplacePluginPreviewResponse,
  type PiPluginComponentEntry,
  type PiPluginComponentDocResponse,
  type PiPluginComponentKind,
  type PiPluginConfigResponse,
  type PiPluginDepsResponse,
  type PiPluginDepsResultResponse,
  type PiPluginDepsStatus,
  type PiPluginEntry,
  type PiPluginOpAccepted,
  type PiPluginsResponse,
} from "@/lib/pi/pi-bridge";
import { getWorkspace } from "@/lib/workspace/workspace-store";
import { t } from "@/lib/i18n";

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
export type PluginDepsStatus = PiPluginDepsStatus;
export type { PiPluginComponentDocResponse, PiPluginComponentKind };

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

/** 当前插件快照（非响应式；命令式流程用，如设计模式门禁。响应式绑定走 usePlugins） */
export function getPluginsSnapshot(): PluginsSnapshot {
  return pluginsCurrent;
}

/** 当前市场快照（非响应式；同上，响应式绑定走 useMarketplaces） */
export function getMarketplacesSnapshot(): MarketplacesSnapshot {
  return marketplacesCurrent;
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

// 插件链变更（安装/卸载/启停/组件开关）会改变 MCP 插件层，但 MCP 镜像是另一个
// store，不会自己感知。这里合并短时间内的多次变更后主动重拉一次：否则设置页的
// 「插件 MCP」分组和输入框连接器会继续显示已卸载插件的服务器，点连接才报 not found。
let mcpRefreshTimer: ReturnType<typeof setTimeout> | null = null;
function refreshMcpAfterPluginChange(cwd?: string | null): void {
  if (typeof window === "undefined") return;
  if (mcpRefreshTimer !== null) clearTimeout(mcpRefreshTimer);
  const target = cwd ?? getWorkspace();
  mcpRefreshTimer = setTimeout(() => {
    mcpRefreshTimer = null;
    void import("@/lib/mcp/mcp")
      .then(({ refreshMcpServers }) => refreshMcpServers(target))
      .catch(() => {});
  }, 120);
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
  refreshMcpAfterPluginChange(cwd);
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
  refreshMcpAfterPluginChange(cwd);
}

/** 读插件依赖状态（详情页判断是否显示安装入口） */
export async function getPluginDeps(
  pluginId: string,
  cwd?: string | null,
): Promise<PiPluginDepsStatus> {
  const res = await piRequest<PiPluginDepsResponse>({
    type: "get_plugin_deps",
    pluginId,
    ...(cwd ? { cwd } : {}),
  });
  return res.status;
}

/**
 * 安装插件依赖（显式用户动作）：npm ci/install 可能跑数分钟，前端按钮保持
 * spinner；完成后刷新插件镜像，让 deps 状态与 MCP 预热结果同步。
 */
export async function installPluginDeps(
  pluginId: string,
  cwd?: string | null,
): Promise<PiPluginDepsResultResponse> {
  const res = await piRequest<PiPluginDepsResultResponse>(
    {
      type: "install_plugin_deps",
      pluginId,
      ...(cwd ? { cwd } : {}),
    },
    10 * 60_000 + 30_000,
  );
  await refreshPlugins(cwd);
  refreshMcpAfterPluginChange(cwd);
  return res;
}

// ---------------------------------------------------------------------------
// 装后配置（清单 config 声明的读/写/重绑；secret 值只在保存帧里出现一次）
// ---------------------------------------------------------------------------

/** 读：schema + 掩码视图（secret 只回是否已设置）+ 三态 */
export async function getPluginConfig(
  pluginId: string,
  cwd?: string | null,
): Promise<PiPluginConfigResponse> {
  return piRequest<PiPluginConfigResponse>({
    type: "get_plugin_config",
    pluginId,
    ...(cwd ? { cwd } : {}),
  });
}

/** 写：secret 转发密钥库并自动建两层绑定，非敏感进 kv 并热重载 */
export async function savePluginConfig(
  pluginId: string,
  values: Record<string, string>,
  cwd?: string | null,
): Promise<PiPluginConfigResponse> {
  const res = await piRequest<PiPluginConfigResponse>({
    type: "set_plugin_config",
    pluginId,
    values,
    ...(cwd ? { cwd } : {}),
  });
  await refreshPlugins(cwd); // configState 变化要回灌清单镜像（卡片徽章即时翻转）
  return res;
}

/** stale 一键重绑：不接明文帧，按 kv 记录重建两层绑定 */
export async function rebindPluginConfig(
  pluginId: string,
  cwd?: string | null,
): Promise<PiPluginConfigResponse> {
  const res = await piRequest<PiPluginConfigResponse>({
    type: "set_plugin_config",
    pluginId,
    rebind: true,
    ...(cwd ? { cwd } : {}),
  });
  await refreshPlugins(cwd);
  return res;
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
  if (kind === "mcp") refreshMcpAfterPluginChange(cwd);
}

// ---------------------------------------------------------------------------
// 组件正文（详情页"查看内容"）
// ---------------------------------------------------------------------------

/** 取单个插件组件的原文：技能 SKILL.md 全文 / 子智能体 YAML / MCP 条目 JSON /
 *  钩子条目 JSON。钩子的 name 参数兼容稳定 id 与展示名（同名条目传 id 精确命中）。
 *  清单只带 name/description，正文按需现取（见 PiPluginComponentDocResponse）。
 *  组件不存在/未安装时 sidecar 回 error，这里以异常上抛，调用方自行呈现。 */
export async function getPluginComponentDoc(
  pluginId: string,
  kind: PiPluginComponentKind,
  name: string,
): Promise<PiPluginComponentDocResponse> {
  return piRequest<PiPluginComponentDocResponse>({
    type: "get_plugin_component_doc",
    pluginId,
    kind,
    name,
  });
}

/** 市场条目预览：未安装插件从市场源目录现读组件清单（详情弹窗用）。
 *  目录未刷新 / 条目不在目录 / 源目录缺失时以异常上抛，弹窗内联呈现。 */
export async function getMarketplacePluginPreview(
  marketplaceId: string,
  name: string,
): Promise<PiMarketplacePluginPreviewResponse> {
  return piRequest<PiMarketplacePluginPreviewResponse>(
    {
      type: "get_marketplace_plugin_preview",
      marketplaceId,
      name,
    },
    // Codex git source 首次预览需要浅克隆（安装/刷新共用缓存），给足网络时间
    120_000,
  );
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
type PendingOpKind =
  | "add_marketplace"
  | "refresh_marketplace"
  | "install_plugin"
  | "install_plugin_local";

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

/** 挂起条目的兜底寿命：结果帧丢失（通道断开 / sidecar 崩溃重启）时不能让
 *  条目永久占位，否则所有安装、更新、卸载按钮会一直禁用。10 分钟远大于
 *  clone/复制的正常耗时；迟到的结果帧仍会整包并入快照。 */
const PENDING_STALE_MS = 10 * 60_000;

function registerPending(op: PendingOpKind, opId: string, key?: string): void {
  pendingOps.set(opId, { opId, op, startedAt: Date.now(), ...(key ? { key } : {}) });
  emitPending();
  setTimeout(() => {
    if (pendingOps.delete(opId)) emitPending();
  }, PENDING_STALE_MS);
}

/**
 * 已回流的结果帧（opId → 结果）：本地安装等秒级操作的结果帧可能先于受理
 * 应答的 promise 续体到达，此时不得再把已结算的 opId 放回 pending——
 * 否则挂起集合永不清除，按钮永久转圈。有界保留供 waitForPluginOp 补结算。
 */
type OpResult = { ok: boolean; errorText?: string };
const settledOps = new Map<string, OpResult>();

async function requestOp(
  op: PendingOpKind,
  payload: Record<string, unknown>,
  key?: string,
): Promise<string> {
  const res = await piRequest<PiPluginOpAccepted>(payload);
  if (!settledOps.has(res.opId)) {
    registerPending(op, res.opId, key);
  }
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

/** 直接安装任意本地插件目录（不经市场）：path 为含三态清单的插件根目录绝对路径 */
export function installPluginLocal(path: string): Promise<string> {
  return requestOp(
    "install_plugin_local",
    { type: "install_plugin_local", path, ...(getWorkspace() ? { cwd: getWorkspace() } : {}) },
    path,
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

/** 安装/更新插件。link=true 走链接安装（dev 模式，仅目录市场：cache 条目
 *  symlink 指源目录，重建产物即生效）；缺省保持已装项现有模式 */
export function installPlugin(
  marketplaceId: string,
  name: string,
  opts: { link?: boolean } = {},
): Promise<string> {
  return requestOp(
    "install_plugin",
    {
      type: "install_plugin",
      marketplaceId,
      name,
      ...(opts.link === true ? { link: true } : {}),
      ...(getWorkspace() ? { cwd: getWorkspace() } : {}),
    },
    `${marketplaceId}:${name}`,
  );
}

// ---------------------------------------------------------------------------
// 更新检测（版本差走两份快照，刷新动作走既有 refresh_marketplace）
// ---------------------------------------------------------------------------

export type PluginUpdate = {
  pluginId: string;
  marketplaceId: string;
  name: string;
  currentVersion: string;
  latestVersion: string;
};

/** 更新类操作的等待上限：sidecar 的 git clone 自身超时是 120s，刷新 + 复制
 *  再算余量；用默认 120s 会把慢仓库的完成帧卡在超时之后，检查结果误报失败，
 *  批量更新也会提前进入下一条、与同一市场的刷新并发。 */
export const PLUGIN_UPDATE_OP_TIMEOUT_MS = 180_000;

/** 已装插件与市场目录的版本差。
 *  链接装常驻源目录、市场已移除的没有更新通道，都不参与；本地安装伪市场
 *  的目录由源目录清单现场合成，同样参与比对。 */
export function pluginUpdatesOf(
  plugins: PluginEntry[],
  marketplaces: MarketplaceEntry[],
): PluginUpdate[] {
  const byMarket = new Map(marketplaces.map((m) => [m.id, m]));
  const updates: PluginUpdate[] = [];
  for (const p of plugins) {
    if (p.linked || p.sourceMissing) continue;
    const entry = byMarket
      .get(p.marketplaceId)
      ?.plugins.find((e) => e.name === p.name);
    if (entry?.version && entry.version !== p.version) {
      updates.push({
        pluginId: p.pluginId,
        marketplaceId: p.marketplaceId,
        name: p.name,
        currentVersion: p.version,
        latestVersion: entry.version,
      });
    }
  }
  return updates;
}

/**
 * 检查全部市场的更新：逐个刷新已登记市场（git 重新浅克隆 / directory 重读
 * 清单），单市场失败（离线、仓库不可达、未装 git）跳过，不阻断其余市场。
 * 刷新结果帧会整包并入快照，结束后调用方直接按 pluginUpdatesOf 取版本差。
 */
export async function checkPluginUpdates(): Promise<{
  checked: number;
  failed: string[];
}> {
  const markets = getMarketplacesSnapshot().marketplaces.filter(
    (m) => m.id !== "local",
  );
  const failed: string[] = [];
  for (const m of markets) {
    try {
      const result = await waitForPluginOp(
        await refreshMarketplace(m.id),
        PLUGIN_UPDATE_OP_TIMEOUT_MS,
      );
      if (!result.ok) throw new Error(result.errorText ?? "");
    } catch (err) {
      failed.push(
        `${m.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  await Promise.all([refreshMarketplaces(), refreshPlugins(getWorkspace())]);
  return { checked: markets.length - failed.length, failed };
}

// ---------------------------------------------------------------------------
// 自发帧回流（同 automation-live 模式：通道缺能力静默降级）
// ---------------------------------------------------------------------------

let watchStarted = false;
let frameHandler: ((frame: { opId: string; op: string; ok: boolean; errorText?: string; name?: string; plugins?: PiPluginEntry[] }) => void) | null = null;

/** 插件详情/市场页可注册帧回调（如操作完成后跳详情、错误弹窗）；返回注销函数。
 *  name/plugins：安装类成功帧附带目标插件名与刷新后的清单（装后配置引导用）。 */
export function setPluginOpHandler(
  cb: ((frame: { opId: string; op: string; ok: boolean; errorText?: string; name?: string; plugins?: PiPluginEntry[] }) => void) | null,
): void {
  frameHandler = cb;
}

/** 等待某次耗时操作的 plugin_op_result 回流（受理应答给出的 opId）。
 *  结果帧先到时从 settledOps 立即结算；帧永不到达（通道断开）时超时 reject。 */
export function waitForPluginOp(opId: string, timeoutMs = 120_000): Promise<OpResult> {
  const done = settledOps.get(opId);
  if (done) return Promise.resolve(done);
  return new Promise<OpResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      opWaiters.delete(opId);
      // 结果帧永不到达（通道断开 / sidecar 崩溃）：摘掉挂起条目，否则 pending
      // 永不清空，安装、更新、卸载按钮会一直处于禁用态
      if (pendingOps.delete(opId)) emitPending();
      reject(new Error(t("marketplace.plugins.opTimeout")));
    }, timeoutMs);
    const list = opWaiters.get(opId) ?? [];
    list.push((result) => {
      clearTimeout(timer);
      resolve(result);
    });
    opWaiters.set(opId, list);
  });
}

const opWaiters = new Map<string, Array<(result: OpResult) => void>>();

function handleFrame(frame: { opId: string; op: string; ok: boolean; errorText?: string; name?: string; plugins?: PluginEntry[]; marketplaces?: MarketplaceEntry[]; workspaceCwd?: string | null }) {
  // 先取挂起条目的 key 再删：结果帧可能先于受理应答续体到达（pending 未登记）
  const inFlightKey = pendingOps.get(frame.opId)?.key;
  pendingOps.delete(frame.opId);
  const result: OpResult = { ok: frame.ok, ...(frame.errorText ? { errorText: frame.errorText } : {}) };
  settledOps.set(frame.opId, result);
  if (settledOps.size > 64) {
    const oldest = settledOps.keys().next().value;
    if (oldest !== undefined) settledOps.delete(oldest);
  }
  emitPending();
  if (frame.ok) {
    applyPluginsData(frame);
    applyMarketplacesData(frame);
    emitPlugins();
    emitMarketplaces();
    // 安装/更新会新增或替换插件层 MCP；卸载走同步命令，已在 uninstallPlugin 里刷新。
    // AI 插件管理工具没有请求 id，改完自发 plugin_changed 帧，同样刷新 MCP。
    if (
      frame.op === "install_plugin" ||
      frame.op === "install_plugin_local" ||
      frame.op === "plugin_changed"
    ) {
      refreshMcpAfterPluginChange(frame.workspaceCwd ?? getWorkspace());
    }
    // 市场安装/更新完成提示（本地安装的成功提示由安装对话框给出，不重复）。
    // 名字优先取结果帧附带值；旧 sidecar 未附带时回落 pending key（`mkt:name`）
    if (frame.op === "install_plugin") {
      const name = frame.name ?? (inFlightKey ? inFlightKey.slice(inFlightKey.indexOf(":") + 1) : "");
      if (name) {
        // 快照已整包并入：提示优先用中文展示名
        const displayName = pluginsCurrent.plugins.find(
          (p) => p.name === name,
        )?.displayName;
        void import("@/components/ui/toast").then(({ toast }) => {
          toast.success({
            title: t("marketplace.plugins.installToast", {
              name: displayName ?? name,
            }),
          });
        });
      }
    }
  } else if (
    frame.op === "install_plugin" ||
    frame.op === "refresh_marketplace"
  ) {
    // 更新路径会先刷新市场再安装，失败时目录可能已被改写（插件被移除、清单
    // 损坏）；失败帧不带快照，补拉一次，避免市场页停在旧目录/旧版本
    void refreshMarketplaces();
    void refreshPlugins(getWorkspace());
  }
  const waiters = opWaiters.get(frame.opId);
  if (waiters) {
    opWaiters.delete(frame.opId);
    for (const settle of waiters) settle(result);
  }
  frameHandler?.(frame);
}

/** 挂载一次（首个 usePlugins/useMarketplaces 订阅者触发）；幂等 */
function ensureFrameWatch(): void {
  if (watchStarted || typeof window === "undefined") return;
  watchStarted = true;
  void (async () => {
    const { getPiChannel } = await import("@/lib/pi/pi-channel");
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
