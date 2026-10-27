/**
 * 远程项目文件通道：右侧 panel（文件树/文件视图/图片预览/编辑器保存）
 * 的 fs_* 命令的 SSH 版本。
 *
 * 为什么在 sidecar：密码主机需要 ssh2，且唯一持有 ssh 通道的地方就是这里；
 * 渲染层只发 {cwd, path, remote:{hostId}}，主进程在转发前注入连接凭据
 * （enrichRemotePayload），密码不进入渲染层。
 *
 * 与本地 fs_* 同形：列目录 {entries:[{name,dir}],truncated}、读文本
 * {content,truncated,binary}、读图片 {base64,size}、写 {ok}。
 * 所有路径收敛在工作区根（会话远端 cwd）内，越界直接报错——
 * 与本地 cmd 的信任根守卫同规。
 */
import { posix } from "node:path";
import type { CommandHandler } from "../command";
import { send } from "../stream";
import type { RemoteTarget } from "../../types";
import { remoteExec } from "../../tools/remote/exec";
import { quotePosixShellArg } from "../../tools/remote/ssh-exec";
import { parseTarget } from "./ssh";

/** 文本读取上限（超出截断标记 truncated） */
const READ_TEXT_CAP = 512 * 1024;
/** 原始字节读取上限（图片预览；超出回 too-large） */
const READ_BINARY_CAP = 8 * 1024 * 1024;
/** 写文件上限（与本地 32MB 封顶对齐） */
const WRITE_CAP = 32 * 1024 * 1024;

function resolveInRoot(cwd: string, path: string | undefined): string {
  const root = cwd.replace(/\/+$/, "") || "/";
  const raw = (path ?? "").trim();
  const abs = raw.startsWith("/")
    ? posix.normalize(raw)
    : posix.normalize(posix.join(root, raw || "."));
  if (root !== "/" && abs !== root && !abs.startsWith(`${root}/`)) {
    throw new Error("path outside workspace");
  }
  return abs;
}

/** base64 读取（GNU base64 优先，openssl 兜底） */
async function readBase64(
  target: RemoteTarget,
  abs: string,
  capBytes: number,
): Promise<{ buffer: Buffer; truncated: boolean }> {
  const q = quotePosixShellArg(abs);
  // 管道退出码取最后一段（tr），head 读不到文件会被吞成空内容——先显式
  // 校验可读性并失败，保证「文件不存在/无权限」对面板是错误而不是空文件
  const result = await remoteExec(
    target,
    `test -f ${q} && test -r ${q} || { echo 'file not found or unreadable' >&2; exit 3; }; ` +
      `head -c ${capBytes + 1} ${q} | base64 | tr -d '\\n' || openssl base64 -A -in ${q}`,
    { timeoutMs: 60_000, maxOutputBytes: Math.ceil((capBytes * 4) / 3) + 128 },
  );
  const buffer = Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
  return { buffer, truncated: buffer.length > capBytes };
}

