"use client";

/**
 * 设计模式前置门禁（纯逻辑，无 UI）：切换到 design 档要求 ui-design 插件
 * 已安装且已启用——插件的技能与 MCP 工具随启用状态自动进出系统提示词，没装
 * 插件设计模式就没有设计稿车道。本模块负责状态探测与「启用 / 安装并等待」
 * 动作；弹窗编排由 components/design-mode-gate.tsx 的 useEnsureUiDesignPlugin
 * 完成（顶栏切换器与设置页共用）。
 * sidecar 提示词侧另有兜底段（app-mode.ts designModeBlock：插件不可用时
 * 指示 agent 引导安装并先走 HTML 原型车道），绕过 UI 直发协议也得到正确表现。
 */

import {
  getMarketplacesSnapshot,
  getPluginsSnapshot,
  installPlugin,
  refreshMarketplaces,
  refreshPlugins,
  setPluginEnabled,
  waitForPluginOp,
  type PluginEntry,
} from "@/lib/plugins/plugins";
import { getWorkspace } from "@/lib/workspace/workspace-store";

/** ui-design 插件身份（市场无关：安装后条目 name 恒为清单名） */
export const UI_DESIGN_PLUGIN_NAME = "ui-design";

export type UiDesignGateState =
  /** 已装已启用：直接放行 */
  | { kind: "ready"; entry: PluginEntry }
  /** 已装被禁用：确认后可一键启用 */
  | { kind: "disabled"; entry: PluginEntry }
  /** 未安装：installMarketplaceId 非空时可一键安装 */
  | { kind: "missing"; installMarketplaceId: string | null }
  /** sidecar 不可达（清单拉取失败）：放行但提示词可能不跟随（degraded 语义一致） */
  | { kind: "unreachable"; error: string };

/** 找已装条目：多市场同名时优先启用项 */
function findUiDesignEntry(): PluginEntry | undefined {
  const entries = getPluginsSnapshot().plugins.filter(
    (p) => p.name === UI_DESIGN_PLUGIN_NAME,
  );
  return entries.find((p) => p.enabled) ?? entries[0];
}

/** 在市场目录里找 ui-design 的可安装来源；needsRefresh 的目录先刷新一次再找 */
async function findInstallSource(): Promise<string | null> {
  const catalogHit = () =>
    getMarketplacesSnapshot().marketplaces.find((m) =>
      m.plugins.some((c) => c.name === UI_DESIGN_PLUGIN_NAME),
    )?.id ?? null;

  const direct = catalogHit();
  if (direct) return direct;

  // 目录为空多半是"从未成功刷新"：刷一轮（directory/git 都轻量）再试
  const stale = getMarketplacesSnapshot().marketplaces.filter(
    (m) => m.needsRefresh && m.plugins.length === 0,
  );
  if (stale.length === 0) return null;
  const { refreshMarketplace } = await import("@/lib/plugins/plugins");
  for (const m of stale) {
    try {
      const opId = await refreshMarketplace(m.id);
      await waitForPluginOp(opId);
    } catch {
      /* 单市场刷新失败不影响其余探测 */
    }
  }
  await refreshMarketplaces();
  return catalogHit();
}

/** 探测门禁状态：先拉新清单（本地命令秒回），失败按 unreachable 放行 */
export async function probeUiDesignGate(): Promise<UiDesignGateState> {
  try {
    await refreshPlugins(getWorkspace());
  } catch {
    /* refreshPlugins 内部吞错进快照；下面用快照 error 字段判定 */
  }
  const snap = getPluginsSnapshot();
  if (snap.error && snap.plugins.length === 0) {
    return { kind: "unreachable", error: snap.error };
  }
  const entry = findUiDesignEntry();
  if (entry) {
    return entry.enabled
      ? { kind: "ready", entry }
      : { kind: "disabled", entry };
  }
  await refreshMarketplaces();
  return { kind: "missing", installMarketplaceId: await findInstallSource() };
}

/** 启用已装的 ui-design 插件（四链热重载由 sidecar 完成） */
export async function enableUiDesignPlugin(entry: PluginEntry): Promise<void> {
  await setPluginEnabled(entry.pluginId, true, getWorkspace());
}

/** 安装 ui-design 并等待结果帧；成功后清单镜像已由结果帧更新 */
export async function installUiDesignPlugin(
  marketplaceId: string,
): Promise<{ ok: boolean; errorText?: string }> {
  const opId = await installPlugin(marketplaceId, UI_DESIGN_PLUGIN_NAME);
  const result = await waitForPluginOp(opId);
  await refreshPlugins(getWorkspace());
  return result;
}
