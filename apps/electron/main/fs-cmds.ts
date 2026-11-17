/**
 * 文件树/我的文件/附件中转（对齐 fs.rs 全部 15 命令与错误码字符串）。
 * 路径守卫同款：cwd 必须命中 kv workspace、task-workspace 子树、资料库根，
 * 或当前项目的虚拟目录根（pi.projectDirs）；相对段拒绝绝对与 `..`；
 * 目标存在时两侧 realpath 防符号链接逃逸。
 */
import { existsSync, lstatSync, openSync, readSync, closeSync, statSync, realpathSync } from "node:fs";
import type { Dirent } from "node:fs";
import { cp, readdir, readFile, mkdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, renameSync, statSync as fstat } from "node:fs";
import { join, basename, dirname, extname, resolve } from "node:path";
import { homedir } from "node:os";
import { appDataDir, sessionsDir } from "./paths";
import { libraryRoot as libraryRootDir } from "./library";
import {
  isTaskWorkspaceMigrating,
  setTaskWorkspaceRoot,
  taskWorkspaceRoot,
  taskWorkspaceRootInfo,
  TASK_WORKSPACE_PROGRESS_EVENT,
} from "./task-workspace-root";
import { managedWorktreeRootFor } from "./worktrees";
import { getDb, kvGet } from "./store";
import {
  trustedProjectRoots,
  trustedProjectRootsFromPaths,
} from "./project-roots";
import { emitToWindows } from "./ipc";
import { logInfo } from "./logging";
import { shell, BrowserWindow } from "electron";
import { spawnSync, spawn } from "node:child_process";

const MAX_LIST_ENTRIES = 5000;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
/**
 * 图片附件读盘上限：前端只做传输 sanity 上限，真正的 2MiB 内联闸门在
 * sidecar（超限图由 Photon 缩放/转码后仍进模型上下文）。这里与
 * attachment_stage 的 24MiB 对齐，避免"选择器能选、读盘先拒"。
 */
const MAX_ATTACHMENT_IMAGE_BYTES = 24 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules"]);
const MAX_WRITE_BYTES = 32 * 1024 * 1024;
const ATTACHMENT_STAGE_MAX_BYTES = 24 * 1024 * 1024;
const ATTACHMENT_STAGE_MAX_TOTAL = 256 * 1024 * 1024;
const ATTACHMENT_RETENTION_KV_KEY = "attachments.retentionDays";
const ATTACHMENT_RETENTION_DEFAULT_DAYS = 7;

class FsError extends Error {}
const fail = (code: string): never => {
  throw new FsError(code);
};

function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** 最近的已存在祖先的 realpath（路径本身不存在时用）：
 *  文件树面板的会话级产物目录（<task-workspace>/<sessionId>）在"首次写文件前"
 *  并不存在，而它是被前端明确当作可信根的——先在"已存在的祖先"上做根校验，
 *  尾巴由后续的 mkdir/touch 创建。 */
