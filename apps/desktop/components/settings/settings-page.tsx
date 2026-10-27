"use client";

import { useEffect, useRef, useState, type FC } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { isMacPlatform, isDesktop } from "@/lib/desktop-env";
import { useFluidHover } from "@/hooks/use-fluid-hover";
import { FluidHoverHighlight } from "@/components/fluid-hover-highlight";
import { FluidHoverRow } from "@/components/fluid-hover-row";
import { WindowControls } from "@/components/window-controls";
import {
  ArchiveIcon,
  BotIcon,
  BoxesIcon,
  BrainIcon,
  ChevronLeftIcon,
  HardDriveDownloadIcon,
  InfoIcon,
  KeyRoundIcon,
  KeyboardIcon,
  PaletteIcon,
  PaintbrushIcon,
  RocketIcon,
  ServerIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  WebhookIcon,
  ZapIcon,
} from "lucide-react";
import { GeneralSettings } from "./components/general-settings";
import { AgentConfigSettings } from "./components/agent-config-settings";
import { AccessAccelSettings } from "./components/access-accel-settings";
import { HooksSettings } from "./components/hooks-settings";
import { WebhooksSettings } from "./components/webhooks-settings";
import { ModelSettings } from "./components/model-settings";
import { AppearanceSettings } from "./components/appearance-settings";
import { AboutSettings } from "./components/about-settings";
import { ArchiveSettings } from "./components/archive-settings";
import { MemorySettings } from "./components/memory-settings";
import { BackupSettings } from "./components/backup-settings";
import { PersonalizationSettings } from "./components/personalization-settings";
import { ShortcutSettings } from "./components/shortcut-settings";
import { SecretsSettings } from "./components/secrets-settings";
import { DesignThemesSettings } from "./components/design-themes-settings";
import { SshHostsSettings } from "./components/ssh-hosts-settings";

export type SettingsSection =
  | "models"
  | "appearance"
  | "about"
  | "general"
  | "archive"
  | "personalization"
  | "memory"
  | "backup"
  | "shortcuts"
  | "webhooks"
  | "hooks"
  | "agent-config"
  | "secrets"
  | "design-themes"
  | "access-accel"
  | "ssh-hosts";

const GROUPS: {
  label: string;
  items: { id: SettingsSection; label: string; icon: FC<{ className?: string }> }[];
}[] = [
  {
    label: "偏好",
    items: [
      { id: "general", label: "通用", icon: SlidersHorizontalIcon },
      { id: "appearance", label: "外观", icon: PaintbrushIcon },
      { id: "personalization", label: "个性化", icon: SparklesIcon },
      { id: "shortcuts", label: "快捷键", icon: KeyboardIcon },
      { id: "archive", label: "归档", icon: ArchiveIcon },
      { id: "backup", label: "备份", icon: HardDriveDownloadIcon },
    ],
  },
  {
    label: "智能体",
    items: [
      { id: "models", label: "模型", icon: BoxesIcon },
      // 智能体配置：电脑控制（能碰本机哪些能力）与 AI 审查（自动动手前谁判风险）
      // 合在一页——两件事都只在回答"我放开了多少"，分成两个入口要拼两次才看得全。
      // 归「智能体」组而不是「系统」——授权的对象是 agent，不是这台机器
      { id: "agent-config", label: "智能体配置", icon: BotIcon },
      { id: "memory", label: "记忆", icon: BrainIcon },
      { id: "hooks", label: "钩子", icon: ZapIcon },
      { id: "secrets", label: "密钥", icon: KeyRoundIcon },
      { id: "design-themes", label: "设计主题", icon: PaletteIcon },
    ],
  },
  {
    label: "系统",
    items: [
      // 访问加速：AI 联网时把 GitHub 等地址改走镜像站。归「系统」而不是
      // 「智能体」——改的是这台机器的出网路径，与授予 agent 什么能力无关
      { id: "access-accel", label: "访问加速", icon: RocketIcon },
      // SSH 主机：远程项目的连接目标，改的是本机出站连接配置，同归「系统」
      { id: "ssh-hosts", label: "SSH 主机", icon: ServerIcon },
      { id: "webhooks", label: "Webhooks", icon: WebhookIcon },
      { id: "about", label: "关于", icon: InfoIcon },
    ],
  },
];

