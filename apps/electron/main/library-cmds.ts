/**
 * 资料库页的主进程命令。
 *
 * 库内读写在 fs_*（资料库根子树已加入可信根，见 fs-cmds.ts resolveRoot），
 * 这里只做资料库特有的四件事：根目录读/改、外部文件导入（拷贝进库）、
 * 库内清单扫描（笔记列表 / 名字搜索，一条实现两个用途）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { appDataDir } from "./paths";
import {
  defaultLibraryRoot,
  isDefaultLibraryRoot,
  libraryRoot,
  setLibraryRoot,
} from "./library";
import { joinRel } from "./fs-cmds";

/** 单次导入的源条目上限（拖一整个文件夹进来也只算一条源） */
const MAX_IMPORT_SOURCES = 500;
/** 扫描：目录名黑名单（与 fs.rs 的 SKIP_DIRS 同规则） */
const SCAN_SKIP_DIRS = new Set([".git", "node_modules"]);
const SCAN_MAX_RESULTS = 500;
const SCAN_MAX_VISITED = 20000;
const SCAN_MAX_DEPTH = 16;
const NOTE_EXTS = new Set([".md", ".markdown"]);

/** 绝对路径判定（两类盘符 + Unix 根） */
const ABS_RE = /^([a-zA-Z]:[\\/]|[\\/])/;

function isInside(a: string, b: string): boolean {
  const ra = resolve(a);
  const rb = resolve(b);
  return (
    ra === rb ||
    ra.startsWith(rb + "/") ||
    (process.platform === "win32" && ra.startsWith(rb + "\\"))
  );
}

/** 目标名已被占用时按 Finder 习惯加「 (2)」「 (3)」… */
function uniqueTarget(dir: string, base: string): string {
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

export function libraryGetRoot(): unknown {
  const root = libraryRoot();
  return {
    root,
    defaultRoot: defaultLibraryRoot(),
    isDefault: isDefaultLibraryRoot(root),
    exists: existsSync(root),
  };
}

export function librarySetRoot(args: { root: string }): unknown {
  return { root: setLibraryRoot(String(args.root ?? "")) };
}

/**
 * 导入外部文件/文件夹到库内 rel 目录：一律**拷贝**（不动源文件），重名自动
 * 加序号。源只被读、目标经 joinRel 锁在库根内；把目录拷进它自己（或子目录）
 * 会无限递归，直接拒绝。dereference 让「拖进来的符号链接」落成真实内容。
 */
export function libraryImport(args: {
  rel?: string;
  paths?: string[];
}): unknown {
  const root = libraryRoot();
  const dir = joinRel(root, String(args.rel ?? ""));
  mkdirSync(dir, { recursive: true });
  const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
  const imported: string[] = [];
  const renamed: { from: string; to: string }[] = [];
  const failed: { path: string; error: string }[] = [];

  let taken = 0;
  for (const src of paths) {
    if (taken >= MAX_IMPORT_SOURCES) {
      failed.push({ path: src, error: "too-many" });
      continue;
    }
    if (!ABS_RE.test(src) || !existsSync(src)) {
      failed.push({ path: src, error: "not-found" });
      continue;
    }
    const target = uniqueTarget(dir, basename(src));
    if (isInside(target, src)) {
      failed.push({ path: src, error: "bad-path" });
      continue;
    }
    try {
      cpSync(src, target, {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: true,
      });
      taken += 1;
      const name = basename(target);
      imported.push(name);
      if (name !== basename(src)) renamed.push({ from: basename(src), to: name });
    } catch (e: any) {
      failed.push({ path: src, error: String(e?.code ?? e?.message ?? e) });
    }
  }
  return { imported, renamed, failed };
}

/**
 * 库内/产物区清单扫描：notesOnly = 全库 md（笔记列表，按修改时间倒序）；
 * query = 名字包含匹配（搜索，命中未展开目录里的文件也找得到）。
 * 递归有深度、访问量、结果数三重上限，巨型目录不会卡住主进程。
 */
export function libraryScan(args: {
  scope?: string;
  notesOnly?: boolean;
  query?: string;
}): unknown {
  const root =
    args.scope === "artifacts"
      ? join(appDataDir(), "task-workspace")
      : libraryRoot();
  const notesOnly = Boolean(args.notesOnly);
  const q = String(args.query ?? "").trim().toLowerCase();
  const out: { rel: string; name: string; size: number; modified: string | null }[] =
    [];
  let visited = 0;
  let truncated = false;

  const walk = (rel: string, depth: number): void => {
    if (truncated) return;
    const abs = rel ? join(root, ...rel.split("/")) : root;
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (visited >= SCAN_MAX_VISITED) {
        truncated = true;
        return;
      }
      const name = e.name;
      if (name.startsWith(".")) continue;
      if (e.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(name) || depth >= SCAN_MAX_DEPTH) continue;
        visited += 1;
        walk(rel ? `${rel}/${name}` : name, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      visited += 1;
      if (notesOnly && !NOTE_EXTS.has(extname(name).toLowerCase())) continue;
      if (q && !name.toLowerCase().includes(q)) continue;
      let size = 0;
      let modified: string | null = null;
      try {
        const st = statSync(join(abs, name));
        size = Number(st.size);
        modified = st.mtime.toISOString();
      } catch {
        /* 竞态删除：跳过 stat，条目仍可列出 */
      }
      out.push({ rel: rel ? `${rel}/${name}` : name, name, size, modified });
    }
  };
  walk("", 0);
  out.sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));
  if (out.length > SCAN_MAX_RESULTS) {
    out.length = SCAN_MAX_RESULTS;
    truncated = true;
  }
  return { entries: out, truncated };
}

export function setupLibraryCommands(
  register: (name: string, fn: (args: any) => any) => void,
): void {
  register("library_get_root", () => libraryGetRoot());
  register("library_set_root", (a) => librarySetRoot(a));
  register("library_import", (a) => libraryImport(a));
  register("library_scan", (a) => libraryScan(a));
}