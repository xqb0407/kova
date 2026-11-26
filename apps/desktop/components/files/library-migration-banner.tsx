"use client";

/**
 * 一次性 Markdown → 原生笔记迁移提示条。
 *
 * 只在库根存在、有未迁移 `.md` 且迁移 marker 尚未完成时出现；迁移在渲染层
 * 逐篇执行（备份 → 转换 → 校验 → 删除原文件），进度原地显示。用户点「稍后」
 * 只隐藏本次会话，不写 marker，下次进入资料库仍会提示。
 */

import { useCallback, useEffect, useState } from "react";
import { ArrowRightIcon, DatabaseZapIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import { isDesktop } from "@/lib/desktop-env";
import {
  markdownMigrationStatus,
  migrateMarkdownToNative,
  type MigrationStatus,
} from "@/lib/notes/migrate-markdown";

export function LibraryMigrationBanner({
  root,
  onMigrated,
}: {
  root: string | null;
  onMigrated: () => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<MigrationStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  useEffect(() => {
    if (!root || !isDesktop()) return;
    let alive = true;
    void markdownMigrationStatus(root)
      .then((next) => {
        if (alive) setStatus(next);
      })
      .catch(() => {
        /* 状态探测失败不打扰使用 */
      });
    return () => {
      alive = false;
    };
  }, [root]);

  const start = useCallback(async () => {
    if (!root || running) return;
    setRunning(true);
    setProgress({ done: 0, total: status?.markdownCount ?? 0 });
    try {
      const report = await migrateMarkdownToNative(root, {
        onProgress: ({ done, total }) => setProgress({ done, total }),
      });
      toast.success(
        t("library.view.migration.done", {
          converted: report.converted.length,
          skipped: report.skipped.length,
        }),
      );
      setStatus(null);
      onMigrated();
    } catch (error) {
      toast.error(
        t("library.view.migration.failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setRunning(false);
    }
  }, [onMigrated, root, running, status?.markdownCount, t]);

  if (!status?.needed || dismissed) return null;

  return (
    <div className="border-primary/25 bg-primary/5 mx-2 mt-2 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
      <DatabaseZapIcon className="text-primary size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-foreground text-xs font-medium">
          {t("library.view.migration.title")}
        </div>
        <div className="text-muted-foreground mt-0.5 text-xs">
          {running
            ? t("library.view.migration.running", {
                done: progress.done,
                total: progress.total,
              })
            : t("library.view.migration.desc", {
                count: status.markdownCount,
              })}
        </div>
      </div>
      {running ? (
        <Loader2Icon className="text-muted-foreground size-4 animate-spin" />
      ) : (
        <>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={() => setDismissed(true)}
          >
            {t("library.view.migration.later")}
          </Button>
          <Button
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            onClick={() => void start()}
          >
            {t("library.view.migration.start")}
            <ArrowRightIcon className="size-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}