/** 事件详情等不可信来源 → section id 的收敛校验（composer 跳本页用）；
 *  集合从 GROUPS 推导，导航加页即校验放开，两处不会漂移 */
const ALL_SECTIONS = new Set<SettingsSection>(GROUPS.flatMap((g) => g.items.map((i) => i.id)));
export function isSettingsSection(raw: unknown): raw is SettingsSection {
  return typeof raw === "string" && ALL_SECTIONS.has(raw as SettingsSection);
}

/** 无跳转目标时落在菜单第一项（当前是「通用」），不要再硬编码 models */
const FIRST_SECTION: SettingsSection = GROUPS[0]?.items[0]?.id ?? "general";

// fluid hover 槽位：模块级常量保证注册序稳定，导航项按 GROUPS 顺序从 0 起；
// 分组标题不注册（高亮跳过，就近点亮条目）。「返回应用」已移到侧边栏底部的
// 固定页脚，不再占 0 号槽位——它脱离了滚动容器，也就脱离了这套按容器坐标
// 测量 rect 的悬浮高亮（见下方页脚注释）
const NAV_ITEM_INDEX = (() => {
  const map = new Map<SettingsSection, number>();
  let next = 0;
  for (const group of GROUPS) {
    for (const item of group.items) map.set(item.id, next++);
  }
  return map;
})();

