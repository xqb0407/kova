"use client";

import { useSyncExternalStore } from "react";
import { Channel, invoke } from "@/desktop-bridge/core";
import type { FitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal } from "@xterm/xterm";
import { isDesktop } from "@/lib/desktop-env";
import { getUiPrefs, subscribeUiPrefs } from "@/lib/settings/ui-prefs";
import { resolveFonts } from "@/lib/theme/palette";
import { getWorkspace, pathBasename } from "@/lib/workspace/workspace-store";
import {
  ensureRemoteProjectsLoaded,
  findRemoteProjectByPath,
} from "@/lib/workspace/remote-projects";
import {
  closePanelTabFor,
  getAllThreadTabs,
  getPanelTabsFor,
  openPanelTab,
  subscribePanelTabs,
  updatePanelTab,
  updatePanelTabFor,
  type PanelTab,
} from "@/lib/panels/panel-tabs";

/**
 * 交互式真终端（PTY，Rust 侧 pty.rs）会话 store + 标签桥：
 * 一个终端 = 一个标签（VSCode 终端 tab 条形态），不再有面板内的独立
 * 会话列表。标签有两个**入口面**（surface）：
 * - "panel"：右侧 Agent 面板标签（与其它面板标签共用顶部标签栏）；
 * - "dock"：底部终端坞（终端按钮唤起的整幅横条，见 lib/terminal/dock）。
 * 两个面的会话同源同池（同一份 list、同一个上限），只是标签宿主不同：
 * 标题回写/进程退出关标签按 surface 分流（面板面走面板桶，坞面走坞
 * store），会话存活判定取两个面标签 id 的**并集**。
 *
 * 生命周期单一事实源 = 标签：任何途径关闭 shell 标签（×、中键、右键
 * 批量、坞内关标签）都会经桥接回收对应会话（杀 PTY + dispose xterm），
 * 刷新后残留的会话/悬空绑定的 xterm 缓冲不会滞留内存。
 *
 * 会话对象（xterm 实例 + 宿主 DOM）挂模块级 store 保活：切标签/收面板/
 * 收起底部坞会重挂载视图，挂载时 appendChild 宿主、卸载时摘除——隐藏时
 * 零 DOM 占用、不做 0×0 fit 空转；进程与屏幕缓冲活在 store 里不受影响。
 *
 * webview 刷新后标签从 localStorage 恢复但会话随进程消失：视图据
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

/** 终端标签的入口面：右侧面板标签 / 底部终端坞（见文件头注释） */
export type ShellSurface = "panel" | "dock";

