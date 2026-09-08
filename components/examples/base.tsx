"use client";

import { useState, type FC } from "react";
import { CloneThreadShell } from "./clone-thread-shell";
import { Header } from "./header";
import { Thread } from "./thread";
import { Logo } from "./header";

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
      headerContent={<Logo collapsed={sidebarCollapsed} />}
      sheetTitle={<Logo />}
    >
      <div className="bg-muted/55 flex h-full flex-col overflow-hidden p-2 md:pl-0">
        <div className="bg-background flex flex-1 flex-col overflow-hidden rounded-lg">
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