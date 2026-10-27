/**
 * 远程项目工具实现：bash/read/write/edit/task_output/task_stop 的 SSH 版。
 *
 * 返回信封与 Rust 宿主 tool_exec.rs 同形（hostToolCall 消费方零改动）：
 * `{ output, truncated?, exitCode?, totalLines?, base64?, mimeType?, bytes? }`。
 * bash 永远不因非零退出码抛错（退出码进信封，命令失败是结果不是异常）；
 * 连接/认证失败抛 RemoteSshError（对模型呈现为工具错误）。
 *
 * 与本地 Rust 宿主的有意差异（v1 降级，见 docs/remote-ssh-projects.md）：
 * - 不维护 read-state 台账（edit 前必须先 read 的强制不生效，靠提示词约束）；
 * - 检查点由调用方（hostTool 分流处）跳过；
 * - 密钥注入/访问加速环境不生效（那些是 Rust 侧注入的本地派生 env）。
 */
import { extname, isAbsolute, posix } from "node:path";
import type { RemoteTarget } from "../../types";
import { quotePosixShellArg, REMOTE_OUTPUT_CAP_BYTES } from "./ssh-exec";
import { remoteExec, remoteExecBash, startRemoteBash } from "./exec";

/** 与 Rust 信封对齐的结果形状（见 hostdb.ts hostToolCall 泛型） */
export type RemoteToolResult = {
  output: string;
  truncated?: boolean;
  exitCode?: number | null;
  totalLines?: number;
  base64?: string;
  mimeType?: string;
  bytes?: number;
};

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const READ_MAX_BYTES = 2 * 1024 * 1024;

/** 相对路径按会话远端 cwd 解析（对齐本地 resolveToolPath 语义；~ 交给远端 shell） */
export function resolveRemotePath(cwd: string, filePath: string): string {
  const p = filePath.trim();
  if (!p) throw new Error("file_path is required");
  if (isAbsolute(p) || p.startsWith("~")) return p;
  return posix.normalize(posix.join(cwd.replaceAll("\\", "/"), p));
}

/** 写入根收敛：远端只允许写会话工作目录内（bash 的越界由审批门管） */
export function assertWriteInRoot(cwd: string, absPath: string): void {
  const root = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
  const target = absPath.replaceAll("\\", "/").replace(/\/+$/, "");
  if (target === root) return;
  if (!target.startsWith(`${root}/`)) {
    throw new Error(
      `写入被拒绝：远程会话只允许写工作目录（${root}）内的文件，目标 ${absPath} 越界`,
    );
  }
}

/* ------------------------------ 后台任务表 ------------------------------ */

type RemoteBgTask = {
  id: number;
  owner: string;
  /** 停止句柄（CLI 子进程或 ssh2 通道，见 exec.ts startRemoteBash） */
  stop: () => void;
  chunks: string[];
  bytes: number;
  truncated: boolean;
  done: boolean;
  exitCode: number | null;
};

/** 全局任务表（对齐 Rust 宿主的 owner 语义：task_output/task_stop 只认本线程） */
const bgTasks = new Map<number, RemoteBgTask>();
let nextBgTaskId = 1;
const BG_OUTPUT_CAP = 256 * 1024;

function evictDoneBgTasks(): void {
  if (bgTasks.size <= 32) return;
  for (const [id, task] of bgTasks) {
    if (task.done && bgTasks.size > 32) bgTasks.delete(id);
  }
}

/* ------------------------------ 各工具实现 ------------------------------ */

async function remoteBash(
  target: RemoteTarget,
  cwd: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  owner: string,
): Promise<RemoteToolResult> {
  const command = String(params.command ?? "").trim();
  if (!command) throw new Error("command is required");

  if (params.runInBackground !== true) {
    const timeoutMs = Math.min(Math.max(Number(params.timeout) || 120_000, 1_000), 600_000);
    // stderr 经脚本的 exec 2>&1 并入 stdout（按真实先后交错，排查构建日志必需）；
    // bash 语义：命令失败（含 cd 失败）是结果不是异常——exitCode 进信封
    const result = await remoteExecBash(target, command, cwd, {
      timeoutMs,
      signal,
    });
    const output = result.truncated
      ? `${result.stdout}\n…[output truncated at ${Math.round(REMOTE_OUTPUT_CAP_BYTES / 1024)}KB]`
      : result.stdout;
    return { output, exitCode: result.exitCode, truncated: result.truncated || undefined };
  }

  // 后台：CLI 子进程 / ssh2 通道统一句柄，输出进内存（tail 256KB 语义对齐 Rust）
  evictDoneBgTasks();
  const id = nextBgTaskId++;
  const task: RemoteBgTask = {
    id,
    owner,
    stop: () => {},
    chunks: [],
    bytes: 0,
    truncated: false,
    done: false,
    exitCode: null,
  };
  bgTasks.set(id, task);
  const handle = startRemoteBash(target, command, cwd, (chunk) => {
    if (task.done) return;
    task.bytes += chunk.length;
    if (task.bytes >= BG_OUTPUT_CAP) task.truncated = true;
    task.chunks.push(chunk);
  });
  task.stop = handle.stop;
  void handle.whenDone.then((code) => {
    task.done = true;
    task.exitCode = code ?? 0;
  });
  return {
    output: `Background task started (taskId: ${id}). Use task_output to read collected output; task_stop to kill.`,
    exitCode: null,
  };
}

