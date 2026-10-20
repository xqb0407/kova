/**
 * 命令注册总装：一个 ipcMain.handle 收全部渲染层 invoke（对齐旧桌面壳
 * generate_handler 清单）。命令名、参数名（camelCase）、错误字符串与 Rust 版一致。
 */
import { register, makeChannelPusher, isChannelArg, setWatchedSessions, type CmdCtx } from "./ipc";
import { setupStoreCommands } from "./store";
import { setupLoggingCommands } from "./logging";
import { setupFsCommands } from "./fs-cmds";
import { setupLibraryCommands } from "./library-cmds";
import { ensureLibraryRoot } from "./library";
import { setupNotifyCommands } from "./notify";
import { setupWebhookCommands } from "./webhook";
import { setupAboutCommands } from "./about";
import { setupGpuCommands } from "./gpu";
import { setupAppearanceCommands } from "./appearance";
import { setupBridgeCommands } from "./bridge";
import { setupResourceCommands } from "./resource";
import { setupGitCommands } from "./git";
import { setupBrowserCommands } from "./browser";
import { setupRemoteCommands } from "./remote";
import { setupTunnelCommands } from "./tunnel";
import { setupBackupCommands } from "./backup";
import { setupUpdateCommands } from "./update";
import * as pty from "./pty";
import * as pi from "./pi-agent";

export function registerAllCommands(): void {
  setupStoreCommands(register);
  setupLoggingCommands(register);
  setupFsCommands(register);
  // 资料库：注册命令前先确保根目录在位（用户改过位置也照样建；index.ts 里
  // initStore 先于本函数，kv 可读）
  ensureLibraryRoot();
  setupLibraryCommands(register);
  setupNotifyCommands(register);
  setupWebhookCommands(register);
  setupAboutCommands(register);
  setupGpuCommands(register);
  setupAppearanceCommands(register);
  setupBridgeCommands(register);
  setupResourceCommands(register);
  setupGitCommands(register);
  setupBrowserCommands(register);
  setupRemoteCommands(register);
  setupTunnelCommands(register);
  setupBackupCommands(register);
  setupUpdateCommands(register);

  /* pi-agent 桥（对齐 pi_agent.rs commands） */
  register("pi_prompt", (a) => pi.piPrompt(a as any));
  register("pi_abort", (a) => pi.piAbort(a as any));
  register("pi_reset", () => pi.piReset());
  register("pi_request", (a) => pi.piRequest(a as any));
  // 渲染层声明本窗口正在看的会话：pi-chunk-batch 的逐 token 增量据此裁剪
  register("pi_watch_sessions", (a, ctx) => {
    setWatchedSessions(ctx.sender, a.sessions);
    return null;
  });

  /* PTY（对齐 pty.rs：on_data 为 Channel） */
  register("pty_open", (a: any, ctx: CmdCtx) => {
    if (!isChannelArg(a.onData)) throw new Error("pty_open requires on_data channel");
    return pty.ptyOpen({ id: String(a.id), cwd: a.cwd ?? null, cols: Number(a.cols ?? 80), rows: Number(a.rows ?? 24), onData: a.onData }, makeChannelPusher(ctx.sender, a.onData));
  });
  register("pty_write", (a) => pty.ptyWrite(a as any));
  register("pty_resize", (a) => pty.ptyResize(a as any));
  register("pty_close", (a) => pty.ptyClose(a as any));
}
