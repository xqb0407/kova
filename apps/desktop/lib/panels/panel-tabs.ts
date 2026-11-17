"use client";

import { useSyncExternalStore } from "react";
import { getPiChannel } from "@/lib/pi/pi-channel";
import { clearPendingSideChatQuote } from "@/lib/side-chat/pending-quote";

/**
 * Agent 面板标签页 store(Codex 侧边面板同款形态),**按会话(线程)分桶**:
 * 每个会话拥有自己独立的一套标签与激活项——切换会话时整组切换,互不可见;
 * 「当前会话」由常驻的 Base 经 setCurrentPanelThread 登记,lib 层的
 * openPanelTab/focusPanelTab 等一律落进当前会话的桶。
 * 全部会话的桶与各自激活项持久化到 localStorage(键 agent-panel-tabs-v2,
 * 按 LRU 限量),重启恢复。浏览器标签的当前 URL/标题也挂在 tab 记录上
 * (updatePanelTab),保证恢复后继续显示。
 * 例外:页面「刷新」(reload)不恢复浏览器标签——刷新应回到干净态,残留的
 * 原生 webview 由 agent-panel 启动兜底销毁;冷启动(重启应用)仍恢复。
 * 迁移:v1(键 agent-panel-tabs,全局一套标签)直接清除不做迁移——
 * 所有会话从空面板开始。
 *
 * 跨会话生命周期口径(shell 桥回收 PTY、浏览器 webview「最后一个标签关闭
 * 才销毁」)以**全部桶的并集**为准:某会话不在前台不代表它的终端/浏览器
 * 可以被回收,只有标签真正关闭/会话被删除(purgeThreadPanelTabs)才算。
 */
export type PanelTabType =
  | "activity"
  | "plan"
  | "review"
  /** 真终端：PTY 交互会话（仅 桌面端,见 tab-registry 可见性过滤） */
  | "shell"
  | "browser"
  | "git"
  /** 会话产物汇总：当前线程 write 出的交付文件清单，随时重新打开预览 */
  | "artifacts"
  /** 文件内容预览：消息 read 工具行唤起（快照），或文件树标签唤起（tab.path=磁盘实时） */
  | "file"
  /** 图片预览：用户消息里的图片点击唤起（不进 + 菜单；data URL 不持久化） */
  | "image"
  /** 工作区文件树浏览（仅 桌面端,见 tab-registry 的可见性过滤） */
  | "explorer"
  /** 子智能体运行过程：消息里 Task 委派行唤起（不进 + 菜单,只能从行进入） */
  | "subagent"
  /** Agent 循环视图（trace_query 按迭代切）：header「更多」唤起（不进 + 菜单），sessionId 绑定 sidecar 会话 */
  | "loop"
  /** UI 插件面板：已装启用插件的面板贡献（agent open_plugin_panel 工具 / + 菜单 / 产物卡唤起） */
  | "plugin"
  /** 划词辅助会话：右侧并排一个隐藏子会话（区分/沿用父会话标签桶） */
  | "side-chat";

export type PanelTab = {
  id: string;
  type: PanelTabType;
  /** 覆盖默认标题(浏览器标签用域名) */
  title?: string;
  url?: string;
  /** 视图数据上下文：审查标签可定向到某次运行检查点（本回合改动） */
  cwd?: string;
  checkpoint?: string;
  /** 检查点的归属文件清单（结算刻定格）：审查视图只显示本轮自己的改动 */
  checkpointPaths?: string[];
  /**
   * 定位上下文（工具行点击唤起时携带）：
   * activity/file = 目标 toolCallId；review = 目标文件路径。
   * 视图侧据此展开对应卡片并滚动到位。
   */
  focus?: string;
  /** file 标签磁盘模式：workspace（tab.cwd）相对路径,实时读盘渲染（文件树点击） */
  path?: string;
  /**
   * 预览标签（VS Code 语义）：文件树单击开出的临时标签，下一次单击会原地
   * 替换它的内容；双击/右键「在新标签页中打开」转为常驻（preview 清掉）。
   * 每个会话最多一个；恢复会话时统一按常驻处理（不跨重启保留临时态）。
   */
  preview?: boolean;
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
  /** side-chat 标签：父会话 id（创建来源） */
  parentSessionId?: string;
  /** side-chat 标签：隐藏子会话 id（运行时/历史都指向它） */
  childSessionId?: string;
  /** side-chat 标签：同一父会话内的编号（标题「辅助会话 N」） */
  ordinal?: number;
  /** file 标签：打开后滚动定位到的行（知识引用「跳到行」用） */
  line?: number;
  /** file 标签：行定位的非ce（同一行重复点击也重新滚动） */
  lineNonce?: number;
};

