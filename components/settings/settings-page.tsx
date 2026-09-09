"use client";

import { useState, type FC } from "react";
import { cn } from "@/lib/utils";
import { isMacPlatform, isTauri } from "@/lib/tauri";
import { WindowControls } from "@/components/window-controls";
import {
  BoxesIcon,
  ChevronLeftIcon,
  GlobeIcon,
  PaintbrushIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { ModelSettings } from "./components/model-settings";
import { RemoteSettings } from "./components/remote-settings";
import { AppearanceSettings } from "./components/appearance-settings";

type SettingsSection = "models" | "remote" | "appearance" | "general";

const GROUPS: {
  label: string;
  items: { id: SettingsSection; label: string; icon: FC<{ className?: string }> }[];
}[] = [
  {
    label: "偏好",
    items: [
      { id: "general", label: "通用", icon: SlidersHorizontalIcon },
      { id: "appearance", label: "外观", icon: PaintbrushIcon },
    ],
  },
  { label: "AI", items: [{ id: "models", label: "模型", icon: BoxesIcon }] },
  {
    label: "系统",
    items: [{ id: "remote", label: "远程访问", icon: GlobeIcon }],
  },
];

/** 设置页：全窗口视图，左侧二级侧边栏导航，"返回应用"回到聊天 */
export const SettingsPage: FC<{ onBack: () => void }> = ({ onBack }) => {
  const [section, setSection] = useState<SettingsSection>("models");
  // 桌面端自绘 titlebar：拖拽区所有桌面端生效；macOS 红绿灯悬浮于侧边栏顶栏，
  // Windows 隐藏系统标题栏后由 WindowControls 接管，网页端无窗口 chrome
  const desktop = isTauri();
  const winControls = desktop && !isMacPlatform();

  return (
    <div className="bg-background flex h-full w-full">
      {/* 二级侧边栏 */}
      <nav
        data-slot="settings-nav"
        className="bg-muted/55 flex w-65 shrink-0 flex-col border-r"
      >
        {/* 顶栏仅作拖拽区：macOS 红绿灯悬浮于此行，"返回应用"单独成行在其下方 */}
        <div
          data-tauri-drag-region={desktop ? "deep" : undefined}
          className="h-12 shrink-0"
        />

        <div className="flex flex-col gap-1 overflow-y-auto p-3 pt-1">
          <button
            type="button"
            onClick={onBack}
            className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm"
          >
            <ChevronLeftIcon className="size-4 shrink-0" />
            返回应用
          </button>
          {GROUPS.map((group) => (
            <div key={group.label} className="flex flex-col gap-1">
              <div className="text-muted-foreground px-2 pt-3 pb-1 text-xs font-medium">
                {group.label}
              </div>
              {group.items.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSection(id)}
                  data-active={section === id}
                  className={cn(
                    "hover:bg-muted flex h-8 items-center gap-2 rounded-md px-2.5 text-sm",
                    "data-active:bg-muted data-active:text-foreground text-muted-foreground",
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  {label}
                </button>
              ))}
            </div>
          ))}
        </div>
      </nav>

      {/* 内容区 */}
      <div className="flex min-w-0 flex-1 flex-col">
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
          {section === "general" && (
            <div className="text-muted-foreground p-5 text-sm">暂无可配置项</div>
          )}
        </div>
      </div>
    </div>
  );
};
