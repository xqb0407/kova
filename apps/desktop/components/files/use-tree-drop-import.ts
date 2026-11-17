"use client";

/**
 * 文件树外部拖放导入的共用实现（面板「文件树」标签与文件树栏各挂一棵树，
 * 行为完全一致）：把 Finder/桌面拖入的磁盘路径拷进落点目录（重名自动加序号），
 * 完成后失效该根的树缓存重拉——树没有 watcher，靠这次刷新让文件立刻出现。
 * 提示口径与资料库导入（use-library-actions）一致：成功不弹，
 * 只有失败/部分失败才提示。
 */

import { useCallback } from "react";
import { refreshFileTree } from "@/lib/workspace/file-tree";
import { fsImport } from "@/lib/workspace/fs";
import { t } from "@/lib/i18n";
import { toast } from "@/components/ui/toast";

/** 返回 FileExplorer 的 onDropPaths 回调（cwd = 树根绝对路径，null = 未就绪） */
export function useTreeDropImport(cwd: string | null) {
  return useCallback(
    (paths: string[], dir: string) => {
      if (!cwd || paths.length === 0) return;
      void (async () => {
        const r = await fsImport(cwd, dir, paths);
        if (!r) {
          // 命令不可用/远程项目/主进程报错：没有明细，给兜底文案
          toast.error(
            t("library.actions.importFailed", {
              error: t("library.actions.unknownError"),
            }),
          );
          return;
        }
        if (r.failed.length > 0) {
          toast.error(
            r.imported.length === 0
              ? t("library.actions.importFailed", {
                  error: r.failed[0]?.error ?? t("library.actions.unknownError"),
                })
              : t("library.actions.partialFailed", {
                  count: r.failed.length,
                  error: r.failed[0]?.error ?? "",
                }),
          );
        }
        refreshFileTree(cwd);
      })();
    },
    [cwd],
  );
}
