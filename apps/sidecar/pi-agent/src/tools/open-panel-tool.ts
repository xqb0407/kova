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
import { findEnabledPluginPanel, readPluginPanels, scanInstalledSync } from "../plugins/store";
import { globMatch } from "../plugins/manifest";
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
      "a workspace document file to it (the panel shows/edits that file). The host ALREADY auto-opens and " +
      "binds a panel the first time you write/edit a file its 'opens' patterns claim; call this only to " +
      "re-focus the panel or re-bind it to a different document. The bound panel live-refreshes on every " +
      "subsequent disk write. Use list_plugins (components.panels) to discover available plugin/panel ids. " +
      "Read-only: it never reads or writes files itself.",
    parameters: Type.Object({
      plugin: Type.String({
        description:
          "Plugin id as in list_plugins (e.g. \"slide-canvas@dev-marketplace\"); the bare plugin name also works " +
          "when it is unambiguous (e.g. \"slide-canvas\")",
      }),
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
      // 精确 id 未命中时按插件名解析：技能里写的是裸名（如 "slide-canvas"），
      // 而真实 id 带市场后缀（"slide-canvas@dir-e9ffc51b"，机器相关）——不让模型去猜后缀
      let resolvedId = pluginId;
      if (!findEnabledPluginPanel(resolvedId, panelId)) {
        const byName = scanInstalledSync().filter((p) => p.enabled && p.name === pluginId);
        if (byName.length === 1) resolvedId = byName[0]!.pluginId;
        else if (byName.length > 1) {
          return textResult(
            `open_plugin_panel：插件名 "${pluginId}" 对应多个安装（${byName.map((p) => p.pluginId).join("、")}），请用完整 id。`,
          );
        }
      }
      const found = findEnabledPluginPanel(resolvedId, panelId);
      if (!found) {
        return textResult(
          `open_plugin_panel：面板不可用（未安装/未启用/无此面板）：${panelId}@${pluginId}。` +
            "可先用 list_plugins 查看已装插件与 components.panels。",
        );
      }
      const raw = typeof p.path === "string" ? p.path.trim() : "";
      const shown = raw ? displayPath(cwd, raw) : undefined;
      sendEventChunk(threadId, {
        type: "data-pluginOpen",
        data: { plugin: resolvedId, panel: panelId, ...(shown ? { path: shown, cwd } : {}) },
      });
      return textResult(
        `已在右侧面板打开「${found.panel.title}」（${found.plugin.name}）${shown ? `，绑定文档 ${shown}` : ""}`,
      );
    },
  };
}

/* ---------------- write/edit 落盘自动开板 ----------------
 * 产品语义：AI 首次成功写入某个"被面板认领"（panel.opens 命中）的工作区文件时，
 * 宿主自动打开该面板并绑定此文件——实时渲染回路不再依赖模型记得调
 * open_plugin_panel（骨架 write 一落盘，面板就出现；后续 edit 由面板文件轮询上屏）。
 * 与 open_plugin_panel 走同一条 data-pluginOpen 通道，宿主侧天然幂等聚焦。
 */

/** 每线程已自动开板过的文件绝对路径（去重：反复 edit 不反复抢焦点；进程重启即清空） */
const autoOpenedByThread = new Map<string, Set<string>>();

/** 找认领该工作区相对路径的第一个启用面板；glob 同时按整条 rel 路径与文件名匹配
 * （面板常写 `*.canvas.json`，用户与模型都把它理解为"任意层级的画布文档"） */
export function findPanelClaimingFile(relPath: string):
  | { pluginId: string; panelId: string; panelTitle: string }
  | undefined {
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  for (const plugin of scanInstalledSync()) {
    if (!plugin.enabled) continue;
    for (const panel of readPluginPanels(plugin)) {
      if (panel.opens.some((g) => globMatch(g, relPath) || globMatch(g, name))) {
        return { pluginId: plugin.pluginId, panelId: panel.id, panelTitle: panel.title };
      }
    }
  }
  return undefined;
}

/** write/edit 成功后调用；任何异常都由调用方吞掉，绝不影响工具结果 */
export function maybeAutoOpenPanel(cwd: string, threadId: string, filePath: string): void {
  const abs = path.resolve(cwd, filePath);
  const rel = path.relative(cwd, abs).replace(/\\/g, "/");
  if (!rel || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) return; // 工作区外：面板不认领
  const seen = autoOpenedByThread.get(threadId) ?? new Set<string>();
  if (seen.has(abs)) return; // 本线程该文件已自动开过板
  const hit = findPanelClaimingFile(rel);
  if (!hit) return;
  if (seen.size > 500) seen.clear(); // 病态防膨胀
  seen.add(abs);
  autoOpenedByThread.set(threadId, seen);
  sendEventChunk(threadId, {
    type: "data-pluginOpen",
    data: { plugin: hit.pluginId, panel: hit.panelId, path: rel, cwd },
  });
}
