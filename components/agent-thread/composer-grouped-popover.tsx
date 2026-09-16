"use client";

import { useEffect, useRef, type ComponentPropsWithoutRef, type FC } from "react";
import {
  ComposerPrimitive,
  unstable_useTriggerPopoverScopeContext,
} from "@assistant-ui/react";
import type { Unstable_TriggerAdapter } from "@assistant-ui/core";
import { SparklesIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type IconComponent = FC<{ className?: string }>;

/** 分组顺序即展示顺序；按条目 type 归组，空组不渲染 */
const GROUP_DEFS: readonly { type: string; label: string }[] = [
  { type: "command", label: "命令" },
  { type: "skill", label: "技能" },
  { type: "tool", label: "MCP 工具" },
  { type: "agent", label: "子智能体" },
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
  const { isLoading } = unstable_useTriggerPopoverScopeContext();
  return (
    <div ref={scrollRef} className="max-h-72 overflow-y-auto overscroll-contain">
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
                        <Icon className="text-muted-foreground size-3.5 shrink-0" />
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

/**
 * 平铺分组的触发弹层（替代预制 ComposerTriggerPopover 的分类钻取形态）：
 * 组头 + 条目一屏展示，超过 max-h-72 内部滚动，组头吸顶。
 * adapter 需为平铺形态（categories() 返回空数组 → 弹层恒为搜索模式，
 * 条目由 search(query) 供给，空 query 时返回全量即完整分组视图）。
 */
const GroupedTriggerPopoverImpl: FC<GroupedTriggerPopoverProps> = ({
  char,
  adapter,
  iconMap,
  fallbackIcon = SparklesIcon,
  emptyLabel,
  className,
  directive,
  action,
}) => {
  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      data-slot="composer-grouped-popover"
      char={char}
      adapter={adapter}
      className={cn(
        "aui-composer-trigger-popover bg-popover text-popover-foreground absolute start-0 bottom-full z-50 mb-2 w-80 overflow-hidden rounded-xl border shadow-2xl",
        className,
      )}
    >
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
