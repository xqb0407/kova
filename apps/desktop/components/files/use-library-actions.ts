"use client";

/**
 * 资料库动作集（资料库页通栏工具条与左栏菜单/空态共用一份实现）。
 * 库内容变化（新建笔记、导入）后经 onChanged 通知调用方：bump 刷新信号，
 * 新建笔记还要把右侧查看器切到新文件上。
 */

import { useCallback, useMemo } from "react";
import { open as openDialog } from "@/desktop-bridge/plugin-dialog";
import { toast } from "@/components/ui/toast";
import { fsErrorText, projectReveal } from "@/lib/workspace/fs";
import { t } from "@/lib/i18n";
import { createLibraryNote } from "@/lib/workspace/library-notes";
import { libraryImport } from "@/lib/workspace/library-files";

export interface LibraryActions {
  /** 在 dir 下新建笔记（dir = "" 为库根），完成后选中新文件 */
  newNote: (dir: string) => Promise<void>;
  /** 把磁盘路径拷进库内 rel 目录（拖放落根；右键菜单可指定目录） */
  importPaths: (paths: string[], rel: string) => Promise<void>;
  /** 弹系统对话框后导入（directory=true 选文件夹） */
  pickImport: (rel: string, directory: boolean) => Promise<void>;
  /** 在系统文件管理器中打开库根 */
  revealRoot: () => Promise<void>;
}

const basenameOf = (rel: string) =>
  rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;

export function useLibraryActions(opts: {
  root: string | null;
  /** 库内容已变化：调用方 bump 刷新；newNote 时另带新笔记相对路径 */
  onChanged: (newNote?: { rel: string; name: string }) => void;
}): LibraryActions {
  const { root, onChanged } = opts;

  return useMemo(() => {
    const importPaths = async (paths: string[], rel: string) => {
      if (paths.length === 0) return;
      try {
        const r = await libraryImport(rel, paths);
        // 成功不弹提示（文件直接出现在树里）；只有全失败/部分失败才提示
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
        onChanged();
      } catch (e) {
        toast.error(t("library.actions.importFailed", { error: String(e) }));
      }
    };

    return {
      newNote: async (dir: string) => {
        if (!root) return;
        const rel = await createLibraryNote(root, dir);
        if (!rel) return;
        onChanged({ rel, name: basenameOf(rel) });
      },
      importPaths,
      pickImport: async (rel: string, directory: boolean) => {
        const picked = await openDialog({
          multiple: true,
          directory,
          title: directory
            ? t("library.actions.pickFolderTitle")
            : t("library.actions.pickFileTitle"),
        });
        const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
        await importPaths(paths, rel);
      },
      revealRoot: async () => {
        if (!root) return;
        const err = await projectReveal(root);
        if (err) toast.error(fsErrorText(err));
      },
    };
  }, [root, onChanged]);
}