/** 设置页：全窗口视图，左侧二级侧边栏导航，"返回应用"回到聊天 */
export const SettingsPage: FC<{
  onBack: () => void;
  /** 跳转目标分区 id（base.tsx 自 window 事件转来，不可信字符串，本模块校验） */
  jumpSection?: string;
  /** 单调递增序号：已挂载状态下同分区重复跳转也要生效，靠它触发 effect */
  jumpSeq?: number;
}> = ({ onBack, jumpSection, jumpSeq }) => {
  const [section, setSection] = useState<SettingsSection>(() =>
    isSettingsSection(jumpSection) ? jumpSection : FIRST_SECTION,
  );
  useEffect(() => {
    if (jumpSeq && isSettingsSection(jumpSection)) setSection(jumpSection);
  }, [jumpSeq, jumpSection]);
  // 左侧导航与侧边栏列表同款 fluid hover：导航容器即滚动容器，
  // 高亮 rect 随 content 滚动（容器内 position:absolute 子元素随之滚动）
  const navRef = useRef<HTMLDivElement>(null);
  const navHover = useFluidHover(navRef);
  // 桌面端自绘 titlebar：拖拽区所有桌面端生效；macOS 红绿灯悬浮于侧边栏顶栏，
  // Windows 隐藏系统标题栏后由 WindowControls 接管，网页端无窗口 chrome
  const desktop = isDesktop();
  const winControls = desktop && !isMacPlatform();
  // macOS 桌面端的红绿灯悬浮在侧栏顶栏左缘；其他平台这一行没有系统 chrome，
  // 放「设置」标题，避免 Windows 上出现一整条空白
  const macDesktop = desktop && isMacPlatform();

  return (
    <div className="bg-muted/55 flex h-full w-full">
      {/* 二级侧边栏 */}
      <nav
        data-slot="settings-nav"
        className="bg-transparent flex w-65 shrink-0  flex-col border-r border-border/50"
      >
        {/* 顶栏拖拽区：macOS 红绿灯悬浮于此行；Windows/Linux/网页放「设置」
            标题，避免左侧一整条空白 */}
        <div
          data-drag-region={desktop ? "deep" : undefined}
          className="flex h-12 shrink-0 items-center pl-5"
        >
          {macDesktop ? null : (
            <span className="text-foreground/90 text-md pt-4 font-bold">设置</span>
          )}
        </div>

        <div
          ref={navRef}
          className="relative flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3 pt-1"
          {...navHover.handlers}
        >
          {/* 选中项常驻高亮：复用同一套 itemRects 测量，切换 section 时
              弹簧滑到目标行。session 恒为 0 → 不随鼠标进出重新淡入淡出，
              只在首挂载淡入、此后只滑位置。渲染在 hover 高亮之前：同层
              绝对定位，鼠标悬停高亮叠在选中高亮之上。 */}
          <FluidHoverHighlight
            rect={
              navHover.isMeasured
                ? (navHover.itemRects[NAV_ITEM_INDEX.get(section) ?? 0] ?? null)
                : null
            }
            session={0}
            className="bg-muted rounded-md"
            // 跨行位移比悬停跟随远得多，用与 ui/tabs 指示器同款的
            // no-overshoot spring（beui 参考曲线），而非 80ms 的 spring.fast。
            transition={{ type: "spring", stiffness: 170, damping: 30, mass: 1.2 }}
          />
          <FluidHoverHighlight hover={navHover} className="rounded-md" />
          {GROUPS.map((group) => (
            <div key={group.label} className="flex flex-col gap-1">
              <div className="text-muted-foreground px-2 pt-3 pb-1 text-xs font-medium">
                {group.label}
              </div>
              {group.items.map(({ id, label, icon: Icon }) => (
                <FluidHoverRow
                  key={id}
                  registerItem={navHover.registerItem}
                  index={NAV_ITEM_INDEX.get(id) ?? 0}
                >
                  <button
                    type="button"
                    onClick={() => setSection(id)}
                    data-active={section === id}
                    className={cn(
                      "flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-sm font-normal",
                      "data-active:text-foreground text-muted-foreground",
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    {label}
                  </button>
                </FluidHoverRow>
              ))}
            </div>
          ))}
        </div>

        {/* "返回应用"固定在侧边栏底部：脱离上面的滚动容器，导航滚到底它也不会
            被滚走。代价是它不再参与 fluid hover（高亮按容器坐标测量，移出容器
            后 rect 会对不上），因此这里用 Button ghost 自带的 hover 底色兜底 */}
        <div className="shrink-0 px-3 pt-1 pb-3">
          <Button
            variant="ghost"
            className="h-8 w-full justify-start gap-1.5 rounded-md px-2.5 text-sm font-normal text-muted-foreground"
            onClick={onBack}
          >
            <ChevronLeftIcon className="size-4 shrink-0" />
            返回应用
          </Button>
        </div>
      </nav>

      {/* 内容区 */}
      <div className="flex min-w-0 flex-1 flex-col bg-background">
        <div
          data-drag-region={desktop ? "deep" : undefined}
          className="flex h-12 shrink-0 items-center justify-end pr-4"
        >
          {/* 窗口控制固定在窗口右上角；仅 Windows/Linux 渲染 */}
          {winControls && <WindowControls />}
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto">
          {section === "models" && <ModelSettings />}
          {section === "appearance" && <AppearanceSettings />}
          {section === "personalization" && <PersonalizationSettings />}
          {section === "memory" && <MemorySettings />}
          {section === "backup" && <BackupSettings />}
          {section === "shortcuts" && <ShortcutSettings />}
          {section === "archive" && <ArchiveSettings />}
          {section === "webhooks" && <WebhooksSettings />}
          {section === "hooks" && <HooksSettings />}
          {section === "agent-config" && <AgentConfigSettings />}
          {section === "secrets" && <SecretsSettings />}
          {section === "design-themes" && <DesignThemesSettings />}
          {section === "about" && <AboutSettings />}
          {section === "general" && <GeneralSettings />}
          {section === "access-accel" && <AccessAccelSettings />}
          {section === "ssh-hosts" && <SshHostsSettings />}
        </div>
      </div>
    </div>
  );
};
