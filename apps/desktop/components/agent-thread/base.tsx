"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FC,
} from "react";
import dynamic from "next/dynamic";
import { Loader2Icon, PanelLeftIcon, RotateCcwIcon } from "lucide-react";
import {
  AnimatePresence,
  animate,
  motion,
  type AnimationPlaybackControls,
} from "framer-motion";
import { useAui, useAuiState } from "@assistant-ui/react";
import { usePanelRef } from "react-resizable-panels";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import {
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { isMacPlatform, isDesktop } from "@/lib/desktop-env";
import { matchesShortcut, useShortcuts } from "@/lib/shortcuts";
import { toggleThemeMode } from "@/lib/settings/ui-prefs";
import { subscribeAutomationFocus } from "@/lib/automation/automations";
import {
  subscribeConnectorManage,
  type ManageTab,
} from "@/lib/connector-nav";
import { setAutomationFrameSync } from "@/lib/automation/automation-live";
import { ensureInboxLoaded } from "@/lib/inbox/inbox-store";
import { setSessionsChangedSync } from "@/lib/pi/pi-sessions-sync";
import { setProjectsChangedSync } from "@/lib/pi/pi-projects-sync";
import { refreshRegistry, initProjectRegistry } from "@/lib/pi/pi-projects";
import { subscribeOpenSession } from "@/lib/pi/open-session";
import { clearLastThread } from "@/lib/pi/pi-last-thread";
import { setThreadNavigateIntent } from "@/lib/pi/pi-thread-navigate";
import { piSessionRegistry } from "@/lib/pi/pi-thread-adapter";
import { LIBRARY_OPEN_REQUEST_EVENT } from "@/lib/workspace/knowledge-link";
import { beginResizeSession, endResizeSession } from "@/lib/ui/resize-session";
import { focusPanelTabFor, getPanelTabsFor, setCurrentPanelThread } from "@/lib/panels/panel-tabs";
import { toggleTerminalDock } from "@/lib/terminal/dock";
import {
  panelResizeContradictsState,
  panelResizeFallbackWantsOpen,
  resolvePanelOpenPref,
  writePanelOpenPref,
} from "@/lib/panels/panel-open-pref";
import { useOnboardingGate } from "@/components/onboarding/onboarding-provider";
import type { LibrarySpaceCard } from "@/components/files/library-landing";
import { CloneThreadShell } from "./clone-thread-shell";
import { ElasticPanelHandle } from "./elastic-panel-handle";
import { Header, Logo } from "./header";
import QuickViewCard from "./quick-view-popover";
import { Thread, isNewChatView } from "./thread";
import { AgentPanelSlot, TerminalDockGate } from "./lazy-surfaces";
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
// Inbox 页：与自动化同款按需 chunk；侧栏徽标只依赖轻量 store
const InboxView = dynamic(
  () => import("@/components/inbox/inbox-view").then((m) => m.InboxView),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
      </div>
    ),
  },
);
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
// 插件/技能页（市场 + 管理子页）：同款按需 chunk
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
// 资料库页（自有文件/笔记 + AI 产物）：同款按需 chunk
const LibraryView = dynamic(
  () =>
    import("@/components/files/library-view").then((m) => m.LibraryView),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
      </div>
    ),
  },
);
// 远程与 IM 管理页（远程控制 / 接入 IM 双 Tab）：同款按需 chunk，
// 侧边栏「远程」菜单激活才拉取
const RemoteView = dynamic(
  () => import("@/components/agent-thread/remote-view").then((m) => m.RemoteView),
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
import { Panel2Icon } from "../icons/panel2-icons";

/** 面板宽度的本地持久化键（px 整数）。面板**开合**已改为按会话分区记忆
 *  （lib/panels/panel-open-pref）；宽度仍是全局偏好，不分区 */
const PANEL_WIDTH_KEY = "agent-panel-width";
const PANEL_MIN_WIDTH = 500;
/** 无历史宽度时的默认面板宽（与 ResizablePanel defaultSize 一致） */
const PANEL_DEFAULT_WIDTH = 500;
/** 聊天列最小宽（把聊天列做成可折叠以支撑面板全屏，折叠动画须释放 minSize） */
const CHAT_MIN_WIDTH = 500;

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
  // 搜索开合提到 Base：Header 需要据此把搜索输入放进同一根顶栏，
  // 折叠态的导航/展开按钮因此保持和资料库/自动化页完全对齐
  const [searchOpen, setSearchOpen] = useState(false);
  const [view, setView] = useState<"chat" | "settings">("chat");
  // 从设置页「重新查看新手引导」时（通用设置 → 入门）把设置视图收掉：
  // 向导是全屏接管，走完后应当直接落在对话界面，而不是退回设置页。
  const onboardingActive = useOnboardingGate().active;
  useEffect(() => {
    if (onboardingActive) setView("chat");
  }, [onboardingActive]);
  // 浏览器面板已迁 `<webview>`（DOM 嵌入渲染）：浮层/设置页/向导弹窗天然盖在
  // 它上面，面板开合动画它随 DOM 平移——旧的「主窗口遮蔽 → browser:occluded
  // 广播 → 隐藏原生子视图」整条链随之退役（参考实现同架构）。
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
  // 侧边栏菜单选中项（受控给 CloneThreadShell）："automation" 时主区
  // 整页切到自动化管理视图；点会话行/新对话由 shell 的导航委托清空回到聊天
  const [activeMenu, setActiveMenu] = useState("");
  /** 资料库页当前路由（null=一级 / 卡=二级空间详情）：决定顶栏分割线 */
  const [librarySpace, setLibrarySpace] = useState<LibrarySpaceCard | null>(
    null,
  );
  // 回答里的资料库引用芯片：切到资料库整页，LibraryView 挂载时消费 pending 请求
  useEffect(() => {
    const onOpen = () => {
      setView("chat");
      setActiveMenu("files");
    };
    window.addEventListener(LIBRARY_OPEN_REQUEST_EVENT, onOpen);
    return () => window.removeEventListener(LIBRARY_OPEN_REQUEST_EVENT, onOpen);
  }, []);
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
  // Inbox 首屏种子：侧栏徽标在 Shell 里订阅，这里只负责拉一次 counts/列表；
  // 后续变化由 inbox_changed 帧驱动 store 自更新。
  useEffect(() => {
    void ensureInboxLoaded();
  }, []);
  // composer「+」菜单的「管理子智能体 / 管理连接器 / 管理技能」：切主区到
  // 插件/技能页并直接落到管理分段（分段本身是 MarketplaceView 的局部态，
  // 故经 prop 下发而非事件）
  const [connectorManageTab, setConnectorManageTab] = useState<ManageTab | null>(null);
  // 一次性跳转请求：市场页消费后清空，避免下次从侧栏进入时重复落到管理页
  const clearConnectorManageTab = useCallback(
    () => setConnectorManageTab(null),
    [],
  );
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
  /** 面板分区键：与面板标签桶同空间（sessionId；草稿期 __LOCALID_ 自身，
   *  绑定 sessionId 后由 rekeyPanelOpenPref 迁移） */
  const panelScopeKey = mainThreadId
    ? (piSessionRegistry.get(mainThreadId) ?? mainThreadId)
    : null;
  useEffect(() => {
    setCurrentPanelThread(panelScopeKey);
  }, [panelScopeKey]);
  useEffect(
    () =>
      subscribeOpenSession(({ sessionId, seq, query }) => {
        // seq/query = 搜索内容命中的定位意图：走模块级 store 交给 thread 层
        //（<Thread> 被刻意 memo 成零 props，props 通道会破坏消息流子树优化）。
        // 意图绑定目标会话 + TTL：switchToThread 失败或目标消息永远到不了时，
        // 旧意图不得在用户之后打开的别的会话里突然生效（短会话 seq 号段易撞）。
        setThreadNavigateIntent(
          seq !== undefined ? { seq, query, sessionKey: sessionId, createdAt: Date.now() } : null,
        );
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
  // 跨端会话清单同步：移动端/网页端（或本端他窗）建会话、改名、删除、归档
  // 等变更 → sidecar 广播 sessions_changed → 去抖整表 reload（此前移动端
  // 新建的会话要手动刷新才能在侧边栏看到；去抖在 lib/pi/pi-sessions-sync）
  useEffect(() => {
    setSessionsChangedSync(() => {
      void aui.threads.reload().catch(() => {});
    });
    return () => setSessionsChangedSync(null);
  }, [aui]);
  // 项目实体跨端同步：另一窗口/端改名、换图标、改目录、归档项目 →
  // projects_changed → 重拉注册表（侧栏/胶囊/空项目卡片立即跟上）
  useEffect(() => {
    // 主壳常驻：确保设置页/自动化/移动弹窗即使侧栏未挂载也有项目注册表
    void initProjectRegistry();
    setProjectsChangedSync(() => {
      void refreshRegistry().catch(() => {});
    });
    return () => setProjectsChangedSync(null);
  }, []);
  // Agent 面板：SSR 首帧恒为展开（避免 hydration 不一致）；挂载/切会话后按
  // **当前会话自己的记忆**恢复开合（下方分区效应）：用户表态优先，从没表过
  // 态的会话有标签就展开、没标签才收起
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelHydrated, setPanelHydrated] = useState(false);
  /** 动画落位基线（null = 下一次落位走 snap、不播开合动画） */
  const prevPanelOpenRef = useRef<boolean | null>(null);
  /** 待播的开合动画（true = 展开方向）。minSize 释放是两段式：先置位、
   *  等约束生效的下一轮再动画；第二轮不能再拿 isToggle 判断——状态沿在
   *  上一轮就已经同步过，会被判成"非开合落位"直接 snap（收起方向尤其明显：
   *  点收起变成瞬间消失，观感与展开对不上）。 */
  const pendingPanelAnimRef = useRef<boolean | null>(null);
  /** 当前分区键的 ref：长生命周期闭包（事件监听/快捷键）不随分区切换重建 */
  const panelScopeKeyRef = useRef<string | null>(panelScopeKey);
  panelScopeKeyRef.current = panelScopeKey;
  const panelOpenRef = useRef(panelOpen);
  panelOpenRef.current = panelOpen;
  /** 面板开合按会话分区恢复：挂载与切会话都读"当前会话自己的记忆"——全局单键
   *  时代 A 会话展开面板、切到 B 也保持展开（2026-10 实报）。分区切换是"跟随
   *  会话"而非用户意图：直接 setPanelOpen、不写记忆；同时把 prevPanelOpenRef
   *  置 null 让宽度动画走 snap——切会话即时落位，不逐帧推挤。
   *  从没表过态的会话（无记录）交给 resolvePanelOpenPref 兜底：有标签等着就
   *  展开（后台会话里 agent 开的标签、切过去该看见的产物都在标签里），没有才
   *  默认收起——否则每个没碰过的会话都要手点一次展开（2026-10 实报"每次切会话
   *  都得重新打开"）。兜底不回写：没表态就一直是没表态。 */
  useEffect(() => {
    const hasTabs = panelScopeKey
      ? getPanelTabsFor(panelScopeKey).tabs.length > 0
      : false;
    setPanelOpen(resolvePanelOpenPref(panelScopeKey, hasTabs));
    prevPanelOpenRef.current = null;
    setPanelHydrated(true);
    // 收起态预排版的宽度：与开合偏好同源（localStorage），分区切换时一起刷新
    const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    setPanelContentW(
      Number.isFinite(saved) && saved >= PANEL_MIN_WIDTH
        ? saved
        : PANEL_DEFAULT_WIDTH,
    );
  }, [panelScopeKey]);
  /** 用户手动开/收的写口（收起/展开按钮、快捷键、拖拽落位、显式展开事件）：
   *  同步写当前会话的分区记忆——这是"用户意图"，与切会话的跟随恢复区分开 */
  const applyUserPanelOpen = useCallback((open: boolean) => {
    setPanelOpen(open);
    writePanelOpenPref(panelScopeKeyRef.current, open);
  }, []);
  // 会话分区切换/水合恢复走 snap：把待播标记清掉，别让上一分区的意图带过来
  useEffect(() => {
    pendingPanelAnimRef.current = null;
  }, [panelScopeKey]);
  // 会话是否有内容：声明在下方（useAuiState），这里用 ref 承接供稳定回调读
  const threadHasContentRef = useRef(false);
  const toggleUserPanelOpen = useCallback(() => {
    const next = !panelOpenRef.current;
    applyUserPanelOpen(next);
    // 新对话（空会话）里 panelGate 关着，直接改 panelOpen 会被闸门按住
    // 不显示（点开像没反应）；点开即经空会话旁路放行。旁路在会话有内容
    // 或面板收起时自动清除
    if (next && !threadHasContentRef.current) setPanelRequestedEmpty(true);
  }, [applyUserPanelOpen]);
  // 迭代1b（P6）：宽屏右列折叠（collapsedSize=0）时不再常驻渲染整棵面板树，
  // 首次展开才挂载、之后保持挂载（收起不再卸载，二次展开零重建）。
  // 活动数据在 panel-activity 的派生 store（每个 runtime 一份，模块级 WeakMap），
  // 面板卸载/未挂载不丢（迭代1）。
  const [panelEverOpened, setPanelEverOpened] = useState(false);
  // 面板视觉状态：像素 ≤1 视为完全收起（收起动画播完才置真）。
  // 面板顶栏占位/收起入口的显隐跟着它走而不是 panelOpen，否则收起动画
  // 一起步顶栏就瞬间跳位（"闪一下"的来源）
  const [panelGone, setPanelGone] = useState(false);
  // onResize 每帧都会进来；只在值真正翻转时才 setState。拖拽中反复调用
  // setState（即使 React 会 bail out）仍可能让 Base 的渲染函数白跑一遍
  const panelGoneRef = useRef(false);
  // 动画期间把 minSize 释放为 0：库对可折叠面板会把 minSize 以下的 resize
  // 钳回 minSize/0（中段瞬间消失），动画期间必须解除钳制，结束后恢复
  const [panelMinReleased, setPanelMinReleased] = useState(false);
  // 开合动画期间冻结面板内容宽（侧边栏同款手法）：内容列宽度定格在动画
  // 起点像素，随面板收窄被裁剪滑出，动画期间整棵面板树零重排（xterm、
  // 会话列表等重排大户不再每帧 relayout）。null = 未冻结（拖拽/静止态
  // 内容恒 100% 跟手）
  const [panelFrozenPx, setPanelFrozenPx] = useState<number | null>(null);
  // 拖拽把手期间只冻结面板**内容区**（卡片与标签栏照常跟手）：xterm /
  // webview / diff 等重排大户在拖拽中零 relayout，松手一次落位。与上面的
  // 开合动画冻结分开——动画冻结整张卡片，拖拽只冻结内容区，观感不同。
  const [panelDragFrozenPx, setPanelDragFrozenPx] = useState<number | null>(null);
  const panelDragActiveRef = useRef(false);
  // ── 面板显示闸 ─────────────────────────────────────────────────────────────
  // 只有「真对话页且当前线程有内容」才允许显示 panel：自动化/插件/文件/使用
  // 统计等非对话页（activeMenu 非空）、设置页，以及新对话（空会话，含启动期
  // 占位线程）一律隐藏——panelShown 随之翻转走同款收起动画。panelOpen 仍是
  // 用户本地开关偏好（localStorage 只记它），闸门翻转不改写偏好：切回有消息
  // 的会话自动恢复展开。isNewChatView 为假即"非新对话态"（有消息，或正在
  // 加载历史）。例外：用户在空会话里显式点开面板（标题栏开关），经
  // panelRequestedEmpty 旁路放行。
  const threadHasContent = useAuiState((s) => !isNewChatView(s));
  threadHasContentRef.current = threadHasContent;
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
  const mac = isDesktop() && isMacPlatform();

  // 水合后（SSR 首帧恒为展开，不代表用户意图）一旦面板处于展开即置位
  useEffect(() => {
    if (panelHydrated && panelOpen) setPanelEverOpened(true);
  }, [panelHydrated, panelOpen]);

  // 面板开合是本地态；标题栏等外部入口经此事件展开。同时置空会话旁路位：
  // 空会话里若只改 panelOpen 会被 panelGate 按住不显示，点击看起来毫无反应。
  // 非对话页（自动化/资料库/设置等）不响应：闸门本就不让面板显示，若仍把
  // panelOpen 写成 true，离开页面回到对话时面板会凭空弹开。
  useEffect(() => {
    const open = () => {
      if (!panelGate) return;
      applyUserPanelOpen(true);
      setPanelRequestedEmpty(true);
    };
    window.addEventListener("agent-panel:open", open);
    return () => window.removeEventListener("agent-panel:open", open);
  }, [applyUserPanelOpen, panelGate]);

  // 主进程 browser_open_panel（e2e / 未来“在面板中打开”入口）：Base 常驻，
  // 面板当前收起也能落桶并展开。落桶键用当前会话指针（与 data-panelOpen 一致）。
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    import("@/desktop-bridge/event")
      .then(({ listen }) =>
        listen<{ url?: string }>("browser:open-panel", (e) => {
          const owner = panelScopeKeyRef.current;
          if (!owner) return;
          const url = typeof e.payload?.url === "string" ? e.payload.url : "";
          focusPanelTabFor(owner, "browser", url ? { url } : undefined);
          window.dispatchEvent(new Event("agent-panel:open"));
        }),
      )
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // 开合 → 驱动 collapsible Panel：用户开合（panelOpen 状态沿）时用
  // framer-motion 把面板宽度在 0↔目标值间逐帧 resize，聊天列随之被连续
  // "推开/让位"（TRAE 式推移感）。动画区间覆盖 minSize 以下，须先释放
  // minSize（两段式：released 置位 → 本 effect 随依赖重跑才启动动画），
  // 结束后恢复钳制；挂载恢复、窄屏切宽屏等非开合落位直接 snap
  const panelAnimRef = useRef<AnimationPlaybackControls | null>(null);
  // 动画被把手 pointerdown 拦停后置位，pointerup 时据此结算中间态
  const panelAnimInterruptedRef = useRef(false);
  /** 开合动画期间的 is-resizing 拖拽会话（与把手拖拽同一套开关）：动画逐帧改宽，
   *  重测量组件若照常逐帧读布局，读量是收放卡顿的主要来源；挂上会话它们跳过
   *  中间帧，落位后由 endResizeSession 统一补一次终态测量。
   *  自带 ref 守卫：与把手拖拽的会话交接时不会重复开/关。 */
  const panelAnimSessionRef = useRef(false);
  /** 量出"动画结束时正文该有多宽"并写进 --chat-width：同一帧完成折行，之后纯平移 */
  const freezeChatText = (target: number) => {
    const chat = chatRef.current;
    const panel = panelRef.current;
    const viewport = document.querySelector<HTMLElement>(
      '[data-slot="aui_thread-viewport"]',
    );
    if (!chat || !panel || !viewport) {
      setChatFreezeMax(null);
      return;
    }
    // 组宽守恒（列 + 把手 + 面板 = 常量）：面板长多少，聊天列就窄多少
    const finalChat =
      chat.getSize().inPixels + (panel.getSize().inPixels - target);
    const cs = getComputedStyle(viewport);
    const pad =
      (Number.parseFloat(cs.paddingLeft) || 0) +
      (Number.parseFloat(cs.paddingRight) || 0);
    const available = Math.max(0, finalChat - pad);
    // 对话宽度设置（--chat-width）写在 <html> 上：rem 上限直接按根字号换算，100% 表示
    // 平铺。必须读 documentElement——动画期间聊天列自身可能已被上一次冻结覆写成 px，
    // 从列内读会拿到过期值。
    const rootStyle = getComputedStyle(document.documentElement);
    const raw = rootStyle.getPropertyValue("--chat-width").trim();
    const num = Number.parseFloat(raw);
    const rootFont = Number.parseFloat(rootStyle.fontSize) || 16;
    const cap = raw.endsWith("%")
      ? (available * (Number.isFinite(num) ? num : 100)) / 100
      : raw.endsWith("rem")
        ? (Number.isFinite(num) ? num : 60) * rootFont
        : Number.isFinite(num)
          ? num
          : 60 * rootFont;
    const width = Math.max(200, Math.min(available, cap));
    setChatFreezeMax(Math.round(width));
  };
  const unfreezeChatText = () => setChatFreezeMax(null);
  const beginPanelAnimSession = () => {
    if (panelAnimSessionRef.current) return;
    panelAnimSessionRef.current = true;
    beginResizeSession();
  };
  const endPanelAnimSession = () => {
    if (!panelAnimSessionRef.current) return;
    panelAnimSessionRef.current = false;
    endResizeSession();
  };
  /** localStorage 里的目标面板宽（无有效记录回默认） */
  const panelTargetWidth = () => {
    const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return Number.isFinite(saved) && saved >= PANEL_MIN_WIDTH
      ? saved
      : PANEL_DEFAULT_WIDTH;
  };
  // 面板内容的排版权宽（px）：收起态也按"下次展开的目标宽"先把内容排好版。
  // 不收窄成 0 的原因见下方冻结容器注释——展开方向原先比收起方向卡得多，
  // 就差在这一下"首次布局"（整棵面板树 0→941px 的重排 + 内部一堆 RO 回调，
  // CodeMirror/diff 这些一进来就要全量测量）。宽度随拖拽落位/记忆同步。
  const [panelContentW, setPanelContentW] = useState<number | null>(null);
  // 动画期间对话正文的排版宽（px，覆写 --chat-width；null = 不覆写）。
  // 正文块是 min(列宽 - 内边距, 对话宽度上限)，上限是 rem 固定值（默认 60rem），
  // 也就是**列宽跨过上限后正文才随之折行**。展开方向这笔折行原先落在动画尾段：
  // 列宽 1767 → 818，越过上限时面板已经走了大半行程、动画只剩最后一段——观感就是
  // "先平移、后折行"两段。收起方向天然相反（列宽一涨就立刻越过阈值，折行发生在头
  // 几毫秒），所以一直觉得顺。这里把折行统一挪到动画起点：按"结束时的宽度"排一次
  // 版，之后的动画只剩纯平移；落位时覆写值与自然值相等，不会再有第二次变化。
  const [chatFreezeMax, setChatFreezeMax] = useState<number | null>(null);
  useEffect(() => {
    if (!panelHydrated || compact) return;
    const p = panelRef.current;
    if (!p) return;
    const target = panelTargetWidth();
    const pending = pendingPanelAnimRef.current;
    const isToggle =
      pending !== null ||
      (prevPanelOpenRef.current !== null &&
        prevPanelOpenRef.current !== panelShown);
    prevPanelOpenRef.current = panelShown;
    panelAnimInterruptedRef.current = false;
    panelAnimRef.current?.stop();
    panelAnimRef.current = null;
    endPanelAnimSession();
    unfreezeChatText();
    if (!isToggle) {
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
      pendingPanelAnimRef.current = panelShown;
      setPanelMinReleased(true);
      return;
    }
    pendingPanelAnimRef.current = null;
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
      setPanelContentW(Math.round(target));
      freezeChatText(target);
      beginPanelAnimSession();
      panelAnimRef.current = animate(p.getSize().inPixels, target, {
        duration: 0.3,
        ease: [0.32, 0.72, 0, 1],
        onComplete: () => {
          panelAnimRef.current = null;
          setPanelMinReleased(false);
          setPanelFrozenPx(null);
          endPanelAnimSession();
          unfreezeChatText();
        },
        onUpdate: (v) => p.resize(v),
      });
    } else {
      const from = p.getSize().inPixels;
      // 冻结内容宽为当前宽：面板左缘右移推挤聊天列，内容随左缘平移、
      // 右侧被裁剪滑出——与侧边栏折叠互为镜像
      setPanelFrozenPx(Math.round(from));
      setPanelContentW(Math.round(from));
      freezeChatText(0);
      beginPanelAnimSession();
      panelAnimRef.current = animate(from, 0, {
        duration: 0.26,
        ease: [0.32, 0.72, 0, 1],
        onComplete: () => {
          panelAnimRef.current = null;
          p.collapse();
          setPanelMinReleased(false);
          setPanelFrozenPx(null);
          endPanelAnimSession();
          unfreezeChatText();
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
  // 卸载时掐掉在途动画，避免回调打到已销毁的 Panel；顺带收掉动画会话
  useEffect(
    () => () => {
      panelAnimRef.current?.stop();
      endPanelAnimSession();
      unfreezeChatText();
    },
    [],
  );
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
  // 分隔条 0 宽，面板全屏目标宽 = 面板宽 + 聊天列宽
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
        return;
      }
      if (p.isCollapsed()) {
        p.expand();
        p.resize(from);
      }
      // 退出 = 面板从全宽缩回：内容冻结在当前全宽，随左缘平移、右侧被裁剪
      // 滑出（与面板收起动画同款）；结束时恢复，宽度即落位宽
      setPanelFrozenPx(agentW);
      chatAnimRef.current = animate(from, target, {
        duration: 0.3,
        ease: [0.32, 0.72, 0, 1],
        onComplete: () => {
          chatAnimRef.current = null;
          setChatMinReleased(false);
          setPanelFrozenPx(null);
        },
        onUpdate: (v) => p.resize(v),
      });
      return;
    }
    if (from <= 1) {
      p.collapse();
      setChatMinReleased(false);
      setPanelFrozenPx(null);
      return;
    }
    // 进入 = 面板长到全宽：内容冻结在目标全宽（面板当前宽 + 聊天列宽），
    // 左缘随聊天列让位左移、右侧裁剪渐显（与面板展开动画同款），
    // 结束时冻结宽恰等于落位宽，无重排跳变
    setPanelFrozenPx(agentW + from);
    chatAnimRef.current = animate(from, 0, {
      duration: 0.3,
      ease: [0.32, 0.72, 0, 1],
      onComplete: () => {
        chatAnimRef.current = null;
        p.collapse();
        setChatMinReleased(false);
        setPanelFrozenPx(null);
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
  const collapsePanel = useCallback(
    () => applyUserPanelOpen(false),
    [applyUserPanelOpen],
  );
  const exitAndCollapsePanel = useCallback(() => {
    exitPanelFullscreen();
    applyUserPanelOpen(false);
  }, [exitPanelFullscreen, applyUserPanelOpen]);

  // 把手 pointerdown：拦停在途动画（动画 resize 会和拖拽互相覆盖），并开启
  // 一次拖拽会话。注意只挂把手——原来挂在 Group 的 onPointerDownCapture 上，
  // 面板内任何点击（包括收起按钮自己）都会掐停动画：连点收起按钮时第二次
  // 点击把动画停在半路且 applyUserPanelOpen(false) 已是 no-op，面板卡死
  // "收不起来"。
  const beginPanelHandleDrag = () => {
    if (panelFullscreen || chatMinReleased || !panelGate) return;
    if (panelAnimRef.current) {
      panelAnimRef.current.stop();
      panelAnimRef.current = null;
      panelAnimInterruptedRef.current = true;
      endPanelAnimSession();
      unfreezeChatText();
    } else {
      panelAnimInterruptedRef.current = false;
    }
    // 被拖拽接管：解除开合动画的内容冻结
    setPanelFrozenPx(null);
    // 拖拽期间挂全站 is-resizing（重测量组件据此跳过逐帧布局读取），
    // 并把内容区宽定格在起始像素：面板外框照常跟手，内容一次都不重排
    if (!panelDragActiveRef.current) {
      panelDragActiveRef.current = true;
      beginResizeSession();
    }
    const p = panelRef.current;
    const px = p ? Math.round(p.getSize().inPixels) : 0;
    // 从收起态拖开时内容区宽度还是 0，不能冻结（会把内容裁没）；
    // 只有面板已经处于有效宽度才冻结，松手后统一落位
    if (panelShown && !p?.isCollapsed() && px >= PANEL_MIN_WIDTH) {
      setPanelDragFrozenPx(px);
    }
  };
  // 松手/取消：撤销拖拽会话，解冻内容区，两拍后通知各处补测终态
  const endPanelHandleDrag = useCallback(() => {
    if (!panelDragActiveRef.current) return;
    panelDragActiveRef.current = false;
    setPanelDragFrozenPx(null);
    endResizeSession();
  }, []);
  // pointerup 理论上都会经过 Group 的 onPointerUpCapture；窗口失焦/指针取消
  // 时可能收不到，这两个兜底防止 is-resizing 和内容冻结永久残留
  useEffect(() => {
    const stop = () => endPanelHandleDrag();
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      endPanelHandleDrag();
    };
  }, [endPanelHandleDrag]);
  // 把手交互结束（pointerup 任意位置都可能）后结算被拦停的动画，
  // 面板必须落到"全开/全收/交给开合效果续跑"三者之一，不许卡在半路
  const settlePanelHandle = () => {
    // 先收拖拽会话：后续结算可能翻转 panelShown/启动动画，内容冻结的
    // 归属要在此之前交还
    endPanelHandleDrag();
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
      applyUserPanelOpen(true);
    } else {
      // 半路 → 归零完成收起
      p.collapse();
      setPanelMinReleased(false);
    }
  };

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
    // 收起态的排版宽跟着走：下次展开按新宽度预排版
    setPanelContentW(px);
    savePanelWidthTimer.current = window.setTimeout(() => {
      savePanelWidthTimer.current = null;
      try {
        localStorage.setItem(PANEL_WIDTH_KEY, String(px));
      } catch {}
    }, 200);
  };

  // 全局快捷键：打开设置 / 直达自动化页 / 开合 Agent 面板 / 开合底部终端 / 切换主题（绑定来自「设置 → 快捷键」，改动即时生效）
  const { openSettings, openAutomations, toggleAgentPanel, toggleTerminal, toggleTheme } =
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
        toggleUserPanelOpen();
      } else if (matchesShortcut(event, toggleTerminal)) {
        // 底部终端坞：开合状态在 lib/terminal/dock（全局一套，不分会话）；
        // 首次展开时 dock 侧自理"空坞给一个终端"
        event.preventDefault();
        toggleTerminalDock();
      } else if (matchesShortcut(event, toggleTheme)) {
        event.preventDefault();
        toggleThemeMode();
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [openSettings, openAutomations, toggleAgentPanel, toggleTerminal, toggleTheme]);

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
      activeMenu === "inbox" ||
      activeMenu === "automation" ||
      activeMenu === "usage" ||
      activeMenu === "connector" ||
      activeMenu === "files" ||
      activeMenu === "remote"
    ) {
      exitPanelFullscreen();
    }
  }, [activeMenu, exitPanelFullscreen]);

  // 元素身份固定：面板开合、侧栏收放都只改 Base 的本地状态，不该让消息流跟着
  // 重渲染（实测一次开合里它占 12~50ms）。Thread 自己按 runtime 订阅更新，
  // 与"由谁渲染它"无关——引用不变时 React 直接跳过这棵子树。
  const threadNode = useMemo(() => <Thread />, []);
  // 资料库页「引用到对话」toast 的「去对话」直达路：清空 activeMenu 即回聊天
  const backToChat = useCallback(() => setActiveMenu(""), []);
  const chat =
    activeMenu === "inbox" ? (
      <InboxView />
    ) : activeMenu === "automation" ? (
      <AutomationsView
        onBackToChat={() => setActiveMenu("")}
        focusTask={automationFocus}
        onFocusConsumed={() => setAutomationFocus(null)}
      />
    ) : activeMenu === "usage" ? (
      <UsageStatsView />
    ) : activeMenu === "connector" ? (
      <MarketplaceView
        manageTab={connectorManageTab}
        onManageTabConsumed={clearConnectorManageTab}
      />
    ) : activeMenu === "files" ? (
      <LibraryView
        onBackToChat={backToChat}
        onSpaceChange={setLibrarySpace}
      />
    ) : activeMenu === "remote" ? (
      <RemoteView onBackToChat={backToChat} />
    ) : (
      threadNode
    );

  // 面板停靠为右列（宽屏且视觉上未完全收起，收起动画途中仍算停靠）：
  // 面板顶栏接管收起入口，并为常驻的 Windows 窗口控件留出同槽占位；
  // 窄屏浮层或面板收没时不渲染该占位。
  const panelDocked = !compact && !panelGone;

  // TRAE 式左右两列：Header 只挂在聊天列上方，分割线从窗口顶通到底；
  // 列本身是带描边圆角的卡片，四周留出窗口底色边距（顶缘仍可拖窗）。
  // 窄屏（浮层模式）下浮层只盖聊天内容区，不遮 Header
  // 回调一律稳定引用：Header 与壳在面板开合时只该因"面板相关 prop"
  // （windowControlsCollapsed / showPanelToggle）重渲染，不该被内联
  // 箭头函数一起拖进来
  const toggleSidebar = useCallback(() => setSidebarCollapsed((v) => !v), []);
  const openMobileSidebar = useCallback(() => setMobileSidebarOpen(true), []);
  const hideSidebar = useCallback(() => setSidebarCollapsed(true), []);
  const openSettingsView = useCallback(() => setView("settings"), []);
  const sidebarHeaderContent = useMemo(
    () => (
      // 展开时显示在侧边栏顶栏；mac 的红绿灯避让（ml-18）由顶栏内组里
      // 第一个元素（shell 渲染的搜索按钮）承接，此处在搜索右侧紧贴排列。
      // 折叠时内容随侧边栏整列 transform 平移出屏，保持挂载不卸载
      <TooltipIconButton
        variant="ghost"
        size="icon"
        tooltip="Hide sidebar"
        side="bottom"
        onClick={hideSidebar}
        className={cn("size-8", !mac && "ml-2")}
      >
        <Panel2Icon className="size-4" />
      </TooltipIconButton>
    ),
    [hideSidebar, mac],
  );
  const sidebarSheetTitle = useMemo(() => <Logo />, []);

  const chatColumn = (
    <div
      data-chat-card
      data-wallpaper-surface="chat"
      className={cn(
        "bg-background border-border/60 relative flex h-full min-w-0 flex-col overflow-hidden",
        // 面板打开时两列卡片贴边（把手 0 宽）；去掉聊天卡片右描边，
        // 让右列的左侧阴影承担分隔，不再留一条缝/一条线
        panelShown && !compact && "border-r-0",
      )}
      // 覆写 --chat-width（thread.tsx 的 --thread-max-width 消费它）：动画期间
      // 正文按结束宽排版，落位时与自然值相等
      style={
        chatFreezeMax !== null
          ? ({ "--chat-width": `${chatFreezeMax}px` } as CSSProperties)
          : undefined
      }
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
      {/* 顶栏独立边界：崩了只塌这一条，占住 h-12 高度不塌布局，主内容照常 */}
      <ErrorBoundary
        label="顶栏"
        fallback={(_, retry) => (
          <div className="border-border/60 text-muted-foreground relative z-10 flex h-12 shrink-0 items-center justify-center gap-2 border-b text-xs">
            顶栏出了点问题
            <Button size="sm" variant="outline" onClick={retry}>
              <RotateCcwIcon className="size-3.5" />
              重试
            </Button>
          </div>
        )}
      >
        <div className="relative z-10 shrink-0">
          <Header
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
          onOpenMobileSidebar={openMobileSidebar}
          searchOpen={searchOpen}
          // 面板开关与左侧侧栏展开按钮同款：开合状态一翻就淡入/淡出
          // （150ms），槽位宽度由 Header 自身按同一条 300ms 曲线收放——
          // 不再等开合动画播完才出现/消失（那样会留一段空槽，观感发跳）
          showPanelToggle={!panelShown}
          onTogglePanel={toggleUserPanelOpen}
          windowControlsCollapsed={!compact && panelShown}
          panelShown={panelShown}
          variant={
            activeMenu === "inbox" ||
            activeMenu === "automation" ||
            activeMenu === "usage" ||
            activeMenu === "connector" ||
            activeMenu === "files" ||
            activeMenu === "remote"
              ? "page"
              : "session"
          }
          // 资料库只有二级页（空间详情，左栏是列表+查看器两栏版式）画顶栏
          // 分割线，与内容分界；一级页是留白卡片版式，不画
          pageDivided={activeMenu === "files" && librarySpace !== null}
        />
        </div>
      </ErrorBoundary>
      <div className="relative z-10 flex-1 overflow-hidden">
        {/* key=activeMenu：切菜单即重挂载，某个页面崩了切走再切回就恢复。
            边界本身不套壳，成功时原样渲染 children，版式不受影响 */}
        <ErrorBoundary key={activeMenu} label="主区">
          {chat}
        </ErrorBoundary>
        {/* 快速查看浮层：只挂聊天会话（管理页无会话语境）；卡片按 threadId
            记录开合（lib/quick-view），收起即整卡卸载，不订阅数据源。
            独立边界：崩了静默消失（已上报），不拖累聊天区 */}
        {activeMenu === "" ? (
          // key=mainThreadId：卡崩了切个会话就重挂载恢复，不用重载窗口
          <ErrorBoundary key={mainThreadId} label="快速查看" fallback={() => null}>
            <QuickViewCard threadId={mainThreadId} />
          </ErrorBoundary>
        ) : null}
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
                  onClick={() => applyUserPanelOpen(false)}
                />
                <motion.div
                  key="panel"
                  initial={{ x: "100%" }}
                  animate={{ x: 0 }}
                  exit={{ x: "100%" }}
                  transition={{ type: "spring", stiffness: 380, damping: 36 }}
                  className="border-border bg-background absolute inset-y-0 right-0 z-40 flex w-[min(92vw,420px)] rounded-l-lg border-l"
                >
                  {/* 面板崩了只塌面板：聊天列照常可用，重试即恢复 */}
                  <ErrorBoundary label="Agent 面板">
                    <AgentPanelSlot onCollapse={collapsePanel} />
                  </ErrorBoundary>
                </motion.div>
              </>
            ) : null}
          </AnimatePresence>
        ) : null}
      </div>
      {/* 底部终端坞：挂在聊天列卡片内的下缘（与 VSCode 集成终端同构——
          终端属于编辑/对话区，不占 Agent 面板的高度）。坞收放只压缩聊天
          正文的可视高度，右列面板始终占满全高。独立边界：崩了只塌坞条 */}
      <ErrorBoundary
        label="终端坞"
        fallback={(_, retry) => (
          <div className="border-border/60 text-muted-foreground flex h-24 shrink-0 flex-col items-center justify-center gap-1.5 border-t text-xs">
            终端坞出了点问题
            <Button size="sm" variant="outline" onClick={retry}>
              <RotateCcwIcon className="size-3.5" />
              重试
            </Button>
          </div>
        )}
      >
        <TerminalDockGate />
      </ErrorBoundary>
    </div>
  );

  return (
    <>
      <CloneThreadShell
        railClassName="border-r-0"
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
        searchOpen={searchOpen}
        onSearchOpenChange={setSearchOpen}
        mobileSidebarOpen={mobileSidebarOpen}
        onMobileSidebarOpenChange={setMobileSidebarOpen}
        activeMenu={activeMenu}
        onActiveMenuChange={setActiveMenu}
        onOpenSettings={openSettingsView}
        headerContent={sidebarHeaderContent}
        sheetTitle={sidebarSheetTitle}
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
            data-drag-region={isDesktop() ? "true" : undefined}
            className={cn(
              "bg-muted/40 relative flex-1 overflow-hidden ",
              !compact && panelGone && "pr-0", !sidebarCollapsed && "pl-0"
            )}
          >
            {/* 终端坞不在这层：它挂在聊天列卡片内（见 chatColumn），右列
                面板保持贯通全高——坞收放只压缩对话正文，不顶起 Agent 面板 */}
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
                // Separator 本体 0 宽，不留 gutter；拖拽命中区由库扩到
                // 16px（触屏 24px），避免压到右侧 tab / 左侧聊天内容
                resizeTargetMinimumSize={{ fine: 16, coarse: 24 }}
                className="min-h-0 flex-1 gap-0"
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
                {/* 0 宽分隔条 + 16px 库命中区：两列卡片之间没有 gutter。
                    视觉是和侧栏同款的 6px 胶囊，悬停/聚焦出现、拖动时弯曲，
                    面板收起/全屏时整体隐藏。宽度约束、开合、键盘和持久化
                    仍全部由 Base + react-resizable-panels 接管。
                    自动化页是全幅视图：库默认双击把手会展开相邻可折叠面板，
                    这里连同拖拽一起禁用，避免误触把面板带进来 */}
                <ElasticPanelHandle
                  hidden={panelGone || panelFullscreen}
                  disabled={panelFullscreen || chatMinReleased || !panelGate}
                  disableDoubleClick={
                    panelFullscreen || chatMinReleased || !panelGate
                  }
                  // 只在把手上拦停动画（面板内按钮点击不受影响，见 settle 注释）
                  onPointerDownCapture={beginPanelHandleDrag}
                  className="m-0 p-0"
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
                    // 库默认给 Panel 内层套 overflow:auto，会裁掉左侧阴影；
                    // 阴影放在这层（卡片外、冻结容器外），面板收起后关掉，
                    // 避免右缘残留一条阴影
                    className={cn(
                      // relative z-10：聊天卡片是 positioned（relative），
                      // 静态的右栏 wrapper 阴影会画在它下面。提升后柔和阴影
                      // 才能真正落到聊天内容上，不需要再叠渐变遮罩。
                      "relative z-10 min-w-0 overflow-visible!",
                      !panelGone &&
                        !panelFullscreen &&
                        !chatMinReleased &&
                        "border-l border-border/60 shadow-[-6px_0_14px_-6px_rgba(0,0,0,0.04)] dark:border-border/80 dark:shadow-[-6px_0_14px_-6px_rgba(0,0,0,0.20)]",
                    )}
                    // 拖到小于 minSize 即自动折叠 / 拖回即展开：状态沿变化时回写开合；
                    // panelGone 跟踪视觉状态（≤1px 且非展开意图），驱动按钮/控件交接
                    onResize={(size) => {
                      const collapsed = size.inPixels <= 1;
                      const nextGone = !panelShown && collapsed;
                      if (nextGone !== panelGoneRef.current) {
                        panelGoneRef.current = nextGone;
                        setPanelGone(nextGone);
                      }
                      if (collapsed === wasCollapsedRef.current) {
                        // 无收放边沿且无在途动画/待结算手势：尺寸仍在变即
                        // 用户在拖 —— 名义收起却拖到有效宽度（拦停后拖拽
                        // 复活）视为想展开，兜底防止面板卡在"开着但收不起来"。
                        // 显示闸关着时（非对话页/设置页）不能算用户表态：
                        // 闸门收放本身就是程序性布局变化，否则离开页面回到
                        // 对话会把面板凭空弹开
                        if (
                          panelResizeFallbackWantsOpen({
                            collapsed,
                            panelShown,
                            panelGate,
                            animating: panelAnimRef.current !== null,
                            interrupted: panelAnimInterruptedRef.current,
                            px: size.inPixels,
                            minWidth: PANEL_MIN_WIDTH,
                          })
                        ) {
                          applyUserPanelOpen(true);
                        }
                        return;
                      }
                      wasCollapsedRef.current = collapsed;
                      // 全屏中面板被收没（点面板顶栏收起/快捷键）：一并退出
                      // 全屏，聊天列弹回，主区不至于空掉
                      if (collapsed) exitPanelFullscreen();
                      // 只有尺寸与 panelShown 相反才算"用户表态"（拖拽/双击把
                      // 面板拉到了状态之外），才同步 panelOpen + 回写记忆；一致
                      // 的是程序落位——切会话 snap、显示闸收放、动画收尾，尺寸
                      // 只是状态在追赶。闸门关着时 panelShown 恒假，天然被这条
                      // 规则排除（旧写法靠 panelGate 挡，三态记忆下必须按尺寸
                      // 是否违背状态判定，否则切会话的收起会把目标会话写成
                      // "明确关过"，兜底再也不生效）
                      if (
                        !panelAnimRef.current &&
                        panelResizeContradictsState(collapsed, panelShown) &&
                        // 展开方向跨过 minSize 才算数（拖出 2px 的沿不算，
                        // 与上方无沿分支的"有效宽度"同一口径）
                        (collapsed || size.inPixels >= PANEL_MIN_WIDTH)
                      )
                        applyUserPanelOpen(!collapsed);
                    }}
                >
                  {panelEverOpened ? (
                    // 冻结容器：开合动画期间内容宽定格（panelFrozenPx），零
                    // 每帧重排；拖拽/静止态不冻结，内容 100% 跟手。
                    // 收起态改用 panelContentW 继续定格（目标宽）：内容不塌回
                    // 0 宽，展开时就没有"首次布局"那一下。
                    // 定格时**右锚定**：面板右缘（顶栏动作、窗口控件）钉在窗口
                    // 右缘不动，左缘随面板收放扫过内容。原先左锚定会让内容随
                    // 左缘平移、右半（含收起/全屏按钮）被裁在面板外——动画期间
                    // 那组按钮整个不可见、落位后才淡入（实报"折叠按钮显示很
                    // 奇怪"）；右锚定后它们从动画第一帧起就在位，自然被面板
                    // 边缘裁切进出，和侧边栏折叠的观感一致
                    <div className="relative h-full overflow-hidden">
                      <div
                        className={cn(
                          "h-full",
                          (panelFrozenPx !== null ||
                            (panelGone && panelContentW !== null)) &&
                            "absolute inset-y-0 right-0",
                        )}
                        style={
                          panelFrozenPx !== null
                            ? { width: panelFrozenPx }
                            : panelGone && panelContentW !== null
                              ? { width: panelContentW }
                              : undefined
                        }
                      >
                        {/* 面板崩了只塌面板：左列聊天照常可用 */}
                        <ErrorBoundary label="Agent 面板">
                          <AgentPanelSlot
                            onCollapse={exitAndCollapsePanel}
                            showWindowControls={panelDocked}
                            fullscreen={panelFullscreen}
                            contentFrozenPx={panelDragFrozenPx}
                            onToggleFullscreen={togglePanelFullscreen}
                            flush
                          />
                        </ErrorBoundary>
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
              onOpenProject={() => {
                clearLastThread();
                void aui.threads.switchToNewThread();
                setView("chat");
              }}
              onOpenSession={() => setView("chat")}
              jumpSection={settingsJump?.id}
              jumpSeq={settingsJump?.seq}
            />
          </ErrorBoundary>
        </div>
      )}
    </>
  );
};
