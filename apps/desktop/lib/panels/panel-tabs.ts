"use client";

import { useSyncExternalStore } from "react";

/**
 * Agent 面板标签页 store(Codex 侧边面板同款形态):
 * 面板是一个标签容器,标签类型见 PANEL_TAB_TYPES,支持多开、关闭、切换;
 * 全部标签与激活项持久化到 localStorage,重启恢复。
 * 浏览器标签的当前 URL/标题也挂在 tab 记录上(updateTab),保证恢复后继续显示。
 * 例外:页面「刷新」(reload)不恢复浏览器标签——刷新应回到干净态,残留的
 * 原生 webview 由 agent-panel 启动兜底销毁;冷启动(重启应用)仍恢复。
 */
export type PanelTabType =
  | "activity"
  | "plan"
  | "review"
  /** 真终端：PTY 交互会话（仅 Tauri 桌面端,见 tab-registry 可见性过滤） */
  | "shell"
  | "browser"
  | "git"
  /** 会话产物汇总：当前线程 write 出的交付文件清单，随时重新打开预览 */
  | "artifacts"
  /** 文件内容预览：消息 read 工具行唤起（快照），或文件树标签唤起（tab.path=磁盘实时） */
  | "file"
  /** 工作区文件树浏览（仅 Tauri 桌面端,见 tab-registry 的可见性过滤） */
  | "explorer"
  /** 子智能体运行过程：消息里 Task 委派行唤起（不进 + 菜单,只能从行进入） */
  | "subagent"
  /** Agent 调用轨迹（trace_query）：header「更多」唤起（不进 + 菜单），sessionId 绑定 sidecar 会话 */
  | "trace"
  /** UI 插件面板：已装启用插件的面板贡献（agent open_plugin_panel 工具 / + 菜单 / 产物卡唤起） */
  | "plugin";

export type PanelTab = {
  id: string;
  type: PanelTabType;
  /** 覆盖默认标题(浏览器标签用域名) */
  title?: string;
  url?: string;
  /** 视图数据上下文：审查标签可定向到某次运行检查点（本回合改动） */
  cwd?: string;
  checkpoint?: string;
  /**
   * 定位上下文（工具行点击唤起时携带）：
   * activity/file = 目标 toolCallId；review = 目标文件路径。
   * 视图侧据此展开对应卡片并滚动到位。
   */
  focus?: string;
  /** file 标签磁盘模式：workspace（tab.cwd）相对路径,实时读盘渲染（文件树点击） */
  path?: string;
  /**
   * shell 标签绑定的终端会话 id（lib/shell.ts）。标签是会话生命周期的
   * 单一事实源：关标签即回收会话，刷新后 id 悬空则视图提示重启。
   */
  sessionId?: string;
  /** subagent 标签绑定的委派 id（lib/subagent-runs store 的键） */
  delegationId?: string;
  /** plugin 标签：面板所属插件 id（`<name>@<mktId>`），与 panelId 组成复合定位键 */
  pluginId?: string;
  /** plugin 标签：面板声明 id（panels.json 里的 id）；path = 绑定的 workspace 相对文档 */
  panelId?: string;
};

export type PanelTabsState = { tabs: PanelTab[]; activeId: string | null };

const STORAGE_KEY = "agent-panel-tabs";

const VALID_TYPES = new Set<PanelTabType>([
  "activity",
  "plan",
  "review",
  "shell",
  "browser",
  "git",
  "artifacts",
  "file",
  "explorer",
  "subagent",
  "trace",
  "plugin",
]);

function validTab(raw: unknown): raw is PanelTab {
  const t = raw as Partial<PanelTab>;
  return (
    typeof t?.id === "string" &&
    typeof t?.type === "string" &&
    VALID_TYPES.has(t.type as PanelTabType)
  );
}

/** 本次页面加载是否为「刷新」(reload)而非冷启动/首次进入。
 *  sessionStorage 哨兵在模块求值时判定：同一 webview 会话内 reload 会保留
 *  sessionStorage，冷启动/重启应用则是全新会话。不用 PerformanceNavigation
 *  Timing——WKWebView 下 tauri 自定义协议导航的 timing type 不稳定为 "reload"。
 *  sessionStorage 不可用（隐私模式等）时按非刷新处理（保守回退原设计） */
const RELOAD_FLAG = "agent-panel-reloaded";
const pageReloaded: boolean = (() => {
  try {
    const hit = sessionStorage.getItem(RELOAD_FLAG) === "1";
    sessionStorage.setItem(RELOAD_FLAG, "1");
    return hit;
  } catch {
    return false;
  }
})();

export function isPageReload(): boolean {
  return pageReloaded;
}

/** 首次使用(无存档)不预开标签:面板以"打开标签页"空态呈现(Codex 同形) */
function defaultState(): PanelTabsState {
  return { tabs: [], activeId: null };
}

function load(): PanelTabsState {
  if (typeof window === "undefined") return { tabs: [], activeId: null };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return defaultState();
    const parsed = JSON.parse(raw) as Partial<PanelTabsState>;
    if (!Array.isArray(parsed.tabs)) return defaultState();
    const restored = parsed.tabs.filter(validTab);
    // 刷新不恢复浏览器标签(见文件头注释);其余类型照常恢复
    const tabs = isPageReload()
      ? restored.filter((t) => t.type !== "browser")
      : restored;
    const activeId =
      typeof parsed.activeId === "string" &&
      tabs.some((t) => t.id === parsed.activeId)
        ? parsed.activeId
        : (tabs[0]?.id ?? null);
    return { tabs, activeId };
  } catch {
    return defaultState();
  }
}

