"use client";

import { useState, type FC } from "react";
import { PanelLeftIcon } from "lucide-react";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { cn } from "@/lib/utils";
import { isMacPlatform, isTauri } from "@/lib/tauri";
import { CloneThreadShell } from "./clone-thread-shell";
import { Header, Logo } from "./header";
import { Thread } from "./thread";
import { SettingsPage } from "@/components/settings/settings-page";
// 应用启动即接管外观偏好（预绘制脚本之后：系统主题监听、跟随实时更新）
import "@/lib/ui-prefs";

export function BaseThread() {
  return <Thread />;
}

export const Base: FC = () => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [view, setView] = useState<"chat" | "settings">("chat");
  // 仅 macOS 有悬浮红绿灯，需在侧边栏顶栏让位
  const mac = isTauri() && isMacPlatform();

  return (
    <>
      <CloneThreadShell
        railClassName="border-r-0"
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
        mobileSidebarOpen={mobileSidebarOpen}
        onMobileSidebarOpenChange={setMobileSidebarOpen}
        onOpenSettings={() => setView("settings")}
        headerContent={
          // 展开时显示在侧边栏顶栏；桌面需避开悬浮的 macOS 红绿灯（ml-18），网页无需让位。
          // 折叠开始时立即卸载，避免图标靠 overflow 裁切滞留在红绿灯旁造成停顿观感
          sidebarCollapsed ? null : (
            <TooltipIconButton
              variant="ghost"
              size="icon"
              tooltip="Hide sidebar"
              side="right"
              onClick={() => setSidebarCollapsed(true)}
              className={cn("size-8", mac ? "ml-18" : "ml-2")}
            >
              <PanelLeftIcon className="size-4" />
            </TooltipIconButton>
          )
        }
        sheetTitle={<Logo />}
      >
        {/* 右侧主内容区：开启穿透效果时保持不透明（globals.css data-content-solid 规则），
            仅左侧侧边栏透出窗口材质 */}
        <div
          data-content-solid
          className="bg-background flex h-full flex-col overflow-hidden md:pl-0 border-l-[0.5]"
        >
          <div className="bg-transparent flex flex-1 flex-col overflow-hidden ">
            <Header
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
              onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
            />
            <main className="flex-1 overflow-hidden">
              <Thread />
            </main>
          </div>
        </div>
      </CloneThreadShell>

      {/* 设置视图：全窗口覆盖，左侧为设置二级侧边栏（含"返回应用"） */}
      {view === "settings" && (
        <div className="bg-background fixed inset-0 z-50">
          <SettingsPage onBack={() => setView("chat")} />
        </div>
      )}
    </>
  );
};