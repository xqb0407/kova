"use client";

import type { FC } from "react";
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
  closePanelTab,
  openPanelTab,
  setActivePanelTab,
  type PanelTab,
} from "@/lib/panel-tabs";
import { TAB_META, tabTitle, useVisiblePanelTabTypes } from "./tab-registry";
import { cn } from "@/lib/utils";

/** 单个标签胶囊:图标 + 标题 + 关闭(悬停显现,激活常显) */
const TabChip: FC<{ tab: PanelTab; active: boolean }> = ({ tab, active }) => {
  const meta = TAB_META[tab.type];
  const Icon = meta.icon;
  return (
    <div
      role="button"
      tabIndex={0}
      title={tabTitle(tab)}
      onClick={() => setActivePanelTab(tab.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") setActivePanelTab(tab.id);
      }}
      className={cn(
        "group flex h-7 max-w-[150px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-2 text-xs outline-none transition-colors",
        active
          ? "border-border bg-muted text-foreground"
          : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
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
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
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
        {tabs.map((t) => (
          <TabChip key={t.id} tab={t} active={t.id === activeId} />
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
