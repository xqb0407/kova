/**
 * SSH 目标参数构造（纯函数，无 Electron 依赖，便于单测）。
 * 供 ssh.ts 的连接/探针命令与终端面板的交互式会话共用：
 * - 工具路径（ssh.ts）另加 BatchMode 等非交互参数；
 * - 交互式终端只用本文件的基础参数（允许密码提示，-t 分配远端 PTY）。
 */
import type { SshHost } from "./ssh";

/** POSIX 单引号转义 */
export function quoteShell(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** `user@host`（alias 优先：端口/用户名/密钥交给 ssh config） */
export function targetOf(host: SshHost): string {
  if (host.alias?.trim()) return host.alias.trim();
  const user = host.username?.trim();
  return user ? `${user}@${host.hostname.trim()}` : host.hostname.trim();
}

/** alias 直连时端口由 ssh config 决定，只有显式主机才传 -p */
export function portOptions(host: SshHost): string[] {
  if (host.alias?.trim()) return [];
  return host.port && host.port !== 22 ? ["-p", String(host.port)] : [];
}

/** 私钥认证：-i + IdentitiesOnly（密码/agent 不传，走默认） */
export function authOptions(host: SshHost): string[] {
  if (host.authType !== "key" || !host.privateKeyPath?.trim()) return [];
  return ["-i", host.privateKeyPath.trim(), "-o", "IdentitiesOnly=yes"];
}

/**
 * 交互式终端参数：与工具执行的 BatchMode 口径不同——必须允许密码交互
 *（密码主机由 ssh 在终端里询问），-t 分配远端 PTY；给了 cwd 时登录后
 * cd 到项目目录并 exec 登录 shell（cd 失败仍有 shell）。
 */
export function buildInteractiveSshArgs(host: SshHost, cwd?: string): string[] {
  const args = [
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    ...portOptions(host),
    ...authOptions(host),
    targetOf(host),
  ];
  const dir = cwd?.trim();
  if (dir) {
    args.push("-t", `cd ${quoteShell(dir)} 2>/dev/null; exec "\${SHELL:-/bin/sh}" -l`);
  }
  return args;
}
