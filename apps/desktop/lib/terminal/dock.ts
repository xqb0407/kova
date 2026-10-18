"use client";

import { useSyncExternalStore } from "react";
import { isDesktop } from "@/lib/desktop-env";
import {
  ensureShellTabBridge,
  isShellCapacityFull,
  registerShellDock,
  spawnShellSession,
  sweepUnboundShells,
} from "@/lib/shell";

/**
 * 底部终端坞（VSCode 集成终端形态）：聊天列卡片底缘一条可拖高的横条，
 * 内含标签栏（标签胶囊 + ×、右缘「+ / 菜单」动作）与 xterm 视口。
 * 它属于对话区而不是整幅主区：收放只压缩聊天正文的高度，右列的 Agent
 * 面板始终贯通全高（实报："panel 不要被顶上去"）。
 *
 * 与右侧面板终端同源：会话池、拉起、回收都在 lib/shell.ts（一个终端 =
 * 一个标签），坞只是第二个入口面——标签集合、开合与高度由本模块持有
 * 并持久化到 localStorage。
 *
 * 生命周期口径：
 * - 收起坞 ≠ 关标签：VSCode 同款，隐藏后 PTY 照常活着（桥按标签判定
 *   存活，标签还在就不会被回收），再次唤起原样接回；
 * - 关掉最后一个标签 → 坞一并收起（没有内容的横条不该占着主区高度）；
 * - 刷新/冷启动后标签从 localStorage 恢复但会话随 webview 消失：视口出
 *   "重新启动"卡（与面板 terminal 标签一致），不静默重建——重建要选
 *   cwd，而启动期 workspace 可能还没同步到位，凭空拉起的壳会落在主目录。
 */

export type DockTab = {
  id: string;
  /** 绑定的终端会话 id（lib/shell.ts）；悬空 = 会话已随刷新消失 */
  sessionId: string | null;
  /** 标签名：cwd 目录名起底，shell 上报 OSC 标题后跟随（切目录即变） */
  title: string;
};

type DockState = {
  open: boolean;
  /** 坞高（px）：主区高度的百分比上限由视图侧钳制 */
  height: number;
  tabs: DockTab[];
  activeId: string | null;
};

/** 默认坞高：约 12 行终端（xterm 13px × 1.15），够看一屏命令输出 */
export const DOCK_DEFAULT_HEIGHT = 260;
/** 下限：抓手 8 + 标签栏 36 + 视口两行左右（再矮就看不到内容了） */
export const DOCK_MIN_HEIGHT = 96;
/** 持久化侧的上限兜底：真正的高度上限由视图按主区实高钳（留出聊天列
 *  头部）；这里只防坏档/异常值把窗口撑爆 */
const DOCK_MAX_HEIGHT = 2400;

/** 坞内标签上限：与面板共用 12 个 PTY 的池，坞自己再收一道口 */
const MAX_DOCK_TABS = 5;

const STORAGE_KEY = "terminal-dock-v1";

const DEFAULT_STATE: DockState = {
  open: false,
  height: DOCK_DEFAULT_HEIGHT,
  tabs: [],
  activeId: null,
};

let state: DockState = DEFAULT_STATE;
let hydrated = false;
const listeners = new Set<() => void>();

const clampHeight = (px: number): number =>
  Math.min(DOCK_MAX_HEIGHT, Math.max(DOCK_MIN_HEIGHT, Math.round(px)));

function load(): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<DockState>;
    const tabs = Array.isArray(parsed.tabs)
      ? parsed.tabs
          .filter(
            (t): t is DockTab =>
              !!t && typeof t.id === "string" && typeof t.title === "string",
          )
          .slice(0, MAX_DOCK_TABS)
          .map((t) => ({
            id: t.id,
            title: t.title,
            sessionId: typeof t.sessionId === "string" ? t.sessionId : null,
          }))
      : [];
    state = {
      open: parsed.open === true && tabs.length > 0,
      height:
        typeof parsed.height === "number" && Number.isFinite(parsed.height)
          ? clampHeight(parsed.height)
          : DOCK_DEFAULT_HEIGHT,
      tabs,
      activeId:
        typeof parsed.activeId === "string" &&
        tabs.some((t) => t.id === parsed.activeId)
          ? parsed.activeId
          : (tabs[0]?.id ?? null),
    };
  } catch {
    // 存档损坏：回落默认（空坞、收起）
  }
}

function ensureHydrated(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  load();
}

function persist(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage 不可用：仅本次会话生效
  }
}

/** 拖拽中高度每帧都在变：落盘节流到停手后一次写（逐帧同步写会卡主线程） */
let persistTimer: number | null = null;
function persistSoon(): void {
  if (typeof window === "undefined") return;
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    persist();
  }, 200);
}

function emit(): void {
  for (const l of listeners) l();
}

function commit(): void {
  if (persistTimer !== null) {
    window.clearTimeout(persistTimer);
    persistTimer = null;
  }
  persist();
  emit();
  // 坞标签集合是会话存活判定的来源之一：变更即回收失去绑定的会话
  sweepUnboundShells();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useTerminalDock(): DockState {
  // 快照 getter 里补水合（与 panel-tabs 同款）：坞常驻挂载、首帧走
  // getServerSnapshot（SSR/水合一致用默认空态），订阅后 React 再读一次
  // 客户端快照——那次必须已经是 load() 之后的状态，否则"上次开着坞"
  // 会被永久渲染成关闭，直到下一次 store 变更才补上
  return useSyncExternalStore(
    subscribe,
    () => {
      ensureHydrated();
      return state;
    },
    () => DEFAULT_STATE,
  );
}

/**
 * 只订阅开合位（原始值快照）：开关按钮挂在 Header / 面板顶栏两处，
 * 拖拽改高时高度每帧都在变——它们不该跟着逐帧重渲染，只有开/合翻转才更新。
 */
export function useTerminalDockOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => {
      ensureHydrated();
      return state.open;
    },
    () => DEFAULT_STATE.open,
  );
}