export type PanelTabsState = { tabs: PanelTab[]; activeId: string | null };

/** 跨会话全量视图条目：shell 桥 / 浏览器 webview 生命周期等按全部桶统计 */
export type ThreadTabs = { threadId: string; tabs: PanelTab[] };

/** 持久化形状 v2：会话 id → 各自标签组；order 为 LRU（最近使用在前） */
type PersistedPanels = {
  byThread: Record<string, PanelTabsState>;
  order: string[];
};

const STORAGE_KEY = "agent-panel-tabs-v2";
const LEGACY_STORAGE_KEY = "agent-panel-tabs";
/** 持久化的会话桶上限（LRU，最近使用在前，超出截断）：防 localStorage 无界膨胀 */
const MAX_THREADS = 30;

const VALID_TYPES = new Set<PanelTabType>([
  "activity",
  "plan",
  "review",
  "shell",
  "browser",
  "git",
  "artifacts",
  "file",
  "image",
  "explorer",
  "subagent",
  "loop",
  "plugin",
  "side-chat",
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
 *  Timing——WKWebView 下 自定义协议导航的 timing type 不稳定为 "reload"。
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

// ---------------------------------------------------------------------------
// 模块级 store：分桶 + 当前会话指针
// ---------------------------------------------------------------------------

/** 稳定空态：缺失桶/未登记会话统一返回它，保证 useSyncExternalStore 快照稳定 */
const EMPTY_STATE: PanelTabsState = { tabs: [], activeId: null };

let byThread: Record<string, PanelTabsState> = {};
/** LRU 顺序（最近使用在前）；包含空桶的会话 id（空桶只影响顺序不落盘） */
let order: string[] = [];
/** 当前会话指针：Base 随 mainThreadId 登记；null 期间所有 mutator no-op */
let currentThreadId: string | null = null;
/** 跨会话全量视图缓存（commit 时重建，引用稳定） */
let allSnapshot: ThreadTabs[] = [];
let hydrated = false;
const listeners = new Set<() => void>();

function ensureHydrated(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  load();
  rebuildAllSnapshot();
}

function load(): void {
  if (typeof window === "undefined") return;
  // v1 全局标签存档按用户决策不迁移：清掉旧键，所有会话从空面板开始
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return;
    const parsed = JSON.parse(raw) as Partial<PersistedPanels>;
    if (!parsed.byThread || typeof parsed.byThread !== "object") return;
    const loaded: Record<string, PanelTabsState> = {};
    for (const [id, bucket] of Object.entries(parsed.byThread)) {
      if (!bucket || !Array.isArray(bucket.tabs)) continue;
      const tabs = (bucket.tabs as unknown[]).filter(validTab);
      // 刷新不恢复浏览器标签(见文件头注释);其余类型照常恢复。
      // preview 是会话内临时态：恢复后统一按常驻处理——不保留「下次单击
      // 就会被顶掉」的半脏状态（关掉应用时正在看的文件应稳定留在标签里）
      const restored = (
        isPageReload() ? tabs.filter((t) => t.type !== "browser") : tabs
      ).map((t) => (t.preview ? { ...t, preview: undefined } : t));
      if (restored.length === 0) continue;
      const activeId =
        typeof bucket.activeId === "string" &&
        restored.some((t) => t.id === bucket.activeId)
          ? bucket.activeId
          : (restored[0]?.id ?? null);
      loaded[id] = { tabs: restored, activeId };
    }
    byThread = loaded;
    const rawOrder = Array.isArray(parsed.order)
      ? parsed.order.filter(
          (id): id is string => typeof id === "string" && id in loaded,
        )
      : [];
    const rest = Object.keys(loaded).filter((id) => !rawOrder.includes(id));
    order = [...rawOrder, ...rest];
  } catch {
    byThread = {};
    order = [];
  }
}

/** 只持久化非空桶，按 LRU 顺序截断到上限（超出者即被驱逐） */
function persist(): void {
  if (typeof window === "undefined") return;
  try {
    const out: PersistedPanels = { byThread: {}, order: [] };
    for (const id of order) {
      const bucket = byThread[id];
      if (!bucket || bucket.tabs.length === 0) continue;
      // image 标签承载内联 data URL（单张可达数 MB），全量落盘会瞬间撑爆
      // localStorage 配额；图片预览是临时态，重启后重新点击消息图片即可
      const tabs = bucket.tabs.filter((t) => t.type !== "image");
      if (tabs.length === 0) continue;
      const activeId = tabs.some((t) => t.id === bucket.activeId)
        ? bucket.activeId
        : (tabs[0]?.id ?? null);
      out.byThread[id] = { tabs, activeId };
      out.order.push(id);
      if (out.order.length >= MAX_THREADS) break;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch {}
}

function rebuildAllSnapshot(): void {
  const next: ThreadTabs[] = [];
  for (const id of order) {
    const bucket = byThread[id];
    if (bucket && bucket.tabs.length > 0)
      next.push({ threadId: id, tabs: bucket.tabs });
  }
  allSnapshot = next;
}

function commit(): void {
  rebuildAllSnapshot();
  persist();
  for (const l of listeners) l();
}

/** LRU touch：置顶（已在顶部则不动） */
function touch(threadId: string): void {
  const i = order.indexOf(threadId);
  if (i > 0) order.splice(i, 1);
  if (i !== 0) order.unshift(threadId);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): PanelTabsState {
  ensureHydrated();
  if (!currentThreadId) return EMPTY_STATE;
  return byThread[currentThreadId] ?? EMPTY_STATE;
}

/**
 * 任意会话桶的变更通道（按属主定靶的核心）：目标桶缺失即新建——后台会话
 * 的首个标签不必等它被查看。结果与原桶引用相等则不提交（保持「无变化不
 * 通知」的既有语义）；写入会 LRU touch 属主线程（它在被使用，不该被驱逐）。
 */
function mutateThread(
  threadId: string,
  next: (state: PanelTabsState) => PanelTabsState,
): void {
  ensureHydrated();
  const prev = byThread[threadId] ?? EMPTY_STATE;
  const value = next(prev);
  if (value === prev) return;
  byThread[threadId] = value;
  touch(threadId);
  commit();
}

/**
 * 当前会话桶的变更通道：指针未登记（Base effect 尚未跑）时 no-op 防御。
 */
function mutateCurrent(next: (state: PanelTabsState) => PanelTabsState): void {
  ensureHydrated();
  if (!currentThreadId) return;
  mutateThread(currentThreadId, next);
}

// ---- 桶内原语（指针版与按属主定向版共用）----

function openTabIn(threadId: string, type: PanelTabType, extra?: PanelTabExtra): string {
  const id = `tab-${crypto.randomUUID()}`;
  mutateThread(threadId, (s) => ({
    tabs: [...s.tabs, { id, type, ...extra }],
    activeId: id,
  }));
  return id;
}

function focusTabIn(threadId: string, type: PanelTabType, extra?: PanelTabExtra): string {
  const existing = getPanelTabsFor(threadId).tabs.find((t) => t.type === type);
  if (existing) {
    mutateThread(threadId, (s) => ({
      tabs: s.tabs.map((t) => (t.id === existing.id ? { ...t, ...extra } : t)),
      activeId: existing.id,
    }));
    return existing.id;
  }
  return openTabIn(threadId, type, extra);
}

function focusPluginIn(
  threadId: string,
  pluginId: string,
  panelId: string,
  extra?: PanelTabExtra,
): string {
  const existing = getPanelTabsFor(threadId).tabs.find(
    (t) =>
      t.type === "plugin" && t.pluginId === pluginId && t.panelId === panelId,
  );
  if (existing) {
    mutateThread(threadId, (s) => ({
      tabs: s.tabs.map((t) =>
        t.id === existing.id ? { ...t, pluginId, panelId, ...extra } : t,
      ),
      activeId: existing.id,
    }));
    return existing.id;
  }
  return openTabIn(threadId, "plugin", { ...extra, pluginId, panelId });
}

/** 关闭即停（产品决策）：辅助会话标签关闭时中止后台生成——sidecar abort
 *  会让在飞轮次把 partial 结算落盘并取消该会话全部排队项，重开标签可见半截
 *  回答；待应用引用一并作废。失败静默：标签照常关闭。 */
function stopClosedSideChatTab(tab: PanelTab): void {
  if (tab.type !== "side-chat" || !tab.childSessionId) return;
  clearPendingSideChatQuote(tab.childSessionId);
  try {
    void getPiChannel()
      .abort(tab.childSessionId)
      .catch(() => {});
  } catch {
    /* 通道未就绪：无在跑轮次可停 */
  }
}

function closeTabIn(threadId: string, id: string): void {
  const victim = getPanelTabsFor(threadId).tabs.find((t) => t.id === id);
  if (victim) stopClosedSideChatTab(victim);
  mutateThread(threadId, (s) => {
    const index = s.tabs.findIndex((t) => t.id === id);
    if (index < 0) return s;
    const tabs = s.tabs.filter((t) => t.id !== id);
    let activeId = s.activeId;
    if (activeId === id) {
      const neighbor = tabs[Math.min(index, tabs.length - 1)];
      activeId = neighbor?.id ?? null;
    }
    return { tabs, activeId };
  });
}

function updateTabIn(threadId: string, id: string, patch: Partial<PanelTab>): void {
  // 目标标签不在该桶：no-op 早退——既无变更通知，也不为后台属主凭空建空桶
  if (!getPanelTabsFor(threadId).tabs.some((t) => t.id === id)) return;
  mutateThread(threadId, (s) => ({
    ...s,
    tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  }));
}

export function usePanelTabs(): PanelTabsState {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_STATE);
}

/** 非 hook 读取当前会话的标签组（触发水合）；lib 层桥接逻辑用 */
export function getPanelTabs(): PanelTabsState {
  return getSnapshot();
}

/** 非 hook 订阅标签集合变更；同样只供 lib 层桥接（如 shell 会话回收）使用 */
export function subscribePanelTabs(cb: () => void): () => void {
  return subscribe(cb);
}

// ---------------------------------------------------------------------------
// 当前会话指针
// ---------------------------------------------------------------------------

/**
 * 登记当前会话（Base 随 assistant-ui mainThreadId 调用）。切换即整组换桶：
 * usePanelTabs 的快照随之指向新会话，各 mutator 也落到新会话的桶。
 */
export function setCurrentPanelThread(threadId: string | null): void {
  ensureHydrated();
  if (currentThreadId === threadId) return;
  currentThreadId = threadId;
  if (threadId) touch(threadId);
  commit();
}

/** 全部会话桶的快照（非 hook，触发水合）；shell 桥等 lib 层用 */
export function getAllThreadTabs(): ThreadTabs[] {
  ensureHydrated();
  return allSnapshot;
}

/**
 * 按线程读取标签组（非 hook）：缺失桶返回稳定空态常量、不建桶。
 * 给按属主定靶的读取方与桶内原语复用判定用。
 */
export function getPanelTabsFor(threadId: string): PanelTabsState {
  ensureHydrated();
  return byThread[threadId] ?? EMPTY_STATE;
}

/**
 * 当前显示会话指针：agent 工具帧/后台进程在属主未知时的兜底靶，
 * 以及「属主=显示会话」的事件门控判定用。
 */
export function getCurrentPanelThreadId(): string | null {
  return currentThreadId;
}

/** 全部会话桶的快照（hook，引用稳定）；浏览器 webview 生命周期等 UI 判定用 */
export function useAllThreadTabs(): ThreadTabs[] {
  return useSyncExternalStore(subscribe, getAllSnapshot, () => allSnapshot);
}

function getAllSnapshot(): ThreadTabs[] {
  ensureHydrated();
  return allSnapshot;
}

/**
 * 会话获得稳定 id 时的桶迁移：本会话内新建的线程在发送首条消息前是
 * `__LOCALID_` 草稿 id，initialize 绑定 sessionId 后由 usePiRuntime 调用
 * 这里把桶（含当前指针）搬到 sessionId 键下——刷新/重启后线程行 id 就是
 * sessionId，桶才接得上。from 桶缺失即只清理指针；to 已有桶（理论不该
 * 发生）以 to 为准。
 */
export function rekeyPanelThread(from: string, to: string): void {
  ensureHydrated();
  if (from === to) return;
  if (byThread[from] && !byThread[to]) byThread[to] = byThread[from]!;
  delete byThread[from];
  const i = order.indexOf(from);
  if (i >= 0) {
    order.splice(i, 1);
    if (!order.includes(to)) order.splice(i, 0, to);
  }
  if (currentThreadId === from) currentThreadId = to;
  commit();
}

/**
 * 会话被删除时清掉它的桶并广播：shell 桥随即回收该会话绑定的 PTY，
 * 浏览器计数重估（归零则销毁 webview）。与删除它的 UI 入口无关——
 * 统一挂在 usePiRuntime 的线程删除漏斗上。
 */
export function purgeThreadPanelTabs(threadId: string): void {
  ensureHydrated();
  if (!(threadId in byThread) && !order.includes(threadId)) return;
  delete byThread[threadId];
  order = order.filter((id) => id !== threadId);
  commit();
}

// ---------------------------------------------------------------------------
// 标签操作：指针版作用于当前显示的会话桶；按属主定靶的 For 版见本节末尾
// ---------------------------------------------------------------------------

export type PanelTabExtra = Pick<
  PanelTab,
  | "title"
  | "url"
  | "cwd"
  | "checkpoint"
  | "checkpointPaths"
  | "focus"
  | "path"
  | "line"
  | "lineNonce"
  | "sessionId"
  | "delegationId"
  | "pluginId"
  | "panelId"
  | "preview"
>;

/** 打开一个新标签并激活(所有类型均可多开)；extra 携带视图数据上下文 */
export function openPanelTab(
  type: PanelTabType,
  extra?: PanelTabExtra,
): string {
  ensureHydrated();
  // 指针未登记：保持旧 no-op 语义——返回 id 但不落任何桶
  if (!currentThreadId) return `tab-${crypto.randomUUID()}`;
  return openTabIn(currentThreadId, type, extra);
}

/** 激活指定标签（不改动标签集合）；供「同文件已开则聚焦」类精确复用 */
export function activatePanelTab(id: string): void {
  mutateCurrent((s) =>
    s.activeId === id || !s.tabs.some((t) => t.id === id)
      ? s
      : { tabs: s.tabs, activeId: id },
  );
}

/**
 * 定位式打开：当前会话已存在同类型标签则复用第一个（改写 extra 并激活），
 * 否则新开。工具行点击走这里，避免每点一行就堆一个标签。
 */
export function focusPanelTab(type: PanelTabType, extra?: PanelTabExtra): string {
  ensureHydrated();
  if (!currentThreadId) return `tab-${crypto.randomUUID()}`;
  return focusTabIn(currentThreadId, type, extra);
}

/**
 * 面板标签的定位式打开：按 (pluginId, panelId) 复合键在当前会话内复用
 * （同一插件的不同面板各自多开，同面板复写 extra 并激活），否则新开。
 * agent 的 open_plugin_panel、+ 菜单、产物卡"在画布中打开"统一走这里。
 */
export function focusPluginPanel(
  pluginId: string,
  panelId: string,
  extra?: PanelTabExtra,
): string {
  ensureHydrated();
  if (!currentThreadId) return `tab-${crypto.randomUUID()}`;
  return focusPluginIn(currentThreadId, pluginId, panelId, extra);
}

/**
 * 打开文件标签：同 (cwd, path) 已有标签则聚焦（并更新行号），否则新开——
 * 面板标签允许同类型多开（不同文件并存），不能走 focusPanelTab 的按类型复用
 * 第一个，否则每点一个文件都把同一个标签覆盖掉。文件树标签与文件预览右栏共用。
 */
export function openOrFocusFileTab(
  cwd: string,
  rel: string,
  name: string,
  line?: number,
): void {
  const existing = getPanelTabs().tabs.find(
    (t) => t.type === "file" && t.cwd === cwd && t.path === rel,
  );
  if (existing) {
    const lineNonce = line ? Date.now() : existing.lineNonce;
    mutateCurrent((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === existing.id
          ? { ...t, ...(line ? { line, lineNonce } : {}) }
          : t,
      ),
      activeId: existing.id,
    }));
    return;
  }
  openPanelTab("file", {
    cwd,
    path: rel,
    title: name,
    focus: undefined,
    line,
    ...(line ? { lineNonce: Date.now() } : {}),
  });
}

