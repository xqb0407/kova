"use client";

import { startTransition, useState, type FC } from "react";
import { FileCodeIcon, FilePenIcon, FilePlusIcon } from "lucide-react";
import {
  type FileChangeEntry,
  type FileChangeGroup,
} from "@/lib/panel-activity";
import { PanelFileDiff } from "@/components/code/panel-diff";
import { DiffStats, PanelSection, StatusDot } from "./section-shell";

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

/** 一次 edit/write 的 diff 块（@pierre/diffs 渲染，主题随「外观 → 代码设置」） */
const EntryDiff: FC<{ entry: FileChangeEntry; path: string }> = ({ entry, path }) => {
  if (entry.failed && entry.output) {
    // 失败:diff 无从谈起(未落盘),直接展示错误输出
    return (
      <pre className="bg-destructive/5 max-h-40 overflow-auto rounded-lg border border-destructive/30 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-destructive">
        {entry.output}
      </pre>
    );
  }

  const { base } = splitPath(path);
  return (
    <div className="overflow-hidden rounded-lg border border-border/60">
      <div className="bg-muted/20 border-border/60 flex items-center gap-1.5 border-b px-2 py-1 text-[10px] text-muted-foreground">
        <OpIcon op={entry.op} />
        <span>{entry.op === "edit" ? "编辑" : "写入"}</span>
        <span className="text-emerald-600 dark:text-emerald-400">
          +{entry.added}
        </span>
        <span className="text-rose-500 dark:text-rose-400">
          -{entry.removed}
        </span>
        {entry.running ? (
          <span className="shimmer ml-auto">进行中…</span>
        ) : null}
      </div>
      <PanelFileDiff name={base} oldText={entry.oldText} newText={entry.newText} />
    </div>
  );
};

/** 单文件卡:头部摘要(路径 + 累计 ±),展开看逐次变更 */
const FileCard: FC<{ group: FileChangeGroup }> = ({ group }) => {
  const [open, setOpen] = useState(false);
  // 与审查标签同款延迟挂载：点击先反馈，diff 重 DOM 下一帧再建
  const [diffMounted, setDiffMounted] = useState(false);
  const { dir, base } = splitPath(group.path);
  const latest = group.entries[group.entries.length - 1];

  const toggle = () => {
    if (open) {
      setOpen(false);
      setDiffMounted(false);
      return;
    }
    setOpen(true);
    requestAnimationFrame(() => startTransition(() => setDiffMounted(true)));
  };

  return (
    <div className="border-border/60 bg-muted/10 overflow-hidden rounded-xl border">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
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
          {diffMounted
            ? group.entries.map((entry) => (
                <EntryDiff key={entry.toolCallId} entry={entry} path={group.path} />
              ))
            : null}
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
