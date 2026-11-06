"use client";

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { GlobeIcon } from "lucide-react";
import { toolCategory } from "./tool-category";
import { SandboxBadge, ToolRow } from "./tool-row.aui";

/** 浏览器工具正常走 BrowserToolUI（resolveToolUI 按前缀分发）；这里保留图标兜底，
 *  供直接复用 ToolFallback 的调用方仍能看到浏览器标识 */
const BROWSER_ICON = <GlobeIcon className="size-4 shrink-0" />;

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
 * 未注册专属渲染的工具（子代理、todo 等，以及未覆盖的未知工具）的通用行：
 * 与 tool-row.aui 的专属行同形（扁平、行内展开输出），只是没有
 * 「点击开面板」动作。分发入口见 assistant-message.tsx + resolveToolUI；
 * browser_* 会先被 BrowserToolUI 接走，不会落到这里。
 */
export const ToolFallback: ToolCallMessagePartComponent = ({
  toolName,
  args,
  argsText,
  result,
  status,
  isError,
  artifact,
}) => {
  const structured = (artifact as { structuredContent?: unknown } | undefined)
    ?.structuredContent;
  const text = resultText(result);
  let output = text;
  if (!output && structured !== undefined && structured !== null) {
    try {
      output = JSON.stringify(structured, null, 2);
    } catch {
      output = String(structured);
    }
  }
  const summary =
    argSummary(args as Record<string, unknown>) ||
    (argsText ? argsText.slice(0, 120) : "");

  return (
    <ToolRow
      label={toolName}
      icon={toolCategory(toolName) === "browser" ? BROWSER_ICON : undefined}
      badge={<SandboxBadge artifact={artifact} result={result} isError={isError} />}
      primary={summary}
      mono
      running={status?.type === "running"}
      failed={isError === true || (!!output && isFailedOutput(output))}
      output={output}
    />
  );
};
