"use client";

import { ChevronDownIcon, LoaderCircleIcon } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { useState, type FC, type ReactNode } from "react";
import { SPRING_SWAP } from "@/lib/ease";
import { AgentDisclosure } from "@/components/custom-ui/agent-disclosure";
import { cn } from "@/lib/utils";

/**
 * Agent 面板区块共用卡片壳:chrome 对齐 custom-ui/TodoList
 * (圆角边框卡 + h-11 折叠头 + AgentDisclosure 内容展开)。
 */
export const PanelSection: FC<{
  icon: ReactNode;
  title: ReactNode;
  /** 头部右侧统计槽(计数/±行数等) */
  trailing?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}> = ({ icon, title, trailing, defaultOpen = true, children, className }) => {
  const reduce = useReducedMotion() ?? false;
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section
      className={cn(
        "bg-card/40 overflow-hidden rounded-2xl border border-border/70",
        className,
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="group hover:bg-muted/40 flex h-11 w-full items-center gap-2.5 px-3.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="grid size-6 shrink-0 place-items-center text-muted-foreground">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90">
          {title}
        </span>
        {trailing}
        <motion.span
          aria-hidden="true"
          animate={{ rotate: open ? 180 : 0 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
          className="shrink-0 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground"
        >
          <ChevronDownIcon className="size-3.5" />
        </motion.span>
      </button>
      <AgentDisclosure open={open}>
        <div className="px-2 pb-2">{children}</div>
      </AgentDisclosure>
    </section>
  );
};

/** 工具条目状态点:运行中转圈,完成绿,失败红(与 ToolFallback 的观感一致) */
export const StatusDot: FC<{ running?: boolean; failed?: boolean }> = ({
  running,
  failed,
}) =>
  running ? (
    <LoaderCircleIcon className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
  ) : (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        failed ? "bg-destructive" : "bg-lime-500",
      )}
    />
  );

/** 行级变更统计徽标:+N −M(绿/红,0 值淡化) */
export const DiffStats: FC<{ added: number; removed: number }> = ({
  added,
  removed,
}) => (
  <span className="shrink-0 text-xs font-medium tabular-nums">
    <span className={cn(added > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground/40")}>
      +{added}
    </span>{" "}
    <span className={cn(removed > 0 ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground/40")}>
      -{removed}
    </span>
  </span>
);

/** 计数淡色小徽标(终端条数等) */
export const CountPill: FC<{ children: ReactNode }> = ({ children }) => (
  <span className="text-muted-foreground shrink-0 text-xs font-medium tabular-nums">
    {children}
  </span>
);
