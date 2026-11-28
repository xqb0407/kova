"use client";

/**
 * 图标栏：窗口最左列的常驻一级导航（小浣熊式布局的三段壳之第一段）。
 *
 * 一级分区 = 顶部四个图标（首页 / 能力中心 / 数据 / 定时任务），底部 =
 * 远程 / 使用统计 / 设置。分区 id 直接复用外壳的 activeMenu 语义
 * （""=首页、"connector"/"files"/"automation"/"remote"/"usage"），
 * 激活态由宿主受控——图标栏自己不持导航状态。
 *
 * 底色透明：整窗是 bg-muted 灰底（chrome 条 + 图标栏 + 内容浮层四周的
 * 灰边同属一块底），图标栏不再自铺底色。激活/悬停用前景色低透明度叠加，
 * 参考实现同款（亮色黑 6%/10%、暗色白 12%）。
 */

import type { ComponentType, FC } from "react";
import {
  BlocksIcon,
  CalendarClockIcon,
  ChartColumnIcon,
  DatabaseIcon,
  HouseIcon,
  MonitorSmartphoneIcon,
  SettingsIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isRemoteMode } from "@/lib/remote";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { InboxIcon } from "@/components/icons/inbox-icons";
import { useT } from "@/lib/i18n";

type RailItem = {
  id: string;
  icon: ComponentType<{ className?: string }>;
  labelKey: string;
};

/** 顶部一级分区：id 与 activeMenu 值同空间（"" = 首页/聊天） */
const RAIL_SECTIONS: RailItem[] = [
  { id: "", icon: HouseIcon, labelKey: "chat.sidebar.home" },
  { id: "inbox", icon: InboxIcon, labelKey: "inbox.sidebar" },
  { id: "connector", icon: BlocksIcon, labelKey: "chat.sidebar.hub" },
  { id: "files", icon: DatabaseIcon, labelKey: "chat.sidebar.data" },
  { id: "automation", icon: CalendarClockIcon, labelKey: "chat.sidebar.schedule" },
];

/** 底部一级入口：设置是动作（开覆盖层）不是视图，不在列 */
const RAIL_BOTTOM: RailItem[] = [
  { id: "remote", icon: MonitorSmartphoneIcon, labelKey: "chat.sidebar.remote" },
  { id: "usage", icon: ChartColumnIcon, labelKey: "chat.sidebar.usageStats" },
];

const RailButton: FC<{
  item: RailItem;
  active: boolean;
  label: string;
  badge?: number;
  onSelect: (id: string) => void;
}> = ({ item, active, label, badge = 0, onSelect }) => {
  const Icon = item.icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-current={active || undefined}
            onClick={() => onSelect(item.id)}
            className={cn(
              "grid size-10 shrink-0 place-items-center rounded-xl transition-colors",
              active
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
            )}
          >
            <span className="relative grid place-items-center">
              <Icon className="size-[18px]" />
              {badge > 0 ? (
                <span
                  aria-hidden
                  className="bg-primary ring-background absolute -top-0.5 -right-0.5 size-1.5 rounded-full ring-2"
                />
              ) : null}
            </span>
          </button>
        }
      />
      <TooltipContent side="right" sideOffset={10}>
        {badge > 0 ? `${label} (${badge > 99 ? "99+" : badge})` : label}
      </TooltipContent>
    </Tooltip>
  );
};

export const NavRail: FC<{
  /** 当前激活分区（activeMenu 值；"" = 首页） */
  active: string;
  /** 收件箱未读数：图标上点一个未读圆点，tooltip 带数量 */
  inboxBadge?: number;
  /** 分区/底部入口点击（settings 除外） */
  onSelect: (id: string) => void;
  /** 底部设置齿轮：打开设置覆盖层 */
  onOpenSettings: () => void;
}> = ({ active, inboxBadge = 0, onSelect, onOpenSettings }) => {
  const t = useT();
  // 远程网页端不渲染桌面专属入口（与旧侧边栏同口径）：自己就是远程会话，
  // 设置/统计是桌面端的事
  const remoteOnly = isRemoteMode();

  return (
    <nav
      aria-label={t("chat.sidebar.aria")}
      className="hidden h-full w-14 shrink-0 flex-col items-center py-2 md:flex"
    >
      <div className="flex flex-col items-center gap-1">
        {RAIL_SECTIONS.map((item) => (
          <RailButton
            key={item.id}
            item={item}
            active={active === item.id}
            label={t(item.labelKey)}
            badge={item.id === "inbox" ? inboxBadge : 0}
            onSelect={onSelect}
          />
        ))}
      </div>
      {!remoteOnly && (
        <div className="mt-auto flex flex-col items-center gap-1">
          {RAIL_BOTTOM.map((item) => (
            <RailButton
              key={item.id}
              item={item}
              active={active === item.id}
              label={t(item.labelKey)}
              onSelect={onSelect}
            />
          ))}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={t("chat.sidebar.settings")}
                  onClick={onOpenSettings}
                  className="text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground grid size-10 shrink-0 place-items-center rounded-xl transition-colors"
                >
                  <SettingsIcon className="size-[18px]" />
                </button>
              }
            />
            <TooltipContent side="right" sideOffset={10}>
              {t("chat.sidebar.settings")}
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </nav>
  );
};
