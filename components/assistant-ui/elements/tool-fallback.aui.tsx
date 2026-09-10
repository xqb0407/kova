"use client";

import { useState } from "react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { ChevronDownIcon, LoaderCircleIcon } from "lucide-react";

/** 从 args 里挑第一个有值的字符串做摘要（bash 的 command、文件工具的 path、检索的 pattern…） */
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

export const ToolFallback: ToolCallMessagePartComponent = ({
  toolName,
  args,
  argsText,
  result,
  status,
}) => {
  const running = status?.type === "running";
  const output = resultText(result);
  const failed = isFailedOutput(output);
  const summary =
    argSummary(args as Record<string, unknown>) ||
    (argsText ? argsText.slice(0, 120) : "");
  const [open, setOpen] = useState(false);

  return (
    <div
      data-slot="aui_tool-fallback"
      className="w-full overflow-hidden rounded-lg border border-border bg-muted/30 text-sm"
    >
      <button
        type="button"
        onClick={() => output && setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50"
      >
        {running ? (
          <LoaderCircleIcon
            size={14}
            className="size-3.5 shrink-0 animate-spin text-muted-foreground"
          />
        ) : (
          <span
            className={`size-2 shrink-0 rounded-full ${
              failed ? "bg-destructive" : "bg-lime-500"
            }`}
          />
        )}
        <span className="shrink-0 font-medium">{toolName}</span>
        {summary ? (
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {summary}
          </code>
        ) : null}
        {output ? (
          <ChevronDownIcon
            size={14}
            className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${
              open ? "rotate-180" : ""
            }`}
          />
        ) : null}
      </button>
      {open && output ? (
        <pre
          className={`max-h-64 overflow-auto border-t px-3 py-2 font-mono text-xs whitespace-pre-wrap ${
            failed ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {output}
        </pre>
      ) : null}
    </div>
  );
};
