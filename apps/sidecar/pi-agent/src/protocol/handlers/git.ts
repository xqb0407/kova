/**
 * 只读 Git 查询（移动/远程端「Git 变更」面板）：git_status + git_diff。
 *
 * 为什么落在 sidecar：桌面端的 Git 面板是 Tauri 本地能力（Rust 里跑 git），
 * 网页/远程端根本没有；而手机要看的东西很窄——「这个会话的仓库现在有哪些
 * 改动、某个文件的 diff 长什么样」，两条只读子命令就够，零副作用。
 *
 * 安全边界（与 remote.rs 的 REMOTE_DENIED_TYPES 叠加）：
 * - cwd 只能取**会话绑定目录**（sessionId → sessions.cwd），客户端不能指定任意
 *   路径去扫盘；没绑目录的会话直接拒绝
 * - 只跑只读子命令（status / rev-parse / diff），参数走 spawn 数组不经 shell，
 *   路径用 `--` 与参数隔开（`--` 之后的 `-foo` 不会被当成选项）
 * - 输出有体积/条数上限，超限截断并置 truncated，不把 WS 与手机内存打爆
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { send } from "../stream";
import { sessionGet } from "../../storage/hostdb";
import type { CommandHandler } from "../command";

/** 单次 git 调用的输出上限（字节）；够读完一个文件的 diff，超了就是异常大的仓库 */
const MAX_OUTPUT_BYTES = 200_000;
/** 未跟踪文件的正文读取上限 */
const MAX_UNTRACKED_BYTES = 120_000;
/** status 清单条数上限 */
const MAX_STATUS_FILES = 500;
const GIT_TIMEOUT_MS = 20_000;

type GitRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

/** spawn 跑一条只读 git 子命令（无 shell；输出封顶，超限杀进程） */
function gitRun(cwd: string, args: string[]): Promise<GitRunResult> {
  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
      });
    } catch (err) {
      resolvePromise({
        code: null,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        truncated: false,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
      truncated = true;
    }, GIT_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length >= MAX_OUTPUT_BYTES) {
        truncated = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* 已退出 */
        }
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        code: null,
        stdout,
        stderr: err.message.includes("ENOENT") ? "未找到 git 命令" : err.message,
        truncated,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, truncated });
    });
  });
}

