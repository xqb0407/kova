"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type FC,
} from "react";
import {
  ComposerPrimitive,
  unstable_useTriggerPopoverScopeContext,
} from "@assistant-ui/react";
import type { Unstable_TriggerAdapter } from "@assistant-ui/core";
import { SparklesIcon } from "lucide-react";
import { FileTypeIcon } from "@/components/agent-thread/agent-panel/file-type-icon";
import { cn } from "@/lib/utils";

type IconComponent = FC<{ className?: string }>;

/** 分组顺序即展示顺序；按条目 type 归组，空组不渲染 */
const GROUP_DEFS: readonly { type: string; label: string }[] = [
  { type: "command", label: "命令" },
  { type: "skill", label: "技能" },
  { type: "tool", label: "MCP 工具" },
  { type: "agent", label: "子智能体" },
  { type: "library", label: "资料库" },
];

function resolveIcon(
  iconKey: string | undefined,
  iconMap: Record<string, IconComponent> | undefined,
  fallback: IconComponent,
): IconComponent {
  if (iconKey && iconMap?.[iconKey]) return iconMap[iconKey]!;
  return fallback;
}

type GroupedTriggerPopoverProps = {
  char: string;
  adapter: Unstable_TriggerAdapter;
  /** 条目按 metadata.icon 查键；条目类型见 composer-commands.ts 的三类 + agent */
  iconMap?: Record<string, IconComponent>;
  fallbackIcon?: IconComponent;
  /** 无匹配条目时的空态文案 */
  emptyLabel: string;
  /** adapter 异步取数中（资料库索引首次加载）：空态显示「加载中…」 */
  isLoading?: boolean;
  /**
   * 展开方向：
   * - "auto"（默认）：按输入框上/下可用空间自动选——小窗/居中时向下，避免被
   *   header 遮住；弹层高度变化（搜索过滤）会自动重算；
   * - "up"/"down"：固定方向（弹窗内等明确场景用）。
   */
  placement?: "auto" | "up" | "down";
  className?: string;
} & (
  | {
      /** 插入指令芯片行为（@ 提及） */
      directive: ComponentPropsWithoutRef<typeof ComposerPrimitive.Unstable_TriggerPopover.Directive>;
      action?: never;
    }
  | {
      /** 选中回调行为（/ 命令） */
      action: ComponentPropsWithoutRef<typeof ComposerPrimitive.Unstable_TriggerPopover.Action>;
      directive?: never;
    }
);