export const handlers: Record<string, CommandHandler> = {
  /** { type:"remote_fs_list", cwd, dir, remote } → { entries, truncated:false } */
  remote_fs_list: async (reqId, msg) => {
    try {
      const target = parseTarget(msg.remote);
      const cwd = String(msg.cwd ?? "");
      const abs = resolveInRoot(cwd, typeof msg.dir === "string" ? msg.dir : "");
      const result = await remoteExec(
        target,
        `cd ${quotePosixShellArg(abs)} && ls -1ap`,
        { timeoutMs: 30_000 },
      );
      const MAX_ENTRIES = 5000;
      const entries = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .slice(0, MAX_ENTRIES)
        .map((line) => ({
          // -p 给目录加尾斜杠：必须先去斜杠再判 . / ..（此前 . 输出成 "./"
          // 逃过过滤，树里出现「可展开的伪目录 . 和 ..」并递归套娃）
          name: line.replace(/\/+$/, ""),
          dir: line.endsWith("/"),
        }))
        .filter((entry) => entry.name && entry.name !== "." && entry.name !== "..");
      send({
        id: reqId,
        type: "remote_fs_list_result",
        entries,
        truncated: result.truncated || entries.length >= MAX_ENTRIES,
      });
    } catch (error) {
      send({
        id: reqId,
        type: "error",
        errorText: error instanceof Error ? error.message : String(error),
      });
    }
  },

  /** { type:"remote_fs_read", cwd, path, remote } → { content,truncated,binary } */
  remote_fs_read: async (reqId, msg) => {
    try {
      const target = parseTarget(msg.remote);
      const cwd = String(msg.cwd ?? "");
      const abs = resolveInRoot(cwd, String(msg.path ?? ""));
      const { buffer, truncated } = await readBase64(target, abs, READ_BINARY_CAP);
      const binary = buffer.includes(0);
      // 文本：截到 READ_TEXT_CAP；binary 时只回标志不塞内容
      const text = binary
        ? ""
        : buffer.subarray(0, READ_TEXT_CAP).toString("utf8");
      send({
        id: reqId,
        type: "remote_fs_read_result",
        content: text,
        truncated: truncated || buffer.length > READ_TEXT_CAP,
        binary,
      });
    } catch (error) {
      send({
        id: reqId,
        type: "error",
        errorText: error instanceof Error ? error.message : String(error),
      });
    }
  },

  /** { type:"remote_fs_read_base64", cwd, path, remote } → { base64,size } | { tooLarge:true } */
  remote_fs_read_base64: async (reqId, msg) => {
    try {
      const target = parseTarget(msg.remote);
      const cwd = String(msg.cwd ?? "");
      const abs = resolveInRoot(cwd, String(msg.path ?? ""));
      const { buffer, truncated } = await readBase64(target, abs, READ_BINARY_CAP);
      if (truncated) {
        send({ id: reqId, type: "remote_fs_read_base64_result", tooLarge: true });
        return;
      }
      send({
        id: reqId,
        type: "remote_fs_read_base64_result",
        base64: buffer.toString("base64"),
        size: buffer.length,
      });
    } catch (error) {
      send({
        id: reqId,
        type: "error",
        errorText: error instanceof Error ? error.message : String(error),
      });
    }
  },

  /** { type:"remote_fs_write", cwd, path, base64, remote } → { ok:true } */
  remote_fs_write: async (reqId, msg) => {
    try {
      const target = parseTarget(msg.remote);
      const cwd = String(msg.cwd ?? "");
      const abs = resolveInRoot(cwd, String(msg.path ?? ""));
      const buffer = Buffer.from(String(msg.base64 ?? ""), "base64");
      if (buffer.length > WRITE_CAP) throw new Error("too-large");
      const dir = posix.dirname(abs);
      await remoteExec(target, `mkdir -p ${quotePosixShellArg(dir)}`, {
        timeoutMs: 30_000,
      });
      await remoteExec(target, `cat > ${quotePosixShellArg(abs)}`, {
        stdin: buffer,
        timeoutMs: 120_000,
      });
      send({ id: reqId, type: "remote_fs_write_result", ok: true });
    } catch (error) {
      send({
        id: reqId,
        type: "error",
        errorText: error instanceof Error ? error.message : String(error),
      });
    }
  },

  /** 文件树写操作：mkdir / touch / rename / delete / move */
  remote_fs_mkdir: async (reqId, msg) => {
    try {
      const target = parseTarget(msg.remote);
      const abs = resolveInRoot(String(msg.cwd ?? ""), String(msg.path ?? ""));
      await remoteExec(target, `mkdir -p ${quotePosixShellArg(abs)}`, {
        timeoutMs: 30_000,
      });
      send({ id: reqId, type: "remote_fs_ok" });
    } catch (error) {
      send({
        id: reqId,
        type: "error",
        errorText: error instanceof Error ? error.message : String(error),
      });
    }
  },

  remote_fs_touch: async (reqId, msg) => {
    try {
      const target = parseTarget(msg.remote);
      const abs = resolveInRoot(String(msg.cwd ?? ""), String(msg.path ?? ""));
      await remoteExec(target, `test -e ${quotePosixShellArg(abs)} && exit 42; : > ${quotePosixShellArg(abs)}`, {
        timeoutMs: 30_000,
        resolveOnNonZeroExit: true,
      }).then((r) => {
        if (r.exitCode === 42) throw new Error("already-exists");
        if (r.exitCode !== 0) throw new Error(r.stderr.trim() || "touch-failed");
      });
      send({ id: reqId, type: "remote_fs_ok" });
    } catch (error) {
      send({
        id: reqId,
        type: "error",
        errorText: error instanceof Error ? error.message : String(error),
      });
    }
  },

  remote_fs_rename: async (reqId, msg) => {
    try {
      const target = parseTarget(msg.remote);
      const cwd = String(msg.cwd ?? "");
      const abs = resolveInRoot(cwd, String(msg.path ?? ""));
      const newName = String(msg.newName ?? "").trim();
      if (
        !newName ||
        newName.includes("/") ||
        newName === "." ||
        newName === ".." ||
        newName.startsWith("-")
      ) {
        throw new Error("bad-name");
      }
      const dest = resolveInRoot(cwd, posix.join(posix.dirname(abs), newName));
      // 同名覆盖会静默丢文件：目标已存在（且不是大小写改名）直接拒绝
      if (dest !== abs) {
        const exists = await remoteExec(target, `test -e ${quotePosixShellArg(dest)}`, {
          timeoutMs: 15_000,
          resolveOnNonZeroExit: true,
        });
        if (exists.exitCode === 0) throw new Error("already-exists");
      }
      await remoteExec(
        target,
        `command mv -f ${quotePosixShellArg(abs)} ${quotePosixShellArg(dest)}`,
        { timeoutMs: 60_000 },
      );
      send({ id: reqId, type: "remote_fs_ok" });
    } catch (error) {
      send({
        id: reqId,
        type: "error",
        errorText: error instanceof Error ? error.message : String(error),
      });
    }
  },

  remote_fs_delete: async (reqId, msg) => {
    try {
      const target = parseTarget(msg.remote);
      const cwd = String(msg.cwd ?? "");
      const abs = resolveInRoot(cwd, String(msg.path ?? ""));
      if (abs === "/" || abs === cwd.replace(/\/+$/, "")) {
        throw new Error("bad-path");
      }
      await remoteExec(target, `rm -rf ${quotePosixShellArg(abs)}`, {
        timeoutMs: 120_000,
      });
      send({ id: reqId, type: "remote_fs_ok" });
    } catch (error) {
      send({
        id: reqId,
        type: "error",
        errorText: error instanceof Error ? error.message : String(error),
      });
    }
  },

  remote_fs_move: async (reqId, msg) => {
    try {
      const target = parseTarget(msg.remote);
      const cwd = String(msg.cwd ?? "");
      const src = resolveInRoot(cwd, String(msg.path ?? ""));
      const destDir = resolveInRoot(cwd, String(msg.destDir ?? ""));
      const name = posix.basename(src);
      // 重名不覆盖：dest 已存在时加 -2/-3… 后缀（对齐本地 fs_move 语义，
      // 拖拽落点同名文件绝不能静默丢数据）
      let finalName = name;
      let dest = posix.join(destDir, name);
      for (let n = 2; n <= 50; n++) {
        if (dest === src) break; // 落点就是当前目录：无操作
        const exists = await remoteExec(
          target,
          `test -e ${quotePosixShellArg(dest)}`,
          { timeoutMs: 15_000, resolveOnNonZeroExit: true },
        );
        if (exists.exitCode !== 0) break;
        const dot = name.lastIndexOf(".");
        finalName = dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
        dest = posix.join(destDir, finalName);
      }
      if (dest === src) {
        send({ id: reqId, type: "remote_fs_move_result", ok: true, name, moved: false });
        return;
      }
      await remoteExec(
        target,
        `command mv -f ${quotePosixShellArg(src)} ${quotePosixShellArg(dest)}`,
        { timeoutMs: 60_000 },
      );
      send({ id: reqId, type: "remote_fs_move_result", ok: true, name: finalName, moved: true });
    } catch (error) {
      send({
        id: reqId,
        type: "error",
        errorText: error instanceof Error ? error.message : String(error),
      });
    }
  },
};
