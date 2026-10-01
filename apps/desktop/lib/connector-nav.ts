"use client";

/**
 * composer「+」菜单 → 插件市场 / 设置页的跨组件跳转信号。
 * 菜单在对话壳树深处，管理页由 base.tsx 的 activeMenu 驱动、市场页内部的
 * manageOpen/manageTab 又是它自己的局部态——三层互不引用，经 window 事件握手。
 * 与 automation 的 focus 通道同一套路子。
 */

export type ManageTab = "plugins" | "skills";

const CONNECTOR_MANAGE_EVENT = "kova:open-connector-manage";

/** 打开插件市场的管理页并落到指定分段（MCP / 技能） */
export function requestConnectorManage(tab: ManageTab): void {
  window.dispatchEvent(new CustomEvent(CONNECTOR_MANAGE_EVENT, { detail: { tab } }));
}

/** 宿主（base.tsx）订阅：切主区到插件市场 */
export function subscribeConnectorManage(cb: (tab: ManageTab) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ tab?: unknown }>).detail;
    cb(detail?.tab === "skills" ? "skills" : "plugins");
  };
  window.addEventListener(CONNECTOR_MANAGE_EVENT, handler);
  return () => window.removeEventListener(CONNECTOR_MANAGE_EVENT, handler);
}

/** 设置页分区跳转（子智能体等）；id 由 settings-page 的 isSettingsSection 校验 */
export function requestSettingsSection(section: string): void {
  window.dispatchEvent(
    new CustomEvent("kova:open-settings-section", { detail: section }),
  );
}
