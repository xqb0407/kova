"use client";

import { useState, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import { FileTextIcon } from "lucide-react";
import type { PanelTab } from "@/lib/panel-tabs";
import { CodeMirrorCode } from "@/components/code/cm-code";
import { stripReadLineNumbers } from "@/lib/read-result";
import { cn } from "@/lib/utils";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { splitPath } from "./git-files";
import { FileTypeIcon } from "./file-type-icon";
import { TabEmpty } from "./tab-empty";

/**
 * 「文件」标签：回看消息里的单文件内容，两种数据源（都是消息快照，
 * 历史会话/刷新后同样可打开）：
 * - read 调用：tab.focus = read part 的 toolCallId（sidecar 带行号前缀，
 *   这里剥掉交给 CodeMirror 自己的行号栏），展示当次读取快照，非磁盘实时内容；
 * - plan_write（含历史 SubmitPlan/SubmitGoal）：tab.focus = 提交 part 的
 *   toolCallId，渲染 args 里的完整计划 Markdown（计划进右侧面板的入口）。
 * Markdown 文件（含计划）头部给「预览 | 源码」切换，预览即消息区同款渲染
 * （复用 MarkdownText：自带 .aui-markdown 包装层，代码块头部按钮/边框等
 * 样式都作用域在该层下，裸 Streamdown 会回退到默认定位导致按钮跑飞）。
 */

type FilePart = {
  kind: "read" | "plan" | "write";
  /** read/write = 真实路径；plan = 标题拼的虚拟 .md 路径（图标/语言用） */
  path: string;
  text: string;
};

/** 打包成单字符串选择器：值不变即引用相等，流式期间避免逐 token 重渲 */
function useFilePart(focus: string | undefined): FilePart | null {
  const packed = useAuiState((s) => {
    if (!focus) return null;
    for (const m of s.thread.messages) {
      for (const p of m.content) {
        if (p.type !== "tool-call" || p.toolCallId !== focus) continue;
        const args = p.args as Record<string, unknown> | undefined;
        const str = (k: string) =>
          typeof args?.[k] === "string" ? (args[k] as string) : "";
        if (p.toolName === "read") {
          const raw =
            typeof p.result === "string"
              ? p.result
              : p.result == null
                ? ""
                : JSON.stringify(p.result);
          return ["read", str("file_path"), raw].join("\0");
        }
        if (p.toolName === "write") {
          // 产物「代码」查看：write args 里就是完整内容快照（源码，无行号前缀）
          return ["write", str("file_path"), str("content")].join("\0");
        }
        if (
          p.toolName === "plan_write" ||
          p.toolName === "SubmitPlan" ||
          p.toolName === "SubmitGoal"
        ) {
          const title =
            str("title") || (p.toolName === "SubmitGoal" ? "目标" : "计划");
          return ["plan", `${title}.md`, str("markdown")].join("\0");
        }
      }
    }
    return null;
  });
  if (packed === null) return null;
  const [kind, path, ...rest] = packed.split("\0");
  const parsed: FilePart["kind"] =
    kind === "plan" ? "plan" : kind === "write" ? "write" : "read";
  return { kind: parsed, path, text: rest.join("\0") };
}

const ModeToggle: FC<{
  mode: "preview" | "source";
  onChange: (m: "preview" | "source") => void;
}> = ({ mode, onChange }) => (
  <div className="border-border/60 ml-auto flex shrink-0 items-center gap-0.5 rounded-md border p-0.5 text-xs">
    {(["preview", "source"] as const).map((m) => (
      <button
        key={m}
        type="button"
        onClick={() => onChange(m)}
        className={cn(
          "rounded px-2 py-0.5 transition-colors",
          mode === m
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {m === "preview" ? "预览" : "源码"}
      </button>
    ))}
  </div>
);

/** part 到位后才挂载：预览/源码初值要按扩展名定，key 保证换文件重置 */
const FileBody: FC<{ part: FilePart }> = ({ part }) => {
  const isMd = /\.mdx?$/i.test(part.path);
  const [mode, setMode] = useState<"preview" | "source">(
    isMd ? "preview" : "source",
  );
  // 行号前缀只在 read 快照里有；计划/写入的正文是原文，别碰
  const text = part.kind === "read" ? stripReadLineNumbers(part.text) : part.text;
  const { dir, base } = splitPath(part.path);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏：文件图标 + 文件名 + 灰色目录（截断时 title 看全路径）+ md 预览/源码切换 */}
      <div
        className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2"
        title={part.path}
      >
        <FileTypeIcon path={part.path} />
        <span className="truncate text-[13px] font-medium text-foreground/90">
          {base}
        </span>
        {dir ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground/70">
            {dir}
          </span>
        ) : null}
        {isMd ? <ModeToggle mode={mode} onChange={setMode} /> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!text ? (
          <p className="text-muted-foreground/60 px-3 py-2 text-xs">
            （没有记录到内容）
          </p>
        ) : mode === "preview" ? (
          <div className="px-4 py-3">
            <MarkdownText text={text} />
          </div>
        ) : (
          <CodeMirrorCode value={text} path={part.path} />
        )}
      </div>
    </div>
  );
};

export const FileTab: FC<{ tab: PanelTab }> = ({ tab }) => {
  const part = useFilePart(tab.focus);
  if (!part)
    return (
      <TabEmpty
        icon={FileTextIcon}
        text="找不到对应的记录（会话已更新或已切换）"
      />
    );
  return <FileBody key={tab.focus ?? part.path} part={part} />;
};
