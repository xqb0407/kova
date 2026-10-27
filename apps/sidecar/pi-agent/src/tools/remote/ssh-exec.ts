/**
 * SSH 执行通道（远程项目工具层）：系统 `ssh` CLI 的薄封装。
 *
 * 选型（v1）：不用 ssh2 库——spawn 系统 ssh 白送 ProxyJump、~/.ssh/config
 * 别名解析与 agent 认证；连接复用用 ControlMaster=auto（同 host:port:user
 * 的后续 exec 走已建通道，ControlPersist 兜休眠恢复）。密码认证需要 sshpass，
 * v1 明确不支持（错误信息里指引改用密钥）。
 *
 * 口径对齐：
 * - 所有命令统一 `/bin/sh -c` 包装（远端默认 shell 可能是 fish，见 ZCode
 *   packages/server/src/remote/ssh-backend.ts 的教训）；
 * - keepalive 15s×3（同 sshAuth.ts），ConnectTimeout 8s，accept-new 免首次
 *   host key 交互确认（变更仍拒绝，安全语义不变）；
 * - 取消 = kill 本地 ssh 进程：通道关闭时远端命令收 SIGHUP 退出。
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RemoteTarget } from "../../types";

const CONNECT_TIMEOUT_S = 8;
const KEEPALIVE_INTERVAL_S = 15;
const KEEPALIVE_COUNT_MAX = 3;
/** 默认命令超时（bash 工具同款默认 120s） */
export const REMOTE_DEFAULT_TIMEOUT_MS = 120_000;
/** 命令超时上限（bash 工具同款 600s） */
export const REMOTE_MAX_TIMEOUT_MS = 600_000;
/** 输出累积上限（信封 truncated 语义的分界） */
export const REMOTE_OUTPUT_CAP_BYTES = 512 * 1024;

function controlDir(): string {
  const dir = join(homedir(), ".kova", "ssh-mux");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // 复用失败只退化为每命令一条连接，不阻断执行
  }
  return dir;
}