/** 高亮项滚入视野：键盘上下键时高亮可能落在滚动容器外，库内不处理跟随 */
function useHighlightScrollIntoView() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { items, highlightedIndex } = unstable_useTriggerPopoverScopeContext();
  useEffect(() => {
    const item = items[highlightedIndex];
    if (!item || !scrollRef.current) return;
    const el = scrollRef.current.querySelector(
      `[data-item-option="${CSS.escape(item.id)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [items, highlightedIndex]);
  return scrollRef;
}

const GroupedItems: FC<{
  iconMap: Record<string, IconComponent> | undefined;
  fallbackIcon: IconComponent;
  emptyLabel: string;
}> = ({ iconMap, fallbackIcon, emptyLabel }) => {
  const scrollRef = useHighlightScrollIntoView();
  const { isLoading, open } = unstable_useTriggerPopoverScopeContext();
  // 关闭态下库会原样渲染 children（TriggerPopoverItems 自己 return null，
  // 但外层滚动 div 还在）：弹层是 Root 的 flex 子项时，这个空 div 连同它的
  // gap 会在输入框底部撑出一段死间隙，必须整个不渲染
  if (!open) return null;
  return (
    <div
      ref={scrollRef}
      className="max-h-72 min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(flat) => (
          <div className="flex flex-col py-1">
            {GROUP_DEFS.map(({ type, label }) => {
              const groupItems = flat.filter((i) => i.type === type);
              if (groupItems.length === 0) return null;
              return (
                <div key={type} className="flex flex-col">
                  <div className="text-muted-foreground sticky top-0 z-10 bg-popover px-3 pb-1 pt-2 text-[11px] leading-4 font-medium tracking-wide">
                    {label}
                  </div>
                  {groupItems.map((item) => {
                    const iconKey =
                      typeof item.metadata?.icon === "string"
                        ? item.metadata.icon
                        : undefined;
                    const Icon = resolveIcon(iconKey, iconMap, fallbackIcon);
                    return (
                      <ComposerPrimitive.Unstable_TriggerPopoverItem
                        key={item.id}
                        item={item}
                        index={flat.indexOf(item)}
                        data-item-option={item.id}
                        className="hover:bg-accent focus:bg-accent data-[highlighted]:bg-accent mx-1 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-start transition-colors outline-none"
                      >
                        {/* 资料库条目用与文件树一致的彩色类型图标（label 即文件名）；
                            其余条目按 iconMap 取 lucide 图标 */}
                        {item.type === "library" ? (
                          <FileTypeIcon
                            path={item.label}
                            className="size-3.5 shrink-0"
                          />
                        ) : (
                          <Icon className="text-muted-foreground size-3.5 shrink-0" />
                        )}
                        <span className="max-w-[50%] shrink-0 truncate text-sm font-medium">
                          {item.label}
                        </span>
                        {item.description && (
                          <span
                            className="text-muted-foreground min-w-0 flex-1 truncate text-xs"
                            title={item.description}
                          >
                            {item.description}
                          </span>
                        )}
                      </ComposerPrimitive.Unstable_TriggerPopoverItem>
                    );
                  })}
                </div>
              );
            })}
            {flat.length === 0 && (
              <div className="text-muted-foreground px-3 py-2 text-sm">
                {isLoading ? "加载中…" : emptyLabel}
              </div>
            )}
          </div>
        )}
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </div>
  );
};

/** 开合探针：弹层外框只在 open 时渲染，但探针在关闭态也会挂载（父级原样
 *  渲染 children），把 open 变化报给外层做方向测量 */
const PopoverOpenProbe: FC<{ onChange: (open: boolean) => void }> = ({
  onChange,
}) => {
  const { open } = unstable_useTriggerPopoverScopeContext();
  useEffect(() => {
    onChange(open);
  }, [open, onChange]);
  return null;
};

/** 弹层最大高度估值的上限（条目区 max-h-72 + 组头/内边距，留点余量） */
const MAX_POPOVER_HEIGHT = 360;
/** 与输入框之间保留的呼吸间距 */
const POPOVER_GAP = 8;
/** 上方连这么点高度都没有时，固定向上会让弹层缩成一条：回退 auto 换边 */
const MIN_UP_SPACE = 120;

/**
 * 可见裁剪区：从锚点往上找第一个 overflow 不是 visible 的祖先。
 * 会话区是「header 之下的 flex-1 overflow-hidden」——直接用视口会把 header
 * 那 64px 也当成可用空间，弹层向上展开时照样被 header 盖住半截。
 */
function clippingViewport(from: HTMLElement | null): {
  top: number;
  bottom: number;
} {
  let node = from;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    if (/(hidden|auto|scroll|clip)/.test(style.overflowY)) {
      const rect = node.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    }
    node = node.parentElement;
  }
  return { top: 0, bottom: window.innerHeight };
}

/**
 * 平铺分组的触发弹层（替代预制 ComposerTriggerPopover 的分类钻取形态）：
 * 组头 + 一屏条目，超过 max-h-72 内部滚动，组头吸顶。
 * adapter 需为平铺形态（categories() 返回空数组 → 弹层恒为搜索模式，
 * 条目由 search(query) 供给，空 query 时返回全量即完整分组视图）。
 *
 * 方向：默认 auto——按输入框上/下可用空间选，小窗/居中时向下展开（此前固定
 * 向上，资料库分组把弹层撑高后会被窗口 header 遮住半截）。弹层自身高度随
 * 搜索过滤变化，用 ResizeObserver 重算；测量落定前先 invisible，避免向上
 * 闪一帧。
 */
const GroupedTriggerPopoverImpl: FC<GroupedTriggerPopoverProps> = ({
  char,
  adapter,
  iconMap,
  fallbackIcon = SparklesIcon,
  emptyLabel,
  isLoading,
  placement = "auto",
  className,
  directive,
  action,
}) => {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  /** auto 模式下的测量结果；null = 尚未测量（先隐藏避免方向闪动） */
  const [autoDir, setAutoDir] = useState<"up" | "down" | null>(null);
  /** 向上展开时锚点上方还剩多少高度：固定向上时按它限高，超出部分在内部
   *  滚动——否则弹层会被会话视口/header 裁掉半截（固定向上要付的代价） */
  const [upMaxHeight, setUpMaxHeight] = useState<number | null>(null);
  /** 向下展开时锚点下方可用高度：小窗里两侧都放不下时，向下也必须限高，
   *  否则弹层会越过窗口底缘（auto 换边只能选一侧，不能保证放得下） */
  const [downMaxHeight, setDownMaxHeight] = useState<number | null>(null);

  const measure = useCallback(() => {
    const el = popoverRef.current;
    // 弹层是 ComposerPrimitive.Root（relative）的直接子元素
    const anchor = el?.parentElement;
    if (!el || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const height = Math.min(
      el.scrollHeight || el.getBoundingClientRect().height,
      MAX_POPOVER_HEIGHT,
    );
    const viewport = clippingViewport(anchor);
    const spaceAbove = rect.top - viewport.top - POPOVER_GAP;
    const spaceBelow = viewport.bottom - rect.bottom - POPOVER_GAP;
    setUpMaxHeight(Math.max(0, Math.floor(spaceAbove)));
    setDownMaxHeight(Math.max(0, Math.floor(spaceBelow)));
    const fitsUp = spaceAbove >= height;
    const fitsDown = spaceBelow >= height;
    // 优先放得下的一侧；都放不下选空间大的一侧；相等时向下（小窗/居中更常见）
    const down = fitsDown
      ? fitsUp
        ? spaceBelow > spaceAbove
        : true
      : fitsUp
        ? false
        : spaceBelow >= spaceAbove;
    setAutoDir(down ? "down" : "up");
  }, []);

  useEffect(() => {
    if (!open) {
      setAutoDir(null);
      setUpMaxHeight(null);
      setDownMaxHeight(null);
      return;
    }
    if (placement !== "auto") setAutoDir(placement);
    // 两个方向都量：auto 用来选方向；固定向上时用上方可用高度给弹层限高
    // 首帧布局落定后再量一次；列表搜索过滤导致高度变化时由 ResizeObserver 重算
    measure();
    const raf = requestAnimationFrame(measure);
    const el = popoverRef.current;
    const resizeObserver =
      typeof ResizeObserver !== "undefined" && el
        ? new ResizeObserver(measure)
        : null;
    if (el) resizeObserver?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [open, placement, measure]);

  const dir =
    placement === "auto"
      ? autoDir
      : placement === "up" &&
          upMaxHeight != null &&
          upMaxHeight < MIN_UP_SPACE
        ? (autoDir ?? "down")
        : placement;
  /** 已量出该方向的可用空间：把弹层高度钉在里面，超出部分内部滚动 */
  const capHeight =
    dir === "up" ? upMaxHeight : dir === "down" ? downMaxHeight : null;

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      ref={popoverRef}
      data-slot="composer-grouped-popover"
      char={char}
      adapter={adapter}
      isLoading={isLoading}
      style={capHeight != null ? { maxHeight: `${capHeight}px` } : undefined}
      className={cn(
        "aui-composer-trigger-popover bg-popover text-popover-foreground absolute start-0 z-50 flex w-80 flex-col overflow-hidden rounded-xl border shadow-2xl",
        dir === "down" ? "top-full mt-2" : "bottom-full mb-2",
        // 尚未测量：先占位但不可见，避免向上闪一帧被 header 切
        ((placement === "auto" && dir === null) ||
          (dir === "up" && upMaxHeight === null)) &&
          "invisible",
        className,
      )}
    >
      <PopoverOpenProbe onChange={setOpen} />
      {directive ? (
        <ComposerPrimitive.Unstable_TriggerPopover.Directive {...directive} />
      ) : action ? (
        <ComposerPrimitive.Unstable_TriggerPopover.Action {...action} />
      ) : null}
      <GroupedItems
        iconMap={iconMap}
        fallbackIcon={fallbackIcon}
        emptyLabel={emptyLabel}
      />
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
};

GroupedTriggerPopoverImpl.displayName = "GroupedTriggerPopover";

export const GroupedTriggerPopover = GroupedTriggerPopoverImpl;
