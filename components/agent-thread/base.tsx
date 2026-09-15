"use client";

import { useEffect, useRef, useState, type FC } from "react";
import dynamic from "next/dynamic";
import { Loader2Icon, PanelLeftIcon } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useAui } from "@assistant-ui/react";
import { usePanelRef } from "react-resizable-panels";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { isMacPlatform, isTauri } from "@/lib/tauri";
import { matchesShortcut, useShortcuts } from "@/lib/shortcuts";
import { subscribeAutomationFocus } from "@/lib/automations";
import { setAutomationFrameSync } from "@/lib/automation-live";
import { subscribeOpenSession } from "@/lib/open-session";
import { CloneThreadShell } from "./clone-thread-shell";
import { Header, Logo } from "./header";
import { Thread } from "./thread";
import { AgentPanel } from "./agent-panel";
// 迭代1b（P6）：设置页整棵模块图（CodeMirror + 语言文法包、cmdk、input-otp、
// qrcode.react）挪出首屏 chunk；外层 fixed inset-0 bg-background 容器保证
// 加载期间是应用底色而非白屏。
const SettingsPage = dynamic(
  () => import("@/components/settings/settings-page").then((m) => m.SettingsPage),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
      </div>
    ),
  },
);
// 自动化管理页：与设置页同款的 chunk 挪出策略，侧边栏「自动化」菜单激活才拉取
const AutomationsView = dynamic(
  () =>
    import("@/components/automations/automations-view").then(
      (m) => m.AutomationsView,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
      </div>
    ),
  },
);
// 应用启动即接管外观偏好（预绘制脚本之后：系统主题监听、跟随实时更新）
import "@/lib/ui-prefs";

/** 面板开合与宽度的本地持久化键（宽度存 px 整数） */
const PANEL_OPEN_KEY = "agent-panel-open";
const PANEL_WIDTH_KEY = "agent-panel-width";
const PANEL_MIN_WIDTH = 300;

export function BaseThread() {
  return <Thread />;
}

/** 窄屏判定：<md 时面板从"右列"切为"浮层"（桌面窗口基本走右列布局） */
function useIsCompact(): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const sync = () => setCompact(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return compact;
}

