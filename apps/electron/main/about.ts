/** 关于页能力（对齐 about.rs）：打开日志目录/外链、开发者模式（kv 持久化 + 启动恢复）。 */
import { app, BrowserWindow, shell } from "electron";
import { mkdirSync } from "node:fs";
import { appLogDir } from "./paths";
import { kvGet, kvSet, kvDelete } from "./store";

export const DEV_KV_KEY = "dev.mode";

/** 仅允许 http(s)/mailto（与 Rust 同款白名单） */
export function openExternal(url: string): null {
  if (!(url.startsWith("https://") || url.startsWith("http://") || url.startsWith("mailto:"))) {
    throw new Error("仅允许打开 http(s)/mailto 链接");
  }
  void shell.openExternal(url);
  return null;
}

export function openLogsDir(): string {
  const dir = appLogDir();
  mkdirSync(dir, { recursive: true });
  void shell.openPath(dir);
  return dir;
}

export function setDevMode(enabled: boolean, sender: Electron.WebContents): null {
  const win = BrowserWindow.fromWebContents(sender);
  if (enabled) {
    win?.webContents.openDevTools({ mode: "detach" });
    kvSet(DEV_KV_KEY, "1");
  } else {
    win?.webContents.closeDevTools();
    kvDelete(DEV_KV_KEY);
  }
  return null;
}

/** 启动恢复：dev 模式开启时自动唤起 DevTools（main 窗口） */
export function restoreDevMode(mainWin: BrowserWindow): void {
  try {
    if (kvGet(DEV_KV_KEY) === "1") mainWin.webContents.openDevTools({ mode: "detach" });
  } catch {
    /* 失败不阻塞启动 */
  }
}

export function setupAboutCommands(register: (name: string, fn: (args: any, ctx: any) => any) => void): void {
  register("open_logs_dir", () => openLogsDir());
  register("open_external", (a) => openExternal(String(a.url)));
  register("set_dev_mode", (a, ctx) => setDevMode(Boolean(a.enabled), ctx.sender));
}
