"use client";

/**
 * 搜索结果行的共用原子件：高亮、右侧槽位、分组标题、归档徽标、行容器类。
 * 抽出来是为了行组件与列表各自只关心自己的数据，样式语汇单点维护。
 */
import { memo, type FC, type ReactNode } from "react";
import { ArchiveIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { highlightNeedle } from "@/lib/search/search-format";

/** 命中子串高亮（大小写不敏感，首次命中；不中则原文） */
export const Highlight: FC<{ text: string; query: string }> = memo(
  function Highlight({ text, query }) {
    const needle = highlightNeedle(query);
    if (!needle) return <>{text}</>;
    const index = text.toLowerCase().indexOf(needle.toLowerCase());
    if (index < 0) return <>{text}</>;
    const end = index + needle.length;
    return (
      <>
        {text.slice(0, index)}
        <span className="text-primary">{text.slice(index, end)}</span>
        {text.slice(end)}
      </>
    );
  },
);

/** 行右侧槽位：常驻相对时间，选中时换成来源（同 thread-list 用时/按钮互斥） */
export const RowSlot: FC<{
  time: string | null;
  meta: string;
  active: boolean;
}> = memo(function RowSlot({ time, meta, active }) {
  return (
    <span className="pointer-events-none relative flex h-4 w-24 shrink-0 items-center justify-end">
      {meta ? (
        <span
          className={cn(
            "absolute inset-y-0 right-0 flex items-center truncate text-xs text-muted-foreground transition-opacity",
            active ? "opacity-100" : "opacity-0",
          )}
        >
          {meta}
        </span>
      ) : null}
      {time ? (
        <span
          className={cn(
            "absolute inset-y-0 right-0 flex items-center text-xs leading-none tabular-nums text-muted-foreground transition-opacity",
            active && meta ? "opacity-0" : "opacity-100",
          )}
        >
          {time}
        </span>
      ) : null}
    </span>
  );
});

export const GroupLabel: FC<{
  label: string;
  action?: "clear-history";
  onClearHistory: () => void;
}> = memo(function GroupLabel({ label, action, onClearHistory }) {
  return (
    <div className="flex items-center justify-between px-2 pb-1 pt-2">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {action === "clear-history" ? (
        <button
          type="button"
          onClick={onClearHistory}
          className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          清空
        </button>
      ) : null}
    </div>
  );
});

export const ArchivedBadge = memo(function ArchivedBadge() {
  return (
    <span className="flex shrink-0 items-center gap-1 rounded border px-1 py-px text-xs leading-none text-muted-foreground">
      <ArchiveIcon className="size-3" />
      归档
    </span>
  );
});

/** 行容器：统一高度/圆角/选中与 hover 底色，行组件只负责内容 */
export function rowClassName(active: boolean, dense = false): string {
  return cn(
    "flex w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm",
    dense ? "h-9" : "h-10",
    active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
  );
}

/** 行图标着色（选中态降饱和，跟随 accent-foreground） */
export function iconClassName(active: boolean): string {
  return cn(
    "size-4 shrink-0",
    active ? "text-accent-foreground/70" : "text-muted-foreground",
  );
}

/**
 * 行组件统一 props。回调接**下标**而不是闭包：列表传下来的 onActivate/onOpen
 * 是稳定的（useCallback），行内部按自己的 index 调用——否则每帧新建闭包会让
 * memo 永远失效。
 */
export type RowProps = {
  /** 在可选中序列里的下标（滚动定位 / 回调入参） */
  index: number;
  active: boolean;
  onActivate: (index: number) => void;
  onOpen: (index: number) => void;
};
