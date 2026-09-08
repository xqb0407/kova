"use client";

import { useState, type FC } from "react";
import { PanelLeftIcon } from "lucide-react";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { CloneThreadShell } from "./clone-thread-shell";
import { Header, Logo } from "./header";
import { Thread } from "./thread";

export function BaseThread() {
  return <Thread />;
}

export const Base: FC = () => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  return (
    <CloneThreadShell
      railClassName="border-r-0"
      collapsed={sidebarCollapsed}
      onCollapsedChange={setSidebarCollapsed}
      mobileSidebarOpen={mobileSidebarOpen}
      onMobileSidebarOpenChange={setMobileSidebarOpen}
      headerContent={
        // 展开时显示在侧边栏顶栏（避开红绿灯），与主 Header 的折叠按钮互斥。
        // 折叠开始时立即卸载，避免图标靠 overflow 裁切滞留在红绿灯旁造成停顿观感
        sidebarCollapsed ? null : (
          <TooltipIconButton
            variant="ghost"
            size="icon"
            tooltip="Hide sidebar"
            side="right"
            onClick={() => setSidebarCollapsed(true)}
            className="ml-18 size-8"
          >
            <PanelLeftIcon className="size-4" />
          </TooltipIconButton>
        )
      }
      sheetTitle={<Logo />}
    >
      <div className="bg-muted/55 flex h-full flex-col overflow-hidden md:pl-0 border-l-[0.5]">
        <div className="bg-transparent flex flex-1 flex-col overflow-hidden rounded-lg">
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
  );
};