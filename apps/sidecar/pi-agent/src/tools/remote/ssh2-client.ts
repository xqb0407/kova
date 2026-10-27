/**
 * ssh2 密码认证执行通道：系统 ssh CLI 无法非交互输密码，密码主机的工具
 * 执行走这里（ssh2 纯 JS 实现，Bun 兼容已验证）。
 *
 * - 连接池按 user@host:port 复用（ssh2 单连接多 exec channel，天然多路复用，
 *   无 ControlMaster 竞态问题）；空闲 10 分钟由 reaper 回收。
 * - 认证：password + tryKeyboard（部分服务器只开 keyboard-interactive，
 *   同一份密码经回调应答——对齐 ZCode sshAuth.ts 的做法）。
 * - keepalive 15s×3，readyTimeout 60s（弱网不误判），与 CLI 路径同口径。
 * - 密码只存在于本进程内存与连接配置；不落盘、不进日志。
 */
import { Client as SSH2Client, type ClientChannel, type ConnectConfig } from "ssh2";
import { createHash } from "node:crypto";
import type { RemoteTarget } from "../../types";
import { RemoteSshError } from "./ssh-exec";

export type PasswordTarget = RemoteTarget & { password: string };

const READY_TIMEOUT_MS = 60_000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_COUNT_MAX = 3;
const POOL_IDLE_EVICT_MS = 10 * 60_000;

interface PoolEntry {
  client: SSH2Client;
  ready: Promise<SSH2Client>;
  lastUsedAt: number;
}

const pool = new Map<string, PoolEntry>();
let reaperStarted = false;

function startReaper(): void {
  if (reaperStarted) return;
  reaperStarted = true;
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of pool) {
      if (now - entry.lastUsedAt > POOL_IDLE_EVICT_MS) {
        pool.delete(key);
        try {
          entry.client.end();
        } catch {
          /* 已断开 */
        }
      }
    }
  }, 60_000);
  timer.unref?.();
}

function normalizeAuthError(message: string): string {
  if (/all configured authentication methods failed/i.test(message)) {
    return "SSH 密码认证失败：请检查用户名与密码是否正确";
  }
  if (/keepalive/i.test(message)) {
    return "SSH 连接超时：服务器长时间无响应（keepalive 3 次未回应）";
  }
  if (/timed out|connect.*ETIMEDOUT|ECONNREFUSED|ENOTFOUND|getaddrinfo/i.test(message)) {
    return `SSH 连接失败：${message}`;
  }
  return message;
}

function poolKey(target: PasswordTarget): string {
  const user = target.username?.trim() || "";
  // 密码指纹参与 key：同一地址换密码（改密/改错后重试）不能复用旧凭据
  // 建立的连接——否则认证错误会被池里的健康连接掩盖
  const fingerprint = createHash("sha256").update(target.password).digest("hex").slice(0, 16);
  return `${user}@${target.host.trim()}:${target.port ?? 22}\0${fingerprint}`;
}

function buildConfig(target: PasswordTarget): ConnectConfig {
  return {
    host: target.host.trim(),
    port: target.port ?? 22,
    username: target.username?.trim() || undefined,
    password: target.password,
    tryKeyboard: true,
    readyTimeout: READY_TIMEOUT_MS,
    keepaliveInterval: KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: KEEPALIVE_COUNT_MAX,
  };
}

/** 建立一条新连接（keyboard-interactive 用同一密码应答所有 prompt） */
function connectPassword(target: PasswordTarget): Promise<SSH2Client> {
  return new Promise((resolve, reject) => {
    const client = new SSH2Client();
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    client.on("ready", () => settle(() => resolve(client)));
    client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
      finish(prompts.map(() => target.password));
    });
    client.on("error", (err: Error) => {
      settle(() => reject(new RemoteSshError(normalizeAuthError(err.message), null, "")));
    });
    client.on("close", () => {
      // ready 前 close = 连接失败；ready 后的 close 由池级监听剔池处理
      settle(() => reject(new RemoteSshError("SSH 连接在就绪前关闭", null, "")));
    });
    try {
      client.connect(buildConfig(target));
    } catch (err) {
      settle(() =>
        reject(
          new RemoteSshError(
            `ssh2 启动失败: ${err instanceof Error ? err.message : String(err)}`,
            null,
            "",
          ),
        ),
      );
    }
  });
}

/** 从池中取一条可用连接；坏连接剔除后重连一次 */
async function acquire(target: PasswordTarget): Promise<SSH2Client> {
  startReaper();
  const key = poolKey(target);
  const existing = pool.get(key);
  if (existing) {
    try {
      const client = await existing.ready;
      existing.lastUsedAt = Date.now();
      return client;
    } catch {
      pool.delete(key);
      // 落到下面重连
    }
  }
  const entry: PoolEntry = {
    client: new SSH2Client(),
    ready: Promise.resolve() as unknown as Promise<SSH2Client>,
    lastUsedAt: Date.now(),
  };
  // 先登记再连接：并发 exec 复用同一次握手
  entry.ready = connectPassword(target).then((client) => {
    entry.client = client;
    // 连接级错误：从池剔除（下次 acquire 重连），但不 reject 已有的 exec
    client.on("error", () => {
      if (pool.get(key) === entry) pool.delete(key);
    });
    client.on("close", () => {
      if (pool.get(key) === entry) pool.delete(key);
    });
    return client;
  });
  pool.set(key, entry);
  return entry.ready;
}

