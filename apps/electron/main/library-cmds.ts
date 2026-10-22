/**
 * 资料库页的主进程命令。
 *
 * 库内读写在 fs_*（资料库根子树已加入可信根，见 fs-cmds.ts resolveRoot），
 * 这里只做资料库特有的四件事：根目录读/改、外部文件导入（拷贝进库）、
 * 库内清单扫描（笔记列表 / 名字搜索，一条实现两个用途）。
 */
import { existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { appDataDir } from "./paths";
import {
  defaultLibraryRoot,
  isDefaultLibraryRoot,
  libraryRoot,
  libraryRootHistory,
  setLibraryRoot,
} from "./library";
import { joinRel, uniqueTarget } from "./fs-cmds";
import { getDb } from "./store";
import { startLibraryWatch } from "./library-watch";

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
export async function libraryImport(args: {
  rel?: string;
  paths?: string[];
}): Promise<unknown> {
  const root = libraryRoot();
  const dir = joinRel(root, String(args.rel ?? ""));
  await mkdir(dir, { recursive: true });
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
 * 递归有深度、访问量、结果数三重上限，且全程异步 fs（不占主进程事件循环）
 * ——巨型目录也不会把界面卡死（同步版本见 slow-ops.ts 的由来）。
 */
export async function libraryScan(args: {
  scope?: string;
  notesOnly?: boolean;
  query?: string;
}): Promise<unknown> {
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

  // 全异步递归：readdir/stat 都走 libuv 线程池。旧实现是同步递归 + 逐文件
  // statSync，两万访问量上限下能把主进程事件循环按住一两秒（界面"哪里都点不了"，
  // 且 crash.ts 的兜底弹窗也弹不出来——同步阻塞期间同进程内没有代码能跑）。
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (truncated) return;
    const abs = rel ? join(root, ...rel.split("/")) : root;
    let entries: Dirent[];
    try {
      entries = await readdir(abs, { withFileTypes: true });
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
        await walk(rel ? `${rel}/${name}` : name, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      visited += 1;
      if (notesOnly && !NOTE_EXTS.has(extname(name).toLowerCase())) continue;
      if (q && !name.toLowerCase().includes(q)) continue;
      let size = 0;
      let modified: string | null = null;
      try {
        const st = await stat(join(abs, name));
        size = Number(st.size);
        modified = st.mtime.toISOString();
      } catch {
        /* 竞态删除：跳过 stat，条目仍可列出 */
      }
      out.push({ rel: rel ? `${rel}/${name}` : name, name, size, modified });
    }
  };
  await walk("", 0);
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
  register("library_set_root", (a) => {
    const result = librarySetRoot(a);
    // 根变了：重启 watcher（旧根的监听作废，新根重新挂上）
    startLibraryWatch();
    return result;
  });
  register("library_import", (a) => libraryImport(a));
  register("library_scan", (a) => libraryScan(a));
  register("library_file_meta_list", (a) => libraryFileMetaList(a));
  register("library_file_meta_get", (a) => libraryFileMetaGet(a));
  register("library_file_meta_set", (a) => libraryFileMetaSet(a));
  register("library_file_meta_delete", (a) => libraryFileMetaDelete(a));
  register("library_file_meta_move", (a) => libraryFileMetaMove(a));
  register("library_refs_check", (a) => libraryRefsCheck(a));
  register("library_watch_restart", () => {
    startLibraryWatch();
    return null;
  });
}

/* --------------------- 文件元数据（标题 / 标签索引） --------------------- */
/**
 * 资料库文件的轻量元数据索引：只存标题与标签，不存正文——文件本身是唯一
 * 事实源。用途是「引用到对话」的 @ 选择器（按标题/标签搜索）与查看器的标签
 * 编辑行。列表时逐行 stat 标记 `missing`：外部删除（Finder/同步盘）不删行，
 * 文件恢复后标签自动回来；应用内永久删除由 `library_file_meta_delete` 清理。
 */

type MetaRow = { rel: string; title: string; tags_json: string; updated_at: number };

/** 单条元数据的缺失判定：异步 stat（与库内其它 fs 同口径，不占事件循环） */
async function metaMissing(root: string, rel: string): Promise<boolean> {
  try {
    return !(await stat(joinRel(root, rel))).isFile();
  } catch {
    return true;
  }
}

function parseMetaTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 读侧归一化：历史脏标签（如旧版 `# + 空格` 归一化产出的 `-123`）
    // 在返回前就收敛，避免列表里出现 `#123` / `#-123` 这种视觉重复
    return normalizeMetaTags(parsed);
  } catch {
    return [];
  }
}

/** 主进程侧的标签归一化（与渲染层 normalizeNoteTags 同规则，防御性再收一遍）。
 *  `# 123` 先剥 `#` 再转空格会产出 `-123`：首尾连字符一并清掉，归并成 `123`。 */
function normalizeMetaTags(raw: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const input of raw) {
    if (typeof input !== "string") continue;
    const tag = input
      .trim()
      .replace(/^#+\s*/, "")
      .replace(/\s+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 48)
      .replace(/-+$/g, "");
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= 20) break;
  }
  return out;
}

export async function libraryFileMetaList(args: { root?: string }): Promise<unknown> {
  const root = typeof args.root === "string" && args.root.trim() ? args.root : libraryRoot();
  if (!existsSync(root)) return { rootMissing: true, entries: [] };
  const rows = getDb()
    .prepare(
      "SELECT rel, title, tags_json, updated_at FROM library_file_meta WHERE root = ?1 ORDER BY updated_at DESC",
    )
    .all(root) as MetaRow[];
  const entries = await Promise.all(
    rows.map(async (row) => ({
      rel: row.rel,
      title: row.title,
      tags: parseMetaTags(row.tags_json),
      missing: await metaMissing(root, row.rel),
      updatedAt: row.updated_at,
    })),
  );
  return { rootMissing: false, entries };
}