/**
 * 预览式打开文件（文件树**单击**，VS Code 语义）：同文件已开则直接激活；
 * 否则复用当前会话里唯一的 preview 标签**原地替换**内容（不再每点一个文件
 * 就多一个标签）；没有 preview 标签时新开一个。双击/右键「在新标签页中打开」
 * 会转成常驻（见 pinFileTab / openOrFocusFileTab）。
 */
export function previewFileTab(cwd: string, rel: string, name: string): void {
  ensureHydrated();
  if (!currentThreadId) return;
  const state = getSnapshot();
  const same = state.tabs.find(
    (t) => t.type === "file" && t.cwd === cwd && t.path === rel,
  );
  if (same) {
    if (state.activeId !== same.id) {
      mutateCurrent((s) => ({ tabs: s.tabs, activeId: same.id }));
    }
    return;
  }
  const preview = state.tabs.find(
    (t) => t.type === "file" && t.preview === true,
  );
  if (preview) {
    mutateCurrent((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === preview.id
          ? {
              ...t,
              cwd,
              path: rel,
              title: name,
              // 定位上下文属于上一个文件：一并清掉，避免审查/行定位串味
              focus: undefined,
              line: undefined,
              lineNonce: undefined,
            }
          : t,
      ),
      activeId: preview.id,
    }));
    return;
  }
  openTabIn(currentThreadId, "file", {
    cwd,
    path: rel,
    title: name,
    focus: undefined,
    preview: true,
  });
}