export const Base: FC = () => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [view, setView] = useState<"chat" | "settings">("chat");
  // 侧边栏菜单选中项（受控给 CloneThreadShell）："automation" 时主区
  // 整页切到自动化管理视图；点会话行/新对话由 shell 的导航委托清空回到聊天
  const [activeMenu, setActiveMenu] = useState("");
  // ⚡ 徽标点击定位请求（nonce 让"再点同一任务"也能重新触发视图滚动）
  const [automationFocus, setAutomationFocus] = useState<{
    taskId: string;
    nonce: number;
  } | null>(null);
  useEffect(
    () =>
      subscribeAutomationFocus((taskId) => {
        setActiveMenu("automation");
        setAutomationFocus({ taskId, nonce: Date.now() });
      }),
    [],
  );
  // 系统通知点击 → 切回聊天并打开对应会话（Rust notify_show 点击回调经
  // lib/notify 装配进 open-session 总线）；会话已被删则静默
  const aui = useAui();
  useEffect(
    () =>
      subscribeOpenSession((sessionId) => {
        void (async () => {
          try {
            await aui.threads.reload();
            await aui.threads.switchToThread(sessionId);
            setActiveMenu("");
          } catch {}
        })();
      }),
    [aui],
  );
  // 定时任务触发/结算 → 侧边栏会话列表自动同步（新物化的定时会话免手动
  // 刷新出现；去抖在 lib/automation-live，reload 不动当前线程运行时）
  useEffect(() => {
    setAutomationFrameSync(() => {
      void aui.threads.reload().catch(() => {});
    });
    return () => setAutomationFrameSync(null);
  }, [aui]);
  // Agent 面板：默认展开，挂载后从 localStorage 恢复开合/宽度
  // （SSR 首帧恒为展开，避免 hydration 不一致）
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelHydrated, setPanelHydrated] = useState(false);
  // 迭代1b（P6）：宽屏右列折叠（collapsedSize=0）时不再常驻渲染整棵面板树，
  // 首次展开才挂载、之后保持挂载（收起不再卸载，二次展开零重建）。
  // 活动数据在 panel-activity 模块级 store（迭代1），面板卸载/未挂载不丢。
  const [panelEverOpened, setPanelEverOpened] = useState(false);
  const panelRef = usePanelRef();
  // onResize 回写开合用：记住上次是否处于折叠，只在状态沿变化时写
  const wasCollapsedRef = useRef(false);
  const compact = useIsCompact();
  // 仅 macOS 有悬浮红绿灯，需在侧边栏顶栏让位
  const mac = isTauri() && isMacPlatform();

  // 恢复上次偏好
  useEffect(() => {
    try {
      if (localStorage.getItem(PANEL_OPEN_KEY) === "0") setPanelOpen(false);
    } catch {}
    setPanelHydrated(true);
  }, []);

  // 水合后（SSR 首帧恒为展开，不代表用户意图）一旦面板处于展开即置位
  useEffect(() => {
    if (panelHydrated && panelOpen) setPanelEverOpened(true);
  }, [panelHydrated, panelOpen]);

  // 面板开合是本地态；composer 等外部入口（如分支菜单的"Git 图谱"）经此事件展开
  useEffect(() => {
    const open = () => setPanelOpen(true);
    window.addEventListener("agent-panel:open", open);
    return () => window.removeEventListener("agent-panel:open", open);
  }, []);

  // 开合 → 驱动 collapsible Panel；恢复宽度在展开后一次 resize
  useEffect(() => {
    if (!panelHydrated || compact) return;
    const p = panelRef.current;
    if (!p) return;
    if (panelOpen) {
      p.expand();
      const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
      if (Number.isFinite(saved) && saved >= PANEL_MIN_WIDTH) p.resize(saved);
    } else {
      p.collapse();
    }
  }, [panelOpen, panelHydrated, compact, panelRef]);

  // 记住开合
  useEffect(() => {
    if (!panelHydrated) return;
    try {
      localStorage.setItem(PANEL_OPEN_KEY, panelOpen ? "1" : "0");
    } catch {}
  }, [panelOpen, panelHydrated]);

  // 记住宽度（拖拽结束后）
  const savePanelWidth = () => {
    const p = panelRef.current;
    if (!p || p.isCollapsed()) return;
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(p.getSize().inPixels)));
    } catch {}
  };

  // 全局快捷键：打开设置 / 直达自动化页 / 开合 Agent 面板（绑定来自「设置 → 快捷键」，改动即时生效）
  const { openSettings, openAutomations, toggleAgentPanel } = useShortcuts();
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (matchesShortcut(event, openSettings)) {
        event.preventDefault();
        setView("settings");
      } else if (matchesShortcut(event, openAutomations)) {
        event.preventDefault();
        // 自动化页挂在 chat 视图内（activeMenu 驱动），设置页开着时也要能直达
        setView("chat");
        setActiveMenu("automation");
      } else if (matchesShortcut(event, toggleAgentPanel)) {
        event.preventDefault();
        setPanelOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [openSettings, openAutomations, toggleAgentPanel]);

  // 进入设置页时清掉文档里的活动选区：选区还在时 SelectionToolbar 的 quote
  // 气泡（挂 body 的 fixed 浮层）不会自动收起，经快捷键等不经鼠标的入口切
  // 视图会带着它浮到设置页上方；removeAllRanges 触发 selectionchange 使其卸载
  useEffect(() => {
    if (view === "settings") window.getSelection()?.removeAllRanges();
  }, [view]);

  const chat =
    activeMenu === "automation" ? (
      <AutomationsView
        onBackToChat={() => setActiveMenu("")}
        focusTask={automationFocus}
        onFocusConsumed={() => setAutomationFocus(null)}
      />
    ) : (
      <Thread />
    );

  return (
    <>
      <CloneThreadShell
        railClassName="border-r-0"
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
        mobileSidebarOpen={mobileSidebarOpen}
        onMobileSidebarOpenChange={setMobileSidebarOpen}
        activeMenu={activeMenu}
        onActiveMenuChange={setActiveMenu}
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
              panelOpen={panelOpen}
              onTogglePanel={() => setPanelOpen((o) => !o)}
              variant={activeMenu === "automation" ? "page" : "session"}
            />
            <main className="flex-1 overflow-hidden">
              {compact ? (
                // 窄屏：面板右缘浮层（聊天区不缩列），遮罩点击收起
                <div className="relative h-full">
                  {chat}
                  <AnimatePresence>
                    {panelOpen ? (
                      <>
                        <motion.div
                          key="panel-backdrop"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.18 }}
                          className="bg-black/30 absolute inset-0 z-30"
                          onClick={() => setPanelOpen(false)}
                        />
                        <motion.div
                          key="panel"
                          initial={{ x: "100%" }}
                          animate={{ x: 0 }}
                          exit={{ x: "100%" }}
                          transition={{ type: "spring", stiffness: 380, damping: 36 }}
                          className="border-border absolute inset-y-0 right-0 z-40 flex w-[min(92vw,420px)] border-l"
                        >
                          <AgentPanel />
                        </motion.div>
                      </>
                    ) : null}
                  </AnimatePresence>
                </div>
              ) : (
                // 宽屏：Codex 式双列，右列可拖宽、可折叠
                <ResizablePanelGroup
                  id="agent-main-split"
                  onLayoutChanged={savePanelWidth}
                  className="gap-0"
                >
                  <ResizablePanel
                    id="chat"
                    minSize="380px"
                    className="min-w-0"
                  >
                    {chat}
                  </ResizablePanel>
                  {/* 折叠时把手淡出但保留：贴左缘拖它即可重新展开 */}
                  <ResizableHandle
                    className={cn(
                      "transition-opacity duration-200",
                      !panelOpen && "opacity-0",
                    )}
                  />
                  <ResizablePanel
                    id="agent-panel"
                    panelRef={panelRef}
                    collapsible
                    collapsedSize={0}
                    minSize={`${PANEL_MIN_WIDTH}px`}
                    maxSize="60%"
                    defaultSize={400}
                    groupResizeBehavior="preserve-pixel-size"
                    // 拖到小于 minSize 即自动折叠 / 拖回即展开：状态沿变化时回写开合
                    onResize={(size) => {
                      const collapsed = size.inPixels <= 1;
                      if (collapsed === wasCollapsedRef.current) return;
                      wasCollapsedRef.current = collapsed;
                      setPanelOpen(!collapsed);
                    }}
                  >
                    {panelEverOpened ? <AgentPanel /> : null}
                  </ResizablePanel>
                </ResizablePanelGroup>
              )}
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
