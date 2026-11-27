/**
 * 资料库页的主进程命令。
 *
 * 库内读写在 fs_*（资料库根子树已加入可信根，见 fs-cmds.ts resolveRoot），
 * 这里只做资料库特有的四件事：根目录读/改、外部文件导入（拷贝进库）、
 * 库内清单扫描（笔记列表 / 名字搜索，一条实现两个用途）。
 */
import { existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { cp, mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  defaultLibraryRoot,
  isDefaultLibraryRoot,
  libraryRoot,
  libraryRootHistory,
  setLibraryRoot,
} from "./library";
import { joinRel, uniqueTarget } from "./fs-cmds";
import { getDb } from "./store";
import { logWarn } from "./logging";
import { startLibraryWatch } from "./library-watch";
import { taskWorkspaceRoot } from "./task-workspace-root";

/** 单次导入的源条目上限（拖一整个文件夹进来也只算一条源） */
const MAX_IMPORT_SOURCES = 500;
/** 扫描：目录名黑名单（与 fs.rs 的 SKIP_DIRS 同规则） */
const SCAN_SKIP_DIRS = new Set([".git", "node_modules"]);
const SCAN_MAX_RESULTS = 500;
const SCAN_MAX_VISITED = 20000;
const SCAN_MAX_DEPTH = 16;
const NOTE_EXTS = new Set([".md", ".markdown", ".knote"]);

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

/** 单条笔记正文上限：防 runaway 把库撑爆（原生 JSON 含块结构，放宽到 8MiB） */
const MAX_NOTE_BYTES = 1024 * 1024;
const MAX_NATIVE_NOTE_BYTES = 8 * 1024 * 1024;
/** 笔记标题/文件名上限（文件名再按文件系统规则收敛一次） */
const MAX_NOTE_TITLE = 200;
/** 文件名按字符截断；60 个 emoji 也仍在常见文件系统的 255 字节上限内 */
const MAX_NOTE_NAME = 60;
/** Windows 保留设备名：CON.md 这类名字在 Win32 上无法创建 */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

/** 标题 → 文件名：只处理文件系统非法字符，保留中文；空标题给稳定回退 */
function noteFileName(title: string): string {
  const cleaned = title
    .replace(/\.(md|markdown|knote)$/iu, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, MAX_NOTE_NAME)
    .replace(/[. ]+$/, "");
  const safe = cleaned || "未命名笔记";
  return WINDOWS_RESERVED_NAME.test(safe) ? `_${safe}` : safe;
}

/** 目标路径的最近已存在祖先是否仍在库根内：捕获「父目录是软链」的逃逸
 *  （新建目录时 realpath 目标本身不存在，joinRel 的末级校验会漏掉）。 */
async function nearestRealWithin(root: string, target: string): Promise<boolean> {
  let cur = resolve(target);
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    realRoot = resolve(root);
  }
  for (;;) {
    try {
      const real = await realpath(cur);
      return (
        real === realRoot ||
        real.startsWith(realRoot + "/") ||
        (process.platform === "win32" && real.startsWith(realRoot + "\\"))
      );
    } catch {
      const up = dirname(cur);
      if (up === cur) return false;
      cur = up;
    }
  }
}

/**
 * 「存为笔记」：把一段正文写成资料库笔记（默认 Markdown；format=knote 时写原生 JSON）。
 * 目录只允许库根内的相对路径；重名按 Finder 习惯加序号。文件是唯一真值，
 * library_file_meta 只同步标题/标签，保证 @ 选择器立刻可搜到。
 */
