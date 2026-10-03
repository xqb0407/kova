"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FC,
} from "react";
import dynamic from "next/dynamic";
import { Loader2Icon, PanelLeftIcon } from "lucide-react";
import {
  AnimatePresence,
  animate,
  motion,
  type AnimationPlaybackControls,
} from "framer-motion";
import { useAui, useAuiState } from "@assistant-ui/react";
import { usePanelRef } from "react-resizable-panels";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { isMacPlatform, isTauri } from "@/lib/tauri";
import { matchesShortcut, useShortcuts } from "@/lib/shortcuts";
import { toggleThemeMode } from "@/lib/settings/ui-prefs";
import { subscribeAutomationFocus } from "@/lib/automation/automations";
import {
  subscribeConnectorManage,
  type ManageTab,
} from "@/lib/connector-nav";
import { setAutomationFrameSync } from "@/lib/automation/automation-live";
import { subscribeOpenSession } from "@/lib/pi/open-session";
import { piSessionRegistry } from "@/lib/pi/pi-thread-adapter";
import { setCurrentPanelThread } from "@/lib/panels/panel-tabs";
import { useOnboardingGate } from "@/components/onboarding/onboarding-provider";
import { useOverlayPresent } from "@/lib/overlay-occlusion";
import { CloneThreadShell } from "./clone-thread-shell";
import { Header, Logo } from "./header";
import { Thread, isNewChatView } from "./thread";
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
// 插件/专家/技能页（市场 + 管理子页）：同款按需 chunk
const MarketplaceView = dynamic(
  () =>
    import("@/components/marketplace/marketplace-view").then(
      (m) => m.MarketplaceView,
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
// 我的文件页（本地 ~/.kova + 云端备份）：同款按需 chunk
const FilesView = dynamic(
  () =>
    import("@/components/files/files-view").then((m) => m.FilesView),
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
import "@/lib/settings/ui-prefs";

/** 面板开合与宽度的本地持久化键（宽度存 px 整数） */
const PANEL_OPEN_KEY = "agent-panel-open";
const PANEL_WIDTH_KEY = "agent-panel-width";
const PANEL_MIN_WIDTH = 300;
/** 无历史宽度时的默认面板宽（与 ResizablePanel defaultSize 一致） */
const PANEL_DEFAULT_WIDTH = 400;
/** 聊天列最小宽（把聊天列做成可折叠以支撑面板全屏，折叠动画须释放 minSize） */
const CHAT_MIN_WIDTH = 380;

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
  // 从设置页「重新查看新手引导」时（通用设置 → 入门）把设置视图收掉：
  // 向导是全屏接管，走完后应当直接落在对话界面，而不是退回设置页。
  const onboardingActive = useOnboardingGate().active;
  useEffect(() => {
    if (onboardingActive) setView("chat");
  }, [onboardingActive]);
  /**
   * 主窗口当前是否被浮层接管 —— 唯一的遮蔽事实源。
   *
   * 浏览器子 webview 是独立的原生 NSView，合成在主 webview 的 DOM 之上，
   * 任何 React z-index（向导是 z-[60]）都压不住它；浮层一出现就必须隐藏。
   *
   * 三个来源，或起来：
   * 1. 设置页整页切换；
   * 2. 新手引导的全屏向导——尤其容易漏，引导激活时 view 已被置回 "chat"，
   *    只看 view 会误判成"无遮蔽"；
   * 3. 任意 ui/ primitive 浮层（Dialog / Popover / Sheet / 菜单 / Select）挂载。
   *    这一项是登记制而不是人工白名单：以前每个会遮挡的地方手动广播一次，
   *    几十个调用点漏一个就复现一次 bug。浮层自己在 Portal 里登记，
   *    这里只读总数。
   */
  const floatingOverlay = useOverlayPresent();
  const mainViewOccluded =
    view === "settings" || onboardingActive || floatingOverlay;
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("browser:occluded", {
        detail: { occluded: mainViewOccluded },
      }),
    );
  }, [mainViewOccluded]);
  // 遮蔽态的 ref：面板开合动画的回调在闭包里读它，判断能否替对方解除遮蔽
  // （设置页/向导/浮层打开时不能解除，恢复交给它们退出时的广播）
  const occludedRef = useRef(mainViewOccluded);
  occludedRef.current = mainViewOccluded;
  // view 的 ref：面板开合动画/exitPanelFullscreen 的守卫在闭包里读它
  const viewRef = useRef(view);
  viewRef.current = view;
  // 「跳到设置页某分区」的 window 事件（composer 主题胶囊的「管理设计主题…」
  // 深在壳树里，不向上透传回调）：seq 单调递增，让「已在设置页再跳同一分区」
  // 也能触发 SettingsPage 的同步 effect；id 校验在 settings-page 模块内做
  //（那边是 dynamic 懒加载 chunk，这里不静态引它的值导出）
  const [settingsJump, setSettingsJump] = useState<{ id: string; seq: number } | null>(null);
  useEffect(() => {
    const onJump = (e: Event) => {
      const detail = (e as CustomEvent<unknown>).detail;
      if (typeof detail !== "string" || !detail) return;
      setView("settings");
      setSettingsJump((prev) => ({ id: detail, seq: (prev?.seq ?? 0) + 1 }));
    };
    window.addEventListener("kova:open-settings-section", onJump);
    return () => window.removeEventListener("kova:open-settings-section", onJump);
  }, []);
  // 面板开合动画期间的 webview 遮蔽开关：动画期间面板内容宽被冻结，浏览器
  // 占位容器不再随面板收窄（native 层不吃 CSS 裁剪，不隐藏会以冻结宽悬浮
  // 盖到聊天列上），故借 browser:occluded 通道隐藏，动画结束由 bounds 状态
  // 机恢复。解除时若主窗口正被全屏浮层接管则跳过（设置页/向导拥有遮蔽权）
  const setPanelWebviewOccluded = (occluded: boolean) => {
    if (occluded || !occludedRef.current) {
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
  // composer「+」菜单的「管理子智能体 / 管理连接器 / 管理技能」：切主区到
  // 插件/专家/技能页并直接落到管理分段（分段本身是 MarketplaceView 的局部态，
  // 故经 prop 下发而非事件）
  const [connectorManageTab, setConnectorManageTab] = useState<ManageTab | null>(null);
  useEffect(
    () =>
      subscribeConnectorManage((tab) => {
        setConnectorManageTab(tab);
        setActiveMenu("connector");
      }),
    [],
  );
  // 系统通知点击 → 切回聊天并打开对应会话（Rust notify_show 点击回调经
  // lib/notify 装配进 open-session 总线）；会话已被删则静默
  const aui = useAui();
  // 面板标签按会话分桶（lib/panels/panel-tabs）：由常驻的 Base 随
  // mainThreadId 推移当前会话指针——面板未展开时 lib 层的 open/focus
  // （agent 工具、subagent 委派行等）也能落进正确的会话桶。指针键用
  // 稳定 id：本会话新建的线程在绑定 sessionId 前是 __LOCALID_ 草稿 id，
  // 经 piSessionRegistry 换出（未绑定的草稿落到草稿 id 自身的桶）
  const mainThreadId = useAuiState((s) => s.threads.mainThreadId);
  useEffect(() => {
    setCurrentPanelThread(
      mainThreadId ? (piSessionRegistry.get(mainThreadId) ?? mainThreadId) : null,
    );
  }, [mainThreadId]);
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
  // 展开动画进行中：Header 窗口控件的卸载（docked 翻转）延迟到动画完成帧，
  // 与面板顶栏控件可见性同帧交接，消除右上角控件空窗（展开闪的来源）
  const [panelExpanding, setPanelExpanding] = useState(false);
  // 动画期间把 minSize 释放为 0：库对可折叠面板会把 minSize 以下的 resize
  // 钳回 minSize/0（中段瞬间消失），动画期间必须解除钳制，结束后恢复
  const [panelMinReleased, setPanelMinReleased] = useState(false);
  // 开合动画期间冻结面板内容宽（侧边栏同款手法）：内容列宽度定格在动画
  // 起点像素，随面板收窄被裁剪滑出，动画期间整棵面板树零重排（xterm、
  // 会话列表等重排大户不再每帧 relayout）。null = 未冻结（拖拽/静止态
  // 内容恒 100% 跟手）
  const [panelFrozenPx, setPanelFrozenPx] = useState<number | null>(null);
  // ── 面板显示闸 ─────────────────────────────────────────────────────────────
  // 只有「真对话页且当前线程有内容」才允许显示 panel：自动化/插件/文件/使用
  // 统计等非对话页（activeMenu 非空）、设置页，以及新对话（空会话，含启动期
  // 占位线程）一律隐藏——panelShown 随之翻转走同款收起动画。panelOpen 仍是
  // 用户本地开关偏好（localStorage 只记它），闸门翻转不改写偏好：切回有消息
  // 的会话自动恢复展开。isNewChatView 为假即"非新对话态"（有消息，或正在
  // 加载历史）。例外：用户在空会话里显式点开面板（composer 分支菜单的
  // 「Git 图谱」只在新对话态可见），经 panelRequestedEmpty 旁路放行。
  const threadHasContent = useAuiState((s) => !isNewChatView(s));
  const [panelRequestedEmpty, setPanelRequestedEmpty] = useState(false);
  // 旁路只在"空会话且面板保持打开"期间生效：会话有了内容（闸本来放行）或
  // 用户手动收起面板即清除，避免切页回来时空会话又被旁路撑开。
  useEffect(() => {
    if (panelRequestedEmpty && (threadHasContent || !panelOpen)) setPanelRequestedEmpty(false);
  }, [threadHasContent, panelOpen, panelRequestedEmpty]);
  const panelGate =
    view === "chat" && activeMenu === "" && (threadHasContent || panelRequestedEmpty);
  const panelShown = panelOpen && panelGate;
  const panelRef = usePanelRef();
  // ── 面板全屏：收起聊天列，Agent 面板平铺主区 ─────────────────────────
  // 聊天列做成可折叠（collapsedSize=0），进全屏把它的宽度动画到 0 后 collapse()
  // 落位；面板 maxSize 同步从 60% 释放为 100% 才能占满。chatMinReleased 与
  // 面板开合的 panelMinReleased 同理：动画区间必须解除 minSize 钳制
  const [panelFullscreen, setPanelFullscreen] = useState(false);
  // exitPanelFullscreen 的守卫镜像（viewRef 同款）：非全屏时收面板/切页等
  // 路径也会路过它，绝不能动全屏过渡态——否则 chatMinReleased 被置位后
  // 没人收尾（panelFullscreen 依赖没变、动画 effect 不重跑），聊天列最小
  // 宽被永久钳在 0
  const panelFullscreenRef = useRef(false);
  panelFullscreenRef.current = panelFullscreen;
  const [chatMinReleased, setChatMinReleased] = useState(false);
  const chatRef = usePanelRef();
  const chatAnimRef = useRef<AnimationPlaybackControls | null>(null);
  // 进全屏瞬间的聊天列宽：退出全屏按它还原
  const chatWidthRef = useRef(CHAT_MIN_WIDTH);
  // 退出全屏：状态翻转 + 解除聊天列 min/max 约束（chatMinReleased 同时
  // 联动面板 maxSize=100%，必须与状态翻转同帧生效，否则退出首帧面板被 60%
  // 上限钳住跳变），动画细节交给下方 effect
  const exitPanelFullscreen = useCallback(() => {
    if (!panelFullscreenRef.current) return;
    panelFullscreenRef.current = false;
    setPanelFullscreen(false);
    setChatMinReleased(true);
  }, []);
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

  // 面板开合是本地态；composer 等外部入口（如分支菜单的"Git 图谱"）经此事件展开。
  // 同时置空会话旁路位：「Git 图谱」恰好只在空会话的新对话里可见，若只改
  // panelOpen 会被 panelGate 按住不显示，点击看起来毫无反应。
  useEffect(() => {
    const open = () => {
      setPanelOpen(true);
      setPanelRequestedEmpty(true);
    };
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
      prevPanelOpenRef.current !== panelShown;
    prevPanelOpenRef.current = panelShown;
    panelAnimInterruptedRef.current = false;
    panelAnimRef.current?.stop();
    panelAnimRef.current = null;
    if (!isToggle) {
      setPanelExpanding(false);
      if (panelShown) {
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
    if (panelShown) {
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
      // 展开途中 Header 仍持有窗口控件（docked 延迟翻转）：面板顶栏控件要
      // 随面板滑入才可见，若 docked 在起步帧就翻 true，Header 控件立即卸载
      // 而顶栏控件还不可见——右上角出现一整段动画时长的控件空窗（闪）
      setPanelExpanding(true);
      panelAnimRef.current = animate(p.getSize().inPixels, target, {
        duration: 0.3,
        ease: [0.32, 0.72, 0, 1],
        onComplete: () => {
          panelAnimRef.current = null;
          setPanelMinReleased(false);
          setPanelFrozenPx(null);
          setPanelWebviewOccluded(false);
          setPanelExpanding(false);
        },
        onUpdate: (v) => p.resize(v),
      });
    } else {
      const from = p.getSize().inPixels;
      // 冻结内容宽为当前宽：面板左缘右移推挤聊天列，内容随左缘平移、
      // 右侧被裁剪滑出——与侧边栏折叠互为镜像
      setPanelFrozenPx(Math.round(from));
      setPanelWebviewOccluded(true);
      setPanelExpanding(false);
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
    panelShown,
    panelHydrated,
    compact,
    panelMinReleased,
    panelRef,
  ]);
  // 卸载时掐掉在途动画，避免回调打到已销毁的 Panel
  useEffect(() => () => panelAnimRef.current?.stop(), []);
  useEffect(() => () => chatAnimRef.current?.stop(), []);
  useEffect(
    () => () => {
      if (savePanelWidthTimer.current !== null)
        clearTimeout(savePanelWidthTimer.current);
    },
    [],
  );

  // 全屏进出动画：入口（toggle/退出三连）已同步解除约束，这里只负责把聊天
  // 列宽度在当前值 ↔ 0/原宽间逐帧过渡，结束时 collapse() 落位并收掉过渡态
  // （minSize/maxSize 恢复钳制）。动画被再次触发（快速连点）时从当前宽度
  // 续走，不跳变。聊天列内容保持跟手（文本逐帧重排不贵，memo 后 React 也
  // 不再参与）；面板自身内容同步冻结（xterm/文件树是每帧 relayout 大户）、
  // 浏览器 webview 借 occluded 通道隐藏——与面板开合动画同款零重排手法；
  // 把手恰 8px（w-2），故面板全屏目标宽 = 面板宽 + 聊天列宽
  useEffect(() => {
    if (!panelHydrated || compact) return;
    const p = chatRef.current;
    if (!p) return;
    chatAnimRef.current?.stop();
    chatAnimRef.current = null;
    const from = Math.round(p.getSize().inPixels);
    const agentW = Math.round(panelRef.current?.getSize().inPixels ?? 0);
    if (!panelFullscreen) {
      const target = chatWidthRef.current;
      if (from >= target) {
        // 已在/超过原宽（快速连点兜底）：直接落位并恢复约束
        if (p.isCollapsed()) {
          p.expand();
          p.resize(target);
        }
        setChatMinReleased(false);
        setPanelFrozenPx(null);
        setPanelWebviewOccluded(false);
        return;
      }
      if (p.isCollapsed()) {
        p.expand();
        p.resize(from);
      }
      // 退出 = 面板从全宽缩回：内容冻结在当前全宽，随左缘平移、右侧被裁剪
      // 滑出（与面板收起动画同款）；结束时恢复，宽度即落位宽
      setPanelFrozenPx(agentW);
      setPanelWebviewOccluded(true);
      chatAnimRef.current = animate(from, target, {
        duration: 0.3,
        ease: [0.32, 0.72, 0, 1],
        onComplete: () => {
          chatAnimRef.current = null;
          setChatMinReleased(false);
          setPanelFrozenPx(null);
          setPanelWebviewOccluded(false);
        },
        onUpdate: (v) => p.resize(v),
      });
      return;
    }
    if (from <= 1) {
      p.collapse();
      setChatMinReleased(false);
      setPanelFrozenPx(null);
      setPanelWebviewOccluded(false);
      return;
    }
    // 进入 = 面板长到全宽：内容冻结在目标全宽（面板当前宽 + 聊天列宽），
    // 左缘随聊天列让位左移、右侧裁剪渐显（与面板展开动画同款），
    // 结束时冻结宽恰等于落位宽，无重排跳变
    setPanelFrozenPx(agentW + from);
    setPanelWebviewOccluded(true);
    chatAnimRef.current = animate(from, 0, {
      duration: 0.3,
      ease: [0.32, 0.72, 0, 1],
      onComplete: () => {
        chatAnimRef.current = null;
        p.collapse();
        setChatMinReleased(false);
        setPanelFrozenPx(null);
        setPanelWebviewOccluded(false);
      },
      onUpdate: (v) => p.resize(v),
    });
  }, [panelFullscreen, panelHydrated, compact, chatRef, panelRef]);

  // 窄屏没有"平铺"概念（面板是浮层），切到窄屏即退出全屏；宽屏下群组已卸载，
  // 清掉可能残留的动画中间态
  useEffect(() => {
    if (compact) {
      setPanelFullscreen(false);
      setChatMinReleased(false);
    }
  }, [compact]);

  // 全屏中按 Esc 退出（对话框等已 preventDefault 的 Escape 不劫持，设置页
  // 覆盖时也不抢；面板开合动画途中不接，避免两套 resize 打架）
  useEffect(() => {
    if (!panelFullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !panelAnimRef.current &&
        viewRef.current === "chat"
      ) {
        event.preventDefault();
        exitPanelFullscreen();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panelFullscreen, exitPanelFullscreen]);

  // 面板全屏切换入口（顶栏按钮）。面板开合动画途中不接全屏：面板 resize
  // 和聊天列 resize 会互相覆盖。useCallback：作为 AgentPanel 的 memo prop
  const togglePanelFullscreen = useCallback(() => {
    if (panelAnimRef.current) return;
    if (panelFullscreen) {
      exitPanelFullscreen();
      return;
    }
    const p = chatRef.current;
    if (!p) return;
    // 记录原宽供退出还原；约束解除与状态翻转同帧提交
    chatWidthRef.current = Math.max(
      CHAT_MIN_WIDTH,
      Math.round(p.getSize().inPixels),
    );
    setPanelFullscreen(true);
    setChatMinReleased(true);
  }, [panelFullscreen, exitPanelFullscreen, chatRef]);

  // 面板收起入口（AgentPanel memo 的稳定 prop）；全屏中收面板先退出全屏，
  // 聊天列回弹与面板收起动画并行，主区不闪空
  const collapsePanel = useCallback(() => setPanelOpen(false), []);
  const exitAndCollapsePanel = useCallback(() => {
    exitPanelFullscreen();
    setPanelOpen(false);
  }, [exitPanelFullscreen]);

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
    // 聊天列现在可折叠：被拖过最小宽自动折叠时，聊天列没有独立的恢复入口，
    // 松手必须弹回（非全屏、非全屏过渡中才处理）
    if (!panelFullscreen && !chatMinReleased) {
      const c = chatRef.current;
      if (c && c.isCollapsed()) {
        c.expand();
        c.resize(CHAT_MIN_WIDTH);
      }
    }
    if (!panelAnimInterruptedRef.current) return;
    panelAnimInterruptedRef.current = false;
    const p = panelRef.current;
    if (!p) return;
    const px = p.getSize().inPixels;
    if (panelShown) {
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

  // 记住宽度（拖拽/布局变化结束后）。onLayoutChanged 每帧都会进来（侧边栏
  // 过渡、开合动画、拖拽、窗口缩放）：低于 minSize 的中间态（收起动画末段、
  // 刚展开的前几帧）不落盘；落盘本身去抖到布局稳定后一次写，逐帧同步
  // localStorage 磁盘 I/O 会卡主线程
  const savePanelWidthTimer = useRef<number | null>(null);
  const savePanelWidth = () => {
    // 全屏态面板占满主区，宽度不落盘（否则历史宽度被记成全窗宽）
    if (panelFullscreen) return;
    const p = panelRef.current;
    if (!p || p.isCollapsed()) return;
    const px = Math.round(p.getSize().inPixels);
    if (px < PANEL_MIN_WIDTH) return;
    if (savePanelWidthTimer.current !== null)
      clearTimeout(savePanelWidthTimer.current);
    savePanelWidthTimer.current = window.setTimeout(() => {
      savePanelWidthTimer.current = null;
      try {
        localStorage.setItem(PANEL_WIDTH_KEY, String(px));
      } catch {}
    }, 200);
  };

  // 全局快捷键：打开设置 / 直达自动化页 / 开合 Agent 面板 / 切换主题（绑定来自「设置 → 快捷键」，改动即时生效）
  const { openSettings, openAutomations, toggleAgentPanel, toggleTheme } =
    useShortcuts();
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
      } else if (matchesShortcut(event, toggleTheme)) {
        event.preventDefault();
        toggleThemeMode();
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [openSettings, openAutomations, toggleAgentPanel, toggleTheme]);

  // 进入设置页时清掉文档里的活动选区：选区还在时 SelectionToolbar 的 quote
  // 气泡（挂 body 的 fixed 浮层）不会自动收起，经快捷键等不经鼠标的入口切
  // 视图会带着它浮到设置页上方；removeAllRanges 触发 selectionchange 使其卸载
  useEffect(() => {
    if (view === "settings") window.getSelection()?.removeAllRanges();
  }, [view]);

  // 进入自动化/使用统计等全幅管理页时退出面板全屏：它们是主区内的全幅视图，
  // 聊天列必须弹回接住版面；面板本身的隐藏交给 panelGate（非对话页统一收起，
  // 不再改写用户的开合偏好）
  useEffect(() => {
    if (
      activeMenu === "automation" ||
      activeMenu === "usage" ||
      activeMenu === "connector" ||
      activeMenu === "files"
    ) {
      exitPanelFullscreen();
    }
  }, [activeMenu, exitPanelFullscreen]);

  const chat =
    activeMenu === "automation" ? (
      <AutomationsView
        onBackToChat={() => setActiveMenu("")}
        focusTask={automationFocus}
        onFocusConsumed={() => setAutomationFocus(null)}
      />
    ) : activeMenu === "usage" ? (
      <UsageStatsView />
    ) : activeMenu === "connector" ? (
      <MarketplaceView manageTab={connectorManageTab} />
    ) : activeMenu === "files" ? (
      <FilesView />
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
    <div
      data-chat-card
      className="bg-background border-border/60 relative flex h-full min-w-0 flex-col overflow-hidden rounded-xl border"
    >
      {/* 自动化页环境光：挂在卡片内顶缘（header 之下、内容之上），
          光带从卡片顶垂下；固定不随内容滚 */}
      {/* {activeMenu === "automation" && (
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-0 h-72 overflow-hidden">
          <div className="from-primary/5 absolute inset-x-0 top-0 h-full bg-gradient-to-b to-transparent" />
          <div className="bg-primary/10 absolute -top-20 left-[12%] hidden size-64 rounded-full blur-3xl dark:block" />
          <div className="bg-primary/[0.08] absolute -top-24 right-[15%] hidden size-72 rounded-full blur-3xl dark:block" />
        </div>
      )} */}
      <div className="relative z-10 shrink-0">
        <Header
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
          onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
          // 折叠按钮跟视觉状态走：面板完全收没（收起动画播完）才在
          // Header 露出展开按钮，避免动画途中按钮提前跳出来闪一下；
          // 显示闸关着（非对话页/新对话空会话）时根本没有可展开的面板，不露按钮
          showPanelToggle={
            panelGate && (compact ? !panelShown : panelGone)
          }
          onTogglePanel={() => setPanelOpen((o) => !o)}
          docked={panelDocked && !panelExpanding}
          variant={
            activeMenu === "automation" ||
            activeMenu === "usage" ||
            activeMenu === "connector" ||
            activeMenu === "files"
              ? "page"
              : "session"
          }
        />
      </div>
      <div className="relative z-10 flex-1 overflow-hidden">
        {/* key=activeMenu：切菜单即重挂载，某个页面崩了切走再切回就恢复。
            边界本身不套壳，成功时原样渲染 children，版式不受影响 */}
        <ErrorBoundary key={activeMenu} label="主区">
          {chat}
        </ErrorBoundary>
        {compact ? (
          <AnimatePresence>
            {panelShown ? (
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
                  <AgentPanel onCollapse={collapsePanel} />
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
        {/* 右侧主内容区：窗口材质开启时透出磨砂（globals.css data-content-solid /
            data-chat-card 规则），关闭时保持不透明底色 */}
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
              "bg-muted/40 relative flex-1 overflow-hidden p-2 pl-0",
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
                  panelRef={chatRef}
                  // 可折叠支撑面板全屏（聊天列收到 0）；平时拖过最小宽也会
                  // 自动折叠，settlePanelHandle 在松手时弹回兜底
                  collapsible
                  collapsedSize={0}
                  minSize={
                    chatMinReleased ? "0px" : `${CHAT_MIN_WIDTH}px`
                  }
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
                  className={cn(
                    "w-2",
                    (panelGone || panelFullscreen) && "[&>div]:hidden",
                    // 全屏中把手整体失效：聊天列已收没，拖拽没有意义还可能
                    // 把它拖回来
                    panelFullscreen && "pointer-events-none",
                  )}
                  disabled={
                    panelFullscreen || chatMinReleased || !panelGate
                  }
                  disableDoubleClick={
                    panelFullscreen || chatMinReleased || !panelGate
                  }
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
                    // 全屏（及进出动画中）释放 60% 上限，面板才能随聊天列
                    // 收没而占满主区
                    maxSize={
                      panelFullscreen || chatMinReleased ? "100%" : "60%"
                    }
                    defaultSize={PANEL_DEFAULT_WIDTH}
                    groupResizeBehavior="preserve-pixel-size"
                    // 拖到小于 minSize 即自动折叠 / 拖回即展开：状态沿变化时回写开合；
                    // panelGone 跟踪视觉状态（≤1px 且非展开意图），驱动按钮/控件交接
                    onResize={(size) => {
                      const collapsed = size.inPixels <= 1;
                      setPanelGone(!panelShown && collapsed);
                      if (collapsed === wasCollapsedRef.current) {
                        // 无收放边沿且无在途动画/待结算手势：尺寸仍在变即
                        // 用户在拖 —— 名义收起却拖到有效宽度（拦停后拖拽
                        // 复活）视为想展开，兜底防止面板卡在"开着但收不起来"
                        if (
                          !collapsed &&
                          !panelShown &&
                          !panelAnimRef.current &&
                          !panelAnimInterruptedRef.current &&
                          size.inPixels >= PANEL_MIN_WIDTH
                        ) {
                          setPanelOpen(true);
                        }
                        return;
                      }
                      wasCollapsedRef.current = collapsed;
                      // 全屏中面板被收没（点面板顶栏收起/快捷键）：一并退出
                      // 全屏，聊天列弹回，主区不至于空掉
                      if (collapsed) exitPanelFullscreen();
                      // 显示闸驱动的收/放（切页、切到空会话，含动画与挂载 snap
                      // 两条路径）不改写用户开合偏好：动画在途或闸门关着时不回写，
                      // 只有用户拖拽/双击落位才同步 panelOpen
                      if (!panelAnimRef.current && panelGate)
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
                          onCollapse={exitAndCollapsePanel}
                          showWindowControls={panelDocked}
                          fullscreen={panelFullscreen}
                          onToggleFullscreen={togglePanelFullscreen}
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

      {/* 设置视图：全窗口覆盖，左侧为设置二级侧边栏（含"返回应用"）。
          单独包一层：崩了不能留下一个坏死的全屏遮罩把整个应用盖住 */}
      {view === "settings" && (
        <div className="bg-background fixed inset-0 z-50">
          <ErrorBoundary key={view} label="设置页">
            <SettingsPage
              onBack={() => setView("chat")}
              jumpSection={settingsJump?.id}
              jumpSeq={settingsJump?.seq}
            />
          </ErrorBoundary>
        </div>
      )}
    </>
  );
};
