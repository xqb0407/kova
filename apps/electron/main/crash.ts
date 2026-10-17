/**
 * 主进程崩溃 / 卡死兜底。
 *
 * Electron 默认对主进程未捕获异常弹出英文的
 * 「A JavaScript error occurred in the main process」并原样贴出堆栈：
 * 用户既看不懂也无法自救，看起来像系统级故障。这里接管默认行为：
 *
 *   - 未捕获异常：全量堆栈写入 crash.log + app.log，界面只给中文恢复选项；
 *   - 未处理 Promise：只记录（第三方库常见非致命），可经环境变量升级为致命；
 *   - 主窗口 unresponsive / render-process-gone：提供等待、重新加载、重启；
 *   - 生产环境界面加载失败：提供重试 / 打开日志 / 退出。
 *
 * 注意：主进程事件循环被**同步阻塞**（死循环、同步 IO 卡死）时，同进程内没有
 * 任何代码能弹窗——这类卡死只能靠外部看门狗杀进程重启（启动期同步阻塞已由
 * index.ts 的 lag 心跳留痕）。这里处理的是"进程还活着但出错了"的场景。
 *
 * 环境变量：
 *   KOVA_NO_CRASH_DIALOG=1     不弹任何恢复窗（e2e / CI），只落日志；
 *   KOVA_CRASH_ON_REJECTION=1  把 unhandledRejection 也按致命错误处理。
 */
import { app, BrowserWindow, crashReporter, dialog, shell } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { appLogDir } from "./paths";
import { logError, logInfo, logWarn } from "./logging";

const APP_LABEL = "扣瓦";
const DIALOG_DISABLED = process.env.KOVA_NO_CRASH_DIALOG === "1";
const CRASH_ON_REJECTION = process.env.KOVA_CRASH_ON_REJECTION === "1";
/** 重启前等 sidecar 收尸的上限：崩溃恢复不能被清理流程拖住 */
const RESTART_GRACE_MS = 1500;

let installed = false;
let shuttingDown = false;
let fatalDialogOpen = false;

/**
 * 开发环境 Dock / 崩溃弹窗角标使用应用自己的图标。
 * 必须在窗口创建之前就生效：启动期崩溃时 index.ts 走不到 createMainWindow，
 * 否则 macOS 会一直显示 Electron 默认的原子图标（用户会以为"logo 没换"）。
 * 打包版由 bundle 的 icon.icns 决定，这里不动。
 */
export function applyDevDockIcon(): void {
  if (process.platform !== "darwin" || app.isPackaged) return;
  try {
    app.dock?.setIcon(join(__dirname, "..", "icons", "icon.png"));
  } catch {
    /* 图标失败不拦启动 */
  }
}

/* ------------------------------ 落盘 ------------------------------ */

function nowText(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function crashLogPath(): string {
  return join(appLogDir(), "crash.log");
}

function stackOf(err: unknown): string {
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err, null, 2) ?? String(err);
  } catch {
    return String(err);
  }
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "未知错误";
}

/** 同步写 crash.log：app.exit 会立刻终止进程，异步日志流可能来不及落盘 */
function writeCrashLog(kind: string, err: unknown): string {
  const stack = stackOf(err);
  const header =
    `=== ${nowText()} [${kind}] ===\n` +
    `app=${app.getName()} ${app.getVersion()} electron=${process.versions.electron} node=${process.versions.node}\n` +
    `platform=${process.platform} ${process.arch} pid=${process.pid} packaged=${app.isPackaged}\n`;
  try {
    mkdirSync(appLogDir(), { recursive: true });
    appendFileSync(crashLogPath(), `${header}${stack}\n\n`, "utf8");
  } catch {
    /* 写日志失败绝不能再把进程带走一次 */
  }
  return stack;
}

/* ------------------------------ 对话框 ------------------------------ */

