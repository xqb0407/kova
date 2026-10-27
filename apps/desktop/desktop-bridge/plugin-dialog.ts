/** 桌面桥 · 系统对话框：open/save/message/ask/confirm → 主进程 Electron dialog。 */
import { invokeBridge } from "./_host";

export interface OpenDialogOptions {
  title?: string;
  multiple?: boolean;
  directory?: boolean;
  filters?: { name: string; extensions: string[] }[];
  defaultPath?: string;
  canCreateDirectories?: boolean;
  /** macOS：显示隐藏文件（~/.ssh 里的私钥选择必需） */
  showHiddenFiles?: boolean;
  parent?: string;
}

export interface SaveDialogOptions {
  title?: string;
  filters?: { name: string; extensions: string[] }[];
  defaultPath?: string;
}

export async function open(options?: OpenDialogOptions | string): Promise<string | string[] | null> {
  const opts = typeof options === "string" ? { title: options } : options ?? {};
  return invokeBridge<string | string[] | null>("bridge_dialog_open", { opts });
}

export async function save(options?: SaveDialogOptions | string): Promise<string | null> {
  const opts = typeof options === "string" ? { title: options } : options ?? {};
  return invokeBridge<string | null>("bridge_dialog_save", { opts });
}

export async function message(message: string, options?: { title?: string; kind?: string }): Promise<void> {
  await invokeBridge("bridge_dialog_message", { message, options: options ?? {} });
}

export async function ask(message: string, options?: { title?: string; kind?: string }): Promise<boolean> {
  return invokeBridge<boolean>("bridge_dialog_ask", { message, options: options ?? {} });
}

export async function confirm(message: string, options?: { title?: string; kind?: string }): Promise<boolean> {
  return invokeBridge<boolean>("bridge_dialog_confirm", { message, options: options ?? {} });
}
