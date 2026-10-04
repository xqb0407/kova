/**
 * 面板打开文件工具（open_file）：不读内容、不落盘，只发一条 data-panelOpen
 * chunk —— 前端把「文件」标签推到前台并展开面板，标签走磁盘实时模式
 * （与文件树点击同一渲染路径，见 panel-tabs/file-view 的 tab.path 分支）。
 *
 * 存在的意义：模型讲代码/文档时能把目标文件推到用户眼前，省去「用户自己去
 * 文件树找」的来回。只读、无副作用；路径不存在时回文本错误（不开空白标签）。
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { sendEventChunk } from "../protocol/stream";

/** 与 tools.ts textResult 同形（AgentToolResult.details 必填） */
const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

/**
 * 展示用路径：绝对路径在 workspace 内则转相对（文件树同款，标题更短），
 * 相对路径做一次 normalize（消掉 a/../b、./x 这类写法）
 */
export function displayPath(cwd: string, raw: string): string {
  if (path.isAbsolute(raw)) {
    if (cwd) {
      const prefix = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
      if (raw.startsWith(prefix)) return raw.slice(prefix.length);
    }
    return raw;
  }
  return path.normalize(raw);
}

export function buildOpenFileTool(cwd: string, threadId: string): AgentTool {
  return {
    name: "open_file",
    label: "Open File",
    description:
      "Open a file in the user's side panel (next to the chat) so they can look at it — same view as " +
      "clicking the file tree. Use it when you want the user to see a specific file you are talking about. " +
      "Read-only: it never modifies the file. Fails with a text error if the path does not exist.",
    parameters: Type.Object({
      path: Type.String({
        description: "File path: workspace-relative (preferred) or absolute",
      }),
    }),
    execute: async (_id, params) => {
      const raw = String((params as { path?: unknown }).path ?? "").trim();
      if (!raw) return textResult("open_file：缺少 path 参数");
      const abs = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
      if (!existsSync(abs)) return textResult(`open_file：文件不存在 ${raw}`);
      if (statSync(abs).isDirectory()) {
        return textResult(`open_file：${raw} 是目录不是文件（目录可用文件树浏览）`);
      }
      const shown = displayPath(cwd, raw);
      // 文件标签磁盘实时模式：cwd + 相对 path（file-view 的 tab.path 分支）
      sendEventChunk(threadId, {
        type: "data-panelOpen",
        data: { type: "file", path: shown, cwd },
      });
      return textResult(`已在面板打开 ${shown}`);
    },
  };
}