export async function librarySaveNote(args: {
  dir?: string;
  title?: string;
  tags?: unknown;
  content?: string;
  format?: string;
}): Promise<unknown> {
  const native = args.format === "knote";
  const ext = native ? ".knote" : ".md";
  const root = libraryRoot();
  let rootReady = false;
  try {
    rootReady = (await stat(root)).isDirectory();
  } catch {
    rootReady = false;
  }
  if (!rootReady) throw new Error("library-unavailable");
  const dir = String(args.dir ?? "")
    .trim()
    .split(/[\\/]+/)
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== ".")
    .join("/");
  const targetDir = joinRel(root, dir);
  if (!(await nearestRealWithin(root, targetDir))) throw new Error("bad-path");
  const content = String(args.content ?? "");
  if (
    Buffer.byteLength(content, "utf8") >
    (native ? MAX_NATIVE_NOTE_BYTES : MAX_NOTE_BYTES)
  ) {
    throw new Error("note-too-large");
  }
  if (native) {
    // 渲染层已经生成好 envelope；主进程只做最低限度的形状校验，
    // 避免把一段损坏 JSON 写进资料库。
    let data: any;
    try {
      data = JSON.parse(content);
    } catch {
      throw new Error("bad-note");
    }
    if (
      !data ||
      data.format !== "kova-note" ||
      typeof data.version !== "number" ||
      typeof data.title !== "string" ||
      !Array.isArray(data.blocks)
    ) {
      throw new Error("bad-note");
    }
  }
  const rawTitle = String(args.title ?? "")
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const title = (rawTitle || "未命名笔记").slice(0, MAX_NOTE_TITLE);
  await mkdir(targetDir, { recursive: true });
  let target = uniqueTarget(targetDir, `${noteFileName(title)}${ext}`);
  // 并发保存（连点/多端）时 uniqueTarget 的检查与写入之间有窗口：用 wx 独占
  // 创建，撞名就重新取号，绝不覆盖已有笔记。
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeFile(target, content, { encoding: "utf8", flag: "wx" });
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" || attempt >= 19) throw err;
      target = uniqueTarget(targetDir, `${noteFileName(title)}${ext}`);
    }
  }
  const name = basename(target);
  const rel = dir ? `${dir}/${name}` : name;
  // 元数据只是 @ 选择器的缓存：写失败不该把「文件已保存」报成失败
  try {
    libraryFileMetaSet({ root, rel, title, tags: args.tags ?? [] });
  } catch (err) {
    logWarn(`[library] save note meta failed: ${String(err)}`);
  }
  return { rel, name, title, tags: normalizeMetaTags(Array.isArray(args.tags) ? args.tags : []) };
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
 * 库内/产物区清单扫描：notesOnly = 全库笔记（.md/.markdown/.knote，按修改时间倒序）；
 * query = 名字包含匹配（搜索，命中未展开目录里的文件也找得到）。
 * 递归有深度、访问量、结果数三重上限，且全程异步 fs（不占主进程事件循环）
 * ——巨型目录也不会把界面卡死（同步版本见 slow-ops.ts 的由来）。
 */
export async function libraryScan(args: {
  scope?: string;
  notesOnly?: boolean;
  query?: string;
  /** 只扫库根下这一棵子树（KB 卡片计数/详情搜索用）；rel 仍返回库根相对 */
  under?: string;
}): Promise<unknown> {
  const root =
    args.scope === "artifacts"
      ? taskWorkspaceRoot()
      : libraryRoot();
  const notesOnly = Boolean(args.notesOnly);
  const q = String(args.query ?? "").trim().toLowerCase();
  // 子树前缀：分段校验（拒绝 . / .. / 空段），收敛到库内的相对路径
  const under = String(args.under ?? "")
    .split(/[\\/]+/)
    .map((seg) => seg.trim())
    .filter(Boolean)
    .filter((seg) => seg !== "." && seg !== "..")
    .join("/");
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
  await walk(under, under ? under.split("/").length : 0);
  out.sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));
  if (out.length > SCAN_MAX_RESULTS) {
    out.length = SCAN_MAX_RESULTS;
    truncated = true;
  }
  return { entries: out, truncated };
}

/* --------------------- 原生笔记路径别名（.md → .knote） --------------------- */

