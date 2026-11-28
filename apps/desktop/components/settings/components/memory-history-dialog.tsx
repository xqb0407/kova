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
import { getLocale, useT } from "@/lib/i18n";
import { Loader2Icon, RotateCcwIcon, Trash2Icon } from "lucide-react";

const SOURCE_LABEL_KEYS: Record<PiMemoryVersionSource, string> = {
  page: "settings.memoryHistory.sourcePage",
  agent: "settings.memoryHistory.sourceAgent",
  external: "settings.memoryHistory.sourceExternal",
  restore: "settings.memoryHistory.sourceRestore",
  delete: "settings.memoryHistory.sourceDelete",
};

const formatTime = (ms: number): string => {
  if (!ms) return "";
  return new Intl.DateTimeFormat(getLocale() === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
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
  const t = useT();
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
      toast.success(
        t("settings.memoryHistory.restored", {
          time: formatTime(versions?.find((v) => v.id === selectedId)?.ts ?? 0),
        }),
      );
      onRestored?.();
      await load();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("settings.memoryHistory.restoreFailed"),
      );
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
      toast.error(
        err instanceof Error ? err.message : t("settings.memoryHistory.deleteFailed"),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 撑满外壳（技能/MCP 编辑弹窗同款）：版本对比看的是长文，固定 h-96 太局促，
          列表与预览随视口高度伸展；预览走 aui-md-panel 紧凑排版（弹窗小容器里
          消息流的 30px 级标题头重脚轻） */}
      <DialogContent className="flex h-[calc(100dvh-6rem)] max-h-[860px] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="shrink-0 px-6 pt-5">
          <DialogTitle>{t("settings.memoryHistory.title", { file })}</DialogTitle>
          <DialogDescription>
            {t("settings.memoryHistory.desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col px-6 pt-4 pb-5">
        {versions === null ? (
          <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
            <Loader2Icon className="mr-2 size-4 animate-spin" />
            {t("settings.memoryHistory.loadingVersions")}
          </div>
        ) : versions.length === 0 ? (
          <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-1 text-sm">
            <span>{t("settings.memoryHistory.noVersions")}</span>
            <span className="text-ui leading-5">
              {t("settings.memoryHistory.noVersionsDesc")}
            </span>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 gap-3">
            {/* 版本列表 */}
            <div className="flex w-64 shrink-0 flex-col gap-1 overflow-y-auto pr-1">
              {versions.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  data-selected={v.id === selectedId}
                  onClick={() => setSelectedId(v.id)}
                  className={cn(
                    "hover:bg-muted flex flex-col gap-1 rounded-lg px-2.5 py-2.5 text-start transition-colors",
                    "data-selected:bg-muted",
                  )}
                >
                  <span className="text-sm font-medium tabular-nums">
                    {formatTime(v.ts)}
                  </span>
                  <span className="text-muted-foreground flex items-center gap-1.5 text-ui leading-5">
                    <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5">
                      {t(SOURCE_LABEL_KEYS[v.source])}
                    </span>
                    {formatBytes(v.bytes)}
                  </span>
                </button>
              ))}
            </div>

            {/* 选中版预览 */}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="bg-muted/60 min-h-0 flex-1 overflow-y-auto rounded-lg border p-4">
                {content === null ? (
                  <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
                    <Loader2Icon className="mr-2 size-4 animate-spin" />
                    {t("settings.memoryHistory.loadingContent")}
                  </div>
                ) : content.trim() ? (
                  <MarkdownText text={content} className="aui-md-panel" />
                ) : (
                  <p className="text-muted-foreground text-sm leading-relaxed">
                    {t("settings.memoryHistory.emptyVersion")}
                  </p>
                )}
              </div>
              <div className="flex items-center justify-between gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive h-8 gap-1.5 px-2 text-ui leading-5"
                  disabled={!selectedId || busy !== null}
                  onClick={() => void remove()}
                >
                  <Trash2Icon className="size-3.5" />
                  {t("settings.memoryHistory.deleteVersion")}
                </Button>
                <Button
                  size="sm"
                  className="h-8 gap-1.5 px-3 text-ui leading-5"
                  disabled={!selectedId || busy !== null}
                  onClick={() => void restore()}
                >
                  {busy === "restore" ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <RotateCcwIcon className="size-3.5" />
                  )}
                  {t("settings.memoryHistory.restoreVersion")}
                </Button>
              </div>
            </div>
          </div>
        )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default MemoryHistoryDialog;