/**
 * 把文件标签转为常驻（文件树**双击** /「在新标签页中打开」）：
 * 已开则去 preview 标记并激活；未开则新开常驻标签（等价 openOrFocusFileTab）。
 */
export function pinFileTab(cwd: string, rel: string, name: string): void {
  ensureHydrated();
  if (!currentThreadId) return;
  const existing = getPanelTabs().tabs.find(
    (t) => t.type === "file" && t.cwd === cwd && t.path === rel,
  );
  if (!existing) {
    openOrFocusFileTab(cwd, rel, name);
    return;
  }
  if (!existing.preview) {
    if (getSnapshot().activeId !== existing.id) activatePanelTab(existing.id);
    return;
  }
  mutateCurrent((s) => ({
    tabs: s.tabs.map((t) =>
      t.id === existing.id ? { ...t, preview: undefined } : t,
    ),
    activeId: existing.id,
  }));
}

/**
 * 打开划词辅助会话标签：同一子会话已开则只激活；否则按父会话内最小空闲序号
 * 新开（标题「辅助会话 N」）。父会话切换时标签桶自动隔离，由现有分桶机制兜住。
 */
export function openSideChatTab(input: {
  parentSessionId: string;
  childSessionId: string;
}): string | null {
  ensureHydrated();
  if (!currentThreadId) return null;
  const threadId = currentThreadId;
  const tabs = getPanelTabsFor(threadId).tabs;
  const existing = tabs.find(
    (t) => t.type === "side-chat" && t.childSessionId === input.childSessionId,
  );
  if (existing) {
    mutateThread(threadId, (s) => ({ tabs: s.tabs, activeId: existing.id }));
    return existing.id;
  }
  const used = new Set(
    tabs.flatMap((t) =>
      t.type === "side-chat" && t.parentSessionId === input.parentSessionId
        ? [t.ordinal ?? 0]
        : [],
    ),
  );
  let ordinal = 1;
  while (used.has(ordinal)) ordinal += 1;
  const id = `tab-${crypto.randomUUID()}`;
  mutateThread(threadId, (s) => ({
    tabs: [
      ...s.tabs,
      {
        id,
        type: "side-chat" as const,
        parentSessionId: input.parentSessionId,
        childSessionId: input.childSessionId,
        ordinal,
      },
    ],
    activeId: id,
  }));
  return id;
}

