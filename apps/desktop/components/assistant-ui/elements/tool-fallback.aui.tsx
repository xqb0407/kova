"use client";

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { ToolRow } from "./tool-row.aui";

/** 从 args 里挑第一个有值的字符串做摘要（检索的 pattern、子代理名…） */
function argSummary(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  for (const key of [
    "command",
    "path",
    "filePath",
    "file_path",
    "pattern",
    "query",
    "subagent",
  ]) {
    const v = args[key];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

/** 结果文本：字符串原样展示（不再 JSON.stringify 导致引号/\n 转义），对象才序列化 */
function resultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

/** sidecar 的失败标记：非零退出码输出 `\n[exit code: N]`，超时输出 `\n[timeout]`（码 0 无标记） */
function isFailedOutput(text: string): boolean {
  return /\[exit code: |\[timeout\]/.test(text);
}

/**
 * 未注册专属渲染的工具（子代理、todo 等）的通用行：
 * 与 tool-row.aui 的专属行同形（扁平、行内展开输出），只是没有
 * 「点击开面板」动作。bash/read/edit/write/WebSearch/WebFetch/glob/grep
 * 的分发见 assistant-message.tsx + AGENT_TOOL_UI。
 */
export const ToolFallback: ToolCallMessagePartComponent = ({
  toolName,
  args,
  argsText,
  result,
  status,
  isError,
}) => {
  const output = resultText(result);
  const summary =
    argSummary(args as Record<string, unknown>) ||
    (argsText ? argsText.slice(0, 120) : "");

  return (
    <ToolRow
      label={toolName}
      primary={summary}
      mono
      running={status?.type === "running"}
      failed={isError === true || (!!output && isFailedOutput(output))}
      output={output}
    />
  );
};
