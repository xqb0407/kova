/**
 * 系统托盘（对齐 tray.rs 行为）：Windows 常驻（关窗进托盘、菜单唤回/退出）；
 * macOS 也建托盘入口（关 Dock 不退出、保持与 Tauri 版一致的用户心智）。
 */
import { app, Menu, Tray, nativeImage } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { focusMainWindow } from "./ipc";
import { logError } from "./logging";

// CJS 打包（esbuild）下 __dirname 即 dist/ 目录
const here = __dirname;
let tray: Tray | null = null;

function trayIconPath(): string | null {
  const candidates = [
    join(here, "..", "icons", "tray.png"),
    join(process.resourcesPath ?? "", "icons", "tray.png"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export function init(): void {
  const iconPath = trayIconPath();
  try {
    const image = iconPath
      ? nativeImage.createFromPath(iconPath)
      : nativeImage.createEmpty();
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 18, height: 18 }));
    tray.setToolTip(app.getName());
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "打开 Kova", click: () => focusMainWindow() },
        { type: "separator" },
        { label: "退出", click: () => app.quit() },
      ]),
    );
    tray.on("click", () => focusMainWindow());
  } catch (e: any) {
    logError(`[tray] init failed: ${e?.message ?? e}`);
  }
}

/** 关窗进托盘时的一次性提示钩子（对齐 on_hidden_to_tray） */
export function onHiddenToTray(): void {
  // Windows 版可在此弹"已最小化到托盘"气泡；保持静默与 Tauri 行为一致
}
