/**
 * SSH 探测命令：密码主机的连接测试与远端目录校验。
 *
 * 为什么在 sidecar：系统 ssh CLI 无法非交互输密码，密码认证走 ssh2
 * （tools/remote/ssh2-client.ts）——执行通道在 sidecar，探针（测试连接/
 * test -d）也放这里，主进程只需转发。密码只在 main → sidecar 管道与
 * 本进程内存中存在，不回传渲染层。
 */
import type { CommandHandler } from "../command";
import { send } from "../stream";
import type { RemoteTarget } from "../../types";
import { remoteExec } from "../../tools/remote/exec";
import { quotePosixShellArg } from "../../tools/remote/ssh-exec";

export function parseTarget(raw: unknown): RemoteTarget {
  const r = raw as
    | { host?: unknown; port?: unknown; username?: unknown; privateKeyPath?: unknown; password?: unknown }
    | undefined;
  const host = String(r?.host ?? "").trim();
  if (!host) throw new Error("target.host is required");
  const port =
    typeof r?.port === "number" && Number.isInteger(r.port) && r.port >= 1 && r.port <= 65535
      ? r.port
      : undefined;
  return {
    host,
    ...(port ? { port } : {}),
    ...(typeof r?.username === "string" && r.username.trim() ? { username: r.username.trim() } : {}),
    ...(typeof r?.privateKeyPath === "string" && r.privateKeyPath.trim()
      ? { privateKeyPath: r.privateKeyPath.trim() }
      : {}),
    ...(typeof r?.password === "string" && r.password.length > 0 ? { password: r.password } : {}),
  };
}

export const handlers: Record<string, CommandHandler> = {
  /**
   * { type: "ssh_list_dirs", target, path } →
   *   { id, type: "ssh_list_dirs_result", ok, path?, dirs?, message }
   * 远端目录浏览（新建远程项目选源文件夹）：cd 后 pwd + ls -1p，只回目录名。
   */
  ssh_list_dirs: async (reqId, msg) => {
    try {
      const target = parseTarget(msg.target);
      const path = String(msg.path ?? "").trim();
      if (!path.startsWith("/")) throw new Error("path must be absolute");
      const command = `cd ${quotePosixShellArg(path)} && pwd && ls -1p`;
      const result = await remoteExec(target, command, {
        timeoutMs: 15_000,
        resolveOnNonZeroExit: true,
      });
      if (result.exitCode !== 0) {
        send({
          id: reqId,
          type: "ssh_list_dirs_result",
          ok: false,
          message: result.stderr.trim().slice(0, 200) || "目录不可访问",
        });
        return;
      }
      const lines = result.stdout.split(/\r?\n/);
      const resolved = (lines[0] ?? path).trim() || path;
      const dirs = lines
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => line.endsWith("/") && !line.startsWith("."))
        .map((line) => line.replace(/\/+$/, ""))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
      send({ id: reqId, type: "ssh_list_dirs_result", ok: true, path: resolved, dirs });
    } catch (error) {
      send({
        id: reqId,
        type: "ssh_list_dirs_result",
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },

  /**
   * { type: "ssh_probe", target, path? } →
   *   { id, type: "ssh_probe_result", ok, message, ms }
   * path 提供时探 test -d（目录存在性），否则只验证连通+认证。
   */
  ssh_probe: async (reqId, msg) => {
    const started = Date.now();
    let ok = false;
    let message = "";
    try {
      const target = parseTarget(msg.target);
      const dir = typeof msg.path === "string" ? msg.path.trim() : "";
      if (dir && !dir.startsWith("/")) throw new Error("path must be absolute");
      const command = dir
        ? `test -d ${quotePosixShellArg(dir)}`
        : "printf __kova_probe_ok__";
      const result = await remoteExec(target, command, {
        timeoutMs: 10_000,
        resolveOnNonZeroExit: true,
      });
      if (dir) {
        ok = result.exitCode === 0;
        message = ok ? "目录存在" : "目录不存在或不可访问";
      } else {
        ok = result.stdout.includes("__kova_probe_ok__");
        message = ok ? "连接成功" : `连接失败: ${result.stderr.trim().slice(0, 200) || "无诊断输出"}`;
      }
    } catch (error) {
      ok = false;
      message = error instanceof Error ? error.message : String(error);
    }
    send({ id: reqId, type: "ssh_probe_result", ok, message, ms: Date.now() - started });
  },
};