function remoteTaskOutput(params: Record<string, unknown>, owner: string): RemoteToolResult {
  const taskId = Number(params.taskId);
  const task = bgTasks.get(taskId);
  if (!task || task.owner !== owner) {
    throw new Error(`task not found: ${taskId}`);
  }
  const body = task.chunks.join("");
  const tail = body.length > BG_OUTPUT_CAP ? body.slice(body.length - BG_OUTPUT_CAP) : body;
  return {
    output:
      (task.truncated ? "…[earlier output truncated]\n" : "") +
      (tail || (task.done ? "(no output)" : "(no output yet)")) +
      (task.done
        ? `\n[task finished with exit code ${task.exitCode}]`
        : "\n[task still running]"),
    truncated: task.truncated || undefined,
    exitCode: task.done ? task.exitCode : null,
  };
}

function remoteTaskStop(params: Record<string, unknown>, owner: string): RemoteToolResult {
  const taskId = Number(params.taskId);
  const task = bgTasks.get(taskId);
  if (!task || task.owner !== owner) {
    throw new Error(`task not found: ${taskId}`);
  }
  if (!task.done) {
    // 杀本地 ssh：通道关闭 → 远端命令树收 SIGHUP。2s 后强杀兜忽略 TERM 的进程
    task.stop();
    return { output: `Task ${taskId} kill signal sent (process tree terminating).` };
  }
  return { output: `Task ${taskId} already finished (exit ${task.exitCode}).` };
}

async function remoteRead(
  target: RemoteTarget,
  cwd: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<RemoteToolResult> {
  const filePath = String(params.file_path ?? "").trim();
  if (!filePath) throw new Error("file_path is required");
  const abs = resolveRemotePath(cwd, filePath);
  const mime = IMAGE_MIME[extname(abs).toLowerCase()];
  if (mime) {
    // 图片：base64 直读（≤2MiB），信封形状与 Rust read 一致
    // base64 -w 0 是 GNU；busybox/macOS 用 openssl base64 -A 兜底
    const { stdout } = await remoteExec(
      target,
      `base64 -w 0 ${quotePosixShellArg(abs)} 2>/dev/null || openssl base64 -A -in ${quotePosixShellArg(abs)}`,
      { cwd, signal, maxOutputBytes: Math.ceil((IMAGE_MAX_BYTES * 4) / 3) + 64 },
    );
    const b64 = stdout.replace(/\s+/g, "");
    if (!b64) throw new Error(`cannot read image: ${abs}`);
    const bytes = Math.floor((b64.length * 3) / 4);
    if (bytes > IMAGE_MAX_BYTES) {
      throw new Error(`image too large (${Math.round(bytes / 1024)}KB > 2MiB); downscale first`);
    }
    return { output: `[image: ${abs}]`, base64: b64, mimeType: mime, bytes };
  }

  // 文本：行数先探（截断标志用），sed 窗口只取 offset/limit 段——任意大小的
  // 文件都能分页读（对齐本地 Rust read 语义；窗口超长行由输出上限截断兜底）。
  // offset/limit 取整：模型传 2.5 这类小数会让 sed '2.5,10p' 直接语法报错
  const offset = Math.max(1, Math.floor(Number(params.offset) || 1));
  const limit = Math.max(1, Math.min(Math.floor(Number(params.limit) || 2000), 2000));
  const stat = await remoteExec(target, `wc -l < ${quotePosixShellArg(abs)}`, {
    cwd,
    signal,
    timeoutMs: 30_000,
  });
  const totalLines = Number(stat.stdout.trim().split(/\s+/).pop()) || 0;
  const endLine = offset + limit - 1;
  const { stdout } = await remoteExec(
    target,
    `sed -n '${offset},${endLine}p' ${quotePosixShellArg(abs)} | cat -n`,
    { cwd, signal },
  );
  // sed -n X,Yp | cat -n 的行号从 1 重数：改回绝对行号（cat -n 风格宽列）
  const width = Math.max(6, String(Math.max(totalLines, endLine)).length);
  const body = stdout
    .replace(/\n$/, "")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const m = /^\s*(\d+)\t(.*)$/.exec(line);
      if (!m) return line;
      return `${String(Number(m[1]) + offset - 1).padStart(width, " ")}\t${m[2]}`;
    })
    .join("\n");
  return {
    output: body || "(empty file)",
    totalLines,
    truncated: offset + limit - 1 < totalLines || undefined,
  };
}

