"use client";

import { useState, type FC } from "react";
import { FileCodeIcon, FilePenIcon, FilePlusIcon } from "lucide-react";
import {
  diffLines,
  type FileChangeEntry,
  type FileChangeGroup,
} from "@/lib/panel-activity";
import { cn } from "@/lib/utils";
import { DiffStats, PanelSection, StatusDot } from "./section-shell";

/** 单条变更最多渲染的 diff 行数,超出折叠(面板窄、内容要克制) */
const MAX_DIFF_LINES = 160;

function splitPath(path: string): { dir: string; base: string } {
  const norm = path.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  if (idx < 0) return { dir: "", base: norm };
  return { dir: norm.slice(0, idx), base: norm.slice(idx + 1) };
}

const OpIcon: FC<{ op: "edit" | "write" }> = ({ op }) =>
  op === "write" ? (
    <FilePlusIcon className="size-3.5 shrink-0 text-muted-foreground" />
  ) : (
    <FilePenIcon className="size-3.5 shrink-0 text-muted-foreground" />
  );

/** 一次 edit/write 的 diff 块(带 +/- 前缀与绿红底色;超量截断) */
const EntryDiff: FC<{ entry: FileChangeEntry }> = ({ entry }) => {
  const [expanded, setExpanded] = useState(false);

  if (entry.failed && entry.output) {
    // 失败:diff 无从谈起(未落盘),直接展示错误输出
    return (
      <pre className="bg-destructive/5 max-h-40 overflow-auto rounded-lg border border-destructive/30 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-destructive">
        {entry.output}
      </pre>
    );
  }

  const lines =
    entry.oldText !== null
      ? diffLines(entry.oldText, entry.newText)
      : (entry.newText.length ? entry.newText.split("\n") : []).map((text) => ({
          kind: "add" as const,
          text,
        }));
  const shown = expanded ? lines : lines.slice(0, MAX_DIFF_LINES);
  const hiddenCount = lines.length - shown.length;

  return (
    <div className="border-border/60 bg-muted/20 overflow-hidden rounded-lg border p-2 font-mono text-[11px] leading-[1.6]">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <OpIcon op={entry.op} />
        <span>{entry.op === "edit" ? "编辑" : "写入"}</span>
        <span className="text-emerald-600 dark:text-emerald-400">
          +{entry.added}
        </span>
        <span className="text-rose-600 dark:text-rose-400">
          -{entry.removed}
        </span>
        {entry.running ? (
          <span className="shimmer ml-auto">进行中…</span>
        ) : null}
      </div>
      <div className="max-h-72 overflow-y-auto">
        {shown.map((line, i) => (
          <div
            key={i}
            className={cn(
              "-mx-2 flex px-2",
              line.kind === "add" &&
                "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
              line.kind === "del" &&
                "bg-rose-500/10 text-rose-700 dark:text-rose-300",
              line.kind === "ctx" && "text-muted-foreground/80",
            )}
          >
            <span className="w-3.5 shrink-0 select-none text-muted-foreground/60">
              {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
            </span>
            <span className="min-w-0 whitespace-pre-wrap break-all">
              {line.text || " "}
            </span>
          </div>
        ))}
      </div>
      {hiddenCount > 0 && !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-muted-foreground hover:text-foreground mt-1 text-[11px] underline-offset-2 hover:underline"
        >
          ⋯ 展开剩余 {hiddenCount} 行
        </button>
      ) : null}
    </div>
  );
};

/** 单文件卡:头部摘要(路径 + 累计 ±),展开看逐次变更 */
const FileCard: FC<{ group: FileChangeGroup }> = ({ group }) => {
  const [open, setOpen] = useState(false);
  const { dir, base } = splitPath(group.path);
  const latest = group.entries[group.entries.length - 1];

  return (
    <div className="border-border/60 bg-muted/10 overflow-hidden rounded-xl border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="hover:bg-muted/40 flex w-full items-center gap-2 px-2.5 py-2 text-left"
      >
        <StatusDot running={group.running} failed={group.failed} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs text-foreground/90">
            {base}
          </span>
          {dir ? (
            <span className="block truncate font-mono text-[10px] text-muted-foreground/70">
              {dir}
            </span>
          ) : null}
        </span>
        <DiffStats added={group.added} removed={group.removed} />
      </button>
      {open ? (
        <div className="flex flex-col gap-1.5 border-t border-border/60 p-2">
          {group.entries.map((entry) => (
            <EntryDiff key={entry.toolCallId} entry={entry} />
          ))}
        </div>
      ) : null}
      {/* 未展开时给最近一次变更一个悬浮提示(整路径) */}
      <span className="sr-only">{latest ? `最近操作: ${group.path}` : ""}</span>
    </div>
  );
};

export const FilesSection: FC<{ groups: FileChangeGroup[] }> = ({ groups }) => {
  if (groups.length === 0) return null;
  const added = groups.reduce((s, g) => s + g.added, 0);
  const removed = groups.reduce((s, g) => s + g.removed, 0);

  return (
    <PanelSection
      icon={<FileCodeIcon className="size-4" />}
      title="文件变更"
      trailing={<DiffStats added={added} removed={removed} />}
    >
      <div className="flex flex-col gap-1.5">
        {groups.map((g) => (
          <FileCard key={g.path} group={g} />
        ))}
      </div>
    </PanelSection>
  );
};
