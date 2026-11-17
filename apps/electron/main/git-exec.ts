/**
 * git 子进程执行（git.ts / worktrees.ts 共用）：只负责 spawn 与结果收集，
 * 不做任何 cwd 信任判定——调用方自行过守卫。
 *
 * opts.timeoutMs：到点杀进程并按失败结算（stderr 标记 timeout）。本地命令
 * 一般不传；网络类命令（fetch/push/ls-remote）必须传，避免网络卡顿占住 UI。
 */
import { spawn } from "node:child_process";
import { guardStreamErrors } from "./child-stream";

export interface GitOut {
  ok: boolean;
  stdout: Buffer;
  stderr: string;
}

export function gitRun(
  args: string[],
  opts: {
    stdin?: Buffer;
    env?: Record<string, string>;
    cwd?: string;
    timeoutMs?: number;
  } = {},
): Promise<GitOut> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...(opts.env ?? {}) },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            try {
              child.kill("SIGKILL");
            } catch {
              /* 已退出 */
            }
          }, opts.timeoutMs)
        : null;
    timer?.unref?.();
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    // git 可能在读完 stdin 前退出（apply --check 冲突、非仓库、hook 失败等），
    // 随后写 stdin 会异步失败；没有 'error' 监听就升级成主进程 uncaughtException
    //（win32 上即 "write EOF"）。成败以 close 的退出码/stderr 为准。
    guardStreamErrors(child.stdin);
    guardStreamErrors(child.stdout);
    guardStreamErrors(child.stderr);
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) =>
      settle(() => reject(new Error(`failed to run git: ${e.message}`))),
    );
    child.on("close", (code) => {
      const stderr = Buffer.concat(err).toString("utf8").trim();
      settle(() =>
        resolve({
          ok: !timedOut && code === 0,
          stdout: Buffer.concat(out),
          stderr: timedOut
            ? `${stderr}${stderr ? " " : ""}[timeout after ${opts.timeoutMs}ms]`
            : stderr,
        }),
      );
    });
    if (opts.stdin) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}