function realpathNearestExisting(p: string): string | null {
  let cur = p;
  for (;;) {
    const rp = tryRealpath(cur);
    if (rp) return rp;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/** 项目 folders（项目实体表）；表为空/不可用时回退旧 kv 路径 map */
function trustedProjectRootsFromStore(): string[] {
  try {
    const rows = getDb()
      .prepare("SELECT path FROM project_folders")
      .all() as { path: unknown }[];
    if (rows.length > 0) {
      return trustedProjectRootsFromPaths(rows.map((row) => row.path));
    }
  } catch {
    /* 旧库/迁移前：回退 */
  }
  return trustedProjectRoots(kvGet("pi.projectDirs"));
}

/** 对齐 resolve_root：可信根之一（workspace / task-workspace / 资料库根 任意子树） */
function resolveRoot(cwd: string): string {
  const stored = kvGet("workspace");
  const want = stored && stored.length > 0 ? stored : null;
  // 校验用「cwd 存在时的 canonical；不存在时最近的已存在祖先的 canonical」——
  // 会话级产物目录 <task-workspace>/<sessionId> 在首次写文件前并不存在，
  // 前端明确把它当可信根（读写会在本次调用里建出来，见 usePanelCwd 注释）。
  const real = tryRealpath(cwd);
  const nearest = real ?? realpathNearestExisting(cwd);
  if (nearest === null) return fail("cwd-not-allowed");
  const probe: string = nearest;
  const within = (p: string, root: string) =>
    p === root || p.startsWith(root + "/") || (process.platform === "win32" && p.startsWith(root + "\\"));

  let trusted = false;
  if (!trusted) {
    // 受管 worktree（worktrees.ts 注册表，精确路径及其子树）：worktree 会话的
    // 文件工具以 worktree 为根。注册表只登记本应用创建的 worktree。
    if (managedWorktreeRootFor(probe)) trusted = true;
  }
  if (want) {
    const b = tryRealpath(want);
    if (b && probe === b) trusted = true;
  }
  if (!trusted) {
    // 任务产物根（设置 → 通用 → 任务产物位置，可改到别的盘）：迁移期间拒绝
    // 写入/读取，避免在目录搬移中读写半成品。
    const taskRoot = taskWorkspaceRoot();
    if (isTaskWorkspaceMigrating() && within(probe, tryRealpath(taskRoot) ?? resolve(taskRoot))) {
      return fail("busy");
    }
    const t = tryRealpath(taskRoot);
    if (t && within(probe, t)) trusted = true;
  }
  if (!trusted) {
    // 资料库根子树（设置 → 通用 → 资料库位置）：library.ts 的校验保证该根
    // 不会是 appDataDir 本体/祖先/内部敏感目录，故这里可以放心放行子树。
    // 根目录不存在时（用户把库指到被删掉的目录）不视为可信，页面以读取
    // 失败 + 更改位置呈现。
    const lib = tryRealpath(libraryRootDir());
    if (lib && within(probe, lib)) trusted = true;
  }
  if (!trusted) {
    // 项目 folders：主目录与附加根都由用户配置，文件树切根后需要能读写。
    // 只认已存在的根（trustedProjectRoots* 已 realpath）。
    const projectRoots = trustedProjectRootsFromStore();
    if (projectRoots.some((root) => probe === root)) trusted = true;
  }
  if (!trusted) return fail("cwd-not-allowed");
  // 返回值必须是 cwd 本身（后续 joinRel 以它为基准拼接相对路径；
  // 返回祖先会把文件写错位置）。存在时给 canonical，不存在时用原样路径。
  return real ?? cwd;
}

/** 目标名已被占用时按 Finder 习惯加「 (2)」「 (3)」…（导入与移动同款） */
export function uniqueTarget(dir: string, base: string): string {
  const first = join(dir, base);
  if (!existsSync(first)) return first;
  const ext = extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const cand = join(dir, `${stem} (${i})${ext}`);
    if (!existsSync(cand)) return cand;
  }
  return join(dir, `${stem} (${Date.now()})${ext}`);
}

/**
 * 同根内移动（资料库树里把行拖到某个文件夹）：移动的是相对路径，目标目录必须
 * 在同一个可信根内且已存在；重名自动加序号（与导入同款），返回落位后的名字。
 * 目录不能移进自身或自己的后代（否则文件系统会给出未定义结果）。
 */
export function fsMove(args: {
  cwd: string;
  path: string;
  destDir: string;
}): unknown {
  const root = resolveRoot(args.cwd ?? "");
  const src = joinRel(root, args.path ?? "");
  if (src === root || src === tryRealpath(root)) return fail("bad-path");
  let st;
  try {
    st = lstatSync(src);
  } catch {
    return fail("not-found");
  }
  const destDir = joinRel(root, args.destDir ?? "");
  let destStat;
  try {
    destStat = statSync(destDir);
  } catch {
    return fail("not-a-directory");
  }
  if (!destStat.isDirectory()) return fail("not-a-directory");

  const base = basename(src);
  if (dirname(src) === destDir) return { ok: true, name: base, moved: false };

  if (st.isDirectory()) {
    const realSrc = tryRealpath(src) ?? src;
    const realDest = tryRealpath(destDir) ?? destDir;
    if (
      realDest === realSrc ||
      realDest.startsWith(realSrc + "/") ||
      (process.platform === "win32" && realDest.startsWith(realSrc + "\\"))
    ) {
      return fail("bad-path");
    }
  }

  const dest = uniqueTarget(destDir, base);
  try {
    renameSync(src, dest);
  } catch {
    return fail("move-failed");
  }
  return { ok: true, name: basename(dest), moved: true };
}

/* ----------------------- 外部文件导入（文件树拖放） ----------------------- */

/** 导入的源个数上限（与 library-cmds 的 MAX_IMPORT_SOURCES 同款） */
const FS_IMPORT_MAX_SOURCES = 500;

/** 绝对路径判定（library-cmds 的 ABS_RE 同规则：POSIX / 与 Windows 盘符） */
const ABS_PATH_RE = /^([a-zA-Z]:[\\/]|[\\/])/;

/** a 是否等于 b 或落在 b 内部（防「目录拷进自己」无限递归；与 library-cmds 同款） */
function isInsidePath(a: string, b: string): boolean {
  if (a === b) return true;
  return (
    a.startsWith(b + "/") ||
    (process.platform === "win32" && a.startsWith(b + "\\"))
  );
}

/**
 * 导入外部文件/文件夹到 cwd 内 dir 目录（文件树的拖放导入）：一律**拷贝**
 * （不动源文件），重名自动加序号（uniqueTarget，与库导入/树内移动同款）。
 * 源只被读（任意磁盘路径），目标经 joinRel 锁在可信根子树内；把目录拷进它
 * 自己（或子目录）会无限递归，直接拒绝。dereference 让「拖进来的符号链接」
 * 落成真实内容（与 library_import 同口径）。
 */
export async function fsImport(args: {
  cwd: string;
  dir: string;
  paths: string[];
}): Promise<unknown> {
  const root = resolveRoot(args.cwd ?? "");
  const dir = joinRel(root, String(args.dir ?? ""));
  await mkdir(dir, { recursive: true });
  const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
  const imported: string[] = [];
  const renamed: { from: string; to: string }[] = [];
  const failed: { path: string; error: string }[] = [];

  let taken = 0;
  for (const src of paths) {
    if (taken >= FS_IMPORT_MAX_SOURCES) {
      failed.push({ path: src, error: "too-many" });
      continue;
    }
    if (!ABS_PATH_RE.test(src) || !existsSync(src)) {
      failed.push({ path: src, error: "not-found" });
      continue;
    }
    const target = uniqueTarget(dir, basename(src));
    if (isInsidePath(target, src)) {
      failed.push({ path: src, error: "bad-path" });
      continue;
    }
    try {
      // 异步拷贝（递归目录可能上千文件）：走线程池，不按住主进程事件循环
      await cp(src, target, {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: true,
      });
      taken += 1;
      const name = basename(target);
      imported.push(name);
      if (name !== basename(src)) {
        renamed.push({ from: basename(src), to: name });
      }
    } catch (e: any) {
      failed.push({ path: src, error: String(e?.code ?? e?.message ?? e) });
    }
  }
  return { imported, renamed, failed };
}

/** 对齐 join_rel（资料库命令库内定位同用） */
export function joinRel(root: string, rel: string): string {
  if (rel.length > 0 && (rel.startsWith("/") || rel.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(rel))) {
    return fail("bad-path");
  }
  const segs = rel.split(/[\\/]/);
  if (segs.some((s) => s === "..")) return fail("bad-path");
  const joined = rel.length === 0 ? root : join(root, ...segs);
  const can = tryRealpath(joined);
  if (can) {
    const base = tryRealpath(root) ?? root;
    if (!(can === base || can.startsWith(base + "/") || (process.platform === "win32" && can.startsWith(base + "\\")))) {
      return fail("bad-path");
    }
  }
  return joined;
}

/* -------------------------- 产物卡：只读元数据与打开 -------------------------- */

const MAX_STAT_PATHS = 20;
/**
 * 允许交给系统默认应用打开的交付物扩展名。刻意不含 exe/app/sh/bat 等可执行
 * 类型：打开动作由用户点击触发，但仍不能把任意可执行文件变成一键入口。
 */
const OPENABLE_ARTIFACT_EXT = new Set([
  "docx",
  "xlsx",
  "pptx",
  "pdf",
  "html",
  "htm",
  "xhtml",
  "svg",
  "md",
  "markdown",
  "mdx",
  "txt",
  "rtf",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "xml",
  "yaml",
  "yml",
  "log",
  "ics",
  "vtt",
  "srt",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
  "ico",
  "tiff",
  "heic",
  "heif",
  "zip",
  "mp3",
  "wav",
  "m4a",
  "ogg",
  "opus",
  "flac",
  "mp4",
  "mov",
  "webm",
  "m4v",
]);

function isAbsoluteLikePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("\\\\") ||
    /^[a-zA-Z]:[\\/]/.test(path)
  );
}