/** 关闭标签:激活项被关时就近切到相邻标签 */
export function closePanelTab(id: string): void {
  ensureHydrated();
  if (!currentThreadId) return;
  closeTabIn(currentThreadId, id);
}

/** 批量关闭的公共收尾:激活项幸存则不动,被关则切到 fallback */
function pruneTabs(
  keep: (tab: PanelTab, index: number) => boolean,
  fallback: string | null,
): void {
  for (const tab of getPanelTabs().tabs) {
    // 快照上先算被移除集合：关闭即停对批量关闭（全部/其他/左右）同样生效
    const index = getPanelTabs().tabs.indexOf(tab);
    if (!keep(tab, index)) stopClosedSideChatTab(tab);
  }
  mutateCurrent((s) => {
    const tabs = s.tabs.filter(keep);
    const activeId = tabs.some((t) => t.id === s.activeId)
      ? s.activeId
      : fallback;
    return { tabs, activeId };
  });
}

/** 关闭全部标签(IDEA「关闭所有选项」):当前会话的面板回到空态 */
export function closeAllPanelTabs(): void {
  for (const tab of getPanelTabs().tabs) stopClosedSideChatTab(tab);
  mutateCurrent(() => ({ tabs: [], activeId: null }));
}

/** 关闭其他标签(只保留 id),目标顺带激活 */
export function closeOtherPanelTabs(id: string): void {
  for (const tab of getPanelTabs().tabs) {
    if (tab.id !== id) stopClosedSideChatTab(tab);
  }
  mutateCurrent((s) => {
    const tab = s.tabs.find((t) => t.id === id);
    if (!tab) return s;
    return { tabs: [tab], activeId: id };
  });
}

