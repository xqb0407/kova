"use client";

/**
 * 记忆文件的版本史弹窗（设置 → 记忆 → 行内「历史」）。
 * 左列版本（时间 · 来源 · 大小），右侧预览选中版内容，动作：恢复此版 / 删除此版。
 * 版本史由 sidecar 在每次改动后自动记一版（写/删/外部改动），保留最近 50 版；
 * 恢复 = 把该版写回（写回本身也进历史，任何一步都能回退）。重依赖（Streamdown）
 * 由调用方 next/dynamic 异步分块加载，不进设置页首屏包。
 */

import { useCallback, useEffect, useState, type FC } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import {
  deleteMemoryVersion,
  listMemoryVersions,
  readMemoryVersion,
  restoreMemoryVersion,
} from "@/lib/memory/memory";
import type {
  PiMemoryVersionEntry,
  PiMemoryVersionSource,
} from "@/lib/pi/pi-bridge";
import { cn } from "@/lib/utils";
import { Loader2Icon, RotateCcwIcon, Trash2Icon } from "lucide-react";

const SOURCE_LABEL: Record<PiMemoryVersionSource, string> = {
  page: "页面保存",
  agent: "AI 写入",
  external: "外部改动",
  restore: "恢复操作",
  delete: "删除前",
};

const formatTime = (ms: number): string => {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const formatBytes = (n: number): string =>
  n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;

export const MemoryHistoryDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 作用域与目录：与设置页当前查看的作用域页签一致 */
  scope: "global" | "workspace";
  cwd: string | null;
  file: string;
  /** 恢复成功后回调（调用方刷新文件清单） */
  onRestored?: () => void;
}> = ({ open, onOpenChange, scope, cwd, file, onRestored }) => {
  const [versions, setVersions] = useState<PiMemoryVersionEntry[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [busy, setBusy] = useState<"restore" | "delete" | null>(null);

  const load = useCallback(() => {
    setVersions(null);
    return listMemoryVersions(scope, cwd, file)
      .then((list) => {
        setVersions(list);
        setSelectedId(list[0]?.id ?? null);
      })
      .catch(() => setVersions([]));
  }, [scope, cwd, file]);

  useEffect(() => {
    if (!open) return;
    setContent(null);
    void load();
  }, [open, load]);

  // 选中版本后拉内容（预览）
  useEffect(() => {
    if (!open || !selectedId) {
      setContent(null);
      return;
    }
    let alive = true;
    setContent(null);
    readMemoryVersion(scope, cwd, file, selectedId)
      .then((text) => {
        if (alive) setContent(text);
      })
      .catch(() => {
        if (alive) setContent("");
      });
    return () => {
      alive = false;
    };
  }, [open, selectedId, scope, cwd, file]);

  const restore = async () => {
    if (!selectedId || busy) return;
    setBusy("restore");
    try {
      await restoreMemoryVersion(scope, cwd, file, selectedId);
      toast.success(`已恢复到 ${formatTime(versions?.find((v) => v.id === selectedId)?.ts ?? 0)} 的版本`);
      onRestored?.();
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "恢复失败，请重试");
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!selectedId || busy) return;
    setBusy("delete");
    try {
      await deleteMemoryVersion(scope, cwd, file, selectedId);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败，请重试");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>版本历史 · {file}</DialogTitle>
          <DialogDescription>
            每次改动自动记一版（页面保存 / AI 写入 / 外部改动 / 恢复 / 删除前），保留最近 50 版；
            恢复会把该版内容写回，写回本身也记一版，随时可以再退回去。
          </DialogDescription>
        </DialogHeader>

        {versions === null ? (
          <div className="text-muted-foreground flex h-64 items-center justify-center text-sm">
            <Loader2Icon className="mr-2 size-4 animate-spin" />
            读取版本…
          </div>
        ) : versions.length === 0 ? (
          <div className="text-muted-foreground flex h-64 flex-col items-center justify-center gap-1 text-sm">
            <span>还没有历史版本。</span>
            <span className="text-xs">这个文件被保存、被 AI 写入或外部改动后，会在这里留下记录。</span>
          </div>
        ) : (
          <div className="flex h-96 gap-3">
            {/* 版本列表 */}
            <div className="flex w-64 shrink-0 flex-col gap-1 overflow-y-auto pr-1">
              {versions.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  data-selected={v.id === selectedId}
                  onClick={() => setSelectedId(v.id)}
                  className={cn(
                    "hover:bg-muted flex flex-col gap-0.5 rounded-lg px-2.5 py-2 text-start transition-colors",
                    "data-selected:bg-muted",
                  )}
                >
                  <span className="text-sm font-medium tabular-nums">
                    {formatTime(v.ts)}
                  </span>
                  <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5">
                      {SOURCE_LABEL[v.source]}
                    </span>
                    {formatBytes(v.bytes)}
                  </span>
                </button>
              ))}
            </div>

            {/* 选中版预览 */}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="bg-muted/60 min-h-0 flex-1 overflow-y-auto rounded-lg border p-3">
                {content === null ? (
                  <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
                    <Loader2Icon className="mr-2 size-4 animate-spin" />
                    读取内容…
                  </div>
                ) : content.trim() ? (
                  <MarkdownText text={content} />
                ) : (
                  <p className="text-muted-foreground text-sm">这一版是空内容</p>
                )}
              </div>
              <div className="flex items-center justify-between gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive h-8 gap-1.5 px-2 text-xs"
                  disabled={!selectedId || busy !== null}
                  onClick={() => void remove()}
                >
                  <Trash2Icon className="size-3.5" />
                  删除此版本
                </Button>
                <Button
                  size="sm"
                  className="h-8 gap-1.5 px-3 text-xs"
                  disabled={!selectedId || busy !== null}
                  onClick={() => void restore()}
                >
                  {busy === "restore" ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <RotateCcwIcon className="size-3.5" />
                  )}
                  恢复此版本
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default MemoryHistoryDialog;