function normalizePathForCompare(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function isUnderPath(path: string, root: string): boolean {
  const p = normalizePathForCompare(path);
  const r = normalizePathForCompare(root);
  return p === r || p.startsWith(`${r}/`);
}

/**
 * 产物路径解析：
 * - 相对路径仍走 workspace 信任根（resolveRoot + joinRel），保持写权限边界；
 * - 绝对路径只做词法等价比对，允许 stat/open（只读元数据 / 用户点击打开）。
 *   `..` 一律拒绝，避免把绝对路径变成目录穿越入口。
 */
function resolveArtifactTarget(cwd: string, path: string): string {
  const raw = String(path ?? "");
  if (!raw || raw.includes("\0")) return fail("bad-path");
  if (raw.replace(/\\/g, "/").split("/").some((segment) => segment === "..")) {
    return fail("bad-path");
  }
  if (isAbsoluteLikePath(raw)) return raw;
  return joinRel(resolveRoot(cwd ?? ""), raw);
}

export async function fsStatMany(args: {
  cwd: string;
  paths: string[];
}): Promise<unknown> {
  const paths = Array.isArray(args.paths)
    ? args.paths.slice(0, MAX_STAT_PATHS)
    : [];
  const results = await Promise.all(
    paths.map(async (requestedPath) => {
      let target: string;
      try {
        target = resolveArtifactTarget(args.cwd ?? "", requestedPath);
      } catch {
        return { path: requestedPath, exists: false };
      }
      try {
        const entryStat = await stat(target);
        return {
          path: requestedPath,
          exists: true,
          isFile: entryStat.isFile(),
          isDirectory: entryStat.isDirectory(),
          size: entryStat.size,
          mtimeMs: entryStat.mtimeMs,
        };
      } catch {
        return { path: requestedPath, exists: false };
      }
    }),
  );
  return { results };
}

export async function fsOpen(args: {
  cwd: string;
  path: string;
}): Promise<unknown> {
  const target = resolveArtifactTarget(args.cwd ?? "", args.path ?? "");
  const extension = extname(target).replace(/^\./, "").toLowerCase();
  if (!OPENABLE_ARTIFACT_EXT.has(extension)) return fail("bad-path");

  const root = args.cwd ? resolveRoot(args.cwd) : null;
  // 绝对路径也要收在用户家目录或当前工作区内；相对路径已由 joinRel 收口。
  if (isAbsoluteLikePath(args.path ?? "")) {
    const real = tryRealpath(target) ?? target;
    if (!isUnderPath(real, homedir()) && !(root && isUnderPath(real, root))) {
      return fail("cwd-not-allowed");
    }
  }

  const entryStat = await stat(target).catch(() => null);
  if (!entryStat || !entryStat.isFile()) return fail("not-found");
  const error = await shell.openPath(target);
  if (error) return fail("open-failed");
  return { ok: true };
}

function readCapped(path: string, cap: number): { buf: Buffer; truncated: boolean } {
  const fd = openSync(path, "r");
  try {
    let pos = 0;
    const chunks: Buffer[] = [];
    const tmp = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const n = readSync(fd, tmp, 0, tmp.length, pos);
      if (n === 0) break;
      pos += n;
      chunks.push(Buffer.from(tmp.subarray(0, n)));
      if (pos >= cap + 1) break; // 多读 1 字节判截断
    }
    const buf = Buffer.concat(chunks);
    if (buf.length > cap) {
      return { buf: buf.subarray(0, cap), truncated: true };
    }
    return { buf, truncated: false };
  } finally {
    closeSync(fd);
  }
}

