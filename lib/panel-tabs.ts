"use client";

import { useSyncExternalStore } from "react";

/**
 * Agent 面板标签页 store(Codex 侧边面板同款形态):
 * 面板是一个标签容器,标签类型见 PANEL_TAB_TYPES,支持多开、关闭、切换;
 * 全部标签与激活项持久化到 localStorage,重启恢复。
 * 浏览器标签的当前 URL/标题也挂在 tab 记录上(updateTab),保证恢复后继续显示。
 */
export type PanelTabType =
  | "activity"
  | "plan"
  | "review"
  /** 真终端：PTY 交互会话（仅 Tauri 桌面端,见 tab-registry 可见性过滤） */
  | "shell"
  | "browser"
  | "git"
  /** 文件内容预览：消息 read 工具行唤起（快照），或文件树标签唤起（tab.path=磁盘实时） */
  | "file"
  /** 工作区文件树浏览（仅 Tauri 桌面端,见 tab-registry 的可见性过滤） */
  | "explorer";

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
  "file",
  "explorer",
]);

function validTab(raw: unknown): raw is PanelTab {
  const t = raw as Partial<PanelTab>;
  return (
    typeof t?.id === "string" &&
    typeof t?.type === "string" &&
    VALID_TYPES.has(t.type as PanelTabType)
  );
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
    const tabs = parsed.tabs.filter(validTab);
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

export type PanelTabExtra = Pick<
  PanelTab,
  "title" | "url" | "cwd" | "checkpoint" | "focus" | "path"
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