async function showBox(win: BrowserWindow | null, options: Electron.MessageBoxOptions): Promise<number | null> {
  try {
    const result =
      win && !win.isDestroyed()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
    return result.response;
  } catch (e: any) {
    logWarn(`[crash] dialog unavailable: ${e?.message ?? e}`);
    return null;
  }
}

function openLogsDir(): void {
  try {
    mkdirSync(appLogDir(), { recursive: true });
    void shell.openPath(appLogDir());
  } catch (e: any) {
    logWarn(`[crash] open logs failed: ${e?.message ?? e}`);
  }
}

/** 对话框父窗：优先焦点窗；没有就退回任意存活窗口。窗口隐藏时先唤回，
 *  否则 Windows 上挂到隐藏父窗的模态框可能根本不显示。 */
function dialogParent(): BrowserWindow | null {
  const candidates = [BrowserWindow.getFocusedWindow(), ...BrowserWindow.getAllWindows()];
  for (const w of candidates) {
    if (!w || w.isDestroyed()) continue;
    if (!w.isVisible()) {
      try {
        w.show();
      } catch {
        /* 唤回失败不拦弹窗 */
      }
    }
    return w;
  }
  return null;
}

function quitNow(code: number): void {
  shuttingDown = true;
  try {
    app.exit(code);
  } catch {
    process.exit(code);
  }
}

/** 崩溃后重启：先尽量收掉工具进程与 sidecar，避免留下孤儿；超时就直接 relaunch */
async function restartApp(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const { cancelAllTools } = await import("./tool-exec");
    cancelAllTools();
  } catch {
    /* 崩溃发生时模块可能只初始化了一半 */
  }
  try {
    const pi = await import("./pi-agent");
    await Promise.race([
      pi.killOnExit(),
      new Promise<void>((resolve) => setTimeout(resolve, RESTART_GRACE_MS)),
    ]);
  } catch {
    /* 同上：清理失败不阻塞重启 */
  }
  try {
    app.relaunch();
  } catch (e: any) {
    logError(`[crash] relaunch failed: ${e?.message ?? e}`);
  }
  quitNow(0);
}

/** 主进程致命错误：日志全量落盘，用户只看到可操作的恢复窗口 */
function onFatal(kind: string, err: unknown): void {
  // 先落盘：退出流程中的异常同样值得记录，只是不再弹窗
  const stack = writeCrashLog(kind, err);
  logError(`[crash] ${kind}:\n${stack}`);

  if (shuttingDown || fatalDialogOpen) return; // 同一个错误风暴里只弹一次
  if (DIALOG_DISABLED) {
    // e2e/CI：不弹窗；启动期错误直接退出，避免半初始化状态继续跑
    if (!app.isReady()) quitNow(1);
    return;
  }

  fatalDialogOpen = true;

  // ready 之前不要直接 showErrorBox：macOS 启动早期（应用尚未激活、没有窗口）
  // 它可能阻塞主进程却不创建任何可见窗口——实测窗口数为 0，用户只看到"卡死"。
  // 等 Electron ready 后再用可操作的 messageBox；5s 仍未 ready 才退回 errorBox。
  if (!app.isReady()) {
    const fallback = setTimeout(() => {
      try {
        dialog.showErrorBox(
          `${APP_LABEL}启动失败`,
          `应用启动时遇到问题，无法继续运行。\n\n` +
            `错误：${firstLine(stack)}\n\n` +
            `诊断信息已写入：\n${crashLogPath()}\n\n` +
            `点击“好”退出应用。若问题反复出现，请把该日志文件反馈给开发者。`,
        );
      } catch {
        /* 无 GUI 环境：logError 已镜像到 stderr */
      }
      quitNow(1);
    }, 5000);

    void app
      .whenReady()
      .then(() => {
        clearTimeout(fallback);
        applyDevDockIcon(); // 弹窗角标/Dock 不能还是 Electron 原子
        if (!shuttingDown) void promptFatal(stack, true);
      })
      .catch(() => {
        clearTimeout(fallback);
        quitNow(1);
      });
    return;
  }

  applyDevDockIcon();
  void promptFatal(stack);
}

