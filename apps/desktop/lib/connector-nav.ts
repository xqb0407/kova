"use client";

/**
 * composer「+」菜单 → 插件/专家/技能页 / 设置页的跨组件跳转信号。
 * 菜单在对话壳树深处，管理页由 base.tsx 的 activeMenu 驱动、市场页内部的
 * section/view/manageTab 又是它自己的局部态——三层互不引用，经 window 事件握手。
 * 与 automation 的 focus 通道同一套路子。
 */

export type ManageTab = "subagents" | "plugins" | "skills";

const CONNECTOR_MANAGE_EVENT = "kova:open-connector-manage";

/** 打开插件/专家/技能页的管理页并落到指定分段（子智能体 / 插件 / 技能） */
export function requestConnectorManage(tab: ManageTab): void {
  window.dispatchEvent(new CustomEvent(CONNECTOR_MANAGE_EVENT, { detail: { tab } }));
}

/** 宿主（base.tsx）订阅：切主区到插件/专家/技能页 */
export function subscribeConnectorManage(cb: (tab: ManageTab) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ tab?: unknown }>).detail;
    cb(detail?.tab === "skills" || detail?.tab === "subagents" ? detail.tab : "plugins");
  };
  window.addEventListener(CONNECTOR_MANAGE_EVENT, handler);
  return () => window.removeEventListener(CONNECTOR_MANAGE_EVENT, handler);
}

/** 设置页分区跳转；id 由 settings-page 的 isSettingsSection 校验 */
export function requestSettingsSection(section: string): void {
  window.dispatchEvent(
    new CustomEvent("kova:open-settings-section", { detail: section }),
  );
}