/** 非 hook 读取（快捷键/外部入口判定用） */
export function getTerminalDock(): DockState {
  ensureHydrated();
  return state;
}

// ---- 开合 ----

export function setTerminalDockOpen(open: boolean): void {
  ensureHydrated();
  // 空坞展开即给一个终端（VSCode 同款：面板不会空着站在那）；拉起失败
  // （非桌面/达会话上限）就不摆空横条——保持收起，点了没反应好过一条
  // 没有任何内容的横条。有标签则原样接回（PTY 一直活着，视口重挂即可）
  if (open && state.tabs.length === 0) {
    newDockTerminal();
    return;
  }
  if (state.open === open) return;
  state = { ...state, open };
  commit();
}

export function toggleTerminalDock(): void {
  setTerminalDockOpen(!getTerminalDock().open);
}

export function closeTerminalDock(): void {
  setTerminalDockOpen(false);
}

/** 拖拽调高（调用方已按容器钳制；这里只做持久化边界的兜底）。
 * 拖拽中每帧都会进来：只重渲染 + 节流落盘，不做标签回收扫描 */
export function setTerminalDockHeight(px: number): void {
  ensureHydrated();
  const height = clampHeight(px);
  if (state.height === height) return;
  state = { ...state, height };
  emit();
  persistSoon();
}

// ---- 标签 ----

export function setActiveDockTab(id: string): void {
  ensureHydrated();
  if (state.activeId === id || !state.tabs.some((t) => t.id === id)) return;
  state = { ...state, activeId: id };
  commit();
}

function updateDockTab(id: string, patch: Partial<DockTab>): void {
  ensureHydrated();
  if (!state.tabs.some((t) => t.id === id)) return;
  state = {
    ...state,
    tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  };
  commit();
}

/**
 * 新开一个坞内终端：标签即刻落地（视口先渲染加载态），异步拉起会话后
 * 回绑标题。返回标签 id；非桌面端/已达上限（坞限额或会话池上限）返回 null。
 */
export function newDockTerminal(): string | null {
  ensureHydrated();
  if (!isDesktop() || isShellCapacityFull()) return null;
  if (state.tabs.length >= MAX_DOCK_TABS) return null;
  ensureShellTabBridge();
  const tabId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  state = {
    open: true,
    height: state.height,
    tabs: [...state.tabs, { id: tabId, sessionId, title: "终端" }],
    activeId: tabId,
  };
  commit();
  void spawnShellSession(sessionId, tabId, "dock")
    .then((s) => claimDockTitle(tabId, s.title))
    .catch(() => {
      // 连 xterm 都没加载起来：不留空标签（期间用户已关则 no-op）
      removeDockTab(tabId);
    });
  return tabId;
}

/** 标签还挂着「终端」占位标题才回写：shell 若已上报过 OSC 标题则不覆盖 */
function claimDockTitle(tabId: string, title: string): void {
  if (state.tabs.find((t) => t.id === tabId)?.title === "终端")
    updateDockTab(tabId, { title });
}

/** 重启标签的会话（刷新后悬空、进程退出后重开、启动失败重试） */
export function restartDockTerminal(tabId: string): void {
  ensureHydrated();
  if (!isDesktop() || isShellCapacityFull()) return;
  if (!state.tabs.some((t) => t.id === tabId)) return;
  ensureShellTabBridge();
  const sessionId = crypto.randomUUID();
  updateDockTab(tabId, { sessionId, title: "终端" });
  void spawnShellSession(sessionId, tabId, "dock")
    .then((s) => claimDockTitle(tabId, s.title))
    // 拉起失败（动态导入炸了）：标签停在悬空态，出"重新启动"卡，吞掉即可
    .catch(() => {});
}

/**
 * 关闭坞标签：标签落地即从集合移除，绑定的会话由回收桥（commit 内触发）
 * 杀壳 + dispose。关掉最后一个标签时坞一并收起——没有内容的横条不该
 * 继续占着主区高度。
 */
export function closeDockTab(id: string): void {
  removeDockTab(id);
}

function removeDockTab(id: string): void {
  ensureHydrated();
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index < 0) return;
  const tabs = state.tabs.filter((t) => t.id !== id);
  const neighbor = tabs[Math.min(index, tabs.length - 1)];
  state = {
    open: tabs.length > 0 && state.open,
    height: state.height,
    tabs,
    activeId: state.activeId === id ? (neighbor?.id ?? null) : state.activeId,
  };
  commit();
}

/** 关闭全部标签（坞一并收起）；菜单入口 */
export function closeAllDockTabs(): void {
  ensureHydrated();
  if (state.tabs.length === 0) {
    setTerminalDockOpen(false);
    return;
  }
  state = { ...state, open: false, tabs: [], activeId: null };
  commit();
}

// 坞模块求值即登记：shell 侧按 surface 分发标题回写/退出关标签，
// 并把坞内标签的会话 id 并入"存活判定"并集（见 lib/shell.ts 桥注释）
registerShellDock({
  boundSessionIds: () => {
    const ids: string[] = [];
    for (const t of state.tabs) if (t.sessionId) ids.push(t.sessionId);
    return ids;
  },
  setTitle: (tabId, title) => updateDockTab(tabId, { title }),
  closeTab: (tabId) => removeDockTab(tabId),
});