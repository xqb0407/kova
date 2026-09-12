"use client";

import { useEffect, useRef, type FC } from "react";
import { openPanelTab, usePanelTabs } from "@/lib/panel-tabs";
import { isTauri } from "@/lib/tauri";
import { TabBar } from "./tab-bar";
import { TAB_META, TabContentView, useVisiblePanelTabTypes } from "./tab-registry";

/**
 * Codex 桌面端风格的右侧 Agent 面板:一个可拖宽、可折叠的标签容器。
 * 标签类型(活动/计划/审查/终端/浏览器)见 tab-registry,支持多开;
 * 无标签时展示"打开标签页"卡片网格空态(此时不渲染标签栏)。
 * 标签集合与激活项持久化;宽度/折叠由 base.tsx 管(收起走 Header 开关)。
 */

/** 空态:居中卡片网格,点击即开对应标签(对齐 Codex 的"打开标签页") */
const EmptyTabsScreen: FC = () => {
  const types = useVisiblePanelTabTypes();
  return (
  <div className="flex h-full flex-col items-center justify-center gap-6 p-6">
    <div className="text-center">
      <h2 className="text-base font-semibold text-foreground">打开标签页</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        选择要在侧边面板中打开的标签。
      </p>
    </div>
    <div className="grid w-full max-w-80 grid-cols-2 gap-2 sm:grid-cols-3">
      {types.map((type) => {
        const meta = TAB_META[type];
        const Icon = meta.icon;
        return (
          <button
            key={type}
            type="button"
            title={meta.description}
            onClick={() => openPanelTab(type)}
            className="bg-muted/40 hover:bg-muted hover:border-border/80 flex h-20 flex-col items-center justify-center gap-2 rounded-xl border border-transparent text-sm text-foreground/90 transition-colors"
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

export const AgentPanel: FC = () => {
  const { tabs, activeId } = usePanelTabs();
  const active = tabs.find((t) => t.id === activeId) ?? null;
  return <PanelShell tabs={tabs} activeId={activeId} active={active} />;
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
}> = ({ tabs, activeId, active }) => {
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

  return (
    <div className="bg-background/70 flex h-full min-w-0 flex-col">
      {/* 无标签时不渲染标签栏:默认即"打开标签页"空态(Codex 同形) */}
      {tabs.length > 0 ? <TabBar tabs={tabs} activeId={activeId} /> : null}
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
