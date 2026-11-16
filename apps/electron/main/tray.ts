/**
 * 系统托盘（Headless v1）：Windows/macOS 常驻（关窗进托盘、菜单唤回/退出）。
 *
 * 状态角标（L1c）：菜单栏/Dock 上暴露「待处理 Inbox 数」与「运行中自动化数」——
 * 窗口关闭后这是唯一的状态可见面。数据由 tray-status.ts 从 sidecar 自发帧
 * （inbox_changed / automation_fired / automation_run_done）喂入，这里只做展示。
 */
import { app, Menu, Tray, nativeImage, type MenuItemConstructorOptions } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { focusMainWindow, emitToWindows } from "./ipc";
import { logError } from "./logging";

// CJS 打包（esbuild）下 __dirname 即 dist/ 目录
const here = __dirname;
let tray: Tray | null = null;

export type TrayStatus = {
  /** Inbox 里 requiresAction 且未 snooze 的条目数 */
  needsAction: number;
  /** 正在跑的自动化轮数（fired − done 的投影） */
  running: number;
};

const status: TrayStatus = { needsAction: 0, running: 0 };

function trayIconPath(): string | null {
  const candidates = [
    join(here, "..", "icons", "tray.png"),
    join(process.resourcesPath ?? "", "icons", "tray.png"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function buildMenu(): Menu {
  const items: MenuItemConstructorOptions[] = [
    { label: "打开 Kova", click: () => focusMainWindow() },
    { type: "separator" },
  ];
  if (status.running > 0) {
    items.push({ label: `${status.running} 个自动化运行中`, enabled: false });
  }
  if (status.needsAction > 0) {
    items.push({
      label: `${status.needsAction} 条待处理`,
      click: () => focusMainWindow(),
    });
  }
  if (status.running > 0 || status.needsAction > 0) items.push({ type: "separator" });
  items.push(
    // 不直接 toggle 窗口：经主窗口桌宠中继改模式（off ↔ 上次形态），
    // 模式是唯一事实源，悬浮窗/角标随模式自动显隐
    { label: "桌宠 显示/隐藏", click: () => emitToWindows("pet-tray-toggle-pet", null) },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  );
  return Menu.buildFromTemplate(items);
}

function tooltip(): string {
  const parts = [app.getName()];
  if (status.running > 0) parts.push(`${status.running} 个自动化运行中`);
  if (status.needsAction > 0) parts.push(`${status.needsAction} 条待处理`);
  return parts.join(" · ");
}

export function init(): void {
  const iconPath = trayIconPath();
  try {
    const image = iconPath
      ? nativeImage.createFromPath(iconPath)
      : nativeImage.createEmpty();
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 18, height: 18 }));
    tray.setToolTip(tooltip());
    tray.setContextMenu(buildMenu());
    tray.on("click", () => focusMainWindow());
    applyStatus();
  } catch (e: any) {
    logError(`[tray] init failed: ${e?.message ?? e}`);
  }
}

/**
 * 更新状态并刷新托盘（幂等：值没变直接返回，避免每帧重建菜单）。
 * 未 init（Linux/无图标/初始化失败）时只记状态，不抛错。
 */
export function applyTrayStatus(patch: Partial<TrayStatus>): void {
  const nextNeeds = patch.needsAction ?? status.needsAction;
  const nextRunning = patch.running ?? status.running;
  if (nextNeeds === status.needsAction && nextRunning === status.running) return;
  status.needsAction = Math.max(0, Math.floor(nextNeeds));
  status.running = Math.max(0, Math.floor(nextRunning));
  applyStatus();
}

function applyStatus(): void {
  if (!tray) return;
  try {
    // macOS 菜单栏图标旁的数字（其它平台无此 API 语义）
    if (process.platform === "darwin") {
      tray.setTitle(status.needsAction > 0 ? ` ${status.needsAction}` : "");
    }
    // Dock badge / Windows taskbar badge：待处理数是用户最该看到的数
    try {
      app.setBadgeCount(status.needsAction);
    } catch {
      /* 平台不支持 */
    }
    tray.setToolTip(tooltip());
    tray.setContextMenu(buildMenu());
  } catch (e: any) {
    logError(`[tray] status update failed: ${e?.message ?? e}`);
  }
}

/** 关窗进托盘时的一次性提示钩子（对齐 on_hidden_to_tray） */
export function onHiddenToTray(): void {
  // Windows 版可在此弹"已最小化到托盘"气泡；保持静默与 旧桌面壳 行为一致
}
