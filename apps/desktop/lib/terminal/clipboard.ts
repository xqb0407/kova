"use client";

import type { Terminal } from "@xterm/xterm";
import { copyText } from "@/lib/remote";

/**
 * 终端剪贴板：右键菜单（shell-viewport）与键盘快捷键（lib/shell 拉起会话时
 * 挂载）共用同一份实现。
 *
 * 复制/粘贴都走 navigator.clipboard，写侧复用 lib/remote 的 copyText（带
 * execCommand 兜底）；粘贴交给 terminal.paste——换行归一化和 bracketed
 * paste 由 xterm 自己处理，宿主不要手工拼 \r 或转义序列。
 */

export type TerminalPasteResult = "pasted" | "empty" | "failed";

type ClipboardKeyEvent = Pick<
  KeyboardEvent,
  "type" | "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
>;

/**
 * Windows/Linux 的剪贴板快捷键判定（纯函数，便于单测；macOS 走系统
 * Edit 菜单的原生 copy/paste，不在这里映射）：
 * Ctrl+Shift+C / Ctrl+Insert 复制，
 * Ctrl+V / Ctrl+Shift+V / Shift+Insert 粘贴。
 *
 * Ctrl+C 永远不接管：shell 里它是 SIGINT，复制必须带 Shift（VSCode 终端
 * 同款口径）。没有选区时复制组合键也直接吞掉，不把 Ctrl+Shift+C 送进 PTY。
 */
export function terminalClipboardAction(
  event: ClipboardKeyEvent,
): "copy" | "paste" | null {
  if (event.type !== "keydown") return null;
  const key = event.key.toLowerCase();

  // Meta 是 Win 键，Alt 留给输入法/组合键，都不抢
  if (event.metaKey || event.altKey) return null;
  if (event.ctrlKey && event.shiftKey && key === "c") return "copy";
  if (event.ctrlKey && !event.shiftKey && event.key === "Insert") return "copy";
  if (event.ctrlKey && key === "v") return "paste";
  if (event.shiftKey && !event.ctrlKey && event.key === "Insert") return "paste";
  return null;
}

/** 复制任意文本；空文本视为无事可做（调用方据此禁用「复制」项） */
export async function copyTerminalText(text: string): Promise<boolean> {
  if (!text) return false;
  return copyText(text);
}

/** 复制终端当前选区（选区已被右键菜单快照时可直接用 copyTerminalText） */
export async function copyTerminalSelection(
  terminal: Pick<Terminal, "getSelection">,
): Promise<boolean> {
  return copyTerminalText(terminal.getSelection());
}

/** 剪贴板文本粘进终端：empty 与 failed 分开，菜单只在失败时提示 */
export async function pasteTerminalClipboard(
  terminal: Pick<Terminal, "paste">,
): Promise<TerminalPasteResult> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.readText)
    return "failed";
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return "empty";
    terminal.paste(text);
    return "pasted";
  } catch {
    return "failed";
  }
}

/**
 * 把快捷键挂到 xterm 上。命中时 preventDefault（挡浏览器默认粘贴/开发者
 * 工具等）并返回 false，xterm 就不会再把它编码成 \x03/\x16 写进 PTY。
 *
 * macOS 不挂：⌘C/⌘V 由应用 Edit 菜单的 copy/paste role 落到 xterm 的
 * 原生 copy/paste 事件上，本来就能用；Electron 的菜单快捷键与页面
 * keydown 是并行触发的（见 webContents before-input-event 文档），再拦
 * 一层会让粘贴执行两次。Windows/Linux 没有应用菜单，且 Ctrl+C 被 xterm
 * 当 SIGINT 吃掉，才需要这层接管。
 */
export function attachTerminalClipboardKeys(
  terminal: Terminal,
  isMac: boolean,
): void {
  if (isMac) return;
  terminal.attachCustomKeyEventHandler((event) => {
    const action = terminalClipboardAction(event);
    if (!action) return true;
    event.preventDefault();
    if (action === "copy") void copyTerminalSelection(terminal);
    else void pasteTerminalClipboard(terminal);
    return false;
  });
}