export type Ssh2RunOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  resolveOnNonZeroExit?: boolean;
};

/** ssh2 exec：与 runSshRemote 同信封（stdout/stderr 分流收集，截断标记） */
export function runSsh2Remote(
  target: PasswordTarget,
  command: string,
  options?: Ssh2RunOptions,
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}> {
  const timeoutMs = Math.min(
    Math.max(options?.timeoutMs ?? 120_000, 1_000),
    600_000,
  );
  const cap = options?.maxOutputBytes ?? 512 * 1024;
  return acquire(target).then(
    (client) =>
      new Promise((resolve, reject) => {
        client.exec(command, (err, channel) => {
          if (err) {
            reject(new RemoteSshError(`远程命令启动失败: ${err.message}`, null, ""));
            return;
          }
          let settled = false;
          let stdoutBytes = 0;
          let stderrBytes = 0;
          let truncated = false;
          const stdout: Buffer[] = [];
          const stderr: Buffer[] = [];
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
              channel.signal("KILL");
            } catch {
              /* 某些服务器不支持 signal，close 兜底 */
            }
            channel.close();
            reject(
              new RemoteSshError(
                `远程命令超时（${Math.round(timeoutMs / 1000)}s）：${command.slice(0, 120)}`,
                null,
                "",
              ),
            );
          }, timeoutMs);
          timer.unref?.();
          const onAbort = () => {
            if (settled) return;
            try {
              channel.signal("KILL");
            } catch {
              /* 同上 */
            }
            channel.close();
          };
          options?.signal?.addEventListener("abort", onAbort, { once: true });
          const finish = (code: number | null, error?: RemoteSshError) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options?.signal?.removeEventListener("abort", onAbort);
            if (error) {
              reject(error);
              return;
            }
            resolve({
              exitCode: code ?? 0,
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: Buffer.concat(stderr).toString("utf8"),
              truncated,
            });
          };
          channel.on("data", (chunk: Buffer) => {
            if (stdoutBytes >= cap) {
              truncated = true;
              return;
            }
            stdoutBytes += chunk.length;
            stdout.push(
              stdoutBytes > cap
                ? chunk.subarray(0, chunk.length - (stdoutBytes - cap))
                : chunk,
            );
            if (stdoutBytes >= cap) truncated = true;
          });
          channel.stderr?.on("data", (chunk: Buffer) => {
            if (stderrBytes >= 64 * 1024) return;
            stderrBytes += chunk.length;
            stderr.push(chunk);
          });
          channel.on("close", (code: number | null) => {
            const stdoutText = Buffer.concat(stdout).toString("utf8");
            const stderrText = Buffer.concat(stderr).toString("utf8");
            if (options?.signal?.aborted) {
              finish(code, new RemoteSshError("远程命令已取消", code, ""));
              return;
            }
            if (code !== 0 && code !== null && !options?.resolveOnNonZeroExit) {
              finish(code, new RemoteSshError(
                `远程命令失败（exit ${code}）: ${stderrText.trim().split("\n").slice(-4).join(" ").slice(0, 600)}`,
                code,
                stderrText,
              ));
              return;
            }
            finish(code ?? 0);
          });
        });
      }),
  );
}

/** ssh2 后台任务句柄：流式收集输出，stop 关通道（远端收 SIGHUP） */
export interface Ssh2StreamHandle {
  stop(): void;
  onData(chunk: string): void;
  whenClose: Promise<number | null>;
}

export function execSsh2Stream(
  target: PasswordTarget,
  command: string,
  onData: (chunk: string) => void,
): Promise<Ssh2StreamHandle> {
  return acquire(target).then(
    (client) =>
      new Promise<Ssh2StreamHandle>((resolve, reject) => {
        client.exec(command, (err, channel: ClientChannel) => {
          if (err) {
            reject(new RemoteSshError(`远程命令启动失败: ${err.message}`, null, ""));
            return;
          }
          let settled = false;
          const handle: Ssh2StreamHandle = {
            stop: () => {
              try {
                channel.signal("KILL");
              } catch {
                /* 忽略 */
              }
              channel.close();
            },
            onData,
            whenClose: new Promise<number | null>((resolveClose) => {
              channel.on("close", (code: number | null) => {
                if (!settled) {
                  settled = true;
                  resolveClose(code ?? 0);
                }
              });
              channel.on("eof", () => {
                /* 数据收尾由 close 报 */
              });
            }),
          };
          channel.on("data", (chunk: Buffer) => onData(chunk.toString("utf8")));
          channel.stderr?.on("data", (chunk: Buffer) => onData(chunk.toString("utf8")));
          resolve(handle);
        });
      }),
  );
}

/** 关闭全部池化连接（进程退出清理用） */
export function closeAllSsh2(): void {
  for (const [, entry] of pool) {
    try {
      entry.client.end();
    } catch {
      /* 忽略 */
    }
  }
  pool.clear();
}
