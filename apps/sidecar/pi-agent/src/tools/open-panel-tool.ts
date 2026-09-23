/**
 * 面板唤起工具（open_plugin_panel）：UI 插件体系的通用 agent→UI 原语——
 * 让模型把某个已安装插件贡献的面板（如无限画布）推到用户眼前，并把工作区
 * 文档文件绑定为该面板的当前文档。不读文件内容、不落盘，只发一条
 * data-pluginOpen chunk（仿 open-file-tool.ts 的面板唤起回路；前端
 * pi-transport 收帧后 focusPluginPanel + 重读文档推送桥）。
 *
 * 与具体插件解耦：这里不认"画布"概念，只认 pluginId + panelId（list_plugins
 * 的 components.panels 供模型选择）。面板未知/禁用时回文本错误（不开空标签）。
 */
import path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { sendEventChunk } from "../protocol/stream";
import { findEnabledPluginPanel } from "../plugins/store";
import { displayPath } from "./open-file-tool";

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

export function buildOpenPanelTool(cwd: string, threadId: string): AgentTool {
  return {
    name: "open_plugin_panel",
    label: "Open Plugin Panel",
    description:
      "Open a UI panel contributed by an installed plugin in the user's side panel, optionally binding " +
      "a workspace document file to it (the panel shows/edits that file). Call it with the plugin name " +
      "after you create or change such a document so the user sees the result immediately; the bound " +
      "panel also live-refreshes when you write the file again. Use list_plugins (components.panels) to " +
      "discover available plugin/panel ids. Read-only: it never reads or writes files itself.",
    parameters: Type.Object({
      plugin: Type.String({ description: "Plugin id as in list_plugins (e.g. \"slide-canvas@dev-marketplace\")" }),
      panel: Type.String({ description: "Panel id contributed by that plugin (e.g. \"canvas\")" }),
      path: Type.Optional(
        Type.String({
          description:
            "Workspace document file to bind to the panel (workspace-relative or absolute), e.g. a .canvas.json deck",
        }),
      ),
    }),
    execute: async (_id, params) => {
      const p = params as { plugin?: unknown; panel?: unknown; path?: unknown };
      const pluginId = String(p.plugin ?? "").trim();
      const panelId = String(p.panel ?? "").trim();
      if (!pluginId || !panelId) return textResult("open_plugin_panel：plugin 与 panel 参数必填");
      const found = findEnabledPluginPanel(pluginId, panelId);
      if (!found) {
        return textResult(
          `open_plugin_panel：面板不可用（未安装/未启用/无此面板）：${panelId}@${pluginId}。` +
            "可先用 list_plugins 查看 components.panels。",
        );
      }
      const raw = typeof p.path === "string" ? p.path.trim() : "";
      const shown = raw ? displayPath(cwd, raw) : undefined;
      sendEventChunk(threadId, {
        type: "data-pluginOpen",
        data: { plugin: pluginId, panel: panelId, ...(shown ? { path: shown, cwd } : {}) },
      });
      return textResult(
        `已在右侧面板打开「${found.panel.title}」（${found.plugin.name}）${shown ? `，绑定文档 ${shown}` : ""}`,
      );
    },
  };
}