/** 关闭右侧标签:目标幸存时激活项不变,否则回落目标 */
export function closePanelTabsToRight(id: string): void {
  ensureHydrated();
  const index = getSnapshot().tabs.findIndex((t) => t.id === id);
  if (index < 0) return;
  pruneTabs((_, i) => i <= index, id);
}

/** 关闭左侧标签:同 closePanelTabsToRight 的镜像 */
export function closePanelTabsToLeft(id: string): void {
  ensureHydrated();
  const index = getSnapshot().tabs.findIndex((t) => t.id === id);
  if (index < 0) return;
  pruneTabs((_, i) => i >= index, id);
}

export function setActivePanelTab(id: string): void {
  mutateCurrent((s) =>
    s.activeId === id || !s.tabs.some((t) => t.id === id)
      ? s
      : { ...s, activeId: id },
  );
}

/** 局部更新标签(浏览器标签写回 url/标题) */
export function updatePanelTab(id: string, patch: Partial<PanelTab>): void {
  ensureHydrated();
  if (!currentThreadId) return;
  updateTabIn(currentThreadId, id, patch);
}

// ---------------------------------------------------------------------------
// 按属主线程定靶的标签操作
//
// 给「可能发生在非显示会话」的写入方用：agent 工具帧（pi-client-base 按帧
// 的 sessionId 归属）、后台终端进程退出/标题回写（shell 记录 ownerThread）。
// 与指针版语义相同，只是靶是传入的属主桶；桶缺失即新建。
// ---------------------------------------------------------------------------

/** 属主版 openPanelTab */
export function openPanelTabFor(
  threadId: string,
  type: PanelTabType,
  extra?: PanelTabExtra,
): string {
  return openTabIn(threadId, type, extra);
}

/** 属主版 focusPanelTab */
export function focusPanelTabFor(
  threadId: string,
  type: PanelTabType,
  extra?: PanelTabExtra,
): string {
  return focusTabIn(threadId, type, extra);
}

/** 属主版 focusPluginPanel */
export function focusPluginPanelFor(
  threadId: string,
  pluginId: string,
  panelId: string,
  extra?: PanelTabExtra,
): string {
  return focusPluginIn(threadId, pluginId, panelId, extra);
}

/** 属主版 closePanelTab */
export function closePanelTabFor(threadId: string, id: string): void {
  closeTabIn(threadId, id);
}

/** 属主版 updatePanelTab */
export function updatePanelTabFor(
  threadId: string,
  id: string,
  patch: Partial<PanelTab>,
): void {
  updateTabIn(threadId, id, patch);
}