export async function libraryFileMetaGet(args: {
  root?: string;
  rel?: string;
}): Promise<unknown> {
  const root = typeof args.root === "string" ? args.root : "";
  const rel = typeof args.rel === "string" ? args.rel : "";
  if (!root || !rel) return null;
  const row = getDb()
    .prepare(
      "SELECT title, tags_json, updated_at FROM library_file_meta WHERE root = ?1 AND rel = ?2",
    )
    .get(root, rel) as MetaRow | undefined;
  if (!row) return null;
  return {
    title: row.title,
    tags: parseMetaTags(row.tags_json),
    missing: await metaMissing(root, rel),
    updatedAt: row.updated_at,
  };
}

export function libraryFileMetaSet(args: {
  root?: string;
  rel?: string;
  title?: string;
  tags?: unknown;
}): unknown {
  const root = typeof args.root === "string" ? args.root : "";
  const rel = typeof args.rel === "string" ? args.rel : "";
  if (!root || !rel) throw new Error("bad-path");
  const title = typeof args.title === "string" ? args.title.slice(0, 200) : null;
  const tagsJson = Array.isArray(args.tags)
    ? JSON.stringify(normalizeMetaTags(args.tags))
    : null;
  // 局部更新语义：title / tags 只在显式传入时覆盖，另一个字段保持原值
  getDb()
    .prepare(
      `INSERT INTO library_file_meta(root, rel, title, tags_json, updated_at)
       VALUES(?1, ?2, COALESCE(?3, ''), COALESCE(?4, '[]'), ?5)
       ON CONFLICT(root, rel) DO UPDATE SET
         title = CASE WHEN ?3 IS NOT NULL THEN ?3 ELSE library_file_meta.title END,
         tags_json = CASE WHEN ?4 IS NOT NULL THEN ?4 ELSE library_file_meta.tags_json END,
         updated_at = ?5`,
    )
    .run(root, rel, title, tagsJson, Date.now());
  return null;
}

/** 重命名/移动后把元数据行迁到新 rel（标签跟着文件走）；同根内 from == to 时 no-op。
 *  isDir 时按 rel/ 前缀批量迁移子树（目录改名不会让里面笔记的标签变 orphan）。 */
export function libraryFileMetaMove(args: {
  root?: string;
  from?: string;
  to?: string;
  isDir?: boolean;
}): unknown {
  const root = typeof args.root === "string" ? args.root : "";
  const from = typeof args.from === "string" ? args.from : "";
  const to = typeof args.to === "string" ? args.to : "";
  if (!root || !from || !to || from === to) return null;
  try {
    if (args.isDir === true) {
      // rel 为 from 本身或 from/ 前缀：用后缀拼出新前缀
      getDb()
        .prepare(
          `UPDATE OR REPLACE library_file_meta
           SET rel = ?3 || substr(rel, length(?2) + 1), updated_at = ?4
           WHERE root = ?1 AND (rel = ?2 OR instr(rel, ?2 || '/') = 1)`,
        )
        .run(root, from, to, Date.now());
    } else {
      getDb()
        .prepare(
          "UPDATE OR REPLACE library_file_meta SET rel = ?3, updated_at = ?4 WHERE root = ?1 AND rel = ?2",
        )
        .run(root, from, to, Date.now());
    }
  } catch {
    // JSON/PK 异常：保留旧行，不让改名流程失败
  }
  return null;
}

export function libraryFileMetaDelete(args: {
  root?: string;
  rels?: unknown;
  isDir?: boolean;
}): unknown {
  const root = typeof args.root === "string" ? args.root : "";
  const rels = Array.isArray(args.rels)
    ? (args.rels.filter((r): r is string => typeof r === "string") as string[])
    : [];
  if (!root || rels.length === 0) return null;
  const db = getDb();
  const delExact = db.prepare(
    "DELETE FROM library_file_meta WHERE root = ?1 AND rel = ?2",
  );
  const delPrefix = db.prepare(
    "DELETE FROM library_file_meta WHERE root = ?1 AND instr(rel, ?2) = 1",
  );
  for (const rel of rels) {
    delExact.run(root, rel);
    // 目录：连带清掉其子树的所有元数据；文件：仅自身
    if (args.isDir === true) delPrefix.run(root, `${rel}/`);
  }
  return null;
}

/* ------------------------------ 引用存在性校验 ------------------------------ */
/**
 * 「引用到对话」草稿守卫的探测命令：按引用芯片里固化的绝对路径 stat 文件。
 * 只读、不读内容。允许根 = 当前资料库根 + 历史根（根改位置后旧引用仍有效），
 * 不在白名单里的路径直接按缺失处理——renderer 只能探测资料库子树，不能拿
 * 这个命令扫任意磁盘路径。
 */
export async function libraryRefsCheck(args: {
  refs?: unknown;
}): Promise<unknown> {
  const refs = Array.isArray(args.refs) ? args.refs : [];
  const allowedRoots = [libraryRoot(), ...libraryRootHistory()];
  const missing: string[] = [];
  for (const ref of refs) {
    const id =
      typeof (ref as { id?: unknown })?.id === "string"
        ? (ref as { id: string }).id
        : "";
    const absPath =
      typeof (ref as { absPath?: unknown })?.absPath === "string"
        ? (ref as { absPath: string }).absPath
        : "";
    if (!id || !absPath) continue;
    if (!allowedRoots.some((root) => isInside(absPath, root))) {
      missing.push(id);
      continue;
    }
    try {
      if (!(await stat(absPath)).isFile()) missing.push(id);
    } catch {
      missing.push(id);
    }
  }
  return { missing };
}