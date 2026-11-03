"use client";

import type { FC } from "react";
import {
  DatabaseIcon,
  FileTextIcon,
  FolderIcon,
  GitBranchIcon,
  ImageIcon,
  PackageIcon,
  PaperclipIcon,
  ScrollTextIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes, sharePct, shortenHome } from "@/lib/resource/format";
import type { Category, Storage } from "@/lib/resource/types";
import { cn } from "@/lib/utils";

/** 类目图标：id 由主进程固定给出（见 main/resource.ts 的 categorySpecs），认不出的一律用包裹图标兜底 */
const CATEGORY_ICON: Record<string, FC<{ className?: string }>> = {
  sessions: DatabaseIcon,
  workspace: FolderIcon,
  attachments: PaperclipIcon,
  checkpoints: GitBranchIcon,
  logs: ScrollTextIcon,
  "browser-cache": ImageIcon,
  "model-cache": FileTextIcon,
};

/**
 * 四列：类目 / 路径 / 占用 / 操作。
 *
 * **四列全部是固定或 fr 宽度，不能有 auto**：每一行都是一张独立的 grid，
 * auto 列会按该行内容取宽——带「清理」按钮的行操作列更宽，同一行里 fr 分到的
 * 空间就变小，于是路径列的起点/宽度逐行不同（实测同一列 x=394/375、w=496/469），
 * 看起来就是"路径没对齐"。列宽与内容无关，各行的列边界才会自然重合。
 */
const ROW_GRID =
  "grid grid-cols-[minmax(9rem,1fr)_minmax(0,1.4fr)_8.5rem_7.5rem] items-center gap-3";

/**
 * 存储表：一行一个类目，路径直接摊开在列里（不再藏在折叠后面），占用列带一根
 * 占应用总量比例的小条——一处颜色都不需要解释，因为全表同一支色。
 *
 * 操作列只放两个动作：「打开」（在文件管理器里定位，便于自己动手看）与
 * 「清理」（仅白名单类目）。把路径与大小都摆到同一行，是因为这一页要回答的
 * 就是"东西在哪、占了多少、能不能删"这三个问题。
 */
export const StorageTable: FC<{
  storage: Storage;
  onClean: (category: Category) => void;
  onReveal: (category: Category) => void;
  /** 正在清理的类目 id（期间禁用所有清理按钮，避免并发删同一批文件） */
  cleaningId: string | null;
}> = ({ storage, onClean, onReveal, cleaningId }) => {
  const total = storage.totalBytes;
  // 数据目录已经在标题栏写着，表里再逐行重复这 50 个字符纯属噪音：落在数据目录
  // 内的条目只显示相对部分（完整绝对路径仍在 tooltip 里）
  const dataDir = shortenHome(storage.dataDir).replace(/\/$/, "");

  return (
    <div className="flex flex-col">
      <div
        className={cn(
          ROW_GRID,
          "bg-background text-muted-foreground border-border sticky top-0 z-10 border-b px-1 py-2 text-xs",
        )}
      >
        <span>类目</span>
        <span>路径</span>
        <span className="text-right">占用</span>
        <span className="text-right">操作</span>
      </div>

      {storage.categories.map((category) => {
        const Icon = CATEGORY_ICON[category.id] ?? PackageIcon;
        const fullPaths = category.paths.map(shortenHome);
        return (
          <div
            key={category.id}
            title={category.hint}
            className={cn(ROW_GRID, "hover:bg-hover rounded-md px-1 py-1.5")}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Icon className="text-muted-foreground size-4 shrink-0" />
              <span className="truncate text-sm">{category.label}</span>
            </span>

            {/* 路径：长名字截断，`+N` 单独摆、不跟着被截掉 */}
            <span className="flex min-w-0 items-center gap-1.5" title={fullPaths.join("\n")}>
              <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">
                {headPath(fullPaths, dataDir)}
              </span>
              {fullPaths.length > 1 && (
                <span className="text-muted-foreground shrink-0 font-mono text-xs">
                  +{fullPaths.length - 1}
                </span>
              )}
            </span>

            <span className="flex min-w-0 items-center justify-end gap-2">
              <span className="bg-foreground/10 h-1.5 w-12 shrink-0 overflow-hidden rounded-full">
                <span
                  className="bg-foreground/60 block h-full rounded-full"
                  style={{ width: `${sharePct(category.bytes, total)}%` }}
                />
              </span>
              <span className="w-20 shrink-0 truncate text-right font-mono text-sm whitespace-nowrap tabular-nums">
                {formatBytes(category.bytes)}
              </span>
            </span>

            <span className="flex shrink-0 items-center justify-end gap-1">
              {category.cleanable && (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={cleaningId !== null}
                  onClick={() => onClean(category)}
                >
                  {cleaningId === category.id ? "清理中…" : "清理"}
                </Button>
              )}
              <Button
                size="xs"
                variant="ghost"
                disabled={category.paths.length === 0}
                onClick={() => onReveal(category)}
              >
                打开
              </Button>
            </span>
          </div>
        );
      })}
    </div>
  );
};

/** 路径列只展示第一条：落在数据目录内的条目省掉重复前缀（完整绝对路径在 tooltip 里） */
function headPath(paths: string[], dataDir: string): string {
  if (paths.length === 0) return "—";
  return dataDir && paths[0].startsWith(`${dataDir}/`) ? paths[0].slice(dataDir.length + 1) : paths[0];
}
