/**
 * 真终端 PTY 后端（对齐 pty.rs）：node-pty（Unix forkpty 等价）；
 * 输出经 Channel 推字节数组（number[]，空数组 = 壳退出标记）；
 * 同 id 顶替、channel 死→杀壳、上限交前端管（MAX_SHELL_SESSIONS 在前端）。
 */
import type { ChannelArg, ChannelPusher } from "./ipc";
import type { IPty as Pty } from "node-pty";
import { logWarn } from "./logging";

interface PtySession {
  pty: Pty;
}
const sessions = new Map<string, PtySession>();

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: "powershell.exe", args: ["-NoLogo"] };
  const s = process.env.SHELL;
  return { file: s && s.length > 0 ? s : "/bin/bash", args: [] };
}

export async function ptyOpen(
  args: { id: string; cwd?: string | null; cols: number; rows: number; onData?: ChannelArg },
  push: ChannelPusher,
): Promise<null> {
  const id = String(args.id);
  // 同 id 已有活会话：先顶替（前端刷新竞态自愈）
  const old = sessions.get(id);
  if (old) {
    try {
      old.pty.kill();
    } catch {
      /* ignore */
    }
    sessions.delete(id);
  }

  // node-pty 延迟加载：加载失败（native 未编译）时 pty 面板报错、其余功能照常
  const ptyMod = await loadNodePty();
  const { file, args: shellArgs } = defaultShell();
  let pty: Pty;
  try {
    pty = ptyMod.spawn(file, shellArgs, {
      name: "xterm-256color",
      cols: Math.max(2, Math.trunc(args.cols ?? 80)),
      rows: Math.max(2, Math.trunc(args.rows ?? 24)),
      cwd: args.cwd && args.cwd.length > 0 ? args.cwd : undefined,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });
  } catch (e: any) {
    throw new Error(`spawn ${file} failed: ${e?.message ?? e}`);
  }

  const session: PtySession = { pty };
  sessions.set(id, session);

  let ended = false;
  pty.onData((data: string) => {
    try {
      push(Array.from(Buffer.from(data, "utf8")));
    } catch {
      // channel 报错 = webview 已刷新/销毁：杀壳回收
      if (!ended) {
        ended = true;
        try {
          pty.kill();
        } catch {
          /* ignore */
        }
        if (sessions.get(id) === session) sessions.delete(id);
        try {
          push([]);
        } catch {
          /* channel 已死则忽略 */
        }
      }
    }
  });
  pty.onExit(() => {
    if (sessions.get(id) === session) sessions.delete(id);
    push([]); // 退出标记
  });
  return null;
}

let nodePtyMod: typeof import("node-pty") | null | undefined;
async function loadNodePty(): Promise<typeof import("node-pty")> {
  if (nodePtyMod === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      nodePtyMod = require("node-pty");
    } catch (e: any) {
      logWarn(`pty: node-pty unavailable: ${e?.message ?? e}`);
      nodePtyMod = null;
    }
  }
  if (!nodePtyMod) throw new Error("terminal is unavailable (node-pty not built)");
  return nodePtyMod;
}

export function ptyWrite(args: { id: string; data: string }): null {
  const s = sessions.get(String(args.id));
  if (!s) throw new Error("pty session not found");
  s.pty.write(String(args.data ?? ""));
  return null;
}

export function ptyResize(args: { id: string; cols: number; rows: number }): null {
  const s = sessions.get(String(args.id));
  if (!s) throw new Error("pty session not found");
  try {
    s.pty.resize(Math.max(2, Math.trunc(args.cols)), Math.max(2, Math.trunc(args.rows)));
  } catch (e: any) {
    throw new Error(`pty resize failed: ${e?.message ?? e}`);
  }
  return null;
}

export function ptyClose(args: { id: string }): null {
  const s = sessions.get(String(args.id));
  if (s) {
    sessions.delete(String(args.id));
    try {
      s.pty.kill();
    } catch {
      /* 重复 close / 已退出：静默幂等 */
    }
  }
  return null;
}

/** 应用退出：杀掉所有活终端（对齐 Rust 进程随壳死；这里显式收） */
export function killAllPty(): void {
  for (const [, s] of sessions) {
    try {
      s.pty.kill();
    } catch {
      /* ignore */
    }
  }
  sessions.clear();
}
