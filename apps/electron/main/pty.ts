/**
 * 真终端 PTY 后端（对齐 pty.rs）：node-pty（Unix forkpty 等价）；
 * 输出经 Channel 推字节数组（number[]，空数组 = 壳退出标记）；
 * 同 id 顶替、channel 死→杀壳、上限交前端管（MAX_SHELL_SESSIONS 在前端）。
 */
import { homedir } from "node:os";
import { existsSync } from "node:fs";
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
  args: {
    id: string;
    cwd?: string | null;
    /** 远程项目：开 SSH 交互会话代替本地 shell（本地 cwd 是远端路径，spawn 必失败） */
    remoteHostId?: string | null;
    cols: number;
    rows: number;
    onData?: ChannelArg;
  },
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

  // 远程项目：本地 shell + 远端 cwd 在 Windows 上 CreateProcess 直接失败
  //（error 268），改为本地开 ssh 交互会话；密码主机由 ssh 在终端里交互询问。
  let file: string;
  let shellArgs: string[];
  let spawnCwd: string | undefined;
  if (args.remoteHostId) {
    const { interactiveSshSpawn } = await import("./ssh");
    const target = interactiveSshSpawn(String(args.remoteHostId), args.cwd ?? undefined);
    if (!target) throw new Error("远程主机不存在或已删除，无法打开终端");
    file = target.file;
    shellArgs = target.args;
    spawnCwd = homedir(); // 本地合法目录：ssh 进程本身不依赖远端路径
  } else {
    const shell = defaultShell();
    file = shell.file;
    shellArgs = shell.args;
    // 本地 cwd 不存在（目录被删/远端路径误传）同样会让 spawn 失败：回落主目录
    const requested = args.cwd?.trim();
    spawnCwd =
      requested && existsSync(requested) ? requested : requested ? homedir() : undefined;
    if (requested && spawnCwd === homedir()) {
      logWarn(`[pty] cwd missing, falling back to home: ${requested}`);
    }
  }

  let pty: Pty;
  try {
    pty = ptyMod.spawn(file, shellArgs, {
      name: "xterm-256color",
      cols: Math.max(2, Math.trunc(args.cols ?? 80)),
      rows: Math.max(2, Math.trunc(args.rows ?? 24)),
      cwd: spawnCwd,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });
  } catch (e: any) {
    // Windows 上 ssh.exe 不存在时给可读提示（Win10+ 自带 OpenSSH 客户端）
    const hint =
      file === "ssh"
        ? "（需要本机安装 OpenSSH 客户端：Windows 设置 → 可选功能 → OpenSSH 客户端）"
        : "";
    throw new Error(`spawn ${file} failed${hint}: ${e?.message ?? e}`);
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
