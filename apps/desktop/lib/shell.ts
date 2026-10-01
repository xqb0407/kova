"use client";

import { useSyncExternalStore } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { FitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal } from "@xterm/xterm";
import { isTauri } from "@/lib/tauri";
import { getWorkspace, pathBasename } from "@/lib/workspace/workspace-store";
import {
  closePanelTab,
  getAllThreadTabs,
  getPanelTabs,
  openPanelTab,
  subscribePanelTabs,
  updatePanelTab,
  type PanelTab,
} from "@/lib/panels/panel-tabs";

/**
 * 交互式真终端（PTY，Rust 侧 pty.rs）会话 store + 面板标签桥：
 * 一个终端 = 一个面板标签（与其它面板标签共用顶部标签栏，VSCode 终端
 * tab 条形态），不再有面板内的独立会话列表。
 *
 * 生命周期单一事实源 = 面板标签：任何途径关闭 shell 标签（×、中键、
 * 右键批量）都会经桥接回收对应会话（杀 PTY + dispose xterm），刷新后
 * 残留的会话/悬空绑定的 xterm 缓冲不会滞留内存。
 *
 * 会话对象（xterm 实例 + 宿主 DOM）挂模块级 store 保活：切面板标签会
 * 重挂载 ShellTab，挂载时 appendChild 宿主、卸载时摘除——隐藏时零 DOM
 * 占用、不做 0×0 fit 空转；进程与屏幕缓冲活在 store 里不受影响。
 *
 * webview 刷新后标签从 localStorage 恢复但会话随进程消失：ShellTab 据
 * sessionId 找不到会话即出"重新启动"卡片，一键重建并回绑标签。
 * 进程退出（用户 exit 等）：通道尾包即关闭所属标签——顶栏不残留死标签，
 * 会话经桥 dispose，内存不留僵尸缓冲（启动失败除外：视口要展示报错文本，
 * 由用户手动关标签）。
 * 输出流 = pty_open 的 ipc::Channel<Vec<u8>>（JSON 化为 number[]），
 * 空数组是 Rust 读线程结束时发的"壳退出"标记；dispose 后通道可能仍有
 * 尾包在途（pty_close 是异步的），以 disposed 标志拦截。
 * 配色跟随应用深浅主题：hex 常量对齐 zinc 中性色（xterm 自解析颜色，
 * 不吃 oklch CSS 变量），主题切换经 MutationObserver 实时重刷所有会话。
 */

/** 同时存活会话上限：每个 PTY 常驻数 MB（shell + 子进程 + xterm 缓冲），
 * 达到上限即拒绝新开，控制内存开销 */
const MAX_SHELL_SESSIONS = 12;

export type ShellSession = {
  id: string;
  /** 标签标题：cwd 目录名（同名自动加 ·N 去重），shell 上报 OSC 标题时跟随 */
  title: string;
  cwd: string | null;
  /** 所属面板标签 id（回写标题用） */
  tabId: string | null;
  terminal: Terminal;
  fit: FitAddon;
  /** xterm.open 的目标容器，脱离 React 树保活 */
  host: HTMLDivElement;
  opened: boolean;
  alive: boolean;
  /** closeShell 后置真：拦截 onData/通道回写与标题上报的清理窗口竞态 */
  disposed: boolean;
  lastCols: number;
  lastRows: number;
};

// xterm 自带解析器只认 hex/rgb，无法消费主题的 oklch 变量 → 手挑等价色
const SHELL_THEMES: Record<"dark" | "light", ITheme> = {
  dark: {
    background: "#18181b",
    foreground: "#e4e4e7",
    cursor: "#e4e4e7",
    cursorAccent: "#18181b",
    selectionBackground: "#3f3f46",
  },
  light: {
    background: "#ffffff",
    foreground: "#18181b",
    cursor: "#18181b",
    cursorAccent: "#ffffff",
    selectionBackground: "#d4d4d8",
    // 亮底下 ANSI 黑/白会隐身或刺眼，压成中灰；彩色 ANSI 维持默认
    black: "#52525b",
    white: "#3f3f46",
    brightBlack: "#71717a",
    brightWhite: "#3f3f46",
  },
};

const currentShellTheme = (): ITheme =>
  document.documentElement.classList.contains("dark")
    ? SHELL_THEMES.dark
    : SHELL_THEMES.light;

