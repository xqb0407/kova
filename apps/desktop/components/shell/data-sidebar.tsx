"use client";

/**
 * 「数据」分区的二级侧边栏：全部文档（知识库一级页）+ 知识库清单。
 * 清单由主区 LibraryView 上报（base 持库），这里纯受控渲染——选中态 =
 * base 的当前空间（null = 一级页）。点击经 onLibrarySelect 请求主区路由。
 */

import type { FC } from "react";
import { FolderOpenIcon, LibraryBigIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import type { KnowledgeBase } from "@/lib/workspace/knowledge-bases";

export const DataSidebar: FC<{
  /** 知识库清单（null = 主区还没上报/未挂载，渲染占位行） */
  kbs: KnowledgeBase[] | null;
  /** 当前选中空间的 KB id（null = 一级页「全部文档」） */
  activeKbId: string | null;
  onSelect: (kbId: string | null) => void;
}> = ({ kbs, activeKbId, onSelect }) => {
  const t = useT();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-5 pb-3">
      <button
        type="button"
        aria-current={activeKbId === null || undefined}
        onClick={() => onSelect(null)}
        className={cn(
          "flex h-9 w-full shrink-0 items-center gap-2.5 rounded-lg px-3 text-sm transition-colors",
          activeKbId === null
            ? "bg-selected font-medium text-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <LibraryBigIcon className="size-4 shrink-0" />
        <span className="truncate">{t("library.view.sidebarAll")}</span>
      </button>

      <p className="text-muted-foreground/70 mt-4 mb-1.5 shrink-0 px-3 text-xs font-medium">
        {t("library.view.sidebarKbs")}
      </p>
      <div className="flex flex-col gap-1">
        {kbs?.map((kb) => (
          <button
            key={kb.id}
            type="button"
            aria-current={activeKbId === kb.id || undefined}
            onClick={() => onSelect(kb.id)}
            title={kb.name}
            className={cn(
              "flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-sm transition-colors",
              activeKbId === kb.id
                ? "bg-selected font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <FolderOpenIcon className="size-4 shrink-0" />
            <span className="truncate">{kb.name}</span>
          </button>
        ))}
        {kbs !== null && kbs.length === 0 ? (
          <p className="text-muted-foreground/70 px-3 py-1 text-xs">
            {t("library.view.sidebarEmpty")}
          </p>
        ) : null}
        {kbs === null
          ? [0, 1].map((i) => (
              <div
                key={i}
                className="bg-muted/60 h-9 w-full animate-pulse rounded-lg"
              />
            ))
          : null}
      </div>
    </div>
  );
};