/** 会话绑定目录（无会话 / 未绑目录 → undefined，调用方回错误帧） */
async function sessionCwd(sessionId: string): Promise<string | undefined> {
  if (!sessionId) return undefined;
  const row = await sessionGet(sessionId);
  const cwd = row && typeof row.cwd === "string" && row.cwd.trim() ? row.cwd : undefined;
  if (!cwd) return undefined;
  try {
    // 同步 stat 只为快速否决明显不存在的目录（读文件时另有错误兜底）
    if (!statSync(cwd).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return cwd;
}

/** porcelain 路径可能带引号（含空格/中文时 git 会 C-quote），拆掉并还原转义 */
export function unquotePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  const inner = trimmed.slice(1, -1);
  return inner.replace(/\\(["\\])/g, "$1").replace(/\\(\d{3})/g, (_m, oct: string) =>
    String.fromCharCode(Number.parseInt(oct, 8)),
  );
}

type StatusFile = {
  path: string;
  /** porcelain 的两列状态（X = 暂存区，Y = 工作区），如 "M "、"??"、"R " */
  x: string;
  y: string;
  /** 面向展示的单字符归类：A/M/D/R/? */
  status: string;
  added: number;
  removed: number;
  untracked: boolean;
};

/** porcelain 两列状态 → 展示用单字符（暂存优先，其次工作区） */
export function classify(x: string, y: string): string {
  if (x === "?" || y === "?") return "?";
  if (x === "A") return "A";
  if (x === "D" || y === "D") return "D";
  if (x === "R") return "R";
  if (x === "M" || y === "M") return "M";
  return x.trim() || y.trim() || "M";
}

/** numstat 行 → path → ±统计（`-\t-\tbinary` 的二进制文件不计行数） */
export function parseNumstat(text: string): Map<string, { added: number; removed: number }> {
  const map = new Map<string, { added: number; removed: number }>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [a, r, ...rest] = line.split("\t");
    if (rest.length === 0) continue;
    const added = a === "-" ? 0 : Number.parseInt(a ?? "0", 10) || 0;
    const removed = r === "-" ? 0 : Number.parseInt(r ?? "0", 10) || 0;
    map.set(unquotePath(rest.join("\t")), { added, removed });
  }
  return map;
}

/** 只读状态：分支 + 变更清单（含 ±行数；未跟踪按整文件新增计 0/0，diff 时现读） */
const git_status: CommandHandler = async (reqId, msg) => {
  const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
  const cwd = await sessionCwd(sessionId);
  if (!cwd) {
    send({
      id: reqId,
      type: "git_status",
      ok: false,
      errorText: "会话没有绑定工作目录（或目录不存在）",
      repo: false,
      files: [],
    });
    return;
  }

  const inside = await gitRun(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    send({
      id: reqId,
      type: "git_status",
      ok: true,
      cwd,
      repo: false,
      branch: null,
      files: [],
    });
    return;
  }

  const [branchRes, statusRes, numstatRes] = await Promise.all([
    gitRun(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitRun(cwd, ["status", "--porcelain=v1", "-uall"]),
    gitRun(cwd, ["diff", "--numstat", "HEAD"]),
  ]);
  const stats = parseNumstat(numstatRes.stdout);

  const files: StatusFile[] = [];
  let truncated = statusRes.truncated;
  for (const line of statusRes.stdout.split("\n")) {
    if (!line.trim()) continue;
    if (files.length >= MAX_STATUS_FILES) {
      truncated = true;
      break;
    }
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    let rest = line.slice(3);
    // rename/copy：porcelain 用 `old -> new`，展示取新路径
    if (x === "R" || x === "C") {
      const arrow = rest.lastIndexOf(" -> ");
      if (arrow !== -1) rest = rest.slice(arrow + 4);
    }
    const p = unquotePath(rest);
    if (!p) continue;
    const untracked = x === "?" && y === "?";
    const numstat = stats.get(p);
    files.push({
      path: p,
      x,
      y,
      status: classify(x, y),
      added: numstat?.added ?? 0,
      removed: numstat?.removed ?? 0,
      untracked,
    });
  }

  send({
    id: reqId,
    type: "git_status",
    ok: true,
    cwd,
    repo: true,
    branch: branchRes.code === 0 ? branchRes.stdout.trim() || null : null,
    files,
    truncated,
  });
};

/** 单文件 diff：已跟踪走 `git diff HEAD --`（暂存+未暂存一并），未跟踪读正文 */
const git_diff: CommandHandler = async (reqId, msg) => {
  const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
  const filePath = typeof msg.path === "string" ? msg.path : "";
  const cwd = await sessionCwd(sessionId);
  if (!cwd || !filePath) {
    send({
      id: reqId,
      type: "git_diff",
      ok: false,
      errorText: !cwd ? "会话没有绑定工作目录（或目录不存在）" : "缺少 path",
      path: filePath,
      diff: "",
    });
    return;
  }

  // 未跟踪文件：git diff 看不见它，直接把正文按整文件新增回给前端
  const tracked = await gitRun(cwd, ["ls-files", "--error-unmatch", "--", filePath]);
  if (tracked.code !== 0) {
    const abs = path.resolve(cwd, filePath);
    // 双击确认不出工作目录：防 `../../etc/passwd` 这类越界读取
    if (!abs.startsWith(path.resolve(cwd) + path.sep)) {
      send({
        id: reqId,
        type: "git_diff",
        ok: false,
        errorText: "路径不在会话工作目录内",
        path: filePath,
        diff: "",
      });
      return;
    }
    try {
      const info = await stat(abs);
      if (!info.isFile() || info.size > MAX_UNTRACKED_BYTES) {
        send({
          id: reqId,
          type: "git_diff",
          ok: true,
          path: filePath,
          untracked: true,
          diff: "",
          truncated: info.size > MAX_UNTRACKED_BYTES,
        });
        return;
      }
      const text = await readFile(abs, "utf8");
      send({
        id: reqId,
        type: "git_diff",
        ok: true,
        path: filePath,
        untracked: true,
        diff: text,
        truncated: false,
      });
    } catch (err) {
      send({
        id: reqId,
        type: "git_diff",
        ok: false,
        errorText: err instanceof Error ? err.message : String(err),
        path: filePath,
        diff: "",
      });
    }
    return;
  }

  const res = await gitRun(cwd, [
    "diff",
    "HEAD",
    "--no-color",
    "--no-ext-diff",
    "--unified=3",
    "--",
    filePath,
  ]);
  send({
    id: reqId,
    type: "git_diff",
    ok: res.code === 0,
    ...(res.code === 0 ? {} : { errorText: res.stderr.trim().split("\n").slice(-2).join(" ") }),
    path: filePath,
    untracked: false,
    diff: res.stdout,
    truncated: res.truncated,
  });
};

export const handlers: Record<string, CommandHandler> = {
  git_status,
  git_diff,
};
