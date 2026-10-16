/**
 * 主窗口创建（对齐 旧桌面壳配置 windows[0] + gpu.rs create_windows +
 * lib.rs on_page_load 首帧显窗 + 5s 兜底 show）。
 */
import { app, BrowserWindow, shell } from "electron";
import { onHiddenToTray } from "./tray";
import { join } from "node:path";
import { trackWindow } from "./ipc";
import { restore as restoreAppearance } from "./appearance";
import { restoreDevMode } from "./about";

// CJS 打包（esbuild）下 __dirname 即 dist/ 目录
const here = __dirname;

export let mainWindow: BrowserWindow | null = null;

/** 只读取句柄（browser.ts 等模块用；避免 import 绑定在赋值前后语义分叉） */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function createMainWindow(devUrl: string | null): BrowserWindow {
  const isMac = process.platform === "darwin";
  // Win 走非分层窗：transparent:true 让 DWM 把窗口视为自合成表面——
  // Win11 系统圆角/投影不给（roundedCorners 仅对非分层窗生效）、
  // acrylic/mica backdrop 同样不支持分层窗、表面 alpha 还会禁掉 ClearType
  // （见 app-runtime-provider sync_webview_surface 注释）。圆角/阴影/材质
  // 全部交回 DWM：创建即实体窗，材质开启时由 appearance.ts 把背景色切成
  // 透明底色透出 backdrop。Linux 维持自绘透明路径不变。
  const isWin = process.platform === "win32";
  const win = new BrowserWindow({
    width: 1600,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    center: true,
    show: false, // visible:false：等首帧就绪再 show（对齐旧桌面壳 消闪烁策略）
    transparent: !isWin,
    backgroundColor: isWin ? "#ffffffff" : "#00000000",
    ...(isMac
      ? {
          title: "扣瓦",
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 20, y: 22 },
          vibrancy: "under-window" as const,
          visualEffectState: "active" as const,
        }
      : {
          frame: false, // Windows/Linux：无边框 + 前端自绘控制（window-controls.tsx）
          title: "扣瓦",
        }),
    icon: join(here, "..", "icons", "icon.png"), // Windows/Linux 窗口图标
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // 面板内置浏览器走 <webview>（DOM 嵌入渲染）：层级/圆角/遮罩/裁剪随主
      // webview 的 DOM 合成自然成立，对齐 ZCode 的内置浏览器架构；guest 由
      // 主进程 browser.ts 经 did-attach 上报的 webContentsId 绑定驱动
      webviewTag: true,
    },
  });
  mainWindow = win;
  trackWindow("main", win);
  // macOS dev（未打包）时 Dock 显示 Electron 默认图标：手动换成应用图标；
  // 打包版由 bundle 的 icon.icns 生效，无需干预
  if (process.platform === "darwin" && !app.isPackaged) {
    try {
      app.dock?.setIcon(join(here, "..", "icons", "icon.png"));
    } catch {
      /* 图标失败不拦启动 */
    }
  }

  // 首帧显示 + 5s 兜底（对齐 on_page_load Finished / setup 兜底线程）
  let shown = false;
  const showOnce = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
  };
  win.webContents.once("dom-ready", showOnce);
  win.webContents.once("did-finish-load", showOnce);
  setTimeout(showOnce, 5000).unref?.();

  win.on("resized", () => {
    if (!win.isDestroyed()) {
      const b = win.getContentBounds();
      win.webContents.send("kova-event", { event: "window-resized", payload: { width: b.width, height: b.height } });
    }
  });

  // Windows：关窗 = 收进托盘（对齐 lib.rs CloseRequested；mac 保留系统行为）
  if (process.platform === "win32") {
    win.on("close", (e) => {
      if (!(win as any).__quitting) {
        e.preventDefault();
        win.hide();
        onHiddenToTray();
      }
    });
  }

  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadURL("kova://app/index.html");
  }

  // 外观 / 开发者模式恢复（setup 顺序：appearance.restore → about.restore）
  restoreAppearance(win);
  restoreDevMode(win);
  return win;
}

/** 外链拦截：主窗口内点击 http(s) 链接一律走系统浏览器（旧桌面壳 同策） */
export function attachExternalLinkGuards(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
}