/* ------------------------------- 命令实现 ------------------------------- */

export async function fsListDir(args: { cwd: string; dir: string }): Promise<unknown> {
  const root = resolveRoot(args.cwd ?? "");
  const target = joinRel(root, args.dir ?? "");
  let entries: Dirent[];
  try {
    // 异步 readdir：单目录可能上千条，同步版本会把主进程事件循环按住
    //（期间全部 IPC 排队、"哪里都点不了"，见 slow-ops.ts）
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    return fail("not-a-directory");
  }
  const dirs: string[] = [];
  const files: string[] = [];
  let truncated = false;
  for (const entry of entries) {
    const name = entry.name;
    if (SKIP_DIRS.has(name)) continue;
    if (dirs.length + files.length >= MAX_LIST_ENTRIES) {
      truncated = true;
      break;
    }
    // 类型直接取 dirent（不再逐条 lstat 系统调用）：符号链接按非目录处理，
    // 与旧 lstat 语义一致；竞态删除的条目照旧列出，点开时报 not-found
    if (entry.isDirectory()) dirs.push(name);
    else files.push(name);
  }
  const byName = (a: string, b: string) => {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    if (la !== lb) return la < lb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  };
  dirs.sort(byName);
  files.sort(byName);
  return {
    entries: [
      ...dirs.map((name) => ({ name, dir: true })),
      ...files.map((name) => ({ name, dir: false })),
    ],
    truncated,
  };
}

export function fsReadFile(args: { cwd: string; path: string }): unknown {
  const root = resolveRoot(args.cwd ?? "");
  const target = joinRel(root, args.path ?? "");
  let r: { buf: Buffer; truncated: boolean };
  try {
    r = readCapped(target, MAX_READ_BYTES);
  } catch {
    return fail("read-failed");
  }
  const sniffLen = Math.min(r.buf.length, BINARY_SNIFF_BYTES);
  if (r.buf.subarray(0, sniffLen).includes(0)) {
    return { content: "", truncated: r.truncated, binary: true };
  }
  let s = r.buf.toString("utf8");
  if (r.truncated) {
    // 截断点退到行首
    const idx = s.lastIndexOf("\n");
    if (idx > s.length / 2) s = s.slice(0, idx);
  }
  return { content: s, truncated: r.truncated, binary: false };
}

export async function fsReadFileBase64(args: { cwd: string; path: string }): Promise<unknown> {
  const root = resolveRoot(args.cwd ?? "");
  const target = joinRel(root, args.path ?? "");
  let size = 0;
  try {
    size = (await stat(target)).size;
  } catch {
    return fail("read-failed");
  }
  if (size > MAX_PREVIEW_BYTES) return fail("too-large");
  let bytes: Buffer;
  try {
    // 上限 20MiB：同步读 + base64 是主进程里最重的一类停顿之一，走线程池
    bytes = await readFile(target);
  } catch {
    return fail("read-failed");
  }
  return { base64: bytes.toString("base64"), size: bytes.length };
}

