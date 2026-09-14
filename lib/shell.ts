"use client";

import { useSyncExternalStore } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { FitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal } from "@xterm/xterm";
import { isTauri } from "@/lib/tauri";
import { getWorkspace, pathBasename } from "@/lib/workspace-store";

/**
 * 交互式真终端（PTY，Rust 侧 pty.rs）会话集合 store——VSCode 集成终端形态：
 * 一个"终端"面板标签内多会话，底部列表切换；关面板标签不杀会话（同 VSCode
 * 隐藏面板），杀会话只有列表项 × / 垃圾桶。webview 刷新后 channel 失效，
 * Rust 侧读线程自动杀壳回收，所以刷新即"全部重开"，不留孤儿。
 * 会话对象（xterm 实例 + 宿主 DOM）挂模块级 store：面板切标签会重挂载
 * 组件，进程、缓冲与元素都活在 store 里，视图只是搬运 appendChild。
 * 输出流 = pty_open 的 ipc::Channel<Vec<u8>>（JSON 化为 number[]），
 * 空数组是 Rust 读线程结束时发的"壳退出"标记。
 * 配色跟随应用深浅主题：hex 常量对齐 zinc 中性色（xterm 自解析颜色，
 * 不吃 oklch CSS 变量），主题切换经 MutationObserver 实时重刷所有会话。
 */

export type ShellSession = {
  id: string;
  /** 底部列表标题：cwd 目录名 */
  title: string;
  cwd: string | null;
  terminal: Terminal;
  fit: FitAddon;
  /** xterm.open 的目标容器，脱离 React 树保活 */
  host: HTMLDivElement;
  opened: boolean;
  alive: boolean;
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
let activeId: string | null = null;
// useSyncExternalStore 快照必须引用稳定：仅在集合/激活项变化时重建
let snapshot: { list: ShellSession[]; activeId: string | null } = {
  list,
  activeId,
};
const listeners = new Set<() => void>();

function commit(): void {
  snapshot = { list, activeId };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useShellStore(): { list: ShellSession[]; activeId: string | null } {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
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

export async function createShell(): Promise<void> {
  if (!isTauri()) return;
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]);
  const id = crypto.randomUUID();
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
  host.className = "h-full w-full";
  const session: ShellSession = {
    id,
    title: (cwd ? pathBasename(cwd) : "") || "主目录",
    cwd,
    terminal,
    fit,
    host,
    opened: false,
    alive: true,
    lastCols: 0,
    lastRows: 0,
  };
  list = [...list, session];
  activeId = id; // 新终端即当前终端

  // 键入 → PTY（写失败=会话已回收，忽略即可）
  terminal.onData((data) => {
    void invoke("pty_write", { id, data }).catch(() => {});
  });
  const channel = new Channel<number[]>();
  channel.onmessage = (bytes) => {
    if (!bytes || bytes.length === 0) {
      if (!session.alive) return;
      session.alive = false;
      terminal.write("\r\n\x1b[2m[进程已退出]\x1b[0m\r\n");
      commit();
      return;
    }
    terminal.write(Uint8Array.from(bytes));
  };
  commit();
  try {
    await invoke("pty_open", {
      id,
      cwd,
      cols: terminal.cols,
      rows: terminal.rows,
      onData: channel,
    });
  } catch (e) {
    session.alive = false;
    terminal.write(`\r\n\x1b[31m终端启动失败: ${String(e)}\x1b[0m\r\n`);
    commit();
  }
}

/** 杀壳 + 销毁 xterm；就近激活相邻会话，空列表则 activeId 归零 */
export function closeShell(id: string): void {
  const index = list.findIndex((s) => s.id === id);
  if (index < 0) return;
  const session = list[index];
  list = list.filter((s) => s.id !== id);
  if (activeId === id) {
    activeId = list[Math.min(index, list.length - 1)]?.id ?? null;
  }
  void invoke("pty_close", { id }).catch(() => {});
  session.terminal.dispose();
  session.host.remove();
  commit();
}

export function closeAllShells(): void {
  for (const s of [...list]) closeShell(s.id);
}

export function setActiveShell(id: string): void {
  if (activeId === id) return;
  activeId = id;
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
