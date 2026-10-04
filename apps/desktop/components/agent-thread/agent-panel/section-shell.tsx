"use client";

import { ChevronDownIcon, LoaderCircleIcon } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FC,
  type ReactNode,
  type RefObject,
} from "react";
import { SPRING_SWAP } from "@/lib/motion/ease";
import { AgentDisclosure } from "@/components/custom-ui/agent-disclosure";
import { cn } from "@/lib/utils";

/** 区块头是否处于吸顶态：内容区里的次级 sticky（如图谱搜索行）据此做同样的全出血处理 */
const SectionPinnedCtx = createContext(false);
export const useSectionPinned = () => useContext(SectionPinnedCtx);

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
  /** 外层滚动容器 ref：IntersectionObserver 的 root，用于精确判定头部是否吸顶 */
  scrollRoot?: RefObject<HTMLElement | null>;
}> = ({ icon, title, trailing, defaultOpen = true, children, className, scrollRoot }) => {
  const reduce = useReducedMotion() ?? false;
  const [open, setOpen] = useState(defaultOpen);
  // 吸顶中：卡片侧/顶边框透明、头部换成与顶栏同规格的底边线与底色；
  // 未吸顶时保持原卡片外观（用户要求：只在吸附那一刻才变）
  const [pinned, setPinned] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        const rootTop = entry.rootBounds?.top ?? 0;
        setPinned(!entry.isIntersecting && entry.boundingClientRect.top < rootTop);
      },
      { root: scrollRoot?.current ?? null, threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [scrollRoot]);

  return (
    // shrink-0：作为 flex-col 滚动容器的子项，overflow-hidden 会使
    // flex 自动最小尺寸归零——不加就会被压扁进视口、外层滚不动。
    // overflow-clip 同样裁圆角但不建立滚动容器，头部 sticky 才有效。
    <section
      className={cn(
        "shrink-0 overflow-clip border border-border/70 bg-card/40 transition-colors",
        // 吸顶时：负外边距抵消滚动容器 p-3，整卡左右撑满滚动区、顶缘取直、
        // 顶/侧边框透明——头部底边线与顶栏底边线连成一条，不再留左右缝
        pinned
          ? "-mx-3 rounded-t-none border-x-transparent border-t-transparent"
          : "rounded-2xl",
        className,
      )}
    >
      {/* 零高哨兵贴在区块顶边：滚出滚动口 ⇔ 头部处于吸顶态 */}
      <div ref={sentinelRef} className="h-px w-full" aria-hidden />
      {/* 滚动到本区块深处时折叠头吸顶，磨砂透出下方内容（对齐 macOS 观感）。
          撑开时左右各补 12px 内边距（px-3.5→px-[26px]），图标/标题位置不动 */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "group hover:bg-muted/40 sticky top-0 z-20 flex h-11 w-full items-center gap-2.5 border-b text-left backdrop-blur-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          pinned
            ? "bg-background/70 border-b-border/60 px-[26px]"
            : "bg-card/60 border-b-transparent px-3.5",
        )}
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
      {/* overflow-clip：同 hidden 般裁切圆角，但不成为滚动容器，
          内容里的次级 sticky（如图谱搜索框）仍能吸附在外层滚动区 */}
      <SectionPinnedCtx.Provider value={pinned}>
        <AgentDisclosure open={open} className="overflow-clip">
          {/* 撑开态内容缩进保持与吸顶前一致（px-2 + 补回左右 12px = px-5） */}
          <div className={cn("pb-2", pinned ? "px-5" : "px-2")}>{children}</div>
        </AgentDisclosure>
      </SectionPinnedCtx.Provider>
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

/** 行级变更统计徽标:+N −M(绿/红,0 值淡化);className 供宿主覆盖字号 */
export const DiffStats: FC<{
  added: number;
  removed: number;
  className?: string;
}> = ({ added, removed, className }) => (
  <span className={cn("shrink-0 text-xs font-medium tabular-nums", className)}>
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
