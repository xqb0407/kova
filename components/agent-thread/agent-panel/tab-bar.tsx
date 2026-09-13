"use client";

import { useId, type FC } from "react";
import { motion, useReducedMotion, type Transition } from "framer-motion";
import { ChevronDownIcon, PlusIcon, XIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  closeAllPanelTabs,
  closeOtherPanelTabs,
  closePanelTab,
  closePanelTabsToLeft,
  closePanelTabsToRight,
  openPanelTab,
  setActivePanelTab,
  type PanelTab,
} from "@/lib/panel-tabs";
import { TAB_META, tabTitle, useVisiblePanelTabTypes } from "./tab-registry";
import { cn } from "@/lib/utils";

// 与 ui/tabs 指示器同款的 no-overshoot spring（beui 参考曲线）。
const pillTransition: Transition = {
  type: "spring",
  stiffness: 170,
  damping: 30,
  mass: 1.2,
};

/**
 * 单个标签胶囊:图标 + 标题 + 关闭(悬停显现,激活常显)。
 * IDE 式操作(参考 IDEA/VS Code):右键弹标签菜单,中键直接关闭,
 * 右键时先激活该标签(菜单标题即指向被操作的标签)。
 * 激活底色/描边交给共享布局滑块（pillLayoutId）：切换标签时从旧胶囊
 * 滑过来。滑块绝对定位在胶囊内（inset-0），横向滚动时随胶囊一起走；
 * -z-10 + isolate 把层叠锁在胶囊内，图标/标题/关闭按钮照常浮在滑块上。
 */
const TabChip: FC<{
  tab: PanelTab;
  active: boolean;
  index: number;
  count: number;
  pillLayoutId: string;
}> = ({ tab, active, index, count, pillLayoutId }) => {
  const meta = TAB_META[tab.type];
  const Icon = meta.icon;
  const reduce = useReducedMotion();
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            role="button"
            tabIndex={0}
            title={tabTitle(tab)}
            onClick={() => setActivePanelTab(tab.id)}
            onContextMenu={() => setActivePanelTab(tab.id)}
            onMouseDown={(e) => {
              // 中键:关闭标签(浏览器会闪滚动指针,需 preventDefault)
              if (e.button === 1) {
                e.preventDefault();
                closePanelTab(tab.id);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") setActivePanelTab(tab.id);
            }}
            className={cn(
              "group relative isolate flex h-7 max-w-[150px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-transparent px-2 text-xs outline-none transition-colors",
              active
                ? "text-foreground"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            {active ? (
              // -inset-px：滑块铺满胶囊的 border-box（绝对定位子元素默认
              // 只到 padding-box，差的那圈正是描边宽度）。
              <motion.span
                layoutId={pillLayoutId}
                layout="position"
                initial={false}
                transition={reduce ? { duration: 0 } : pillTransition}
                className="border-border bg-muted absolute -inset-px -z-10 rounded-lg border"
              />
            ) : null}
            <Icon className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{tabTitle(tab)}</span>
            <button
              type="button"
              aria-label="关闭标签"
              onClick={(e) => {
                e.stopPropagation();
                closePanelTab(tab.id);
              }}
              className={cn(
                "hover:bg-foreground/10 hover:text-foreground -mr-1 flex size-4 shrink-0 items-center justify-center rounded transition-opacity",
                active ? "opacity-60" : "opacity-0 group-hover:opacity-60",
              )}
            >
              <XIcon className="size-3" />
            </button>
          </div>
        }
      />
      <ContextMenuContent className="min-w-44">
        <ContextMenuItem onClick={() => closePanelTab(tab.id)}>
          关闭当前
        </ContextMenuItem>
        <ContextMenuItem
          disabled={count <= 1}
          onClick={() => closeOtherPanelTabs(tab.id)}
        >
          关闭其他
        </ContextMenuItem>
        <ContextMenuItem
          disabled={index === 0}
          onClick={() => closePanelTabsToLeft(tab.id)}
        >
          关闭左侧
        </ContextMenuItem>
        <ContextMenuItem
          disabled={index === count - 1}
          onClick={() => closePanelTabsToRight(tab.id)}
        >
          关闭右侧
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => closeAllPanelTabs()}>
          关闭全部
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

/**
 * 面板标签栏(Codex 同款):左为标签总览下拉(溢出时快速跳转),
 * 中间横向滚动标签条,右为 "+" 新标签菜单。
 * 面板收起走 Header 的开关按钮,这里不放折叠入口。
 */
export const TabBar: FC<{
  tabs: PanelTab[];
  activeId: string | null;
}> = ({ tabs, activeId }) => {
  const types = useVisiblePanelTabTypes();
  const pillLayoutId = useId();
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b-[0.5] px-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="所有标签"
              title="所有标签"
              className="text-muted-foreground hover:bg-muted hover:text-foreground size-7 shrink-0 rounded-md"
            >
              <ChevronDownIcon className="mx-auto size-4" />
            </button>
          }
        />
        <DropdownMenuContent align="start" className="min-w-44">
          <DropdownMenuGroup>
            <DropdownMenuLabel>打开的标签</DropdownMenuLabel>
            {tabs.length === 0 ? (
              <div className="text-muted-foreground px-2 py-1.5 text-xs">
                暂无标签
              </div>
            ) : (
              tabs.map((t) => {
                const Icon = TAB_META[t.type].icon;
                return (
                  <DropdownMenuItem
                    key={t.id}
                    onClick={() => setActivePanelTab(t.id)}
                  >
                    <Icon className="text-muted-foreground size-3.5 shrink-0" />
                    <span className="truncate">{tabTitle(t)}</span>
                  </DropdownMenuItem>
                );
              })
            )}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 标签条:溢出横向滚动 */}
      <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((t, i) => (
          <TabChip
            key={t.id}
            tab={t}
            active={t.id === activeId}
            index={i}
            count={tabs.length}
            pillLayoutId={pillLayoutId}
          />
        ))}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="新标签"
              title="新标签"
              className="text-muted-foreground hover:bg-muted hover:text-foreground size-7 shrink-0 rounded-md"
            >
              <PlusIcon className="mx-auto size-4" />
            </button>
          }
        />
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuGroup>
            <DropdownMenuLabel>打开标签页</DropdownMenuLabel>
            {types.map((type) => {
              const meta = TAB_META[type];
              const Icon = meta.icon;
              return (
                <DropdownMenuItem key={type} onClick={() => openPanelTab(type)}>
                  <Icon className="text-muted-foreground size-3.5 shrink-0" />
                  <span>{meta.label}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
