/**
 * 文件树/我的文件/附件中转（对齐 fs.rs 全部 15 命令与错误码字符串）。
 * 路径守卫同款：cwd 必须命中 kv workspace 或 task-workspace 子树；
 * 相对段拒绝绝对与 `..`；目标存在时两侧 realpath 防符号链接逃逸。
 */
import { existsSync, lstatSync, openSync, readSync, closeSync, statSync, realpathSync } from "node:fs";
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync as fstat,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, basename, dirname, extname } from "node:path";
import { appDataDir, sessionsDir } from "./paths";
import { kvGet } from "./store";
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

/** 对齐 resolve_root：两个可信根之一（workspace 或 task-workspace 任意子树） */
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
  if (want) {
    const b = tryRealpath(want);
    if (b && probe === b) trusted = true;
  }
  if (!trusted) {
    const t = tryRealpath(join(appDataDir(), "task-workspace"));
    if (t && within(probe, t)) trusted = true;
  }
  if (!trusted) return fail("cwd-not-allowed");
  // 返回值必须是 cwd 本身（后续 joinRel 以它为基准拼接相对路径；
  // 返回祖先会把文件写错位置）。存在时给 canonical，不存在时用原样路径。
  return real ?? cwd;
}

/** 对齐 join_rel */
function joinRel(root: string, rel: string): string {
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

export function fsListDir(args: { cwd: string; dir: string }): unknown {
  const root = resolveRoot(args.cwd ?? "");
  const target = joinRel(root, args.dir ?? "");
  let names: string[];
  try {
    names = readdirSync(target, { withFileTypes: true }).map((d) => d.name);
    if (!existsSync(join(target, names[0] ?? "."))) {
      // readdirSync 对文件会抛；这里防御式二次检查目录
    }
  } catch {
    return fail("not-a-directory");
  }
  const dirs: string[] = [];
  const files: string[] = [];
  let truncated = false;
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    if (dirs.length + files.length >= MAX_LIST_ENTRIES) {
      truncated = true;
      break;
    }
    try {
      const st = lstatSync(join(target, name));
      if (st.isDirectory()) dirs.push(name);
      else files.push(name);
    } catch {
      /* 竞态删除：跳过 */
    }
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

export function fsReadFileBase64(args: { cwd: string; path: string }): unknown {
  const root = resolveRoot(args.cwd ?? "");
  const target = joinRel(root, args.path ?? "");
  let size = 0;
  try {
    size = statSync(target).size;
  } catch {
    return fail("read-failed");
  }
  if (size > MAX_PREVIEW_BYTES) return fail("too-large");
  let bytes: Buffer;
  try {
    bytes = readFileSync(target);
  } catch {
    return fail("read-failed");
  }
  return { base64: bytes.toString("base64"), size: bytes.length };
}

export function fsWriteFile(args: { cwd: string; path: string; base64: string }): unknown {
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
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
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

export function fsDelete(args: { cwd: string; path: string }): unknown {
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
    if (st.isDirectory()) rmSync(target, { recursive: true, force: true });
    else unlinkSync(target);
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
  return join(appDataDir(), "task-workspace");
}

export function appFileList(args: { rel: string }): unknown {
  const root = appTaskWorkspaceRoot();
  const target = joinRel(root, args.rel ?? "");
  let entriesRaw: any[];
  try {
    entriesRaw = readdirSync(target, { withFileTypes: true });
  } catch (e: any) {
    if (e?.code === "ENOENT") return { entries: [] }; // 从未跑过无目录任务 = 空清单
    throw new Error(`read_dir ${target}: ${e?.message ?? e}`);
  }
  const out: any[] = [];
  for (const e of entriesRaw) {
    const name = e.name;
    if (name.startsWith(".")) continue;
    const isDir = e.isDirectory();
    let size = 0;
    let modified: string | null = null;
    try {
      const st = statSync(join(target, name));
      size = isDir ? 0 : Number(st.size);
      modified = st.mtime.toISOString(); // RFC3339 本地化差异可忽略（前端 new Date 解析）
    } catch {
      /* 竞态 */
    }
    out.push({ name, dir: isDir, size, modified });
  }
  out.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    const la = String(a.name).toLowerCase();
    const lb = String(b.name).toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
  return { entries: out };
}

export function appFilePreview(args: { rel: string }): unknown {
  const root = appTaskWorkspaceRoot();
  const path = joinRel(root, args.rel ?? "");
  let st;
  try {
    st = statSync(path);
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
    return { kind: "image", mime: IMAGE_MIME[ext], data: readFileSync(path).toString("base64") };
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

export function appFileDelete(args: { rel: string }): unknown {
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
    if (st.isSymbolicLink()) unlinkSync(path);
    else if (st.isDirectory()) rmSync(path, { recursive: true, force: true });
    else unlinkSync(path);
  } catch (e: any) {
    throw new Error(`remove: ${e?.message ?? e}`);
  }
  return { ok: true };
}

export function appFileReveal(args: { rel: string }): unknown {
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

function collectStageEntries(root: string): StageEntry[] {
  const out: StageEntry[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of dirs) {
    const p = join(root, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      let sub: string[];
      try {
        sub = readdirSync(p);
      } catch {
        continue;
      }
      for (const sn of sub) {
        const sp = join(p, sn);
        let sst;
        try {
          sst = statSync(sp);
        } catch {
          continue;
        }
        if (sst.isDirectory()) continue;
        out.push({ path: sp, mtimeMs: sst.mtimeMs, size: sst.size });
      }
    } else {
      out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

export function pruneStageDir(root: string, days: number | null): void {
  if (!days || days <= 0) return;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const keep: StageEntry[] = [];
  for (const e of collectStageEntries(root)) {
    if (e.mtimeMs < cutoff) {
      try {
        unlinkSync(e.path);
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
        unlinkSync(e.path);
        total -= e.size;
      } catch {
        /* ignore */
      }
    }
  }
  // 清掉已空的线程目录
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const p = join(root, name);
    try {
      if (!statSync(p).isDirectory()) continue;
      if (readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function pruneAttachmentsScheduled(): void {
  try {
    pruneStageDir(attachmentRoot(), attachmentRetentionDays());
  } catch {
    /* 清理失败不影响宿主 */
  }
}

export function attachmentStage(args: {
  name: string;
  dataBase64: string;
  threadId?: string | null;
  hash?: string | null;
}): unknown {
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
  if (!existsSync(path)) writeFileSync(path, bytes);
  pruneStageDir(root, attachmentRetentionDays());
  return { path };
}

export function attachmentReadBase64(args: { path: string }): unknown {
  const p = String(args.path ?? "");
  if (!p || !/^([a-zA-Z]:[\\/]|[\/])/.test(p)) return fail("bad-path"); // 仅绝对路径
  let st;
  try {
    st = statSync(p);
  } catch {
    return fail("read-failed");
  }
  if (!st.isFile()) return fail("read-failed");
  if (st.size > MAX_ATTACHMENT_IMAGE_BYTES) return fail("too-large");
  let bytes: Buffer;
  try {
    bytes = readFileSync(p);
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
  register("fs_read_file", (a) => fsReadFile(a));
  register("fs_read_file_base64", (a) => fsReadFileBase64(a));
  register("fs_write_file", (a) => fsWriteFile(a));
  register("fs_mkdir", (a) => fsMkdir(a));
  register("fs_touch", (a) => fsTouch(a));
  register("fs_rename", (a) => fsRename(a));
  register("fs_delete", (a) => fsDelete(a));
  register("fs_reveal", (a) => fsReveal(a));
  register("project_reveal", (a) => projectReveal(a));
  register("app_file_list", (a) => appFileList(a));
  register("app_file_preview", (a) => appFilePreview(a));
  register("app_file_delete", (a) => appFileDelete(a));
  register("app_file_reveal", (a) => appFileReveal(a));
  register("attachment_stage", (a) => attachmentStage(a));
  register("attachment_read_base64", (a) => attachmentReadBase64(a));
}