/** POSIX 单引号包裹（' → '\''），防注入/防空格拆词 */
export function quotePosixShellArg(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** 目标串：user@host（-p 由 portOptions 携带）；host 允许直接是 ssh config 别名 */
export function remoteTargetArg(target: RemoteTarget): string {
  const host = target.host.trim();
  return target.username?.trim() ? `${target.username.trim()}@${host}` : host;
}

export function targetOptions(target: RemoteTarget): string[] {
  const opts = [
    "-o", `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
    "-o", `ServerAliveInterval=${KEEPALIVE_INTERVAL_S}`,
    "-o", `ServerAliveCountMax=${KEEPALIVE_COUNT_MAX}`,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "BatchMode=yes",
    // ControlMaster 多路复用：%C 是 host/port/user 的散列 token，天然按目标分桶
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${join(controlDir(), "mux-%C")}`,
    "-o", "ControlPersist=600",
  ];
  if (target.port && target.port !== 22) opts.push("-p", String(target.port));
  if (target.privateKeyPath?.trim()) {
    opts.push("-i", target.privateKeyPath.trim(), "-o", "IdentitiesOnly=yes");
  }
  return opts;
}

/** 无复用直连参数：mux 竞态/陈旧 socket 的一次性回退（见 runSshRemote 尾部重试） */
function directOptions(target: RemoteTarget): string[] {
  const opts = [
    "-o", `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
    "-o", `ServerAliveInterval=${KEEPALIVE_INTERVAL_S}`,
    "-o", `ServerAliveCountMax=${KEEPALIVE_COUNT_MAX}`,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "BatchMode=yes",
  ];
  if (target.port && target.port !== 22) opts.push("-p", String(target.port));
  if (target.privateKeyPath?.trim()) {
    opts.push("-i", target.privateKeyPath.trim(), "-o", "IdentitiesOnly=yes");
  }
  return opts;
}

/** mux 层错误（竞态抢 socket / 陈旧 socket / master 崩了）——值得直连重试一次 */
function isMuxError(message: string): boolean {
  return /mux|control socket|controlsocket|already exists/i.test(message);
}

/** 远端脚本：cd 到工作目录（可选）后执行，统一 POSIX 语义 */
export function remoteScript(command: string, cwd?: string): string {
  const body = cwd?.trim() ? `cd ${quotePosixShellArg(cwd.trim())} && ${command}` : command;
  return `/bin/sh -c ${quotePosixShellArg(body)}`;
}

/**
 * bash 工具专用脚本：cd（可选）→ 合并 stderr → 原样执行命令。
 * 不用 `{ cmd; } 2>&1` 包装——命令以 `&` 结尾或含独立 `}` token 会触发
 * sh 语法错误（实测）；`exec 2>&1` 对整个脚本生效且零包装风险。
 */
export function remoteBashScript(command: string, cwd?: string): string {
  const lines: string[] = [];
  if (cwd?.trim()) lines.push(`cd ${quotePosixShellArg(cwd.trim())} || exit 127`);
  lines.push("exec 2>&1");
  lines.push(command);
  return `/bin/sh -c ${quotePosixShellArg(lines.join("\n"))}`;
}

export type RemoteRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

export type RemoteRunOptions = {
  /** 远端工作目录（存在性由调用方保证；不存在时 cd 失败 → exit 1） */
  cwd?: string;
  /** 写入远端命令 stdin（write/cat > file 用） */
  stdin?: string | Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 输出上限（默认 REMOTE_OUTPUT_CAP_BYTES，超出截断并标记） */
  maxOutputBytes?: number;
  /** true = 非零退出也 resolve（bash 语义：命令失败是结果不是异常），stderr 单独返回 */
  resolveOnNonZeroExit?: boolean;
};

export class RemoteSshError extends Error {
  readonly exitCode: number | null;
  readonly stderrTail: string;
  constructor(message: string, exitCode: number | null, stderrTail: string) {
    super(message);
    this.name = "RemoteSshError";
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

/** ssh2 风格认证失败归一（模型/用户可读，指引改密钥） */
function normalizeSshError(stderr: string, exitCode: number | null): RemoteSshError {
  const tail = stderr.trim().split("\n").slice(-4).join(" ").slice(0, 600);
  if (/permission denied/i.test(stderr) && /publickey|password/i.test(stderr)) {
    return new RemoteSshError(
      "SSH 认证失败：请确认该主机已配置密钥登录（ssh <host> 可直连）。当前远程执行不支持密码认证。",
      exitCode,
      tail,
    );
  }
  if (/connection (refused|timed out)|could not resolve hostname/i.test(stderr)) {
    return new RemoteSshError(`SSH 连接失败：${tail || "无法建立连接"}`, exitCode, tail);
  }
  return new RemoteSshError(`远程命令失败（exit ${exitCode ?? "?"}）: ${tail}`, exitCode, tail);
}

function sshRunOnce(
  args: string[],
  options: RemoteRunOptions | undefined,
  cap: number,
  timeoutMs: number,
  command: string,
): Promise<RemoteRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, {
      stdio: ["pipe", "pipe", "pipe"],
      // 复用 ControlMaster 时 ssh 可能 prompt pass短语——BatchMode 已禁；
      // detached 无必要：随 sidecar 退出而退出
    });

    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    const abort = () => {
      if (settled) return;
      child.kill("SIGTERM");
      // 2s 宽限后强杀，防止 ssh 忽略 TERM 挂住
      const grace = setTimeout(() => child.kill("SIGKILL"), 2_000);
      grace.unref?.();
    };
    options?.signal?.addEventListener("abort", abort, { once: true });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(
        new RemoteSshError(
          `远程命令超时（${Math.round(timeoutMs / 1000)}s）：${command.slice(0, 120)}`,
          null,
          "",
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes < cap) {
        stdoutBytes += chunk.length;
        stdout.push(stdoutBytes > cap ? chunk.subarray(0, chunk.length - (stdoutBytes - cap)) : chunk);
        if (stdoutBytes >= cap) truncated = true;
      } else {
        truncated = true;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 64 * 1024) return; // stderr 只做诊断，64KB 足够
      stderrBytes += chunk.length;
      stderr.push(chunk);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", abort);
      reject(new RemoteSshError(`ssh 启动失败: ${error.message}`, null, ""));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", abort);
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (options?.signal?.aborted) {
        reject(new RemoteSshError("远程命令已取消", null, ""));
        return;
      }
      if (code !== 0 && !options?.resolveOnNonZeroExit) {
        reject(normalizeSshError(stderrText, code));
        return;
      }
      resolve({ exitCode: code ?? 0, stdout: stdoutText, stderr: stderrText, truncated });
    });

    if (options?.stdin != null) {
      child.stdin.on("error", () => {
        /* 远端 cat 提前退出时 EPIPE：交给 close 分支报错 */
      });
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * 在远端执行一条命令并等待结束。非零退出码抛 RemoteSshError（调用方可拿
 * exitCode/stderr 组装信封——bash 工具要展示失败输出，read/write 要直接抛）。
 * mux 竞态（并行首连抢同一 ControlPath / 陈旧 socket）自动直连重试一次。
 */
/**
 * 原始脚本执行（调用方自带 /bin/sh -c 包装，如 remoteBashScript）。
 * 非零退出码抛 RemoteSshError（resolveOnNonZeroExit 可覆盖）；mux 竞态直连重试。
 */
export function runSshScript(
  target: RemoteTarget,
  script: string,
  options?: RemoteRunOptions,
): Promise<RemoteRunResult> {
  const timeoutMs = Math.min(
    Math.max(options?.timeoutMs ?? REMOTE_DEFAULT_TIMEOUT_MS, 1_000),
    REMOTE_MAX_TIMEOUT_MS,
  );
  const cap = options?.maxOutputBytes ?? REMOTE_OUTPUT_CAP_BYTES;
  const buildArgs = (useMux: boolean): string[] => [
    ...(useMux ? targetOptions(target) : directOptions(target)),
    remoteTargetArg(target),
    "--",
    script,
  ];
  return sshRunOnce(buildArgs(true), options, cap, timeoutMs, script).catch((error) => {
    if (error instanceof RemoteSshError && isMuxError(error.message)) {
      return sshRunOnce(buildArgs(false), options, cap, timeoutMs, script);
    }
    throw error;
  });
}

/** cd 到工作目录（可选）后执行命令，统一 POSIX 语义（/bin/sh -c 包装） */
export function runSshRemote(
  target: RemoteTarget,
  command: string,
  options?: RemoteRunOptions,
): Promise<RemoteRunResult> {
  return runSshScript(target, remoteScript(command, options?.cwd), options);
}