async function promptFatal(stack: string, startup = false): Promise<void> {
  const parent = dialogParent();
  const detail = [
    ...(startup ? ["应用尚未完成启动，当前会话无法继续。"] : []),
    `发生时间：${nowText()}`,
    `错误：${firstLine(stack)}`,
    `日志目录：${appLogDir()}`,
    "",
    "诊断信息已写入 crash.log。重启后如果仍然出现，请把日志目录反馈给开发者。",
    ...(app.isPackaged ? [] : ["", "— 开发模式堆栈 —", stack]),
  ].join("\n");

  for (;;) {
    const response = await showBox(parent, {
      type: "error",
      title: startup ? `${APP_LABEL}启动失败` : `${APP_LABEL}遇到了问题`,
      message: startup ? `${APP_LABEL}启动时遇到了问题，需要重新启动` : `${APP_LABEL}遇到了一个意外问题，需要重新启动`,
      detail,
      buttons: ["重启应用", "打开日志文件夹", "退出"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });

    if (response === 1) {
      openLogsDir();
      continue; // 看完日志还能回来重启
    }
    if (response === 0) {
      await restartApp();
      return;
    }
    quitNow(1);
    return;
  }
}

/* ------------------------------ 窗口级恢复 ------------------------------ */

/**
 * 接管一个窗口的卡死/崩溃事件。
 * 主窗口必须接；资源管理器等独立窗口也可以接（reload 后即可恢复）。
 */
export function watchWindow(win: BrowserWindow, label = "main"): void {
  const wc = win.webContents;
  let unresponsivePromptOpen = false;
  let gonePromptOpen = false;
  let loadPromptOpen = false;

  wc.on("unresponsive", () => {
    logWarn(`[crash] ${label} window unresponsive`);
    if (shuttingDown || unresponsivePromptOpen || DIALOG_DISABLED) return;
    unresponsivePromptOpen = true;
    void (async () => {
      const response = await showBox(win, {
        type: "warning",
        title: `${APP_LABEL}暂时无响应`,
        message: "界面暂时没有响应",
        detail: "可以再等一会儿；如果一直无响应，重新加载界面通常能恢复。",
        buttons: ["继续等待", "重新加载界面", "重启应用"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      unresponsivePromptOpen = false;
      if (response === 1) {
        logWarn(`[crash] ${label} reload requested by user (unresponsive)`);
        if (!win.isDestroyed()) win.webContents.reload();
      } else if (response === 2) {
        await restartApp();
      }
    })();
  });

  wc.on("responsive", () => logInfo(`[crash] ${label} window responsive again`));

  wc.on("render-process-gone", (_event, details) => {
    const desc = `reason=${details.reason} exitCode=${details.exitCode}`;
    if (details.reason === "clean-exit") {
      logInfo(`[crash] ${label} renderer exited cleanly (${desc})`);
      return;
    }
    writeCrashLog("render-process-gone", new Error(`${label} renderer gone: ${desc}`));
    logError(`[crash] ${label} renderer gone: ${desc}`);
    if (shuttingDown || gonePromptOpen || DIALOG_DISABLED) return;

    gonePromptOpen = true;
    void (async () => {
      for (;;) {
        if (win.isDestroyed()) {
          // 用户先关了窗口：不弹第二个窗，交给下次启动
          gonePromptOpen = false;
          return;
        }
        const response = await showBox(win, {
          type: "error",
          title: `${APP_LABEL}界面已停止运行`,
          message: "界面进程意外退出",
          detail:
            `原因：${details.reason}（退出码 ${details.exitCode}）\n\n` +
            "重新加载界面通常可以恢复；如果反复出现，请重启应用并附带日志。",
          buttons: ["重新加载界面", "打开日志文件夹", "重启应用", "退出"],
          defaultId: 0,
          cancelId: 3,
          noLink: true,
        });
        if (response === 1) {
          openLogsDir();
          continue; // 看完日志回到同一组恢复选项
        }
        if (response === 0) {
          gonePromptOpen = false;
          if (!win.isDestroyed()) win.webContents.reload();
          return;
        }
        if (response === 2) {
          await restartApp();
          return;
        }
        if (response === null) {
          gonePromptOpen = false;
          return;
        }
        quitNow(1);
        return;
      }
    })();
  });

  // 生产环境加载失败 = 用户面对一个空白窗口。dev 下 Next 尚未就绪属常态，只留日志。
  wc.on("did-fail-load", (_event, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = ERR_ABORTED（被新导航取消）
    logError(`[crash] ${label} load failed (${code}): ${desc} — ${url}`);
    if (!app.isPackaged || shuttingDown || loadPromptOpen || DIALOG_DISABLED) return;
    loadPromptOpen = true;
    void (async () => {
      for (;;) {
        if (win.isDestroyed()) {
          loadPromptOpen = false;
          return;
        }
        const response = await showBox(win, {
          type: "error",
          title: `${APP_LABEL}界面加载失败`,
          message: "界面未能加载",
          detail: `${desc}（${code}）\n${url}\n\n日志目录：${appLogDir()}`,
          buttons: ["重试", "打开日志文件夹", "退出"],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
        });
        if (response === 1) {
          openLogsDir();
          continue;
        }
        if (response === 0) {
          loadPromptOpen = false;
          if (!win.isDestroyed()) win.webContents.reload();
          return;
        }
        if (response === null) {
          loadPromptOpen = false;
          return;
        }
        quitNow(1);
        return;
      }
    })();
  });

  wc.on("preload-error", (_event, preloadPath, error) => {
    writeCrashLog("preload-error", error);
    logError(`[crash] ${label} preload error (${preloadPath}): ${stackOf(error)}`);
  });
}

/* ------------------------------ 装配 ------------------------------ */

export function installCrashGuard(): void {
  if (installed) return;
  installed = true;

  // 本地收集原生崩溃转储（不上传）：renderer/GPU 原生崩溃时只有这里留得下证据
  try {
    crashReporter.start({
      productName: "Kova",
      uploadToServer: false,
      compress: true,
    });
  } catch (e: any) {
    logWarn(`[crash] crashReporter unavailable: ${e?.message ?? e}`);
  }

  // 启动期崩溃可能走不到建窗：Dock 图标在这里独立于窗口尽早换上
  void app.whenReady().then(() => applyDevDockIcon()).catch(() => undefined);

  // 兜底 handler 自身绝不能再抛：递归进入 uncaughtException 会让进程直接 abort
  const safeFatal = (kind: string, err: unknown) => {
    try {
      onFatal(kind, err);
    } catch (e: any) {
      try {
        logError(`[crash] fatal handler failed: ${e?.message ?? e}`);
      } catch {
        /* 连日志都写不了就放弃，保持进程存活 */
      }
    }
  };

  process.on("uncaughtException", (err) => safeFatal("uncaughtException", err));
  process.on("unhandledRejection", (reason) => {
    // unhandledRejection 默认不弹窗（第三方库常见非致命），只记录；
    // 需要把它当致命错误时打开 KOVA_CRASH_ON_REJECTION=1。
    if (CRASH_ON_REJECTION) {
      safeFatal("unhandledRejection", reason);
      return;
    }
    const stack = writeCrashLog("unhandledRejection", reason);
    logError(`[crash] unhandledRejection:\n${stack}`);
  });

  // 正常退出期间会销毁 renderer、杀掉 GPU/utility 子进程：先置位，
  // 避免退出流程触发恢复弹窗或把"退出"误判成崩溃。
  app.on("before-quit", () => {
    shuttingDown = true;
  });

  app.on("child-process-gone", (_event, details) => {
    const line = `type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`;
    if (details.reason === "clean-exit") {
      logInfo(`[crash] child process gone (${line})`);
      return;
    }
    writeCrashLog("child-process-gone", new Error(line));
    logWarn(`[crash] child process gone (${line})`);
  });
}
