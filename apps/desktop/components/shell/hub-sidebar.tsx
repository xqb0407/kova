"use client";

/**
 * 「能力中心」分区的二级侧边栏：市场（插件 / 技能 / MCP）、已安装入口、
 * 管理分段三组。子导航选中态受控（base 持 hubSection，主区
 * MarketplaceView 同源）；「管理」各分段经 base 的 manageRequest 直落
 * 管理页，与主区页头右上角的「管理」同一通道。
 */

import type { FC } from "react";
import {
  BotIcon,
  PackageIcon,
  ServerIcon,
  SparklesIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
// type-only：编译期擦除，不会把 marketplace-view（重模块，按需 chunk）拖进首屏。
import type {
  ManageTab,
  MarketplaceSection,
} from "@/components/marketplace/marketplace-view";

const HUB_ITEMS: {
  id: MarketplaceSection;
  icon: LucideIcon;
  labelKey: string;
}[] = [
  {
    id: "connectors",
    icon: ServerIcon,
    labelKey: "marketplace.view.tab.connectors",
  },
  {
    id: "plugins",
    icon: PackageIcon,
    labelKey: "marketplace.view.tab.plugins",
  },
  {
    id: "skills",
    icon: SparklesIcon,
    labelKey: "marketplace.view.tab.skills",
  },
];

const MANAGE_ITEMS: {
  id: ManageTab;
  icon: LucideIcon;
  labelKey: string;
}[] = [
  {
    id: "subagents",
    icon: BotIcon,
    labelKey: "marketplace.view.manageMeta.subagents.label",
  },
  {
    id: "plugins",
    icon: ServerIcon,
    labelKey: "marketplace.view.manageMeta.plugins.label",
  },
  {
    id: "skills",
    icon: SparklesIcon,
    labelKey: "marketplace.view.manageMeta.skills.label",
  },
  {
    id: "commands",
    icon: TerminalIcon,
    labelKey: "marketplace.view.manageMeta.commands.label",
  },
];

const ITEM_CLASS =
  "flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-sm transition-colors";
const IDLE_CLASS =
  "text-muted-foreground hover:bg-muted hover:text-foreground";

/** 分组小标题：与主侧栏的区块标题同字号，分组之间用上间距拉开。
 *  左对齐：与条目图标同一列（容器内边距 12 + 按钮内边距 12 = 24px） */
const GroupLabel: FC<{ children: string; className?: string }> = ({
  children,
  className,
}) => (
  <p
    className={cn(
      "text-muted-foreground/70 mb-1 px-3 text-xs font-medium",
      className,
    )}
  >
    {children}
  </p>
);

export const HubSidebar: FC<{
  active: MarketplaceSection;
  onSelect: (section: MarketplaceSection) => void;
  onOpenManage: (tab: ManageTab) => void;
}> = ({ active, onSelect, onOpenManage }) => {
  const t = useT();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pt-5 pb-3">
        <GroupLabel>{t("marketplace.hubSidebar.market")}</GroupLabel>
        {HUB_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={active === item.id || undefined}
              onClick={() => onSelect(item.id)}
              className={cn(
                ITEM_CLASS,
                active === item.id
                  ? "bg-selected text-foreground font-medium"
                  : IDLE_CLASS,
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{t(item.labelKey)}</span>
            </button>
          );
        })}

        <GroupLabel className="mt-4">
          {t("marketplace.hubSidebar.manage")}
        </GroupLabel>
        {MANAGE_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onOpenManage(item.id)}
              className={cn(ITEM_CLASS, IDLE_CLASS)}
            >
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{t(item.labelKey)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
