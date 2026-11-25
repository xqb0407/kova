/**
 * Electron 主入口（对齐 lib.rs 的启动装配顺序）：
 * 单实例 → 路径/日志 →（备份换入挂点）→ SQLite → GPU 开关 → 协议/CSP →
 * 主窗口（首帧再显示）→ 菜单/托盘 → 附件定时清理 → 预热 sidecar → 退出收尸。
 */
import { app, BrowserWindow, protocol, net } from "electron";
import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { initPaths, appDataDir } from "./paths";
import { isTrustedFilePath } from "./fs-cmds";
import { PREVIEW_INJECT_SCRIPT } from "./preview-inject";
import { initLogging, logError, logInfo, logWarn } from "./logging";
import { lastSlowMainOp, SLOW_OP_ATTRIBUTION_WINDOW_MS } from "./slow-ops";
import { installCrashGuard } from "./crash";
import { setupIpc, focusMainWindow } from "./ipc";
import { registerAllCommands } from "./registry";
import { installBrowserSessionGuards } from "./browser-permissions";
import { installWebviewGuards } from "./browser-guards";
import { getDb, initStore } from "./store";
import { encrypt, initSecretCipher, isSecretCipherReady } from "./secret";
import { migrateSecretsToEncrypted } from "./secret-migration";
import { syncCredentialFile } from "./credential-file-sync";
import { applyGpuFlag, logGpuStatus } from "./gpu";
import { applyPendingRestore, applyRestoreSanitize } from "./backup";
import { createMainWindow, attachExternalLinkGuards } from "./window";
import * as tray from "./tray";
import * as menu from "./menu";
import { startAttachmentPruneTimer } from "./fs-cmds";
import * as pi from "./pi-agent";
import * as automation from "./automation-service";
import * as remote from "./remote";
import * as quit from "./quit";
import { autoStartUhpServer } from "./uhp";
import { startImSubsystem } from "./im/im-commands";
import { initWebhookKv, startWebhookServer, stopWebhookServer } from "./webhook-server";
import { startTriggerWatchers } from "./trigger-watchers";
import { noteInboxChanged } from "./tray-status";
import {
  initInboxConnectors,
  stopInboxConnectors,
} from "./inbox-connectors";
import { kvGet, kvSet } from "./store";
import { reapOrphanBgTasks, setBgOrphanKv } from "./tool-exec";

// 孤儿后台任务登记的 kv 读写（tool-exec 不能静态 import store——测试环境
// 没有 Electron 宿主；运行时注入解耦）
setBgOrphanKv({ get: kvGet, set: kvSet });

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
  ".apng": "image/png",
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
  "img-src 'self' data: blob: https: http: kova:; font-src 'self' data:; connect-src 'self' ws: wss: http://127.0.0.1:* http://localhost:* https: kova:; " +
  "worker-src 'self' blob:; frame-src 'self' data: blob: https: kova:; media-src 'self' data: blob:; object-src 'none'; base-uri 'self'; form-action 'self'";

