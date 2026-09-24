"use client";

import { useRef, useState, type FC } from "react";
import { cn } from "@/lib/utils";
import { isMacPlatform, isTauri } from "@/lib/tauri";
import { useFluidHover } from "@/hooks/use-fluid-hover";
import { FluidHoverHighlight } from "@/components/fluid-hover-highlight";
import { FluidHoverRow } from "@/components/fluid-hover-row";
import { WindowControls } from "@/components/window-controls";
import {
  ArchiveIcon,
  BoxesIcon,
  BotIcon,
  BrainIcon,
  ChevronLeftIcon,
  GlobeIcon,
  HardDriveDownloadIcon,
  InfoIcon,
  KeyRoundIcon,
  KeyboardIcon,
  PaintbrushIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  WebhookIcon,
  ZapIcon,
} from "lucide-react";
import { GeneralSettings } from "./components/general-settings";
import { HooksSettings } from "./components/hooks-settings";
import { WebhooksSettings } from "./components/webhooks-settings";
import { ModelSettings } from "./components/model-settings";
import { RemoteSettings } from "./components/remote-settings";
import { AppearanceSettings } from "./components/appearance-settings";
import { AboutSettings } from "./components/about-settings";
import { ArchiveSettings } from "./components/archive-settings";
import { MemorySettings } from "./components/memory-settings";
import { BackupSettings } from "./components/backup-settings";
import { PersonalizationSettings } from "./components/personalization-settings";
import { SubagentsSettings } from "./components/subagents-settings";
import { ShortcutSettings } from "./components/shortcut-settings";
import { SecretsSettings } from "./components/secrets-settings";

type SettingsSection =
  | "models"
  | "remote"
  | "appearance"
  | "about"
  | "general"
  | "archive"
  | "personalization"
  | "memory"
  | "backup"
  | "shortcuts"
  | "subagents"
  | "webhooks"
  | "hooks"
  | "secrets";

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
      { id: "subagents", label: "子智能体", icon: BotIcon },
      { id: "memory", label: "记忆", icon: BrainIcon },
      { id: "hooks", label: "钩子", icon: ZapIcon },
      { id: "secrets", label: "密钥", icon: KeyRoundIcon },
    ],
  },
  {
    label: "系统",
    items: [
      { id: "remote", label: "远程访问", icon: GlobeIcon },
      { id: "webhooks", label: "Webhooks", icon: WebhookIcon },
      { id: "about", label: "关于", icon: InfoIcon },
    ],
  },
];

// fluid hover 槽位：模块级常量保证注册序稳定。「返回应用」= 0，
// 导航项按 GROUPS 顺序接在其后；分组标题不注册（高亮跳过，就近点亮条目）。
const NAV_ITEM_INDEX = (() => {
  const map = new Map<SettingsSection, number>();
  let next = 1;
  for (const group of GROUPS) {
    for (const item of group.items) map.set(item.id, next++);
  }
  return map;
})();

/** 设置页：全窗口视图，左侧二级侧边栏导航，"返回应用"回到聊天 */
export const SettingsPage: FC<{ onBack: () => void }> = ({ onBack }) => {
  const [section, setSection] = useState<SettingsSection>("models");
  // 左侧导航与侧边栏列表同款 fluid hover：导航容器即滚动容器，
  // 高亮 rect 随 content 滚动（容器内 position:absolute 子元素随之滚动）
  const navRef = useRef<HTMLDivElement>(null);
  const navHover = useFluidHover(navRef);
  // 桌面端自绘 titlebar：拖拽区所有桌面端生效；macOS 红绿灯悬浮于侧边栏顶栏，
  // Windows 隐藏系统标题栏后由 WindowControls 接管，网页端无窗口 chrome
  const desktop = isTauri();
  const winControls = desktop && !isMacPlatform();

  return (
    <div className="bg-muted/55 flex h-full w-full">
      {/* 二级侧边栏 */}
      <nav
        data-slot="settings-nav"
        className="bg-transparent flex w-65 shrink-0 flex-col border-r"
      >
        {/* 顶栏仅作拖拽区：macOS 红绿灯悬浮于此行，"返回应用"单独成行在其下方 */}
        <div
          data-tauri-drag-region={desktop ? "deep" : undefined}
          className="h-12 shrink-0"
       />
         


        <div
          ref={navRef}
          className="relative flex flex-col gap-1 overflow-y-auto p-3 pt-1"
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
          <FluidHoverRow registerItem={navHover.registerItem} index={0}>
            <button
              type="button"
              onClick={onBack}
              className="text-muted-foreground hover:text-foreground flex h-8 w-full shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm"
            >
              <ChevronLeftIcon className="size-4 shrink-0" />
              返回应用
            </button>
          </FluidHoverRow>
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
                      "flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-sm",
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
      </nav>

      {/* 内容区 */}
      <div className="flex min-w-0 flex-1 flex-col bg-background">
        <div
          data-tauri-drag-region={desktop ? "deep" : undefined}
          className={cn(
            "flex h-12 shrink-0 items-center justify-end",
            winControls ? "pr-0" : "pr-4",
          )}
        >
          {/* 窗口控制固定在窗口右上角；仅 Windows/Linux 渲染 */}
          {winControls && <WindowControls />}
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto">
          {section === "models" && <ModelSettings />}
          {section === "remote" && <RemoteSettings />}
          {section === "appearance" && <AppearanceSettings />}
          {section === "personalization" && <PersonalizationSettings />}
          {section === "memory" && <MemorySettings />}
          {section === "backup" && <BackupSettings />}
          {section === "shortcuts" && <ShortcutSettings />}
          {section === "subagents" && <SubagentsSettings />}
          {section === "archive" && <ArchiveSettings />}
          {section === "webhooks" && <WebhooksSettings />}
          {section === "hooks" && <HooksSettings />}
          {section === "secrets" && <SecretsSettings />}
          {section === "about" && <AboutSettings />}
          {section === "general" && <GeneralSettings />}
        </div>
      </div>
    </div>
  );
};