export type ShellSession = {
  id: string;
  /** 标签标题：cwd 目录名（同名自动加 ·N 去重），shell 上报 OSC 标题时跟随 */
  title: string;
  cwd: string | null;
  /** 所属标签 id（回写标题、进程退出关标签用），靶面由 surface 决定 */
  tabId: string | null;
  /** 标签所在入口面：标题回写与退出关标签按此分流 */
  surface: ShellSurface;
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

/**
 * 底部终端坞（lib/terminal/dock.ts）登记的回调：坞面会话的标签生命周期
 * 由坞 store 持有，shell 侧按 surface 分发而不反向 import 坞模块（避免
 * 循环依赖——坞模块要 import 本模块的拉起/展示原语）。坞模块求值时登记
 * （模块级、幂等）。
 */
export type ShellDockHooks = {
  /** 坞内全部标签绑定的会话 id：桥回收判定的并集来源之一 */
  boundSessionIds(): Iterable<string>;
  /** OSC 标题上报回写坞标签 */
  setTitle(tabId: string, title: string): void;
  /** 进程退出（或会话回收）关闭坞标签 */
  closeTab(tabId: string): void;
};

let dockHooks: ShellDockHooks | null = null;

export function registerShellDock(hooks: ShellDockHooks): void {
  dockHooks = hooks;
}

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

/** 终端字体跟随外观设置：代码字体 + 代码字号（终端略大 1px 保持可读） */
function terminalFont(): { fontFamily: string; fontSize: number } {
  const prefs = getUiPrefs();
  const { codeStack } = resolveFonts(prefs);
  return {
    fontFamily: codeStack,
    fontSize: Math.min(24, Math.max(12, prefs.codeFontSize + 1)),
  };
}

// 字体变化时更新存活终端（xterm 会自己重排）；模块加载即订阅，无需视图参与
{
  let applied = "";
  subscribeUiPrefs(() => {
    const font = terminalFont();
    const key = `${font.fontFamily}|${font.fontSize}`;
    if (key === applied) return;
    applied = key;
    for (const session of list) {
      if (session.disposed) continue;
      session.terminal.options.fontFamily = font.fontFamily;
      session.terminal.options.fontSize = font.fontSize;
      fitShell(session);
    }
  });
}

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

// ---- 标签 ↔ 会话桥：标签（两个入口面）是会话生命周期的单一事实源 ----

/**
 * 回收未被任何标签绑定的会话（幂等；面板标签 store 变更、坞标签变更时都调）。
 * 绑定口径必须是**两个面的并集**：面板标签按会话分桶，回收只看当前会话会
 * 把别的会话正开着的终端杀光（全部桶的并集兜住）；坞标签是全局一套，
 * 由坞模块登记的回调提供 id 集合。
 */
export function sweepUnboundShells(): void {
  const bound = new Set<string>();
  for (const bucket of getAllThreadTabs()) {
    for (const t of bucket.tabs)
      if (t.type === "shell" && t.sessionId) bound.add(t.sessionId);
  }
  if (dockHooks) for (const id of dockHooks.boundSessionIds()) bound.add(id);
  for (const s of [...list]) if (!bound.has(s.id)) closeShell(s.id);
}

/**
 * 由标签全局唯一 uuid 反查所属会话桶：进程退出关闭、OSC 标题回写一律按
 * 属主落桶，后台会话的回写不得污染用户正在看的桶。比在会话上记录打开时
 * 指针更稳——草稿期开的终端经历 rekey（桶键 __LOCALID_→sessionId）后，
 * 反查依然跟着标签走。标签不在任何桶（已被用户关闭/会话已删）返回 null，
 * 调用方静默跳过。
 */
function tabOwnerThread(tabId: string): string | null {
  return (
    getAllThreadTabs().find((b) => b.tabs.some((t) => t.id === tabId))
      ?.threadId ?? null
  );
}

let bridgeInstalled = false;
/**
 * 安装桥（幂等，仅桌面端）：订阅面板标签 store，标签集合每次变更即回收
 * 未被任何标签绑定的会话。模块级订阅不随面板组件卸载失效——紧凑模式
 * 下面板收起也不漏杀。由 newTerminalTab/ShellTab 首次触达时安装。
 * （坞面标签变更由坞模块自己调 sweepUnboundShells——两边都是标签变更即
 * 回收，入口面不同而已。）
 */
export function ensureShellTabBridge(): void {
  if (bridgeInstalled || typeof window === "undefined" || !isDesktop()) return;
  bridgeInstalled = true;
  subscribePanelTabs(sweepUnboundShells);
  sweepUnboundShells();
}

// ---- 创建入口 ----

/** 创建中的会话 id：xterm 动态导入是异步的，期间标签已开出，
 * 视图据 pending 渲染加载态而非"已结束"卡，避免重复拉起 */
const pendingIds = new Set<string>();

export function hasPendingShell(id: string | undefined): boolean {
  return !!id && pendingIds.has(id);
}

/** 存活会话数是否已达上限（面板与坞共用同一池）：调用方据此拒绝新开标签 */
export function isShellCapacityFull(): boolean {
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
async function spawnShell(
  id: string,
  tabId: string,
  surface: ShellSurface,
): Promise<ShellSession> {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]);
  const cwd = getWorkspace();
  const font = terminalFont();
  const terminal = new Terminal({
    fontFamily: font.fontFamily,
    fontSize: font.fontSize,
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
    surface,
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
  // 上报即写回所属标签，切目录时顶部标签跟着变。靶面按 surface 分流：
  // 面板面按标签反查属主桶（后台会话的回写不污染当前显示的桶），坞面
  // 是全局一套标签，直接交出坞模块。
  terminal.onTitleChange((t) => {
    if (session.disposed || !session.alive) return;
    const next = t.trim().slice(0, 40);
    if (!next || next === session.title) return;
    session.title = next;
    commit();
    if (surface === "dock") {
      dockHooks?.setTitle(tabId, next);
      return;
    }
    const owner = tabOwnerThread(tabId);
    if (owner) updatePanelTabFor(owner, tabId, { title: next });
  });
  // 远程项目：本地 cwd 是远端路径，pty 会在本地 spawn 失败（Windows 上
  // 直接 error 268）——改开 SSH 交互会话，cwd 不再下传
  await ensureRemoteProjectsLoaded();
  const remoteProject = cwd ? findRemoteProjectByPath(cwd) : null;
  const channel = new Channel<number[]>();
  channel.onmessage = (bytes) => {
    if (session.disposed) return;
    if (!bytes || bytes.length === 0) {
      if (!session.alive) return;
      session.alive = false;
      commit();
      // 进程退出（如 exit / Ctrl-D）→ 直接关闭所属标签；桥随即杀壳 +
      // dispose（本通道连带失效），不留一个"死标签"占顶栏位置占内存。
      // 靶面按 surface 分流：面板面按属主桶关闭（后台会话的进程退出不得
      // 关掉显示会话里的标签），坞面直接交出坞模块。
      if (session.tabId) {
        if (session.surface === "dock") dockHooks?.closeTab(session.tabId);
        else {
          const owner = tabOwnerThread(session.tabId);
          if (owner) closePanelTabFor(owner, session.tabId);
        }
      }
      return;
    }
    terminal.write(Uint8Array.from(bytes));
  };
  try {
    await invoke("pty_open", {
      id,
      cwd: remoteProject ? null : cwd,
      remoteHostId: remoteProject?.hostId,
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

/**
 * 拉起会话并登记 pending（面板面/坞面共用入口）：拖过异步窗口的标签视图
 * 据 pending 出加载态；拉起失败由调用方收标签。
 * 拉起完成后补一次回收：异步期间标签可能已被用户关掉（面板 ×/坞关标签），
 * 而那时会话还没进 store、桥扫不到它——补扫一次即杀，不留孤儿 PTY。
 */
export async function spawnShellSession(
  id: string,
  tabId: string,
  surface: ShellSurface,
): Promise<ShellSession> {
  pendingIds.add(id);
  try {
    return await spawnShell(id, tabId, surface);
  } finally {
    pendingIds.delete(id);
    sweepUnboundShells();
  }
}

/** 标签还挂着“终端”占位标题才回写：shell 若已上报过 OSC 标题则不覆盖。
 * 异步拉起完成时用户可能已切走会话——回写按属主桶定靶，不碰显示会话 */
function claimTabTitle(tabId: string, title: string): void {
  const owner = tabOwnerThread(tabId);
  if (!owner) return;
  const cur = getPanelTabsFor(owner).tabs.find((t) => t.id === tabId);
  if (cur && cur.title === "终端") updatePanelTabFor(owner, tabId, { title });
}

/** 新开一个终端标签：标签即刻落地（视图先渲染加载态），异步拉起会话后回绑标题 */
export function newTerminalTab(): void {
  if (!isDesktop() || isShellCapacityFull()) return;
  ensureShellTabBridge();
  const id = crypto.randomUUID();
  const tabId = openPanelTab("shell", { sessionId: id, title: "终端" });
  void spawnShellSession(id, tabId, "panel")
    .then((s) => claimTabTitle(tabId, s.title))
    .catch(() => {
      // 连 xterm 都没加载起来：不留空标签（期间用户已关则反查落空 no-op）
      const owner = tabOwnerThread(tabId);
      if (owner) closePanelTabFor(owner, tabId);
    });
}

/**
 * 重启标签的会话（进程退出后重开、刷新恢复、启动失败重试）。
 * 直接把标签指向新会话 id：旧会话若还滞留在 store 里（死壳缓冲），
 * 本次 updatePanelTab 的提交即被桥回收，无需手动杀。
 */
export function restartShellTab(tab: PanelTab): void {
  if (!isDesktop() || isShellCapacityFull()) return;
  ensureShellTabBridge();
  const id = crypto.randomUUID();
  updatePanelTab(tab.id, { sessionId: id, title: "终端" });
  void spawnShellSession(id, tab.id, "panel")
    .then((s) => claimTabTitle(tab.id, s.title))
    // 拉起失败（动态导入炸了）：标签停在 sessionId 悬空态,出“重新启动”卡,吞掉即可
    .catch(() => {});
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
  // 0 尺寸容器（坞收起的隐藏态、面板开合动画的裁剪帧）不做 fit：fit 会
  // 算出 1×1 并打一次 pty_resize，把壳的终端尺寸打乱，展开后又得抖回来
  if (session.host.clientWidth === 0 || session.host.clientHeight === 0) return;
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
