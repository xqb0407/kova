/**
 * Electron 主入口（对齐 lib.rs 的启动装配顺序）：
 * 单实例 → 路径/日志 →（备份换入挂点）→ SQLite → GPU 开关 → 协议/CSP →
 * 主窗口（首帧再显示）→ 菜单/托盘 → 附件定时清理 → 预热 sidecar → 退出收尸。
 */
import { app, BrowserWindow, protocol, net } from "electron";
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { initPaths, appDataDir } from "./paths";
import { initLogging, logError, logInfo, logWarn } from "./logging";
import { setupIpc, focusMainWindow } from "./ipc";
import { registerAllCommands } from "./registry";
import { initStore } from "./store";
import { applyGpuFlag } from "./gpu";
import { applyPendingRestore } from "./backup";
import { createMainWindow, attachExternalLinkGuards, mainWindow } from "./window";
import { destroyForReload as destroyBrowserForReload } from "./browser";
import * as tray from "./tray";
import * as menu from "./menu";
import { startAttachmentPruneTimer } from "./fs-cmds";
import * as pi from "./pi-agent";
import * as remote from "./remote";
import * as tunnel from "./tunnel";
import { cancelAllTools } from "./tool-exec";
import { killAllPty } from "./pty";

const DEV = process.argv.includes("--dev");
const DEV_URL = process.env.KOVA_DEV_URL ?? "http://localhost:3000";
if (DEV) (globalThis as any).__KOVA_DEV_URL = DEV_URL; // resource 窗口等子窗口共用

/* ------------------------------ 静态协议 kova:// ------------------------------ */

protocol.registerSchemesAsPrivileged([
  {
    scheme: "kova",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

import { rendererOutDir } from "./out-dir";
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "text/plain",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

/** 与 旧桌面壳配置 security.csp 等价（去掉 ipc.localhost 项） */
const CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self' ws: wss: http://127.0.0.1:* http://localhost:* https:; " +
  "worker-src 'self' blob:; frame-src 'self' data: blob: https:; media-src 'self' data: blob:; object-src 'none'; base-uri 'self'; form-action 'self'";

function registerStaticProtocol(): void {
  protocol.handle("kova", async (request) => {
    try {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const clean = normalize(rel).replace(/\\/g, "/");
      if (clean.includes("..")) return new Response("forbidden", { status: 403 });
      const base = join(rendererOutDir(), clean);
      const candidates = [base, base + ".html", join(base, "index.html")];
      let filePath: string | null = null;
      for (const c of candidates) {
        if (existsSync(c)) {
          const st = require("node:fs").statSync(c);
          if (st.isFile()) {
            filePath = c;
            break;
          }
        }
      }
      if (!filePath) {
        filePath = join(rendererOutDir(), "404.html");
        if (!existsSync(filePath)) filePath = null;
      }
      if (!filePath) return new Response("not found", { status: 404 });
      const resp = await net.fetch(`file://${filePath}`);
      const ext = filePath.slice(filePath.lastIndexOf("."));
      const headers = new Headers(resp.headers);
      headers.set("content-type", MIME[ext] ?? "application/octet-stream");
      headers.set("content-security-policy", CSP);
      return new Response(resp.body, { status: resp.ok ? 200 : 404, headers });
    } catch (e: any) {
      logError(`[kova-protocol] ${e?.message ?? e}`);
      return new Response("error", { status: 500 });
    }
  });
}

/* ------------------------------ 生命周期 ------------------------------ */

// 单实例（对齐 旧桌面壳_plugin_single_instance）：第二次启动只唤回已有窗口。
// 必须先 initPaths：Electron 的单实例锁按 userData 目录走，KOVA_DATA_DIR
// 沙箱实例需要与真实实例并存（e2e），锁的落点必须跟随同一份路径决定。
initPaths(); // userData 指向 com.kova.assistant（或 KOVA_DATA_DIR 覆盖）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => focusMainWindow());

  initLogging();
  applyPendingRestore(); // 待恢复备份换入：必须早于任何存储打开（当前为挂点）
  initStore();
  applyGpuFlag(); // 建窗前读开关（与 gpu.rs create_windows 时序同构）

  void app.whenReady().then(async () => {
    registerStaticProtocol();
    setupIpc();
    registerAllCommands();
    pi.setRemoteModule(remote as any);
    remote.stopOnExit; // 显式引用避免摇树掉模块图副作用
    const win = createMainWindow(DEV ? DEV_URL : null);
    attachExternalLinkGuards(win);
    // 主页面（重）加载开始即移除浏览器子视图：原生层不随页面重载销毁，
    // 否则刷新后旧页面悬浮盖住启动画面（对齐 lib.rs on_page_load Started）
    win.webContents.on("did-start-navigation", (_e, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) destroyBrowserForReload();
    });
    menu.install();
    if (process.platform === "win32") {
      try {
        tray.init();
      } catch (e: any) {
        logError(`[tray] init failed: ${e?.message ?? e}`);
      }
    }
    startAttachmentPruneTimer();
    // 预热拉起 sidecar：自动化调度器必须早于用户首条消息存活
    void pi.ensureSpawned().catch((e) => logError(`[pi_agent] warm start failed: ${e?.message ?? e}`));
    logInfo(`[kova] electron shell ready (data: ${appDataDir()}, dev=${DEV})`);
  });

  let quitting = false;
  app.on("before-quit", (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    if (mainWindow && !mainWindow.isDestroyed()) (mainWindow as any).__quitting = true;
    // 退出收尸（对齐 RunEvent::Exit）：先同步收掉在飞工具进程树，
    // 再优雅关 sidecar（shutdown + 6s 宽限），然后关网关/隧道/终端
    try {
      cancelAllTools();
    } catch (err) {
      logError(`[exit] cancel tools: ${err}`);
    }
    void (async () => {
      try {
        await pi.killOnExit();
      } catch (err) {
        logError(`[exit] pi-agent: ${err}`);
      }
      try {
        remote.stopOnExit();
      } catch {
        /* ignore */
      }
      try {
        tunnel.stopNow();
      } catch {
        /* ignore */
      }
      try {
        killAllPty();
      } catch {
        /* ignore */
      }
      app.exit(0);
    })();
  });

  app.on("window-all-closed", () => {
    // Windows 关窗即隐藏进托盘（见 window.ts）；macOS 保持存活；
    // 没有托盘驻留的平台（Linux）直接退出
    if (process.platform === "linux") app.quit();
  });

  app.on("activate", () => {
    // Dock 点击：唤回主窗（macOS），没有窗口时重建
    if (BrowserWindow.getAllWindows().length === 0) {
      const win = createMainWindow(DEV ? DEV_URL : null);
      attachExternalLinkGuards(win);
    } else {
      focusMainWindow();
    }
  });
}