let list: ShellSession[] = [];
// useSyncExternalStore 快照必须引用稳定：仅在集合变化时重建
let snapshot: { list: ShellSession[] } = { list };
const listeners = new Set<() => void>();

function commit(): void {
  snapshot = { list };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useShellStore(): { list: ShellSession[] } {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}

/** 找会话（含 store 外判定）：ShellTab 按 tab.sessionId 认领 */
export function findShell(id: string | undefined): ShellSession | null {
  if (!id) return null;
  return list.find((s) => s.id === id) ?? null;
}

// 主题切换实时重刷：.dark 类挂在 <html> 上（layout.tsx/ui-prefs 维护），
// 观察同一个类，所有活会话立即换色
if (typeof document !== "undefined") {
  new MutationObserver(() => {
    const theme = currentShellTheme();
    for (const s of list) s.terminal.options.theme = theme;
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
}

// ---- 标签 ↔ 会话桥：面板标签是会话生命周期的单一事实源 ----

function syncSessionsToTabs(): void {
  // 标签按会话分桶后回收口径必须是**全部桶的并集**：只看当前会话会在
  // 切走会话时把别的会话正开着的终端杀光
  const bound = new Set<string>();
  for (const bucket of getAllThreadTabs()) {
    for (const t of bucket.tabs)
      if (t.type === "shell" && t.sessionId) bound.add(t.sessionId);
  }
  for (const s of [...list]) if (!bound.has(s.id)) closeShell(s.id);
}

let bridgeInstalled = false;
/**
 * 安装桥（幂等，仅桌面端）：订阅面板标签 store，标签集合每次变更即回收
 * 未被任何标签绑定的会话。模块级订阅不随面板组件卸载失效——紧凑模式
 * 下面板收起也不漏杀。由 newTerminalTab/ShellTab 首次触达时安装。
 */
export function ensureShellTabBridge(): void {
  if (bridgeInstalled || typeof window === "undefined" || !isTauri()) return;
  bridgeInstalled = true;
  subscribePanelTabs(syncSessionsToTabs);
  syncSessionsToTabs();
}

// ---- 创建入口 ----

/** 创建中的会话 id：xterm 动态导入是异步的，期间标签已开出，
 * ShellTab 据 pending 渲染加载态而非"已结束"卡，避免重复拉起 */
const pendingIds = new Set<string>();

export function hasPendingShell(id: string | undefined): boolean {
  return !!id && pendingIds.has(id);
}

function shellCapacityFull(): boolean {
  return list.length + pendingIds.size >= MAX_SHELL_SESSIONS;
}

/** 同目录多开去重：web、web·2、web·3…… */
function nextSessionTitle(base: string): string {
  const taken = new Set(list.map((s) => s.title));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}·${n}`)) n++;
  return `${base}·${n}`;
}

/** 底层拉起：动态导入 xterm → 建会话入 store → 开 PTY。
 * 动态导入失败会 reject（调用方负责收回标签）；pty_open 失败不 reject，
 * 会话以"已退出"形态留在标签里给出错文本，走重启。 */
async function spawnShell(id: string, tabId: string): Promise<ShellSession> {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]);
  const cwd = getWorkspace();
  const terminal = new Terminal({
    fontFamily: '"Cascadia Mono", Consolas, Menlo, "JetBrains Mono", monospace',
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 5000,
    theme: currentShellTheme(),
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  const host = document.createElement("div");
  // h-full w-full(非 absolute):随视口容器的 padding 留出边距——绝对定位子元素
  // 对齐 padding box 会无视内边距;fit 量的是本元素 clientWidth/Height,天然扣除
  host.className = "h-full w-full";
  const session: ShellSession = {
    id,
    title: nextSessionTitle((cwd ? pathBasename(cwd) : "") || "主目录"),
    cwd,
    tabId,
    terminal,
    fit,
    host,
    opened: false,
    alive: true,
    disposed: false,
    lastCols: 0,
    lastRows: 0,
  };
  list = [...list, session];
  commit();

  // 键入 → PTY（写失败=会话已回收，忽略即可）
  terminal.onData((data) => {
    if (session.disposed) return;
    void invoke("pty_write", { id, data }).catch(() => {});
  });
  // shell 经 OSC 0/2 上报的标题接管标签名（zsh/bash 提示符常带 cwd）；
  // 上报即写回面板标签，切目录时顶部标签跟着变
  terminal.onTitleChange((t) => {
    if (session.disposed || !session.alive) return;
    const next = t.trim().slice(0, 40);
    if (!next || next === session.title) return;
    session.title = next;
    commit();
    updatePanelTab(tabId, { title: next });
  });
  const channel = new Channel<number[]>();
  channel.onmessage = (bytes) => {
    if (session.disposed) return;
    if (!bytes || bytes.length === 0) {
      if (!session.alive) return;
      session.alive = false;
      commit();
      // 进程退出（如 exit / Ctrl-D）→ 直接关闭所属标签；桥随即杀壳 +
      // dispose（本通道连带失效），不留一个"死标签"占顶栏位置占内存
      if (session.tabId) closePanelTab(session.tabId);
      return;
    }
    terminal.write(Uint8Array.from(bytes));
  };
  try {
    await invoke("pty_open", {
      id,
      cwd,
      cols: terminal.cols,
      rows: terminal.rows,
      onData: channel,
    });
  } catch (e) {
    // 启动失败不自动关标签：错误文本写进视口让用户看到原因,手动关标签重试
    session.alive = false;
    terminal.write(`\r\n\x1b[31m终端启动失败: ${String(e)}\x1b[0m\r\n`);
    commit();
  }
  return session;
}

/** 标签还挂着“终端”占位标题才回写：shell 若已上报过 OSC 标题则不覆盖 */
function claimTabTitle(tabId: string, title: string): void {
  const cur = getPanelTabs().tabs.find((t) => t.id === tabId);
  if (cur && cur.title === "终端") updatePanelTab(tabId, { title });
}

/** 新开一个终端标签：标签即刻落地（视图先渲染加载态），异步拉起会话后回绑标题 */
export function newTerminalTab(): void {
  if (!isTauri() || shellCapacityFull()) return;
  ensureShellTabBridge();
  const id = crypto.randomUUID();
  pendingIds.add(id);
  const tabId = openPanelTab("shell", { sessionId: id, title: "终端" });
  void spawnShell(id, tabId)
    .then((s) => claimTabTitle(tabId, s.title))
    .catch(() => {
      // 连 xterm 都没加载起来：不留空标签（期间用户已关则此处 no-op）
      closePanelTab(tabId);
    })
    .finally(() => pendingIds.delete(id));
}

/**
 * 重启标签的会话（进程退出后重开、刷新恢复、启动失败重试）。
 * 直接把标签指向新会话 id：旧会话若还滞留在 store 里（死壳缓冲），
 * 本次 updatePanelTab 的提交即被桥回收，无需手动杀。
 */
export function restartShellTab(tab: PanelTab): void {
  if (!isTauri() || shellCapacityFull()) return;
  ensureShellTabBridge();
  const id = crypto.randomUUID();
  pendingIds.add(id);
  updatePanelTab(tab.id, { sessionId: id, title: "终端" });
  void spawnShell(id, tab.id)
    .then((s) => claimTabTitle(tab.id, s.title))
    // 拉起失败（动态导入炸了）：标签停在 sessionId 悬空态,出“重新启动”卡,吞掉即可
    .catch(() => {})
    .finally(() => pendingIds.delete(id));
}

/** 杀壳 + dispose xterm + 摘除宿主（幂等；正常由桥在标签关闭时调用） */
export function closeShell(id: string): void {
  const index = list.findIndex((s) => s.id === id);
  if (index < 0) return;
  const session = list[index];
  list = list.filter((s) => s.id !== id);
  session.disposed = true;
  session.tabId = null;
  void invoke("pty_close", { id }).catch(() => {});
  session.terminal.dispose();
  session.host.remove();
  commit();
}

/** fit 容器并同步 PTY 窗口尺寸（未 open/已退出/0×0 容器都是合法空转） */
export function fitShell(session: ShellSession): void {
  if (!session.opened || !session.alive) return;
  try {
    session.fit.fit();
  } catch {
    return; // 容器尚未完成布局
  }
  const { cols, rows } = session.terminal;
  if (cols === session.lastCols && rows === session.lastRows) return;
  session.lastCols = cols;
  session.lastRows = rows;
  void invoke("pty_resize", { id: session.id, cols, rows }).catch(() => {});
}