export async function fsWriteFile(args: {
  cwd: string;
  path: string;
  base64: string;
}): Promise<unknown> {
  const root = resolveRoot(args.cwd ?? "");
  const target = joinRel(root, args.path ?? "");
  let bytes: Buffer;
  try {
    bytes = Buffer.from(String(args.base64 ?? "").trim(), "base64");
  } catch {
    return fail("bad-base64");
  }
  if (bytes.length > MAX_WRITE_BYTES) return fail("too-large");
  try {
    // 上限 32MiB：同 readFileBase64，同步写会把事件循环按住
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  } catch {
    return fail("write-failed");
  }
  return { ok: true, size: bytes.length };
}

export function fsMkdir(args: { cwd: string; path: string }): unknown {
  const root = resolveRoot(args.cwd ?? "");
  const target = joinRel(root, args.path ?? "");
  try {
    lstatSync(target);
    return fail("already-exists");
  } catch {
    /* 不存在 = 正常路径 */
  }
  try {
    mkdirSync(target, { recursive: true });
  } catch {
    return fail("mkdir-failed");
  }
  return { ok: true };
}

export function fsTouch(args: { cwd: string; path: string }): unknown {
  const root = resolveRoot(args.cwd ?? "");
  const target = joinRel(root, args.path ?? "");
  try {
    mkdirSync(dirname(target), { recursive: true });
    const fd = openSync(target, "wx");
    closeSync(fd);
  } catch (e: any) {
    if (e?.code === "EEXIST") return fail("already-exists");
    return fail("write-failed");
  }
  return { ok: true };
}

function isBadName(name: string): boolean {
  return (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    /[\/\\:*?"<>|]/.test(name)
  );
}

/**
 * 绝对路径是否落在任一可信根子树内（与 resolveRoot 同一套根：当前 workspace、
 * task-workspace、资料库根）。**读侧**校验，给 kova:// 文件通道用：让 HTML
 * 预览的 iframe 有真实基址（srcDoc 的 about:srcdoc 解析不了相对图片/CSS），
 * 同时不放行可信根之外的任何文件。
 */
export function isTrustedFilePath(abs: string): boolean {
  const real = tryRealpath(abs);
  if (!real) return false;
  const within = (p: string, root: string) =>
    p === root ||
    p.startsWith(root + "/") ||
    (process.platform === "win32" && p.startsWith(root + "\\"));
  const roots: string[] = [];
  try {
    const ws = kvGet("workspace");
    if (ws && ws.length > 0) roots.push(ws);
  } catch {
    /* store 未就绪：只走下面两个固定根 */
  }
  roots.push(libraryRootDir());
  if (!isTaskWorkspaceMigrating()) roots.push(taskWorkspaceRoot());
  for (const r of roots) {
    const rr = tryRealpath(r);
    if (rr && within(real, rr)) return true;
  }
  return false;
}

export function fsRename(args: { cwd: string; path: string; newName: string }): unknown {
  const root = resolveRoot(args.cwd ?? "");
  const target = joinRel(root, args.path ?? "");
  const newName = String(args.newName ?? "");
  if (isBadName(newName)) return fail("bad-name");
  const parent = dirname(target);
  const dest = join(parent, newName);
  try {
    lstatSync(dest);
    return fail("already-exists");
  } catch {
    /* dest 不存在 = 正常 */
  }
  try {
    renameSync(target, dest);
  } catch {
    return fail("rename-failed");
  }
  return { ok: true };
}

export async function fsDelete(args: { cwd: string; path: string }): Promise<unknown> {
  const root = resolveRoot(args.cwd ?? "");
  const target = joinRel(root, args.path ?? "");
  if (target === root || target === tryRealpath(root)) return fail("bad-path");
  let st;
  try {
    st = lstatSync(target);
  } catch {
    return fail("not-found");
  }
  try {
    // 目录可能整棵很大（合作仓库里的 node_modules 之类）：异步删，别按住事件循环
    if (st.isDirectory()) await rm(target, { recursive: true, force: true });
    else await unlink(target);
  } catch {
    return fail("delete-failed");
  }
  return { ok: true };
}

export function fsReveal(args: { cwd: string; path: string }): unknown {
  const root = resolveRoot(args.cwd ?? "");
  const target = joinRel(root, args.path ?? "");
  if (!existsSync(target)) return fail("not-found");
  revealInFileManager(target, false);
  return { ok: true };
}

/** 对齐 reveal_in_file_manager（Electron 原生等价：showItemInFolder / openPath） */
export function revealInFileManager(target: string, openDir: boolean): void {
  try {
    if (openDir) shell.openPath(target);
    else shell.showItemInFolder(target);
  } catch {
    throw new FsError("reveal-failed");
  }
}

/**
 * 在系统文件管理器中定位一个目录（侧栏项目的「在 Finder / 资源管理器中显示」）。
 *
 * 与 fs_reveal 的差别只在信任根：fs_reveal 的 cwd 必须命中当前 workspace（那是
 * 文件树面板的作用域），而项目目录是用户自己选过的、且侧栏里可能不止一个——
 * 未必是当前 workspace。这里不做 workspace 校验，只留"绝对路径 + 已存在的目录"
 * 两道基本闸（同 bridge_fs_read_text 对"用户亲选路径"的授权口径）。
 */
export function projectReveal(args: { path: string }): unknown {
  const dir = String(args.path ?? "").trim();
  if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(dir)) return fail("bad-path");
  if (!existsSync(dir)) return fail("not-found");
  if (!statSync(dir).isDirectory()) return fail("not-a-directory");
  revealInFileManager(dir, false);
  return { ok: true };
}

