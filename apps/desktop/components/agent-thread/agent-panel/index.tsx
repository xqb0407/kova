"use client";

import { memo, useEffect, useRef, useState, type FC, type ReactNode } from "react";
import { RenderProbe } from "@/components/debug/render-probe";
import {
  Maximize2Icon,
  Minimize2Icon,
  PanelRightCloseIcon,
} from "lucide-react";
import {
  getCurrentPanelThreadId,
  openPanelTab,
  usePanelTabs,
} from "@/lib/panels/panel-tabs";
import { newTerminalTab } from "@/lib/shell";
import { isDesktop } from "@/lib/desktop-env";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { NewTabMenu, TabBar } from "./tab-bar";
import { PanelStarfield } from "./empty-starfield";
import { TAB_META, TabContentView, tabTitle, useVisiblePanelTabTypes } from "./tab-registry";
import { BrowserView } from "./browser-view";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { PanelIcon } from "@/components/icons/panel-icons";

/**
 * Codex 桌面端风格的右侧 Agent 面板:一个可拖宽、可折叠的标签容器。
 * 标签类型(活动/计划/审查/文件树/终端/浏览器/Git)见 tab-registry,全部支持多开
 * (终端一个标签=一个会话,会话列表并入顶部标签栏);
 * 无标签时展示"打开标签页"卡片网格空态(此时不渲染标签栏)。
 * 标签集合与激活项持久化;宽度/折叠由 base.tsx 管(收起走 Header 开关)。
 */

/** 空态:居中卡片网格,点击即开对应标签(对齐 Codex 的"打开标签页")。
 *  面板宽度是容器尺寸而非视口尺寸，media query 感知不到收窄——用容器查询：
 *  窄(<@sm)一行一个(单列列表)，宽面板(@sm+)收拢为 2/3 列九宫格 */
const EmptyTabsScreen: FC = () => {
  const types = useVisiblePanelTabTypes();
  return (
  <div className="@container relative isolate flex h-full flex-col items-center justify-center gap-6 overflow-hidden p-6">
    {/* 背景星点网格：随鼠标视差 + 光标处亮起（装饰层，不参与命中） */}
    <PanelStarfield />
    <div className="relative z-10 text-center">
      <h2 className="text-base font-semibold text-foreground">打开标签页</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        选择要在侧边面板中打开的标签。
      </p>
    </div>
    {/* 窄面板:单列一行一个;宽面板(@sm+):2/3 列宫格 */}
    <div className="relative z-10 mx-auto grid w-full max-w-80 grid-cols-1 gap-2 @sm:grid-cols-2 @xl:grid-cols-3">
      {types.map((type) => {
        const meta = TAB_META[type];
        const Icon = meta.icon;
        // 单列(窄面板):图标在左、文字随右的行式布局;宫格(@sm+):上下堆叠
        return (
          <button
            key={type}
            type="button"
            title={meta.description}
            // shell 新标签即新会话(带上限),其余类型直接新开
            onClick={() =>
              type === "shell" ? newTerminalTab() : openPanelTab(type)
            }
            className="bg-muted/40 hover:bg-muted hover:border-border/80 flex h-12 w-full flex-row items-center justify-start gap-3 rounded-xl border border-transparent px-4 text-sm text-foreground/90 transition-colors @sm:h-20 @sm:flex-col @sm:justify-center @sm:gap-2 @sm:px-0"
          >
            <Icon className="size-4 text-muted-foreground" />
            <span>{meta.label}</span>
          </button>
        );
      })}
    </div>
  </div>
  );
};

/**
 * @param onCollapse 顶栏「收起面板」入口；省略则不渲染（面板不再需要自收起时）
 *        渲染窗口控件占位，与 Header 的常驻浮层同槽对齐（浮层仍由
 *        Header 的实例绘制，本实例只留占位）
 * @param fullscreen 面板全屏中（聊天列已收起，面板平铺主区；状态由 base.tsx 持有）
 * @param onToggleFullscreen 切换全屏；省略则不渲染按钮（窄屏浮层无全屏概念）
 * @param contentFrozenPx 把手拖拽中内容区的冻结宽度（px；null = 跟手）。
 *        只冻内容区、不冻卡片与标签栏：面板外框实时跟手，xterm/webview/diff
 *        等重排大户在拖拽期间零 relayout，松手一次落位。
 */
const AgentPanelImpl: FC<{
  onCollapse?: () => void;
  fullscreen?: boolean;
  contentFrozenPx?: number | null;
  onToggleFullscreen?: () => void;
  /** 宽屏右列：与聊天卡片贴边，去掉左描边并用左侧阴影分隔 */
  flush?: boolean;
}> = ({
  onCollapse,
  fullscreen = false,
  contentFrozenPx = null,
  onToggleFullscreen,
  flush = false,
}) => {
  const { tabs, activeId } = usePanelTabs();
  const active = tabs.find((t) => t.id === activeId) ?? null;

  return (
    // 渲染耗时自检（仅开发构建）：与消息流各挂一个 label，见 render-probe.tsx
    <RenderProbe label="右侧面板">
    <PanelShell
      tabs={tabs}
      activeId={activeId}
      active={active}
      onCollapse={onCollapse}
      fullscreen={fullscreen}
      contentFrozenPx={contentFrozenPx}
      onToggleFullscreen={onToggleFullscreen}
      flush={flush}
    />
    </RenderProbe>
  );
};