function cleanAliasRel(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

/** 迁移/重命名后记录旧路径；同一旧路径重复写入时覆盖到最新目标 */
export function libraryNoteAliasSet(args: {
  root?: string;
  oldRel?: string;
  newRel?: string;
}): unknown {
  const root = String(args.root ?? libraryRoot());
  const oldRel = cleanAliasRel(args.oldRel);
  const newRel = cleanAliasRel(args.newRel);
  if (!root || !oldRel || !newRel || oldRel === newRel) return null;
  getDb()
    .prepare(
      `INSERT INTO library_note_aliases (root, old_rel, new_rel, created_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(root, old_rel) DO UPDATE SET
         new_rel = excluded.new_rel,
         created_at = excluded.created_at`,
    )
    .run(root, oldRel, newRel, Date.now());
  return null;
}

/** 旧路径 → 当前路径；支持链式别名，最多 20 跳，循环直接截断 */
export function libraryNoteAliasResolve(args: {
  root?: string;
  rel?: string;
}): { rel: string | null } {
  const root = String(args.root ?? libraryRoot());
  let rel = cleanAliasRel(args.rel);
  if (!root || !rel) return { rel: null };
  const db = getDb();
  const stmt = db.prepare(
    `SELECT new_rel FROM library_note_aliases WHERE root = ?1 AND old_rel = ?2`,
  );
  const original = rel;
  const roots = [root, ...libraryRootHistory().filter((item) => item !== root)];
  const seen = new Set<string>();
  let aliasRoot = root;
  for (let i = 0; i < 20; i += 1) {
    if (seen.has(rel)) break;
    seen.add(rel);
    let row = stmt.get(aliasRoot, rel) as { new_rel?: string } | undefined;
    // 资料库整体搬过位置：历史根里登记的旧路径仍要能解析
    if (!row?.new_rel) {
      for (const candidate of roots) {
        row = stmt.get(candidate, rel) as { new_rel?: string } | undefined;
        if (row?.new_rel) {
          aliasRoot = candidate;
          break;
        }
      }
    }
    if (!row?.new_rel || row.new_rel === rel) break;
    rel = row.new_rel;
  }
  return { rel: rel === original ? null : rel };
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
  register("library_save_note", (a) => librarySaveNote(a));
  register("library_scan", (a) => libraryScan(a));
  register("library_file_meta_list", (a) => libraryFileMetaList(a));
  register("library_file_meta_get", (a) => libraryFileMetaGet(a));
  register("library_file_meta_set", (a) => libraryFileMetaSet(a));
  register("library_file_meta_delete", (a) => libraryFileMetaDelete(a));
  register("library_file_meta_move", (a) => libraryFileMetaMove(a));
  register("library_refs_check", (a) => libraryRefsCheck(a));
  register("library_note_alias_set", (a) => libraryNoteAliasSet(a));
  register("library_note_alias_resolve", (a) => libraryNoteAliasResolve(a));
  register("knowledge_refs_stats", (a) => knowledgeRefsStats(a));
  register("knowledge_refs_for_path", (a) => knowledgeRefsForPath(a));
  register("knowledge_refs_recent", (a) => knowledgeRefsRecent(a));
  register("knowledge_refs_repath", (a) => knowledgeRefsRepath(a));
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

type MetaRow = {
  rel: string;
  title: string;
  tags_json: string;
  icon: string;
  updated_at: number;
};

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
      "SELECT rel, title, tags_json, icon, updated_at FROM library_file_meta WHERE root = ?1 ORDER BY updated_at DESC",
    )
    .all(root) as MetaRow[];
  const entries = await Promise.all(
    rows.map(async (row) => ({
      rel: row.rel,
      title: row.title,
      tags: parseMetaTags(row.tags_json),
      icon: row.icon ?? "",
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
      "SELECT title, tags_json, icon, updated_at FROM library_file_meta WHERE root = ?1 AND rel = ?2",
    )
    .get(root, rel) as MetaRow | undefined;
  if (!row) return null;
  return {
    title: row.title,
    tags: parseMetaTags(row.tags_json),
    icon: row.icon ?? "",
    missing: await metaMissing(root, rel),
    updatedAt: row.updated_at,
  };
}

export function libraryFileMetaSet(args: {
  root?: string;
  rel?: string;
  title?: string;
  tags?: unknown;
  icon?: string;
}): unknown {
  const root = typeof args.root === "string" ? args.root : "";
  const rel = typeof args.rel === "string" ? args.rel : "";
  if (!root || !rel) throw new Error("bad-path");
  const title = typeof args.title === "string" ? args.title.slice(0, 200) : null;
  const tagsJson = Array.isArray(args.tags)
    ? JSON.stringify(normalizeMetaTags(args.tags))
    : null;
  // 图标是 emoji 或 `dicebear:icons:<name>`（见渲染层 lib/ui/dicebear-icons）；
  // 这里只做长度与不可见字符防御，格式合法性由渲染端解析时把关
  const icon =
    typeof args.icon === "string"
      ? args.icon.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 64)
      : null;
  // 局部更新语义：title / tags / icon 只在显式传入时覆盖，其余字段保持原值
  getDb()
    .prepare(
      `INSERT INTO library_file_meta(root, rel, title, tags_json, icon, updated_at)
       VALUES(?1, ?2, COALESCE(?3, ''), COALESCE(?4, '[]'), COALESCE(?5, ''), ?6)
       ON CONFLICT(root, rel) DO UPDATE SET
         title = CASE WHEN ?3 IS NOT NULL THEN ?3 ELSE library_file_meta.title END,
         tags_json = CASE WHEN ?4 IS NOT NULL THEN ?4 ELSE library_file_meta.tags_json END,
         icon = CASE WHEN ?5 IS NOT NULL THEN ?5 ELSE library_file_meta.icon END,
         updated_at = ?6`,
    )
    .run(root, rel, title, tagsJson, icon, Date.now());
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

/**
 * KB 改名后迁移知识使用记录：source/scopeId 下 path === from 或 from/ 前缀的
 * 行把前缀换成 to（sidecar kb_read 写入的事实源，只在此处原地更新）。
 */
export function knowledgeRefsRepath(args: {
  source?: string;
  scopeId?: string;
  from?: string;
  to?: string;
}): unknown {
  const source = typeof args.source === "string" ? args.source : "";
  const scopeId = typeof args.scopeId === "string" ? args.scopeId : "";
  const from = typeof args.from === "string" ? args.from : "";
  const to = typeof args.to === "string" ? args.to : "";
  if (!source || !from || !to || from === to) return null;
  const db = getDb();
  const prefixLen = from.length;
  // 目录名里可能有 LIKE 通配符（_ / %）：转义后再拼模式
  const likePattern = `${from.replace(/[\\%_]/g, (ch) => `\\${ch}`)}/%`;
  db.prepare(
    `UPDATE OR IGNORE knowledge_refs
       SET path = ?4 || substr(path, ?5 + 1)
     WHERE source = ?1 AND scope_id = ?2 AND path LIKE ?3 ESCAPE '\\'`,
  ).run(source, scopeId, likePattern, to, prefixLen);
  db.prepare(
    `UPDATE OR IGNORE knowledge_refs SET path = ?4
     WHERE source = ?1 AND scope_id = ?2 AND path = ?3`,
  ).run(source, scopeId, from, to);
  return null;
}

/* ------------------------------ 知识使用记录 ------------------------------ */
/**
 * 笔记/文档的引用统计（渲染层详情用）。写入侧在 sidecar 的 kb_read 经
 * host_query `knowledge_refs_record` 落库；这里只读。
 */
export function knowledgeRefsStats(args: {
  source?: string;
  scopeId?: string;
  path?: string;
}): unknown {
  const source = typeof args.source === "string" ? args.source : "";
  const scopeId = typeof args.scopeId === "string" ? args.scopeId : "";
  const path = typeof args.path === "string" ? args.path : "";
  if (!source || !path) return { count: 0, lastTs: null };
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n, MAX(ts) AS lastTs FROM knowledge_refs
       WHERE source = ?1 AND scope_id = ?2 AND path = ?3`,
    )
    .get(source, scopeId, path) as { n?: number; lastTs?: number | null } | undefined;
  return {
    count: Number(row?.n ?? 0),
    lastTs:
      row?.lastTs === null || row?.lastTs === undefined
        ? null
        : Number(row.lastTs),
  };
}

export function knowledgeRefsForPath(args: {  source?: string;
  scopeId?: string;
  path?: string;
  limit?: number;
}): unknown {
  const source = typeof args.source === "string" ? args.source : "";
  const scopeId = typeof args.scopeId === "string" ? args.scopeId : "";
  const path = typeof args.path === "string" ? args.path : "";
  if (!source || !path) return [];
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
  return getDb()
    .prepare(
      `SELECT kr.session_id AS sessionId, kr.ts, s.title, s.cwd
       FROM knowledge_refs kr
       LEFT JOIN sessions s ON s.id = kr.session_id
       WHERE kr.source = ?1 AND kr.scope_id = ?2 AND kr.path = ?3
       ORDER BY kr.ts DESC LIMIT ?4`,
    )
    .all(source, scopeId, path, limit)
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        sessionId: String(r.sessionId ?? ""),
        ts: Number(r.ts ?? 0),
        title: typeof r.title === "string" ? r.title : null,
        cwd: typeof r.cwd === "string" ? r.cwd : "",
      };
    });
}

/** 某来源最近被使用过的路径（资料库 recent 排序用）：path → 最近一次 ts */
export function knowledgeRefsRecent(args: {
  source?: string;
  scopeId?: string;
  limit?: number;
}): unknown {
  const source = typeof args.source === "string" ? args.source : "";
  const scopeId = typeof args.scopeId === "string" ? args.scopeId : "";
  if (!source) return [];
  const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 500);
  return getDb()
    .prepare(
      `SELECT path, MAX(ts) AS lastTs FROM knowledge_refs
       WHERE source = ?1 AND scope_id = ?2
       GROUP BY path ORDER BY lastTs DESC LIMIT ?3`,
    )
    .all(source, scopeId, limit)
    .map((row) => {
      const r = row as Record<string, unknown>;
      return { path: String(r.path ?? ""), lastTs: Number(r.lastTs ?? 0) };
    });
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
    const rel =
      typeof (ref as { rel?: unknown })?.rel === "string"
        ? (ref as { rel: string }).rel
        : "";
    if (!id || !absPath) continue;
    if (!allowedRoots.some((root) => isInside(absPath, root))) {
      missing.push(id);
      continue;
    }
    let exists = false;
    try {
      exists = (await stat(absPath)).isFile();
    } catch {
      exists = false;
    }
    // 迁移后的历史引用：旧 .md 已不在，但别名表指到 .knote
    if (!exists && rel) {
      const aliasStmt = getDb().prepare(
        `SELECT new_rel FROM library_note_aliases WHERE root = ?1 AND old_rel = ?2`,
      );
      for (const root of allowedRoots) {
        const row = aliasStmt.get(root, rel) as { new_rel?: string } | undefined;
        if (!row?.new_rel) continue;
        try {
          if ((await stat(joinRel(root, row.new_rel))).isFile()) {
            exists = true;
            break;
          }
        } catch {
          /* 换下一个历史根 */
        }
      }
    }
    if (!exists) missing.push(id);
  }
  return { missing };
}