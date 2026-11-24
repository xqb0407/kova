/**
 * 渲染桥命令（desktop-bridge 的非业务面）：窗口控制、系统对话框、
 * 应用元信息、路径助手、http_post（对齐 http.rs）。
 */
import { app, BrowserWindow, dialog } from "electron";
import { join } from "node:path";
import type { CmdCtx } from "./ipc";
import { restoreMaximizedWindowAt } from "./window-drag";
import { resolveSystemProxyUrl } from "./system-proxy";
import { testProxyConnection } from "./proxy-test";

export function setupBridgeCommands(register: (name: string, fn: (args: any, ctx: CmdCtx) => any) => void): void {
  const winOf = (ctx: CmdCtx) => {
    const w = BrowserWindow.fromWebContents(ctx.sender);
    if (!w) throw new Error("no window for sender");
    return w;
  };

  register("win_minimize", (_a, ctx) => {
    winOf(ctx).minimize();
    return null;
  });
  register("win_maximize", (_a, ctx) => {
    winOf(ctx).maximize();
    return null;
  });
  register("win_unmaximize", (_a, ctx) => {
    winOf(ctx).unmaximize();
    return null;
  });
  register("win_toggle_maximize", (_a, ctx) => {
    const w = winOf(ctx);
    // 全屏没有标题栏/窗口按钮可点；双击拖拽区也不该改变全屏态
    if (w.isFullScreen()) return null;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
    return null;
  });
  register("win_close", (_a, ctx) => {
    winOf(ctx).close();
    return null;
  });
  register("win_hide", (_a, ctx) => {
    winOf(ctx).hide();
    return null;
  });
  register("win_show", (_a, ctx) => {
    const w = winOf(ctx);
    if (w.isMinimized()) w.restore();
    w.show();
    return null;
  });
  register("win_is_maximized", (_a, ctx) => winOf(ctx).isMaximized());
  /** 拖拽起点快照：位置与窗口态一次取全，避免多次 IPC 之间状态变化 */
  register("win_get_drag_state", (_a, ctx) => {
    const w = winOf(ctx);
    const b = w.getBounds();
    return {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      maximized: w.isMaximized(),
      fullscreen: w.isFullScreen(),
    };
  });
  register("win_set_focus", (_a, ctx) => {
    winOf(ctx).focus();
    return null;
  });
  register("win_is_focused", (_a, ctx) => winOf(ctx).isFocused());
  register("win_get_position", (_a, ctx) => {
    const b = winOf(ctx).getBounds();
    return { x: b.x, y: b.y };
  });
  register("win_set_position", (a, ctx) => {
    const w = winOf(ctx);
    // 全屏没有标题栏可拖，也不该把窗口挪出屏幕（标准应用同样不响应）
    if (w.isFullScreen()) return null;
    const b = w.getBounds();
    w.setPosition(Math.round(Number(a.x ?? b.x)), Math.round(Number(a.y ?? b.y)));
    return null;
  });
  /**
   * 最大化窗口的拖拽还原（Windows 原生 drag-to-restore）：按光标位置先还原到
   * 普通尺寸再一步落位。cursorX/cursorY 是当前光标屏幕坐标，grabOffsetY 是
   * 按下时光标距窗口顶缘的距离。具体判定见 window-drag.ts（可单测）。
   */
  register("win_unmaximize_at", (a, ctx) => restoreMaximizedWindowAt(winOf(ctx), a));
  register("win_set_always_on_top", (a, ctx) => {
    winOf(ctx).setAlwaysOnTop(Boolean(a.flag));
    return null;
  });

  /* 对话框（对齐 plugin-dialog 前端面） */
  register("bridge_dialog_open", async (a, ctx) => {
    const w = BrowserWindow.fromWebContents(ctx.sender);
    const opts = a.opts ?? {};
    const properties: (
      | "openFile"
      | "openDirectory"
      | "multiSelections"
      | "createDirectory"
      | "showHiddenFiles"
    )[] = [];
    if (opts.directory) properties.push("openDirectory");
    else properties.push("openFile");
    if (opts.multiple) properties.push("multiSelections");
    if (opts.canCreateDirectories) properties.push("createDirectory");
    if (opts.showHiddenFiles) properties.push("showHiddenFiles");
    const filters = Array.isArray(opts.filters)
      ? opts.filters.map((f: any) => ({ name: String(f.name ?? ""), extensions: (f.extensions ?? []).map(String) }))
      : undefined;
    const req = {
      title: opts.title ? String(opts.title) : undefined,
      defaultPath: opts.defaultPath ? String(opts.defaultPath) : undefined,
      filters,
      properties,
    } as any;
    const r = w ? await dialog.showOpenDialog(w, req) : await dialog.showOpenDialog(req);
    if (r.canceled) return null;
    return opts.multiple ? r.filePaths : r.filePaths[0] ?? null;
  });
  register("bridge_dialog_save", async (a, ctx) => {
    const w = BrowserWindow.fromWebContents(ctx.sender);
    const opts = a.opts ?? {};
    const req = {
      title: opts.title ? String(opts.title) : undefined,
      defaultPath: opts.defaultPath ? String(opts.defaultPath) : undefined,
      filters: Array.isArray(opts.filters)
        ? opts.filters.map((f: any) => ({ name: String(f.name ?? ""), extensions: (f.extensions ?? []).map(String) }))
        : undefined,
    } as any;
    const r = w ? await dialog.showSaveDialog(w, req) : await dialog.showSaveDialog(req);
    if (r.canceled || !r.filePath) return null;
    return r.filePath;
  });
  register("bridge_dialog_message", async (a, ctx) => {
    const w = BrowserWindow.fromWebContents(ctx.sender);
    const req = { message: String(a.message), title: a.options?.title ? String(a.options.title) : undefined } as any;
    if (w) await dialog.showMessageBox(w, req);
    else await dialog.showMessageBox(req);
    return null;
  });
  for (const [name, type] of [
    ["bridge_dialog_ask", "question"],
    ["bridge_dialog_confirm", "question"],
  ] as const) {
    register(name, async (a, ctx) => {
      const w = BrowserWindow.fromWebContents(ctx.sender);
      const req = {
        type,
        message: String(a.message),
        buttons: ["确定", "取消"],
        defaultId: 0,
        cancelId: 1,
      } as any;
      const r = w ? await dialog.showMessageBox(w, req) : await dialog.showMessageBox(req);
      return r.response === 0;
    });
  }

  /* 应用元信息 / 路径 */
  /** 设置页「网络代理」：检测系统代理（不含用户设置/环境变量） */
  register("bridge_system_proxy", () => resolveSystemProxyUrl());
  /** 设置页「测试连接」：url 省略时测系统代理 */
  register("bridge_test_proxy", (a) =>
    testProxyConnection(typeof a.url === "string" ? a.url : undefined),
  );
  register("bridge_app_version", () => app.getVersion());
  // 真实运行时版本（关于页"Electron 版本"行）：旧桌面壳那栏曾显示兼容占位串
  register("bridge_runtime_version", () => process.versions.electron ?? "unknown");
  register("bridge_app_name", () => app.getName());
  register("bridge_app_data_dir", () => app.getPath("userData"));
  register("bridge_home_dir", () => app.getPath("home"));
  register("bridge_app_window_size", (_a, ctx) => {
    const b = winOf(ctx).getContentBounds();
    return { width: b.width, height: b.height };
  });
  register("bridge_path_join", (a) => join(...(a.parts ?? []).map(String)));

  /* plugin-fs 兼容：dialog 用户亲选路径的文本写出/读入（与网页端 File input 同授权语义） */
  register("bridge_fs_write_text", (a) => {
    const { writeFileSync } = require("node:fs");
    const p = String(a.path ?? "");
    if (!/^([a-zA-Z]:[\\/]|[\/])/.test(p)) throw new Error("bad-path");
    writeFileSync(p, String(a.content ?? ""), "utf8");
    return null;
  });
  register("bridge_fs_read_text", (a) => {
    const { readFileSync } = require("node:fs");
    const p = String(a.path ?? "");
    if (!/^([a-zA-Z]:[\\/]|[\/])/.test(p)) throw new Error("bad-path");
    return readFileSync(p, "utf8");
  });

  /* JS→主进程事件广播（bridge/event.ts emit 用；当前前端未用，保留通道形状） */
  register("bridge_emit", (a, ctx) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("kova-event", { event: String(a.event), payload: a.payload ?? null });
    }
    return null;
  });

  /* http_post（对齐 http.rs：webhook 等统一出站通道；CORS 无关，主进程直发） */
  register("http_post", async (a) => {
    const urlS = String(a.url);
    let parsed: URL;
    try {
      parsed = new URL(urlS);
    } catch (e: any) {
      throw new Error(`invalid url: ${e?.message ?? e}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`unsupported scheme: ${parsed.protocol.replace(":", "")}`);
    }
    const timeoutMs = Math.min(60_000, Math.max(1_000, Math.trunc(Number(a.timeoutMs ?? 10_000))));
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const headers = new Headers();
      if (Array.isArray(a.headers)) {
        for (const [k, v] of a.headers) headers.set(String(k), String(v));
      }
      const resp = await fetch(urlS, { method: "POST", body: String(a.body ?? ""), headers, signal: ac.signal });
      const text = await resp.text();
      return { status: resp.status, ok: resp.status >= 200 && resp.status < 300, snippet: Array.from(text).slice(0, 500).join("") };
    } catch (e: any) {
      throw new Error(e?.name === "AbortError" ? "request timed out" : String(e?.message ?? e));
    } finally {
      clearTimeout(t);
    }
  });
}