/**
 * memo：Base 的任何状态翻转（侧边栏开合、动画冻结位等）不再牵连面板子树
 * （终端/浏览器/文件树）重渲染；标签与会话状态经内部 store 订阅照常更新，
 * fullscreen 等 prop 变化时照常重渲染。
 */
export const AgentPanel = memo(AgentPanelImpl);

/**
 * 面板壳 + 浏览器 webview 生命周期:最后一个浏览器 tab 关闭即销毁子 webview
 * （不销毁会常驻占内存,且重新打开空 tab 时残留上一页——原生层盖在 React 之上,
 * 空态覆盖层挡不住它）。tab 切换仍只隐藏,保留页面状态。
 * 生命周期判定用**全部会话桶的并集**：标签按会话分桶后,只看当前会话会在
 * 切走会话时把别的会话正开着的 webview 误销毁。
 */
const PanelShell: FC<{
  tabs: ReturnType<typeof usePanelTabs>["tabs"];
  activeId: string | null;
  active: ReturnType<typeof usePanelTabs>["tabs"][number] | null;
  onCollapse?: () => void;
  fullscreen?: boolean;
  contentFrozenPx?: number | null;
  onToggleFullscreen?: () => void;
  flush?: boolean;
}> = ({
  tabs,
  activeId,
  active,
  onCollapse,
  fullscreen = false,
  contentFrozenPx = null,
  onToggleFullscreen,
  flush = false,
}) => {
  const t = useT();
  // 浏览器面板已迁 `<webview>`：guest 随元素走，切标签/关标签/页面刷新都由
  // DOM 生命周期接管，旧的「browser_detach {destroy}」兜底（防原生子视图
  // 悬浮残留）整段退役。
  // 面板宽度感知：收起动画/拖窄时顶栏按钮会被移动的左缘硬裁"吃掉"，
  // 宽度不足以容纳按钮（含右缘留白）就整体淡出并禁点，消失干净利落。
  // 只在布尔翻转时 setState，动画逐帧 resize 不触发重渲染
  const shellRef = useRef<HTMLDivElement>(null);
  const [barHidden, setBarHidden] = useState(false);
  const barHiddenRef = useRef(false);
  useEffect(() => {
    const el = shellRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      // 拖拽调宽时 shell 每帧都在变：只在布尔翻转时 setState，
      // 避免逐帧调用把面板子树白白重渲染一遍
      const next = (entries[0]?.contentRect.width ?? 999) < 56;
      if (next === barHiddenRef.current) return;
      barHiddenRef.current = next;
      setBarHidden(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // shell 标签关闭【会】回收会话：lib/shell.ts 的标签桥订阅 panel-tabs,
  // 任何途径关掉 shell 标签(×/中键/右键批量)都杀掉绑定的 PTY + dispose
  // xterm——不留孤儿进程占内存;会话本体(缓冲/宿主元素)活在 store,标签
  // 只是入口。页面刷新后标签从 localStorage 恢复但会话已随 webview 消失,
  // ShellTab 检测到 sessionId 悬空即出"重新启动"卡片重建

  // 顶栏右缘动作：收起按钮（TRAE 式，面板展开时收起入口从 Header 移到这里）
  // + 停靠态窗口控件占位（浮层由 Header 常驻实例绘制，这里只留同槽 100px）。
  // 空标签态也保留顶栏：拖拽区/收起/占位不能随标签栏一起消失
  const desktop = isDesktop();
  // 顶栏动作不做位移动画：内容在开合动画期间右锚定（见 base.tsx 冻结容器），
  // 这组按钮钉在面板右缘、随面板左缘扫过被自然裁切进出；只在面板窄到放不下
  // 时（barHidden）整体淡出。不再按落位信号延迟淡入——那样动画期间整组按钮
  // 都是隐形的，收起按钮会"凭空冒出来"（实报观感奇怪）
  const barActions: ReactNode =
    onCollapse || onToggleFullscreen ? (
      <div
        className={cn(
          "flex items-center gap-0.5 transition-opacity duration-150",
          barHidden && "pointer-events-none opacity-0",
        )}
      >
        {/* 终端开关不在这里：它始终贴在聊天列右上角（面板展开后即两列
            分割线旁，见 agent-thread/header），不随面板顶栏走。
            顺序固定为 [全屏] [收起]：收起入口统一钉在最右上角（所有面板
            顶栏状态同此顺序），不随窗口控件占位挪位 */}
        {onToggleFullscreen ? (
          <TooltipIconButton
            variant="ghost"
            size="icon"
            tooltip={
              t(
                fullscreen
                  ? "chat.agentPanel.exitFullscreen"
                  : "chat.agentPanel.fullscreen",
              )
            }
            side="bottom"
            aria-pressed={fullscreen}
            onClick={onToggleFullscreen}
            className={cn(
              "size-7 shrink-0",
              fullscreen && "bg-muted text-foreground",
            )}
          >
            {fullscreen ? (
              <Minimize2Icon className="size-4" />
            ) : (
              <Maximize2Icon className="size-4" />
            )}
          </TooltipIconButton>
        ) : null}
        {onCollapse ? (
          <TooltipIconButton
            variant="ghost"
            size="icon"
            tooltip={t("chat.agentPanel.collapse")}
            side="bottom"
            onClick={onCollapse}
            className="size-7 shrink-0 md:hidden"
          >
            <PanelIcon className="size-4" />
          </TooltipIconButton>
        ) : null}
      </div>
    ) : null;

  // 常驻浏览器 pane：活动标签是浏览器就用它；否则沿用**本会话**标签列表里的
  // 首个浏览器 tab（`<webview>` guest 只有留在 DOM 里才保留页面，切标签不重载
  // 靠这层）。**不跨会话回退**：以前为了保住"后台会话也能驱动浏览器"退到过
  // 其他会话的浏览器标签，结果是别的会话开的浏览器会出现在本会话面板里
  //（2026-10 用户实测）。会话隔离优先——本会话没有浏览器标签就不挂 pane，
  // 后台会话的 browser_* 工具按"面板没开"报错（用户切到该会话即恢复）。
  const browserPaneTab =
    active?.type === "browser"
      ? active
      : (tabs.find((t) => t.type === "browser") ?? null);
  // 浏览器 pane 按会话重挂载：同一个 <webview> 跨会话复用会把上一会话的页面
  // 直接交给新会话（还允许新会话的 agent 继续驱动它）。销毁重建后，切回来
  // 会按标签里持久化的 URL 重新加载，但绝不再共享页面与 guest 属主。
  const panelThreadId = getCurrentPanelThreadId();

  return (
    // 宽屏 flush：左缘贴住聊天卡片（0 宽分隔条），去掉左描边和左侧圆角，
    // 用左侧阴影做分隔；窄屏浮层仍保留完整卡片描边 + 圆角
    <div
      ref={shellRef}
      className={cn(
        "bg-background flex h-full min-w-0 flex-col overflow-hidden",
        flush
          ? "rounded-r-lg border-y border-r border-border/60"
          : "rounded-lg border border-border/60",
      )}
    >
      {tabs.length > 0 ? (
        <TabBar tabs={tabs} activeId={activeId} actions={barActions} />
      ) : (
        // 无标签时不渲染标签条:默认即"打开标签页"空态(Codex 同形),
        // 但顶栏（拖拽区 + "+"新标签菜单 + 右缘动作）常驻——
        // 零标签也能直接开标签/插件面板,不必先靠下方卡片网格
        <div
          data-drag-region={desktop ? "deep" : undefined}
          className="flex h-12 shrink-0 items-center justify-end gap-1.5 pr-3"
        >
          <div
            className={cn(
              "flex items-center transition-opacity duration-150",
              barHidden && "pointer-events-none opacity-0",
            )}
          >
            <NewTabMenu />
          </div>
          {barActions ? (
            <span aria-hidden className="bg-border/70 h-4 w-px shrink-0" />
          ) : null}
          {barActions}
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* 拖拽期间内容区宽定格在起始像素（contentFrozenPx）：外框与标签栏
            照常跟手，xterm/webview/diff 等内容在拖拽中零重排；松手后 base
            清空冻结值，内容一次落位 */}
        <div
          className="relative h-full min-w-0"
          style={
            contentFrozenPx !== null ? { width: contentFrozenPx } : undefined
          }
        >
          {/* 活动标签非浏览器：照常渲染该标签内容（key=tab.id 重挂载，组件内
              状态标签私有；边界接管同一个 key——某个标签崩了只坏那一个） */}
          {active && active.type !== "browser" ? (
            <ErrorBoundary key={active.id} label={`面板标签「${tabTitle(active)}」`}>
              <TabContentView tab={active} />
            </ErrorBoundary>
          ) : null}
          {/* 常驻浏览器 pane：非活动时绝对覆盖 + visibility 隐藏（不销毁元素，
              guest 页面状态得以保留；切回即原样显示，无需重新加载） */}
          {browserPaneTab ? (
            <div
              className={cn(
                "h-full",
                // 非活动态：绝对覆盖 + **pointer-events-none**——包装层本身是
                // 透明的可命中元素，只藏内层（invisible）不够，整块会用默认
                // pointer-events 吃掉上层标签内容区的全部点击（启动恢复浏览器
                // 标签后点不动面板里的按钮，就是这个坑）
                active?.type !== "browser" &&
                  "pointer-events-none absolute inset-0",
              )}
            >
              <ErrorBoundary label="浏览器面板">
                <BrowserView
                  key={panelThreadId ?? "no-thread"}
                  tab={browserPaneTab}
                  hidden={active?.type !== "browser"}
                  ownerThreadId={panelThreadId}
                />
              </ErrorBoundary>
            </div>
          ) : null}
          {!active ? <EmptyTabsScreen /> : null}
        </div>
      </div>
    </div>
  );
};
