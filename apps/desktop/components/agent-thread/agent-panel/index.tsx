"use client";

import { useEffect, useRef, useState, type FC, type ReactNode } from "react";
import { PanelRightCloseIcon } from "lucide-react";
import {
  isPageReload,
  openPanelTab,
  usePanelTabs,
} from "@/lib/panel-tabs";
import { newTerminalTab } from "@/lib/shell";
import { isMacPlatform, isTauri } from "@/lib/tauri";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { WindowControls } from "@/components/window-controls";
import { cn } from "@/lib/utils";
import { TabBar } from "./tab-bar";
import { TAB_META, TabContentView, useVisiblePanelTabTypes } from "./tab-registry";

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
  <div className="@container flex h-full flex-col items-center justify-center gap-6 p-6">
    <div className="text-center">
      <h2 className="text-base font-semibold text-foreground">打开标签页</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        选择要在侧边面板中打开的标签。
      </p>
    </div>
    {/* 窄面板:单列一行一个;宽面板(@sm+):2/3 列宫格 */}
    <div className="mx-auto grid w-full max-w-80 grid-cols-1 gap-2 @sm:grid-cols-2 @xl:grid-cols-3">
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
 * @param showWindowControls 停靠为右列时窗口右缘即面板右缘，Windows/Linux
 *        自绘三键由面板顶栏接管（Header 同步让位，见 base.tsx panelDocked）
 */
export const AgentPanel: FC<{
  onCollapse?: () => void;
  showWindowControls?: boolean;
}> = ({ onCollapse, showWindowControls = false }) => {
  const { tabs, activeId } = usePanelTabs();
  const active = tabs.find((t) => t.id === activeId) ?? null;
  return (
    <PanelShell
      tabs={tabs}
      activeId={activeId}
      active={active}
      onCollapse={onCollapse}
      showWindowControls={showWindowControls}
    />
  );
};

/**
 * 面板壳 + 浏览器 webview 生命周期:最后一个浏览器 tab 关闭即销毁子 webview
 * （不销毁会常驻占内存,且重新打开空 tab 时残留上一页——原生层盖在 React 之上,
 * 空态覆盖层挡不住它）。tab 切换仍只隐藏,保留页面状态。
 */
const PanelShell: FC<{
  tabs: ReturnType<typeof usePanelTabs>["tabs"];
  activeId: string | null;
  active: ReturnType<typeof usePanelTabs>["tabs"][number] | null;
  onCollapse?: () => void;
  showWindowControls: boolean;
}> = ({ tabs, activeId, active, onCollapse, showWindowControls }) => {
  const browserCount = tabs.filter((t) => t.type === "browser").length;
  const prevCount = useRef(browserCount);
  useEffect(() => {
    if (prevCount.current > 0 && browserCount === 0 && isTauri()) {
      import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("browser_detach", { destroy: true }))
        .catch(() => {});
    }
    prevCount.current = browserCount;
  }, [browserCount]);

  // 启动兜底（仅首帧判定）：页面刷新不恢复浏览器 tab（panel-tabs 的 load 已
  // 过滤，browserCount=0），但上次会话的原生子 webview 不随主 webview 重载
  // 销毁，仍悬浮在旧 bounds 上——这里销毁。冷启动恢复路径 browserCount>0
  // 不触发；本无 webview 时调用幂等无害。ref 防面板重挂载后重复执行
  const bootChecked = useRef(false);
  useEffect(() => {
    if (bootChecked.current) return;
    bootChecked.current = true;
    if (browserCount > 0 || !isTauri() || !isPageReload()) return;
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("browser_detach", { destroy: true }))
      .catch(() => {});
  }, [browserCount]);

  // 面板宽度感知：收起动画/拖窄时顶栏按钮会被移动的左缘硬裁"吃掉"，
  // 宽度不足以容纳按钮（含右缘留白）就整体淡出并禁点，消失干净利落。
  // 只在布尔翻转时 setState，动画逐帧 resize 不触发重渲染
  const shellRef = useRef<HTMLDivElement>(null);
  const [barHidden, setBarHidden] = useState(false);
  useEffect(() => {
    const el = shellRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      setBarHidden((entries[0]?.contentRect.width ?? 999) < 56);
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
  // + 停靠态接管的 Windows 三键。空标签态也保留顶栏：拖拽区/收起/三键不能
  // 随标签栏一起消失
  const desktop = isTauri();
  const winControls = desktop && !isMacPlatform();
  const barActions: ReactNode =
    onCollapse || showWindowControls ? (
      <div
        className={cn(
          "flex items-center transition-opacity duration-150",
          barHidden && "pointer-events-none opacity-0",
        )}
      >
        {onCollapse ? (
          <TooltipIconButton
            variant="ghost"
            size="icon"
            tooltip="收起 Agent 面板"
            side="bottom"
            onClick={onCollapse}
            className="size-8 shrink-0"
          >
            <PanelRightCloseIcon className="size-4" />
          </TooltipIconButton>
        ) : null}
        {showWindowControls ? <WindowControls /> : null}
      </div>
    ) : null;

  return (
    // 与聊天列同款卡片：描边 + 圆角，四周边距由 base.tsx 主区 padding 留出
    <div
      ref={shellRef}
      className="bg-background border-border/60 flex h-full min-w-0 flex-col overflow-hidden rounded-xl border"
    >
      {tabs.length > 0 ? (
        <TabBar
          tabs={tabs}
          activeId={activeId}
          actions={barActions}
          flushActions={winControls && showWindowControls}
        />
      ) : (
        // 无标签时不渲染标签条:默认即"打开标签页"空态(Codex 同形),
        // 但顶栏（拖拽区 + 右缘动作）常驻
        <div
          data-tauri-drag-region={desktop ? "deep" : undefined}
          className={cn(
            "border-border/80 flex h-12 shrink-0 items-center justify-end border-b-[0.5]",
            winControls && showWindowControls ? "pr-0" : "pr-2",
          )}
        >
          {barActions}
        </div>
      )}
      <div className="min-h-0 flex-1">
        {active ? (
          // key=tab.id:切换标签即重挂载,组件内状态(浏览器历史等)标签私有
          <TabContentView key={active.id} tab={active} />
        ) : (
          <EmptyTabsScreen />
        )}
      </div>
    </div>
  );
};
