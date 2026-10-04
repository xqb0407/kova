"use client";

import { useMemo } from "react";
import { usePlugins } from "@/lib/plugins/plugins";
import { useWorkspace } from "@/lib/workspace/workspace-store";
import type { PiPluginPanelEntry } from "@/lib/pi/pi-bridge";

/**
 * UI 面板贡献的派生读模型：从已装插件清单（lib/plugins/plugins.ts 镜像）里
 * 摊平出 enabled 插件的 components.panels。面板 "+" 菜单、产物卡
 * opens-glob 路由、桥宿主权限门控统一以此为数据源。
 */
export type PluginPanelContribution = {
  pluginId: string;
  pluginName: string;
  panel: PiPluginPanelEntry;
};

/** 已装启用插件的面板贡献清单（随插件 store 自动更新；卸载即消失）。
 *  loading=true 表示清单还没拉到（冷启动水合中），调用方应显加载态而非"无面板" */
export function usePluginPanels(): {
  panels: PluginPanelContribution[];
  loading: boolean;
} {
  const workspace = useWorkspace();
  const { plugins, loading } = usePlugins(workspace);
  const panels = useMemo(
    () =>
      plugins
        .filter((p) => p.enabled)
        .flatMap((p) =>
          (p.components.panels ?? []).map((panel) => ({
            pluginId: p.pluginId,
            pluginName: p.name,
            panel,
          })),
        ),
    [plugins],
  );
  return { panels, loading };
}

/** opens glob 匹配（与 sidecar manifest.globMatch 同语义：`*` 不跨路径分隔符） */
export function panelOpenMatches(pattern: string, path: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(path);
}

/** 通配字面量长度（去掉 `*` 后的字符数）：越大越具体，如 `*.deck.canvas.json` 压过 `*.canvas.json` */
function globSpecificity(pattern: string): number {
  return pattern.replace(/\*/g, "").length;
}

/**
 * 找能打开该 workspace 相对路径的面板贡献（产物卡「在画布中打开」）。
 * 多个面板认领同一文件时**最具体的 glob 优先**（`*.deck.canvas.json` 压过
 * `*.canvas.json`），同分再按注册顺序——否则宽后缀插件会吞掉窄后缀插件的文件。
 */
export function findPanelForFile(
  contributions: PluginPanelContribution[],
  path: string,
): PluginPanelContribution | undefined {
  let best: PluginPanelContribution | undefined;
  let bestSpec = -1;
  for (const c of contributions) {
    for (const g of c.panel.opens) {
      if (!panelOpenMatches(g, path)) continue;
      const spec = globSpecificity(g);
      if (spec > bestSpec) {
        best = c;
        bestSpec = spec;
      }
      break;
    }
  }
  return best;
}
