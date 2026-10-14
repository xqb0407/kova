"use client";

import type { FC } from "react";
import {
  AppWindowIcon,
  BoxesIcon,
  ChevronRightIcon,
  PuzzleIcon,
  ServerIcon,
  TerminalIcon,
} from "lucide-react";
import { AgentDisclosure } from "@/components/custom-ui/agent-disclosure";
import { formatBytes, formatPct } from "@/lib/resource/format";
import type { GroupStat } from "@/lib/resource/types";
import { cn } from "@/lib/utils";

/** 分组图标：id 由 Rust 侧固定给出，认不出的用中立图标兜底 */
const GROUP_ICON: Record<string, FC<{ className?: string }>> = {
  core: ServerIcon,
  render: AppWindowIcon,
  plugin: PuzzleIcon,
  terminal: TerminalIcon,
  other: BoxesIcon,
};

/** 单组最多渲染的进程行数：智能体猛跑工具时不至于把 DOM 撑爆 */
const MAX_ROWS = 60;

/** 四列：名称吃剩余宽度，三个数字列等宽右对齐（与表头、分组行、进程行共用） */
const ROW_GRID = "grid grid-cols-[minmax(0,1fr)_5rem_5rem_5.5rem] items-center gap-3";

/**
 * 分组进程表：表头只出现一次并吸顶，分组行与进程行共用同一套列。
 *
 * 版式刻意**不用卡片**（对照活动监视器）：页面底色就是表的底色，没有圆角、
 * 没有外框，全表只有一条横线（表头下沿）。层级靠两样东西表达——
 * 子进程缩进 + 一条竖引导线——而不是给每一行都描边：之前"组间分隔线 + 每个
 * 进程行自己的上边框"同粗细堆在一起，线从卡片左边缘切过缩进，看着像网格残了。
 *
 * 两个度量列始终都在（不随页签换列）：切页签只改**排序**与顶部磁贴，
 * 数字位置始终不动。
 */
export const ProcessTable: FC<{
  groups: GroupStat[];
  /** 当前页签的排序依据 */
  metric: "cpu" | "mem";
  expanded: Record<string, boolean>;
  onToggle: (id: string) => void;
}> = ({ groups, metric, expanded, onToggle }) => {
  if (groups.length === 0) {
    return <div className="text-muted-foreground py-6 text-sm">暂时拿不到本应用的进程列表。</div>;
  }

  // 分组与组内进程都按当前页签的度量排序
  const ordered = groups.slice().sort((a, b) => (metric === "cpu" ? b.cpu - a.cpu : b.mem - a.mem));

  return (
    <div className="flex flex-col">
      {/* 吸顶表头：长列表滚动时列名始终可见；底色用页面底色盖住下面的行 */}
      <div
        className={cn(
          ROW_GRID,
          "bg-background text-muted-foreground border-border sticky top-0 z-10 border-b px-1 py-2 text-xs",
        )}
      >
        <span>名称</span>
        <span className="text-right">PID</span>
        <span className={cn("text-right", metric === "cpu" && "text-foreground font-medium")}>
          CPU
        </span>
        <span className={cn("text-right", metric === "mem" && "text-foreground font-medium")}>
          内存
        </span>
      </div>

      {ordered.map((group) => {
        const open = expanded[group.id] ?? false;
        const Icon = GROUP_ICON[group.id] ?? BoxesIcon;
        const rows = group.processes.slice().sort((a, b) => b[metric] - a[metric]);
        const shown = rows.slice(0, MAX_ROWS);
        return (
          <div key={group.id}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => onToggle(group.id)}
              className={cn(
                ROW_GRID,
                // 分组行是"表里的一个小标题"：给一层淡底色而不是描边，与进程行区分。
                // w-full 必须有：button 默认按内容收缩，缺了它网格会被压成内容宽度、
                // 数字列错位（现象是分组行的合计挤在左边）
                "hover:bg-hover bg-muted/40 mt-2 w-full rounded-md px-1 py-2 text-left",
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <ChevronRightIcon
                  className={cn(
                    "text-muted-foreground size-3.5 shrink-0 transition-transform duration-200",
                    open && "rotate-90",
                  )}
                />
                <Icon className="text-muted-foreground size-4 shrink-0" />
                <span className="truncate text-sm font-medium">{group.label}</span>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {group.count} 个
                </span>
              </span>
              {/* 分组行没有 PID：留空以保住列对齐 */}
              <span />
              <span className="truncate text-right font-mono text-sm whitespace-nowrap tabular-nums">
                {formatPct(group.cpu)}
              </span>
              <span className="truncate text-right font-mono text-sm whitespace-nowrap tabular-nums">
                {formatBytes(group.mem)}
              </span>
            </button>

            <AgentDisclosure open={open}>
              {/* 竖引导线从分组箭头下方贯穿整组：缩进有了依据，就不必再描横线 */}
              <div className="relative py-0.5">
                <span aria-hidden className="bg-border absolute top-0 bottom-1 left-[9px] w-px" />
                {shown.map((proc) => (
                  <div
                    key={proc.pid}
                    title={proc.detail}
                    className={cn(ROW_GRID, "hover:bg-hover rounded-md px-1 py-1.5 pl-8 text-sm")}
                  >
                  <span className="min-w-0 truncate">{proc.name}</span>
                  <span className="text-muted-foreground truncate text-right font-mono text-xs whitespace-nowrap tabular-nums">
                    {proc.pid}
                  </span>
                  <span className="truncate text-right font-mono text-xs whitespace-nowrap tabular-nums">
                    {formatPct(proc.cpu)}
                  </span>
                  <span className="truncate text-right font-mono text-xs whitespace-nowrap tabular-nums">
                    {formatBytes(proc.mem)}
                  </span>
                  </div>
                ))}
                {rows.length > shown.length && (
                  <div className="text-muted-foreground px-1 py-1.5 pl-8 text-xs">
                    其余 {rows.length - shown.length} 个进程未显示
                  </div>
                )}
              </div>
            </AgentDisclosure>
          </div>
        );
      })}
    </div>
  );
};