/* ------------------------------- 我的文件（task-workspace） ------------------------------- */

function appTaskWorkspaceRoot(): string {
  return taskWorkspaceRoot();
}

export async function appFileList(args: { rel: string }): Promise<unknown> {
  if (isTaskWorkspaceMigrating()) return fail("busy");
  const root = appTaskWorkspaceRoot();
  const target = joinRel(root, args.rel ?? "");
  let entriesRaw: Dirent[];
  try {
    entriesRaw = await readdir(target, { withFileTypes: true });
  } catch (e: any) {
    if (e?.code === "ENOENT") return { entries: [] }; // 从未跑过无目录任务 = 空清单
    throw new Error(`read_dir ${target}: ${e?.message ?? e}`);
  }
  // 每条一次异步 stat（大小/时间要展示）：系统调用走 libuv 线程池，不占主线程；
  // 同步版本在千级条目目录上会把事件循环按住（见 slow-ops.ts）
  const out = await Promise.all(
    entriesRaw
      .filter((e) => !e.name.startsWith("."))
      .map(async (e) => {
        const isDir = e.isDirectory();
        let size = 0;
        let modified: string | null = null;
        try {
          const st = await stat(join(target, e.name));
          size = isDir ? 0 : Number(st.size);
          modified = st.mtime.toISOString(); // RFC3339 本地化差异可忽略（前端 new Date 解析）
        } catch {
          /* 竞态 */
        }
        return { name: e.name, dir: isDir, size, modified };
      }),
  );
  out.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    const la = String(a.name).toLowerCase();
    const lb = String(b.name).toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
  return { entries: out };
}

export async function appFilePreview(args: { rel: string }): Promise<unknown> {
  if (isTaskWorkspaceMigrating()) return fail("busy");
  const root = appTaskWorkspaceRoot();
  const path = joinRel(root, args.rel ?? "");
  let st;
  try {
    st = await stat(path);
  } catch {
    return fail("not-a-file");
  }
  if (!st.isFile()) return fail("not-a-file");
  const ext = extname(path).slice(1).toLowerCase();
  const IMAGE_MIME: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
  };
  if (IMAGE_MIME[ext]) {
    if (st.size > 8 * 1024 * 1024) return { kind: "unsupported" };
    // 预览图最大 8MiB：同步读 + base64 会按住主进程（走线程池）
    return { kind: "image", mime: IMAGE_MIME[ext], data: (await readFile(path)).toString("base64") };
  }
  if (ext === "html" || ext === "htm") {
    if (st.size <= 1024 * 1024) return { kind: "html", text: readFileSync(path).toString("utf8") };
    const { buf } = readCapped(path, 1024 * 1024);
    return { kind: "html", text: buf.toString("utf8") };
  }
  const TEXT_EXTS = new Set([
    "md", "txt", "json", "csv", "ts", "tsx", "js", "jsx", "py", "rs", "go", "html",
    "css", "sh", "toml", "yaml", "yml", "log", "xml",
  ]);
  if (TEXT_EXTS.has(ext)) {
    const { buf } = readCapped(path, 32 * 1024);
    return { kind: "text", text: buf.toString("utf8") };
  }
  return { kind: "unsupported" };
}

export async function appFileDelete(args: { rel: string }): Promise<unknown> {
  if (isTaskWorkspaceMigrating()) return fail("busy");
  const root = appTaskWorkspaceRoot();
  const path = joinRel(root, args.rel ?? "");
  if (path === root) return fail("bad-path");
  let st;
  try {
    st = lstatSync(path);
  } catch (e: any) {
    throw new Error(`stat: ${e?.message ?? e}`);
  }
  try {
    if (st.isSymbolicLink()) await unlink(path);
    else if (st.isDirectory()) await rm(path, { recursive: true, force: true });
    else await unlink(path);
  } catch (e: any) {
    throw new Error(`remove: ${e?.message ?? e}`);
  }
  return { ok: true };
}