function registerStaticProtocol(): void {
  protocol.handle("kova", async (request) => {
    try {
      const url = new URL(request.url);
      // kova://pet/<宠物目录>/<文件>：桌宠库资源直出（对齐 Codex 的 ~/.codex/pets
      // 模型——放文件夹进 appData/pets 即可用）。路径钳在库目录内，防穿越。
      if (url.hostname === "pet") {
        let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
        const clean = normalize(rel).replace(/\\/g, "/");
        if (clean === "" || clean.split("/").includes("..")) {
          return new Response("forbidden", { status: 403 });
        }
        const root = join(appDataDir(), "pets");
        const abs = join(root, ...clean.split("/"));
        if (!abs.startsWith(root + sep)) return new Response("forbidden", { status: 403 });
        if (!existsSync(abs) || !statSync(abs).isFile()) {
          return new Response("not found", { status: 404 });
        }
        const resp = await net.fetch(pathToFileURL(abs).toString());
        const ext = abs.slice(abs.lastIndexOf("."));
        const headers = new Headers(resp.headers);
        headers.set("content-type", MIME[ext] ?? "application/octet-stream");
        return new Response(resp.body, { status: resp.ok ? 200 : 404, headers });
      }
      // kova://file/<绝对路径>：受信根内的本地文件直出（HTML 预览 iframe 用——
      // srcDoc 的 about:srcdoc 没有基址，相对路径的图片/CSS 一律解析不了）。
      // 只放行「当前 workspace / task-workspace / 资料库根」子树内真实存在的文件。
      if (url.hostname === "file") {
        let p = decodeURIComponent(url.pathname);
        if (process.platform === "win32") p = p.replace(/^\/+/, "");
        if (!existsSync(p) || !isTrustedFilePath(p)) {
          return new Response("forbidden", { status: 403 });
        }
        if (!require("node:fs").statSync(p).isFile()) {
          return new Response("not-a-file", { status: 403 });
        }
        const resp = await net.fetch(pathToFileURL(p).toString());
        const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
        const headers = new Headers(resp.headers);
        headers.set("content-type", MIME[ext] ?? "application/octet-stream");
        // HTML 追加预览脚本（查找引擎 + 右键菜单上报）：iframe 是跨源
        // sandbox，宿主摸不到内部 DOM，能力只能由文档自带（见 preview-inject.ts）。
        // 原字节不动、只在末尾追加——页面自身的脚本/布局不受影响。
        if (ext === ".html" || ext === ".htm") {
          const body = Buffer.from(await resp.arrayBuffer());
          const injected = Buffer.concat([
            body,
            Buffer.from(PREVIEW_INJECT_SCRIPT, "utf8"),
          ]);
          return new Response(injected, {
            status: resp.ok ? 200 : 404,
            headers,
          });
        }
        // 不套应用自身的 CSP：预览的是用户页面，iframe sandbox 已是它的边界
        return new Response(resp.body, { status: resp.ok ? 200 : 404, headers });
      }
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

/**
 * 主进程事件循环 lag 心跳：任何同步阻塞点（sqlite 长 BUSY 自旋、漏网的
 * spawnSync 子进程…）冻住主循环时，全部 IPC 排队、UI"哪里都点不了"——
 * 这条心跳是事后唯一能区分「主进程卡住」还是「渲染进程卡住」的证据。
 * 每 1s 采样，单次漂移 >2s 记一行日志（含漂移时长与最近一条慢操作归因，
 * 见 slow-ops.ts），unref 不拖住退出。
 */
function startLagWatchdog(): void {
  let last = Date.now();
  const t = setInterval(() => {
    const now = Date.now();
    const drift = now - last - 1000;
    if (drift > 2000) {
      const slow = lastSlowMainOp();
      const attribution =
        slow && now - slow.at <= SLOW_OP_ATTRIBUTION_WINDOW_MS
          ? `（最近慢操作：${slow.label} ${slow.ms}ms）`
          : "（无慢操作留痕：可能是渲染进程卡住，或纯同步死循环）";
      logWarn(`[lag] main loop stalled ~${drift}ms${attribution}`);
    }
    last = now;
  }, 1000);
  t.unref?.();
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
  // 接管 Electron 默认的英文崩溃窗：必须在 initStore/applyPendingRestore
  // 等可能抛错的启动步骤之前装好（启动期异常在 ready 后走恢复对话框）
  installCrashGuard();
  // 退出守卫：⌘Q 按住确认 / 菜单托盘退出保持旧行为（见 quit.ts）
  quit.installQuitGuard();
  startLagWatchdog(); // 尽早开表：启动期同步阻塞（备份换入/存储打开）也要留痕
  applyPendingRestore(); // 待恢复备份换入：必须早于任何存储打开（当前为挂点）
  initStore();
  // SIGKILL 孤儿后台任务回收：db 就绪即可读上一次实例的登记。必须在
  // ensureSpawned 预热之前——先回收，别让新任务表里的 id 与旧进程混淆。
  try {
    const reaped = reapOrphanBgTasks();
    if (reaped > 0) logWarn(`[kova] reaped ${reaped} orphan background task(s) from previous run`);
  } catch (e: any) {
    logWarn(`[kova] bg orphan reap failed: ${e?.message ?? e}`);
  }
  applyGpuFlag(); // 建窗前读开关（与 gpu.rs create_windows 时序同构）

  void app.whenReady().then(async () => {
    // GPU 特性/设备留痕：3D/WebGL 页面卡顿靠这行区分「驱动回退到软件渲染」与
    // 「主进程同步阻塞」。异步读，不挡启动。
    void logGpuStatus();
    // 主密钥必须在 ready 之后初始化（Linux safeStorage 依赖 ready），且要早于
    // 任何会 encrypt/decrypt 的 IPC/命令注册。迁移把历史明文行原地加密。
    initSecretCipher();
    if (isSecretCipherReady()) {
      try {
        const migrated = migrateSecretsToEncrypted(getDb(), encrypt);
        logInfo(
          `[secret] migration: migrated=${migrated.migrated} legacy=${migrated.legacy} failed=${migrated.failed}`,
        );
      } catch (e) {
        logError(`[secret] migration failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    // 换机恢复后的密文探测：必须在密钥初始化与明文迁移之后（此时 decrypt 才可用）。
    // 没有 restore-applied 标记时是 no-op。
    try {
      applyRestoreSanitize();
    } catch (e) {
      logError(`[backup] restore sanitize failed: ${e instanceof Error ? e.message : e}`);
    }
    // 共享凭据文件镜像（~/.kova/credentials.json）：启动重建一次。必须在主密钥
    // 就绪之后（否则 decrypt 全败会把好镜像覆盖成空凭据）且在恢复消毒之后
    // （镜像要反映消毒后的表）。之后各写 handler 增量重建（见 data.ts）。
    // sidecar（ACP/本地模式）启动时只读注入；失败不影响桌面功能。
    if (isSecretCipherReady()) {
      try {
        syncCredentialFile(getDb());
      } catch (e) {
        logError(`[credential-file] startup sync failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    registerStaticProtocol();
    setupIpc();
    registerAllCommands();
    // 收件箱外部来源：配置就绪后开始轮询；sidecar 未就绪时先缓存快照，
    // spawn 回调会补推（不会因为侧车晚起而丢条目）。
    initInboxConnectors();
    // 浏览器面板 partition 的权限闸门必须先于任何 webview 导航装好
    // （Electron 未注册 handler 时会自动批准所有敏感权限）。
    installBrowserSessionGuards();
    pi.setRemoteModule(remote as any);
    remote.stopOnExit; // 显式引用避免摇树掉模块图副作用
    const win = createMainWindow(DEV ? DEV_URL : null);
    attachExternalLinkGuards(win);
    installWebviewGuards(win);
    // 浏览器面板是 <webview> DOM 元素：主页面（重）加载即随文档销毁，
    // 不再需要"重载时移除原生子视图"的钩子（旧 WebContentsView 时代遗留）
    menu.install();
    // macOS 也建托盘（Headless v1：关窗 hide 后菜单栏提供状态与唤回）
    if (process.platform === "win32" || process.platform === "darwin") {
      try {
        tray.init();
      } catch (e: any) {
        logError(`[tray] init failed: ${e?.message ?? e}`);
      }
    }
    startAttachmentPruneTimer();
    // 预热拉起自动化调度器与 sidecar：调度器必须早于用户首条消息存活。
    // dev 源码模式由 sidecar 进程内调度（KOVA_AUTOMATION_INPROC=1），不拉二进程。
    // 二进制缺失也先切 in-process：避免 sidecar 远程超时后才回退，期间和
    // 稍后拉起的调度器短暂并存。
    if (process.env.KOVA_AUTOMATION_INPROC !== "1") {
      if (automation.automationBinaryAvailable()) {
        void automation
          .ensureAutomationSpawned()
          .catch((e) => logError(`[automation] warm start failed: ${e?.message ?? e}`));
      } else {
        process.env.KOVA_AUTOMATION_INPROC = "1";
        logWarn("[automation] binary unavailable; sidecar will schedule in-process");
      }
    }
    void pi.ensureSpawned().catch((e) => logError(`[worker] warm start failed: ${e?.message ?? e}`));
    // UHP server is opt-in; auto-start only when the setting is enabled.
    void autoStartUhpServer();
    // 托盘初始待处理数：跨会话保留的 inbox 条目不会自发变更帧，启动补拉一次
    // （侧车冷启动慢就让首个 inbox_changed 修正，不阻塞启动）
    void (async () => {
      try {
        const line = await pi.piRequestInternal({
          payload: { type: "list_inbox", limit: 1 },
          timeoutMs: 12_000,
        });
        const parsed = JSON.parse(line) as { counts?: Record<string, unknown> };
        noteInboxChanged(parsed.counts);
      } catch {
        /* sidecar 未就绪：等真实变更帧 */
      }
    })();
    // IM 通道启动恢复（微信等 enabled 通道续长轮询；失败不阻断启动）
    void startImSubsystem().catch((e) => logError(`[im] restore failed: ${e?.message ?? e}`));
    // 事件触发 webhook 端点（127.0.0.1；失败不阻断启动，触发器功能退化为不可用）
    initWebhookKv(kvGet, kvSet);
    void startWebhookServer().catch((e) => logError(`[webhook] start failed: ${e?.message ?? e}`));
    // 事件触发器 watcher（文件/git）：workspace 来自 kv "workspace"
    try {
      startTriggerWatchers(kvGet("workspace"));
    } catch (e: any) {
      logError(`[triggers] start failed: ${e?.message ?? e}`);
    }
    logInfo(`[kova] electron shell ready (data: ${appDataDir()}, dev=${DEV})`);
    // worktree 冒烟（KOVA_SMOKE_WORKTREES=1）：走真实命令表跑全链路后退出。
    // 数据目录由 scripts/smoke-worktrees.mjs 指向临时目录，不碰用户数据。
    if (process.env.KOVA_SMOKE_WORKTREES === "1") {
      void import("./smoke-worktrees")
        .then((m) => m.runWorktreeSmoke())
        .then((result) => {
          process.stdout.write(`[smoke:worktrees] ${JSON.stringify(result)}\n`);
          app.exit(result.ok ? 0 : 1);
        })
        .catch((err) => {
          process.stdout.write(
            `[smoke:worktrees] crashed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          app.exit(1);
        });
    }
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