async function remoteWrite(
  target: RemoteTarget,
  cwd: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<RemoteToolResult> {
  const filePath = String(params.file_path ?? "").trim();
  const content = String(params.content ?? "");
  if (!filePath) throw new Error("file_path is required");
  const abs = resolveRemotePath(cwd, filePath);
  assertWriteInRoot(cwd, abs);
  const append = params.mode === "append";
  const dir = posix.dirname(abs.replaceAll("\\", "/"));
  await remoteExec(target, `mkdir -p ${quotePosixShellArg(dir)}`, {
    cwd,
    signal,
    timeoutMs: 30_000,
  });
  await remoteExec(
    target,
    `cat ${append ? ">>" : ">"} ${quotePosixShellArg(abs)}`,
    { cwd, signal, stdin: content, timeoutMs: 60_000 },
  );
  return {
    output: `File ${append ? "appended" : "written"}: ${abs} (${Buffer.byteLength(content, "utf8")} bytes)`,
  };
}

async function remoteEdit(
  target: RemoteTarget,
  cwd: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<RemoteToolResult> {
  const filePath = String(params.file_path ?? "").trim();
  const oldString = String(params.old_string ?? "");
  const newString = String(params.new_string ?? "");
  const replaceAll = params.replace_all === true;
  if (!filePath) throw new Error("file_path is required");
  if (!oldString) throw new Error("old_string is required");
  const abs = resolveRemotePath(cwd, filePath);
  assertWriteInRoot(cwd, abs);
  // 读全文 → 本侧替换 → 写回（语义与本地 edit 一致：精确匹配 + 唯一性）。
  // 上限内必须整读整写：默认 512KB 输出上限会把中等文件截断，写回即丢数据
  const stat = await remoteExec(target, `wc -c < ${quotePosixShellArg(abs)}`, {
    cwd,
    signal,
    timeoutMs: 30_000,
  });
  const totalBytes = Number(stat.stdout.trim().split(/\s+/).pop()) || 0;
  if (totalBytes > READ_MAX_BYTES) {
    throw new Error(
      `file too large for edit (${Math.round(totalBytes / 1024)}KB > 2MiB); split the change or use bash + sed`,
    );
  }
  const { stdout } = await remoteExec(target, `cat ${quotePosixShellArg(abs)}`, {
    cwd,
    signal,
    maxOutputBytes: READ_MAX_BYTES,
  });
  const content = stdout;
  const count = content.split(oldString).length - 1;
  if (count === 0) {
    throw new Error(
      `String to replace not found in file: ${abs}\n\nOld string: ${oldString.slice(0, 200)}`,
    );
  }
  if (count > 1 && !replaceAll) {
    throw new Error(
      `Found ${count} occurrences of the string in ${abs}. The old_string must match exactly once — add surrounding context or set replace_all=true.`,
    );
  }
  const updated = replaceAll
    ? content.replaceAll(oldString, newString)
    : content.replace(oldString, newString);
  await remoteExec(target, `cat > ${quotePosixShellArg(abs)}`, {
    cwd,
    signal,
    stdin: updated,
    timeoutMs: 60_000,
  });
  return { output: `File edited: ${abs} (${count} replacement${count > 1 ? "s" : ""})` };
}

/* ------------------------------ 分发入口 ------------------------------ */

/** hostTool.execute 的远程分支：与 hostToolCall 同签名（name/cwd/params/signal/owner） */
export async function remoteToolCall(
  name: string,
  cwd: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  owner: string,
  target: RemoteTarget,
): Promise<RemoteToolResult> {
  switch (name) {
    case "bash":
      return remoteBash(target, cwd, params, signal, owner);
    case "read":
      return remoteRead(target, cwd, params, signal);
    case "write":
      return remoteWrite(target, cwd, params, signal);
    case "edit":
      return remoteEdit(target, cwd, params, signal);
    case "task_output":
      return remoteTaskOutput(params, owner);
    case "task_stop":
      return remoteTaskStop(params, owner);
    default:
      throw new Error(`remote execution not supported for tool: ${name}`);
  }
}

/** 远程 glob/grep 共用的文件列举（M3 搜索改道用；返回相对 cwd 的 posix 路径） */
export async function remoteListFiles(
  target: RemoteTarget,
  cwd: string,
  base: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const result = await remoteExec(
    target,
    // 排除 node_modules/.git 与「隐藏目录之下」的文件；隐藏文件本身保留
    //（与本地 walkFiles 语义一致：跳隐藏目录、不跳隐藏文件）
    `find ${quotePosixShellArg(base)} -type f ` +
      `-not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.*/*' ` +
      `2>/dev/null | head -c ${4 * 1024 * 1024}`,
    { cwd, signal, timeoutMs: 60_000 },
  );
  const prefix = cwd.replaceAll("\\", "/").replace(/\/+$/, "") + "/";
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((abs) => (abs.startsWith(prefix) ? abs.slice(prefix.length) : abs));
}
