"use client";

import { useEffect, useRef, useState, type FC } from "react";
import dynamic from "next/dynamic";
import { Loader2Icon, PanelLeftIcon } from "lucide-react";
import {
  AnimatePresence,
  animate,
  motion,
  type AnimationPlaybackControls,
} from "framer-motion";
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
// 使用统计页：与设置页不同模块，侧边栏底部入口（activeMenu="usage"）才拉取；
// three.js / recharts 由其内部再按需分块
const UsageStatsView = dynamic(
  () =>
    import("@/components/settings/components/usage-stats-settings").then(
      (m) => m.UsageStatsSettings,
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
/** 无历史宽度时的默认面板宽（与 ResizablePanel defaultSize 一致） */
const PANEL_DEFAULT_WIDTH = 400;

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
  // 设置视图全窗口覆盖主窗口：广播 browser:occluded，让浏览器面板隐藏其子
  // webview（原生层 z 序高于任何 React z-index，不隐藏会悬浮盖在设置页上）；
  // 返回应用后由 browser-view 的 bounds 同步状态机恢复显示。
  // 使用统计走 activeMenu（主区内切页，侧边栏保持对话列表），无需遮蔽
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("browser:occluded", {
        detail: { occluded: view === "settings" },
      }),
    );
  }, [view]);
  // view 的 ref：面板开合动画的回调在闭包里读它，判断当前是否设置页覆盖
  // （设置页打开时不能替它解除 webview 遮蔽，恢复交给设置页退出广播）
  const viewRef = useRef(view);
  viewRef.current = view;
  // 面板开合动画期间的 webview 遮蔽开关：动画期间面板内容宽被冻结，浏览器
  // 占位容器不再随面板收窄（native 层不吃 CSS 裁剪，不隐藏会以冻结宽悬浮
  // 盖到聊天列上），故借 browser:occluded 通道隐藏，动画结束由 bounds 状态
  // 机恢复。解除时若正处于设置页则跳过（设置页拥有遮蔽权）
  const setPanelWebviewOccluded = (occluded: boolean) => {
    if (occluded || viewRef.current === "chat") {
      window.dispatchEvent(
        new CustomEvent("browser:occluded", { detail: { occluded } }),
      );
    }
  };
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
  // 面板视觉状态：像素 ≤1 视为完全收起（收起动画播完才置真）。
  // 按钮/窗口控件交接跟着它走而不是 panelOpen，否则收起动画一起步
  // 顶栏按钮就瞬间跳位（"闪一下"的来源）
  const [panelGone, setPanelGone] = useState(false);
  // 动画期间把 minSize 释放为 0：库对可折叠面板会把 minSize 以下的 resize
  // 钳回 minSize/0（中段瞬间消失），动画期间必须解除钳制，结束后恢复
  const [panelMinReleased, setPanelMinReleased] = useState(false);
  // 开合动画期间冻结面板内容宽（侧边栏同款手法）：内容列宽度定格在动画
  // 起点像素，随面板收窄被裁剪滑出，动画期间整棵面板树零重排（xterm、
  // 会话列表等重排大户不再每帧 relayout）。null = 未冻结（拖拽/静止态
  // 内容恒 100% 跟手）
  const [panelFrozenPx, setPanelFrozenPx] = useState<number | null>(null);
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

  // 开合 → 驱动 collapsible Panel：用户开合（panelOpen 状态沿）时用
  // framer-motion 把面板宽度在 0↔目标值间逐帧 resize，聊天列随之被连续
  // "推开/让位"（TRAE 式推移感）。动画区间覆盖 minSize 以下，须先释放
  // minSize（两段式：released 置位 → 本 effect 随依赖重跑才启动动画），
  // 结束后恢复钳制；挂载恢复、窄屏切宽屏等非开合落位直接 snap
  const panelAnimRef = useRef<AnimationPlaybackControls | null>(null);
  // 动画被把手 pointerdown 拦停后置位，pointerup 时据此结算中间态
  const panelAnimInterruptedRef = useRef(false);
  const prevPanelOpenRef = useRef<boolean | null>(null);
  /** localStorage 里的目标面板宽（无有效记录回默认） */
  const panelTargetWidth = () => {
    const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return Number.isFinite(saved) && saved >= PANEL_MIN_WIDTH
      ? saved
      : PANEL_DEFAULT_WIDTH;
  };
  useEffect(() => {
    if (!panelHydrated || compact) return;
    const p = panelRef.current;
    if (!p) return;
    const target = panelTargetWidth();
    const isToggle =
      prevPanelOpenRef.current !== null &&
      prevPanelOpenRef.current !== panelOpen;
    prevPanelOpenRef.current = panelOpen;
    panelAnimInterruptedRef.current = false;
    panelAnimRef.current?.stop();
    panelAnimRef.current = null;
    if (!isToggle) {
      if (panelOpen) {
        p.expand();
        p.resize(target);
      } else {
        p.collapse();
      }
      return;
    }
    // minSize 未释放时先置位，等约束生效（本 effect 重跑）再动画
    if (!panelMinReleased) {
      setPanelMinReleased(true);
      return;
    }
    if (panelOpen) {
      // 从收起态起步才需要先归零；收起动画途中反向（面板尚未真正收起）
      // 直接从当前宽度续走，避免 resize(0) 造成瞬间跳变
      if (p.isCollapsed()) {
        p.expand();
        p.resize(0);
      }
      // 冻结内容宽为目标宽：面板从 0 展开时内容左缘随面板左缘左移入位，
      // 右侧被裁剪渐显——动画期间面板树零重排
      setPanelFrozenPx(Math.round(target));
      setPanelWebviewOccluded(true);
      panelAnimRef.current = animate(p.getSize().inPixels, target, {
        duration: 0.3,
        ease: [0.32, 0.72, 0, 1],
        onComplete: () => {
          panelAnimRef.current = null;
          setPanelMinReleased(false);
          setPanelFrozenPx(null);
          setPanelWebviewOccluded(false);
        },
        onUpdate: (v) => p.resize(v),
      });
    } else {
      const from = p.getSize().inPixels;
      // 冻结内容宽为当前宽：面板左缘右移推挤聊天列，内容随左缘平移、
      // 右侧被裁剪滑出——与侧边栏折叠互为镜像
      setPanelFrozenPx(Math.round(from));
      setPanelWebviewOccluded(true);
      panelAnimRef.current = animate(from, 0, {
        duration: 0.26,
        ease: [0.32, 0.72, 0, 1],
        onComplete: () => {
          panelAnimRef.current = null;
          p.collapse();
          setPanelMinReleased(false);
          setPanelFrozenPx(null);
          setPanelWebviewOccluded(false);
        },
        onUpdate: (v) => p.resize(v),
      });
    }
  }, [
    panelOpen,
    panelHydrated,
    compact,
    panelMinReleased,
    panelRef,
  ]);
  // 卸载时掐掉在途动画，避免回调打到已销毁的 Panel
  useEffect(() => () => panelAnimRef.current?.stop(), []);

  // 把手 pointerdown 拦停在途动画（动画 resize 会和拖拽互相覆盖）。
  // 注意只挂把手——原来挂在 Group 的 onPointerDownCapture 上，面板内任何
  // 点击（包括收起按钮自己）都会掐停动画：连点收起按钮时第二次点击把动画
  // 停在半路且 setPanelOpen(false) 已是 no-op，面板卡死"收不起来"
  const interruptPanelAnim = () => {
    if (panelAnimRef.current) {
      panelAnimRef.current.stop();
      panelAnimRef.current = null;
      panelAnimInterruptedRef.current = true;
    } else {
      panelAnimInterruptedRef.current = false;
    }
    // 被拖拽接管：解除内容冻结与 webview 遮蔽，内容恢复 100% 跟手
    setPanelFrozenPx(null);
    setPanelWebviewOccluded(false);
  };
  // 把手交互结束（pointerup 任意位置都可能）后结算被拦停的动画，
  // 面板必须落到"全开/全收/交给开合效果续跑"三者之一，不许卡在半路
  const settlePanelHandle = () => {
    if (!panelAnimInterruptedRef.current) return;
    panelAnimInterruptedRef.current = false;
    const p = panelRef.current;
    if (!p) return;
    const px = p.getSize().inPixels;
    if (panelOpen) {
      // 展开途中被拦停：宽度不足 minSize 直接落位到目标宽，避免留下窄条
      if (px < PANEL_MIN_WIDTH) {
        p.expand();
        p.resize(panelTargetWidth());
      }
      setPanelMinReleased(false);
    } else if (px >= PANEL_MIN_WIDTH) {
      // 收起途中停在了有效宽度 → 视为想展开，开合效果会续跑剩余动画
      setPanelOpen(true);
    } else {
      // 半路 → 归零完成收起
      p.collapse();
      setPanelMinReleased(false);
    }
  };

  // 记住开合
  useEffect(() => {
    if (!panelHydrated) return;
    try {
      localStorage.setItem(PANEL_OPEN_KEY, panelOpen ? "1" : "0");
    } catch {}
  }, [panelOpen, panelHydrated]);

  // 记住宽度（拖拽结束后）。动画/拖拽途中 onLayoutChanged 每帧都会进来，
  // 低于 minSize 的中间态（收起动画末段、刚展开的前几帧）不落盘，
  // 否则会把用户设置的目标宽度覆盖成 0/半途值
  const savePanelWidth = () => {
    const p = panelRef.current;
    if (!p || p.isCollapsed()) return;
    const px = Math.round(p.getSize().inPixels);
    if (px < PANEL_MIN_WIDTH) return;
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(px));
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

  // 进入自动化/使用统计页自动收起右侧 panel：它们是主区内的全幅管理页，
  // 原先开着的面板既挤占内容又和页内自己的滚动区打架
  useEffect(() => {
    if (activeMenu === "automation" || activeMenu === "usage") setPanelOpen(false);
  }, [activeMenu]);

  const chat =
    activeMenu === "automation" ? (
      <AutomationsView
        onBackToChat={() => setActiveMenu("")}
        focusTask={automationFocus}
        onFocusConsumed={() => setAutomationFocus(null)}
      />
    ) : activeMenu === "usage" ? (
      <UsageStatsView />
    ) : (
      <Thread />
    );

  // 面板停靠为右列（宽屏且视觉上未完全收起，收起动画途中仍算停靠）：
  // 窗口右缘即面板，收起入口与 Windows 窗口控件上移到面板顶栏；
  // 窄屏浮层或面板收没时它们仍留在 Header
  const panelDocked = !compact && !panelGone;

  // TRAE 式左右两列：Header 只挂在聊天列上方，分割线从窗口顶通到底；
  // 列本身是带描边圆角的卡片，四周留出窗口底色边距（顶缘仍可拖窗）。
  // 窄屏（浮层模式）下浮层只盖聊天内容区，不遮 Header
  const chatColumn = (
    <div className="bg-background border-border/60 relative flex h-full min-w-0 flex-col overflow-hidden rounded-xl border">
      {/* 自动化页环境光：挂在卡片内顶缘（header 之下、内容之上），
          光带从卡片顶垂下；固定不随内容滚 */}
      {activeMenu === "automation" && (
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-0 h-72 overflow-hidden">
          <div className="from-primary/5 absolute inset-x-0 top-0 h-full bg-gradient-to-b to-transparent" />
          <div className="bg-primary/10 absolute -top-20 left-[12%] hidden size-64 rounded-full blur-3xl dark:block" />
          <div className="bg-primary/[0.08] absolute -top-24 right-[15%] hidden size-72 rounded-full blur-3xl dark:block" />
        </div>
      )}
      <div className="relative z-10 shrink-0">
        <Header
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
          onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
          // 折叠按钮跟视觉状态走：面板完全收没（收起动画播完）才在
          // Header 露出展开按钮，避免动画途中按钮提前跳出来闪一下
          showPanelToggle={compact ? !panelOpen : panelGone}
          onTogglePanel={() => setPanelOpen((o) => !o)}
          docked={panelDocked}
          variant={
            activeMenu === "automation" || activeMenu === "usage"
              ? "page"
              : "session"
          }
        />
      </div>
      <div className="relative z-10 flex-1 overflow-hidden">
        {chat}
        {compact ? (
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
                  className="border-border bg-background absolute inset-y-0 right-0 z-40 flex w-[min(92vw,420px)] rounded-l-xl border-l"
                >
                  <AgentPanel onCollapse={() => setPanelOpen(false)} />
                </motion.div>
              </>
            ) : null}
          </AnimatePresence>
        ) : null}
      </div>
    </div>
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
          // 展开时显示在侧边栏顶栏；mac 的红绿灯避让（ml-18）由顶栏内组里
          // 第一个元素（shell 渲染的搜索按钮）承接，此处在搜索右侧紧贴排列。
          // 折叠时内容随侧边栏整列 transform 平移出屏，保持挂载不卸载
          <TooltipIconButton
            variant="ghost"
            size="icon"
            tooltip="Hide sidebar"
            side="bottom"
            onClick={() => setSidebarCollapsed(true)}
            className={cn("size-8", !mac && "ml-2")}
          >
            <PanelLeftIcon className="size-4" />
          </TooltipIconButton>
        }
        sheetTitle={<Logo />}
      >
        {/* 右侧主内容区：开启穿透效果时保持不透明（globals.css data-content-solid 规则），
            仅左侧侧边栏透出窗口材质 */}
        <div
          data-content-solid
          className="bg-background relative flex h-full flex-col overflow-hidden md:pl-0"
        >
          {/* 主区四周留边露出窗口底色（muted），两列卡片浮在其上；
              边距条本身是窗口拖拽区（仅命中 padding 自身，不深入子树）。
              收起态把手（8px）仍占在右缘，右 padding 同步归零，
              保证四周边距恒等于 8px（把手宽 = 留边宽 = 列间距）。
              跟随 panelGone（视觉收没）而非 panelOpen，避免收起动画
              刚起步就跳 padding */}
          <main
            data-tauri-drag-region={isTauri() ? "true" : undefined}
            className={cn(
              "bg-muted/40 relative flex-1 overflow-hidden p-2",
              !compact && panelGone && "pr-0",
            )}
          >
            {compact ? (
              // 窄屏：单列聊天 + 面板右缘浮层（浮层只盖内容区，不遮 Header）
              chatColumn
            ) : (
              // 宽屏：TRAE 式左右两列贯通全高，右列可拖宽、可折叠
              <ResizablePanelGroup
                id="agent-main-split"
                onLayoutChanged={savePanelWidth}
                // 拦停动画的 pointerup 结算挂这里（而非 pointerdown）：
                // 把手上按下的手势无论在哪松开都能落到终态，且不干扰
                // 面板内按钮的正常点击（pointerup 只是结算，不掐动画）
                onPointerUpCapture={settlePanelHandle}
                className="gap-0"
              >
                <ResizablePanel
                  id="chat"
                  minSize="380px"
                  className="min-w-0"
                >
                  {chatColumn}
                </ResizablePanel>
                {/* 把手加宽到 8px = 四周留边，两列卡片间隙与边距一致；
                    分割线非常驻：悬停才浮现细线，面板收起时细线整体隐藏
                    （只留拖拽命中区），贴右缘拖动即可重新展开。
                    自动化页是全幅视图：库默认双击把手会展开相邻可折叠面板，
                    这里连同拖拽一起禁用，避免误触把面板带进来 */}
                <ResizableHandle
                  className={cn("w-2", panelGone && "[&>div]:hidden")}
                  disabled={activeMenu === "automation"}
                  disableDoubleClick={activeMenu === "automation"}
                  // 只在把手上拦停动画（面板内按钮点击不受影响，见 settle 注释）
                  onPointerDownCapture={interruptPanelAnim}
                />
                <ResizablePanel
                  id="agent-panel"
                  panelRef={panelRef}
                  collapsible
                  collapsedSize={0}
                    minSize={
                      panelMinReleased
                        ? "0px"
                        : `${PANEL_MIN_WIDTH}px`
                    }
                    maxSize="60%"
                    defaultSize={PANEL_DEFAULT_WIDTH}
                    groupResizeBehavior="preserve-pixel-size"
                    // 拖到小于 minSize 即自动折叠 / 拖回即展开：状态沿变化时回写开合；
                    // panelGone 跟踪视觉状态（≤1px 且非展开意图），驱动按钮/控件交接
                    onResize={(size) => {
                      const collapsed = size.inPixels <= 1;
                      setPanelGone(!panelOpen && collapsed);
                      if (collapsed === wasCollapsedRef.current) {
                        // 无收放边沿且无在途动画/待结算手势：尺寸仍在变即
                        // 用户在拖 —— 名义收起却拖到有效宽度（拦停后拖拽
                        // 复活）视为想展开，兜底防止面板卡在"开着但收不起来"
                        if (
                          !collapsed &&
                          !panelOpen &&
                          !panelAnimRef.current &&
                          !panelAnimInterruptedRef.current &&
                          size.inPixels >= PANEL_MIN_WIDTH
                        ) {
                          setPanelOpen(true);
                        }
                        return;
                      }
                      wasCollapsedRef.current = collapsed;
                      setPanelOpen(!collapsed);
                    }}
                >
                  {panelEverOpened ? (
                    // 冻结容器：开合动画期间内容宽定格（panelFrozenPx），随
                    // 面板收窄被裁剪滑出（与侧边栏折叠同款，零每帧重排）；
                    // 拖拽/静止态不冻结，内容 100% 跟手
                    <div className="h-full overflow-hidden">
                      <div
                        className="h-full"
                        style={
                          panelFrozenPx !== null
                            ? { width: panelFrozenPx }
                            : undefined
                        }
                      >
                        <AgentPanel
                          onCollapse={() => setPanelOpen(false)}
                          showWindowControls={panelDocked}
                        />
                      </div>
                    </div>
                  ) : null}
                </ResizablePanel>
              </ResizablePanelGroup>
            )}
          </main>
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
