/**
 * 命令路由：渲染层 invoke → 主进程注册表（对齐旧桌面壳的 invoke_handler +
 * panic_guard：任何 handler 异常都被捕获为 {ok:false,error}，绝不让主进程崩）。
 * 事件面：emitToWindows 对齐旧桌面壳 app.emit；Channel 参数（{__ch__:id}）
 * 提供反向推送器，对齐 旧桌面壳的 IPC Channel。
 */
import { BrowserWindow, ipcMain, type WebContents } from "electron";
import { logDebug, logError, logInfo } from "./logging";
import { noteMainOp } from "./slow-ops";

export type CmdCtx = { sender: WebContents };
export type CmdHandler = (args: Record<string, any>, ctx: CmdCtx) => unknown | Promise<unknown>;

const commands = new Map<string, CmdHandler>();

export function register(name: string, fn: CmdHandler): void {
  if (commands.has(name)) throw new Error(`duplicate command: ${name}`);
  commands.set(name, fn);
}

export function hasCommand(name: string): boolean {
  return commands.has(name);
}

/** Channel 参数形状（渲染层 _host.ts 序列化产物） */
export type ChannelArg = { __ch__: string };
export function isChannelArg(v: unknown): v is ChannelArg {
  return typeof v === "object" && v !== null && "__ch__" in (v as object);
}
export type ChannelPusher = (data: unknown) => void;

export function makeChannelPusher(sender: WebContents, ch: ChannelArg): ChannelPusher {
  return (data: unknown) => {
    if (sender.isDestroyed()) return;
    sender.send("kova-channel", { id: ch.__ch__, data });
  };
}

export function setupIpc(): void {
  ipcMain.handle("kova-invoke", async (event, payload: { cmd: string; args: unknown }) => {
    const { cmd, args } = payload ?? ({} as any);
    const fn = commands.get(cmd);
    if (!fn) {
      // 旧桌面壳 未知命令报错形状：command <name> not found
      return { ok: false, error: `command ${cmd} not found` };
    }
    try {
      const t0 = Date.now();
      const value = await fn((args ?? {}) as Record<string, any>, { sender: event.sender });
      // 慢命令自报：同步 fs / 同步 SQLite 会把事件循环按住（界面"哪里都点不了"），
      // 留痕后生产日志能直接点名；lag 心跳也据此归因（见 slow-ops.ts）
      noteMainOp(cmd, Date.now() - t0);
      return { ok: true, value: value ?? null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 这些是用户状态而非系统故障（git 非仓库/未安装、目录不存在、workspace
      // 不匹配、未选择目录），渲染层会自行降级；不再按 ERROR 每次 focus 刷屏。
      const expected =
        /^(not-repo|no-git|cwd-not-allowed|cwd-missing|workspace-missing|bad-path|home-not-allowed|app-data-not-allowed|too-many)(?::|$)/.test(
          msg,
        );
      if (expected) logDebug(`[ipc] ${cmd}: ${msg}`);
      else logError(`[ipc] ${cmd} failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });
}

/** 对齐旧桌面壳 `app.emit(name, payload)`：广播到全部窗口 */
export function emitToWindows(name: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("kova-event", { event: name, payload });
  }
}

/** 定向发射（对齐 emit_to("main", …)） */
export function emitToWindow(label: string, name: string, payload: unknown): void {
  const w = windowsByLabel.get(label);
  if (w && !w.isDestroyed()) w.webContents.send("kova-event", { event: name, payload });
}

const windowsByLabel = new Map<string, BrowserWindow>();

export function trackWindow(label: string, win: BrowserWindow): void {
  windowsByLabel.set(label, win);
  win.once("closed", () => windowsByLabel.delete(label));
}

export function getWindow(label: string): BrowserWindow | undefined {
  return windowsByLabel.get(label);
}

export function focusMainWindow(): void {
  const win = windowsByLabel.get("main");
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  logInfo("[ipc] main window focused");
}
