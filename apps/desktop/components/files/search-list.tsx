"use client";

/**
 * 搜索结果列表（资料库/产物区左侧栏的搜索态）：主进程 library_scan 的名字
 * 匹配结果，扁平展示——树是懒加载的，未展开目录里的文件只有靠扫描才找得到。
 * 点击行 = 选中并在右侧查看器打开。
 */

import type { FC } from "react";
import { Loader2Icon, SearchXIcon } from "lucide-react";
import { FileTypeIcon } from "@/components/agent-thread/agent-panel/file-type-icon";
import {
  formatBackupBytes,
  formatBackupTime,
} from "@/lib/settings/backup-config";
import type { LibraryScanEntry } from "@/lib/workspace/library-files";
import { cn } from "@/lib/utils";

export const SearchList: FC<{
  /** origin = 命中来自哪个根（资料库 / AI 产物），非 library 时行尾标来源 */
  entries: (LibraryScanEntry & { origin?: "library" | "artifacts" })[];
  loading: boolean;
  truncated: boolean;
  query: string;
  selected: string | null;
  onSelect: (entry: LibraryScanEntry & { origin?: "library" | "artifacts" }) => void;
}> = ({ entries, loading, truncated, query, selected, onSelect }) => {
  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-xs">
        <Loader2Icon className="size-3.5 animate-spin" />
        搜索中…
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="text-muted-foreground/60 flex flex-col items-center gap-2 px-4 py-10 text-center text-xs">
        <SearchXIcon className="size-5" />
        没有匹配「{query}」的文件
      </div>
    );
  }
  return (
    <div className="flex flex-col p-1">
      {entries.map((e) => {
        const dirPart = e.rel.includes("/")
          ? e.rel.slice(0, e.rel.lastIndexOf("/"))
          : "";
        return (
          <button
            key={e.rel}
            onClick={() => onSelect(e)}
            title={e.rel}
            className={cn(
              "hover:bg-muted/70 flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
              selected === e.rel && "bg-selected",
            )}
          >
            <FileTypeIcon path={e.name} className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{e.name}</span>
              <span className="text-muted-foreground/70 block truncate font-mono text-[10px]">
                {e.origin === "artifacts" && (
                  <span className="text-muted-foreground/70 mr-1 font-sans">
                    AI 产物 ·
                  </span>
                )}
                {dirPart}
              </span>
            </span>
            <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
              {e.modified ? formatBackupTime(e.modified) : ""}
              {e.size > 0 ? ` · ${formatBackupBytes(e.size)}` : ""}
            </span>
          </button>
        );
      })}
      {truncated && (
        <p className="text-muted-foreground/60 px-2 py-2 text-[10px]">
          结果过多，仅显示前 {entries.length} 条
        </p>
      )}
    </div>
  );
};