let state: PanelTabsState = { tabs: [], activeId: null };
let hydrated = false;
const listeners = new Set<() => void>();

function ensureHydrated(): void {
  if (hydrated || typeof window === "undefined") return;
  state = load();
  hydrated = true;
}

function commit(next: PanelTabsState): void {
  state = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {}
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): PanelTabsState {
  ensureHydrated();
  return state;
}

export function usePanelTabs(): PanelTabsState {
  return useSyncExternalStore(subscribe, getSnapshot, () => state);
}

/** 非 hook 读取当前标签集合（触发水合）；lib 层桥接逻辑用 */
export function getPanelTabs(): PanelTabsState {
  return getSnapshot();
}

/** 非 hook 订阅标签集合变更；同样只供 lib 层桥接（如 shell 会话回收）使用 */
export function subscribePanelTabs(cb: () => void): () => void {
  return subscribe(cb);
}

export type PanelTabExtra = Pick<
  PanelTab,
  | "title"
  | "url"
  | "cwd"
  | "checkpoint"
  | "focus"
  | "path"
  | "sessionId"
  | "delegationId"
  | "pluginId"
  | "panelId"
>;

/** 打开一个新标签并激活(所有类型均可多开)；extra 携带视图数据上下文 */
export function openPanelTab(
  type: PanelTabType,
  extra?: PanelTabExtra,
): string {
  ensureHydrated();
  const id = `tab-${crypto.randomUUID()}`;
  commit({
    tabs: [...state.tabs, { id, type, ...extra }],
    activeId: id,
  });
  return id;
}

/**
 * 定位式打开：已存在同类型标签则复用第一个（改写 extra 并激活），
 * 否则新开。工具行点击走这里，避免每点一行就堆一个标签。
 */
export function focusPanelTab(type: PanelTabType, extra?: PanelTabExtra): string {
  ensureHydrated();
  const existing = state.tabs.find((t) => t.type === type);
  if (existing) {
    commit({
      tabs: state.tabs.map((t) =>
        t.id === existing.id ? { ...t, ...extra } : t,
      ),
      activeId: existing.id,
    });
    return existing.id;
  }
  return openPanelTab(type, extra);
}

/**
 * 面板标签的定位式打开：按 (pluginId, panelId) 复合键复用（同一插件的
 * 不同面板各自多开，同面板复写 extra 并激活），否则新开。
 * agent 的 open_plugin_panel、+ 菜单、产物卡"在画布中打开"统一走这里。
 */
export function focusPluginPanel(
  pluginId: string,
  panelId: string,
  extra?: PanelTabExtra,
): string {
  ensureHydrated();
  const existing = state.tabs.find(
    (t) =>
      t.type === "plugin" && t.pluginId === pluginId && t.panelId === panelId,
  );
  if (existing) {
    commit({
      tabs: state.tabs.map((t) =>
        t.id === existing.id ? { ...t, pluginId, panelId, ...extra } : t,
      ),
      activeId: existing.id,
    });
    return existing.id;
  }
  return openPanelTab("plugin", { ...extra, pluginId, panelId });
}

/** 关闭标签:激活项被关时就近切到相邻标签 */
export function closePanelTab(id: string): void {
  ensureHydrated();
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index < 0) return;
  const tabs = state.tabs.filter((t) => t.id !== id);
  let activeId = state.activeId;
  if (activeId === id) {
    const neighbor = tabs[Math.min(index, tabs.length - 1)];
    activeId = neighbor?.id ?? null;
  }
  commit({ tabs, activeId });
}

/** 批量关闭的公共收尾:激活项幸存则不动,被关则切到 fallback */
function pruneTabs(
  keep: (tab: PanelTab, index: number) => boolean,
  fallback: string | null,
): void {
  const tabs = state.tabs.filter(keep);
  const activeId = tabs.some((t) => t.id === state.activeId)
    ? state.activeId
    : fallback;
  commit({ tabs, activeId });
}

/** 关闭全部标签(IDEA「关闭所有选项」):面板回到空态 */
export function closeAllPanelTabs(): void {
  ensureHydrated();
  commit({ tabs: [], activeId: null });
}

/** 关闭其他标签(只保留 id),目标顺带激活 */
export function closeOtherPanelTabs(id: string): void {
  ensureHydrated();
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  commit({ tabs: [tab], activeId: id });
}

/** 关闭右侧标签:目标幸存时激活项不变,否则回落目标 */
export function closePanelTabsToRight(id: string): void {
  ensureHydrated();
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index < 0) return;
  pruneTabs((_, i) => i <= index, id);
}

/** 关闭左侧标签:同 closePanelTabsToRight 的镜像 */
export function closePanelTabsToLeft(id: string): void {
  ensureHydrated();
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index < 0) return;
  pruneTabs((_, i) => i >= index, id);
}

export function setActivePanelTab(id: string): void {
  ensureHydrated();
  if (state.activeId === id || !state.tabs.some((t) => t.id === id)) return;
  commit({ ...state, activeId: id });
}

/** 局部更新标签(浏览器标签写回 url/标题) */
export function updatePanelTab(id: string, patch: Partial<PanelTab>): void {
  ensureHydrated();
  const tabs = state.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t));
  commit({ tabs, activeId: state.activeId });
}