export function appFileReveal(args: { rel: string }): unknown {
  if (isTaskWorkspaceMigrating()) return fail("busy");
  const root = appTaskWorkspaceRoot();
  const target = joinRel(root, args.rel ?? "");
  if (!existsSync(target)) return fail("not-found");
  revealInFileManager(target, target ? statSync(target).isDirectory() : false);
  return { ok: true };
}

/* ------------------------------- 附件中转 ------------------------------- */

function sanitizeAttachmentName(name: string): string {
  const base = (name || "").split(/[\/\\]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "");
  const trimmed = cleaned.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return "document";
  return Array.from(trimmed).slice(0, 120).join("");
}

function sanitizeThreadId(tid: string): string {
  const cleaned = (tid || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  return cleaned || "misc";
}

function sanitizeHash(hash: string): string | null {
  const cleaned = (hash || "").replace(/[^0-9a-fA-F]/g, "").slice(0, 64);
  return cleaned.length >= 8 ? cleaned : null;
}

function attachmentExt(name: string): string {
  const norm = (name || "").toLowerCase();
  const dot = norm.lastIndexOf(".");
  if (dot >= 0 && dot + 1 < norm.length && !norm.slice(dot + 1).includes("/")) return norm.slice(dot);
  return ".bin";
}

function attachmentRoot(): string {
  return join(appDataDir(), "attachments");
}

function attachmentRetentionDays(): number | null {
  const raw = kvGet(ATTACHMENT_RETENTION_KV_KEY);
  if (raw == null) return ATTACHMENT_RETENTION_DEFAULT_DAYS;
  const n = parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : ATTACHMENT_RETENTION_DEFAULT_DAYS;
}

interface StageEntry {
  path: string;
  mtimeMs: number;
  size: number;
}

async function collectStageEntries(root: string): Promise<StageEntry[]> {
  const out: StageEntry[] = [];
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return out;
  }
  // 中转区可能累积上千文件：全程异步 fs（线程池），别把事件循环按住
  for (const name of dirs) {
    const p = join(root, name);
    let st;
    try {
      st = await stat(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      let sub: string[];
      try {
        sub = await readdir(p);
      } catch {
        continue;
      }
      const children = await Promise.all(
        sub.map(async (sn) => {
          const sp = join(p, sn);
          try {
            const sst = await stat(sp);
            if (sst.isDirectory()) return null;
            return { path: sp, mtimeMs: sst.mtimeMs, size: sst.size } satisfies StageEntry;
          } catch {
            return null;
          }
        }),
      );
      for (const entry of children) if (entry) out.push(entry);
    } else {
      out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

export async function pruneStageDir(root: string, days: number | null): Promise<void> {
  if (!days || days <= 0) return;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const keep: StageEntry[] = [];
  for (const e of await collectStageEntries(root)) {
    if (e.mtimeMs < cutoff) {
      try {
        await unlink(e.path);
      } catch {
        /* ignore */
      }
      continue;
    }
    keep.push(e);
  }
  let total = keep.reduce((s, e) => s + e.size, 0);
  if (total > ATTACHMENT_STAGE_MAX_TOTAL) {
    keep.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const e of keep) {
      if (total <= ATTACHMENT_STAGE_MAX_TOTAL) break;
      try {
        await unlink(e.path);
        total -= e.size;
      } catch {
        /* ignore */
      }
    }
  }
  // 清掉已空的线程目录
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    const p = join(root, name);
    try {
      if (!(await stat(p)).isDirectory()) continue;
      if ((await readdir(p)).length === 0) await rm(p, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function pruneAttachmentsScheduled(): void {
  // 定时清理：异步执行、失败只吞进 catch（不能向定时器抛，清理失败不影响宿主）
  void pruneStageDir(attachmentRoot(), attachmentRetentionDays()).catch(() => {});
}

export async function attachmentStage(args: {
  name: string;
  dataBase64: string;
  threadId?: string | null;
  hash?: string | null;
}): Promise<unknown> {
  const b64 = String(args.dataBase64 ?? "").trim();
  if (b64.length === 0) return fail("empty");
  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64, "base64");
  } catch {
    return fail("bad-base64");
  }
  if (bytes.length > ATTACHMENT_STAGE_MAX_BYTES) return fail("too-large");
  const root = attachmentRoot();
  const dir = join(root, sanitizeThreadId(String(args.threadId ?? "")));
  mkdirSync(dir, { recursive: true });
  const ext = attachmentExt(sanitizeAttachmentName(String(args.name ?? "")));
  const hex = sanitizeHash(String(args.hash ?? ""));
  let fname: string;
  if (hex) {
    fname = hex + ext;
  } else {
    const d = new Date();
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    fname =
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}` +
      `-${Math.random().toString(16).slice(2, 14)}${ext}`;
  }
  const path = join(dir, fname);
  if (!existsSync(path)) await writeFile(path, bytes);
  // 清理 fire-and-forget：不再让每次粘贴都等一轮中转区扫描（异步执行、失败不影响本次落盘）
  pruneAttachmentsScheduled();
  return { path };
}

export async function attachmentReadBase64(args: { path: string }): Promise<unknown> {
  const p = String(args.path ?? "");
  if (!p || !/^([a-zA-Z]:[\\/]|[\/])/.test(p)) return fail("bad-path"); // 仅绝对路径
  let st;
  try {
    st = await stat(p);
  } catch {
    return fail("read-failed");
  }
  if (!st.isFile()) return fail("read-failed");
  if (st.size > MAX_ATTACHMENT_IMAGE_BYTES) return fail("too-large");
  let bytes: Buffer;
  try {
    // 上限 24MiB：同步读会按住主进程几百毫秒（还要再 base64 一份），必须异步
    bytes = await readFile(p);
  } catch {
    return fail("read-failed");
  }
  return { base64: bytes.toString("base64"), size: bytes.length };
}

/** 每小时定时清理（lib.rs setup 同款，不依赖下次粘贴触发） */
let pruneTimer: NodeJS.Timeout | null = null;
export function startAttachmentPruneTimer(): void {
  pruneAttachmentsScheduled();
  pruneTimer = setInterval(pruneAttachmentsScheduled, 60 * 60 * 1000);
  pruneTimer.unref?.();
}

export function stopAttachmentPruneTimer(): void {
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = null;
}

export function setupFsCommands(register: (name: string, fn: (args: any) => any) => void): void {
  register("fs_list_dir", (a) => fsListDir(a));
  register("fs_stat_many", (a) => fsStatMany(a));
  register("fs_open", (a) => fsOpen(a));
  register("fs_read_file", (a) => fsReadFile(a));
  register("fs_read_file_base64", (a) => fsReadFileBase64(a));
  register("fs_write_file", (a) => fsWriteFile(a));
  register("fs_mkdir", (a) => fsMkdir(a));
  register("fs_touch", (a) => fsTouch(a));
  register("fs_rename", (a) => fsRename(a));
  register("fs_move", (a) => fsMove(a));
  register("fs_import", (a) => fsImport(a));
  register("fs_delete", (a) => fsDelete(a));
  register("fs_reveal", (a) => fsReveal(a));
  register("project_reveal", (a) => projectReveal(a));
  register("app_file_list", (a) => appFileList(a));
  register("app_file_preview", (a) => appFilePreview(a));
  register("app_file_delete", (a) => appFileDelete(a));
  register("app_file_reveal", (a) => appFileReveal(a));
  register("task_workspace_get_root", () => taskWorkspaceRootInfo());
  register("task_workspace_migrate_state", () => ({ migrating: isTaskWorkspaceMigrating() }));
  register("task_workspace_set_root", async (a) => {
    // 待应用的备份恢复会按当前根换入，先重启完成恢复再切换（backup.ts 的
    // PENDING_RESTORE_FILE 同名文件）
    if (existsSync(join(appDataDir(), "pending-restore.json"))) {
      throw new Error("有待应用的备份恢复，请先重启应用完成恢复后再切换任务产物位置");
    }
    // 依赖惰性引入：pi-agent / tool-exec 与 fs-cmds 处在同一模块图，静态
    // import 会把工具执行链提前拉起来（且测试环境没有 electron 运行时）。
    const [pi, tool] = await Promise.all([import("./pi-agent"), import("./tool-exec")]);
    return setTaskWorkspaceRoot(String(a?.root ?? ""), {
      migrate: a?.migrate === true,
      // 忙判定：宿主在飞工具 + sidecar 活动轮次（渲染层守卫在通道未就绪时
      // 可能漏判，这里以主进程看到的同一份起止广播兜底）
      busyReason: () =>
        tool.activeToolCount() > 0 || pi.piActiveTurnCount() > 0 ? "busy" : null,
      stopWriters: async () => {
        const wasRunning = pi.piAgentRunning();
        if (wasRunning) await pi.killOnExit();
        return wasRunning;
      },
      resumeWriters: (wasRunning) => {
        if (wasRunning) void pi.ensureSpawned().catch(() => undefined);
      },
      // 逐文件复制会给出上万条进度；渲染层按需展示，10Hz 足够且不会刷爆 IPC
      onProgress: (() => {
        let last = 0;
        return (p) => {
          const now = Date.now();
          if (p.phase === "copying" && now - last < 100) return;
          last = now;
          emitToWindows(TASK_WORKSPACE_PROGRESS_EVENT, p);
        };
      })(),
    });
  });
  register("attachment_stage", (a) => attachmentStage(a));
  register("attachment_read_base64", (a) => attachmentReadBase64(a));
}
