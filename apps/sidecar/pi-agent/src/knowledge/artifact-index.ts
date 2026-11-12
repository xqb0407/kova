/**
 * 文件域知识索引：任务产物 + 资料库根。
 *
 * 从 search/search-index.ts 拆出：这是 Knowledge 域自己的派生投影，
 * 会话域（session_blocks）仍归全局搜索索引。
 */
import {
  closeSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  type Dirent,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import {
  ARTIFACT_OWNER_LIBRARY,
  libraryRootGet,
  searchArtifactsDelete,
  searchArtifactsRecent,
  searchArtifactsScanList,
  searchArtifactsScanSet,
  searchArtifactsUpsert,
  sessionList,
} from "../storage/hostdb";
import { taskSessionSeg, taskWorkspaceBase } from "../sessions/resolve";
import { logErr } from "../log";

const ARTIFACT_SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "vendor",
  "data",
  ".kova",
]);
/** 进内容索引的文本扩展名（可编码文本；二进制/媒体只进「文件名」索引） */
const ARTIFACT_TEXT_EXTS = new Set([
  ".md", ".markdown", ".txt", ".json", ".html", ".htm", ".css", ".js",
  ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".yaml", ".yml", ".svg",
  ".csv", ".xml",
]);
/** 单文件抽取正文上限：产物以代码/文档为主，64KB 覆盖绝大多数源文件 */
const ARTIFACT_MAX_TEXT_BYTES = 64 * 1024;
/** 单归属域文件行数上限（防 runaway；正常产物目录远小于此） */
const ARTIFACT_MAX_FILES = 800;
/** 扫描宽限：先收下更多文件再按「笔记优先」截取，避免 800 条被旧文件占满 */
const ARTIFACT_SCAN_MAX_FILES = 5_000;
const NOTE_FILE_RE = /\.(?:md|markdown)$/iu;
/** 搜索摘要的片段半径（与全局搜索索引同口径） */
const PREVIEW_RADIUS = 60;

function artifactLibraryBaseFallback(): string {
  return process.env.PI_LIBRARY_ROOT
    ? resolve(process.env.PI_LIBRARY_ROOT)
    : "";
}

/** 资料库根以宿主当前值为准（换根后无需重启 sidecar）；host 查询不可用才回退 env */
async function artifactLibraryBase(): Promise<string> {
  try {
    const { root } = await libraryRootGet();
    if (root && root.trim()) return resolve(root);
  } catch {
    /* host query 不可用：回退启动期 env */
  }
  return artifactLibraryBaseFallback();
}

/**
 * 递归列出一个文件域目录（深度/数量双上限，跳过依赖目录）。
 * 返回 rel（POSIX）→ 绝对路径与 mtime。
 */
function listArtifactFiles(base: string): Map<string, { abs: string; mtimeMs: number }> {
  const out = new Map<string, { abs: string; mtimeMs: number }>();
  const walk = (rel: string, depth: number): void => {
    if (out.size >= ARTIFACT_SCAN_MAX_FILES) return;
    const abs = rel ? join(base, ...rel.split("/")) : base;
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.size >= ARTIFACT_SCAN_MAX_FILES) return;
      const name = entry.name;
      if (name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (ARTIFACT_SCAN_SKIP_DIRS.has(name) || depth >= 12) continue;
        walk(rel ? `${rel}/${name}` : name, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const fileRel = rel ? `${rel}/${name}` : name;
      // abs 已含 rel 路径段，直接 join(name)——不能拿 fileRel 再拼（会翻倍）
      const fileAbs = join(abs, name);
      try {
        const st = statSync(fileAbs);
        out.set(fileRel, { abs: fileAbs, mtimeMs: st.mtimeMs });
      } catch {
        /* 竞态删除：跳过 */
      }
    }
  };
  walk("", 0);
  if (out.size <= ARTIFACT_MAX_FILES) return out;
  // 超额时笔记优先、其余按 mtime 倒序：新存/常写的笔记不会被一堆旧附件挤出索引
  const ranked = [...out.entries()]
    .sort(([relA, a], [relB, b]) => {
      const noteA = NOTE_FILE_RE.test(relA) ? 1 : 0;
      const noteB = NOTE_FILE_RE.test(relB) ? 1 : 0;
      return (
        noteB - noteA ||
        b.mtimeMs - a.mtimeMs ||
        (relA < relB ? -1 : relA > relB ? 1 : 0)
      );
    })
    .slice(0, ARTIFACT_MAX_FILES);
  return new Map(ranked);
}

/** 单文件抽取：文本扩展名取正文（截断），其余只索引文件名 */
function extractArtifactText(abs: string, name: string): string {
  const ext = extname(name).toLowerCase();
  if (!ARTIFACT_TEXT_EXTS.has(ext)) return "";
  try {
    const stat = statSync(abs);
    if (stat.size > 2 * 1024 * 1024) return ""; // 超大文本不索引正文
    // 只读前 64KB：旧实现 readFileSync 会把 2MB 上限内的整个文件读进内存，
    // 800 个文件的库首轮索引可能吃掉几百 MB；索引本来也只保留前 64KB。
    const fd = openSync(abs, "r");
    let text: string;
    try {
      const buf = Buffer.alloc(ARTIFACT_MAX_TEXT_BYTES);
      const read = readSync(fd, buf, 0, buf.length, 0);
      text = buf.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
    if (text.includes("\u0000")) return ""; // 二进制伪装成文本扩展名
    return text;
  } catch {
    return "";
  }
}

/** 预览用正文：剥掉 YAML frontmatter（笔记存为 .md 时必然带一段元数据，
 *  直接截前 140 字会让搜索摘要全是 `--- title: ...`）。全文索引仍保留原样，
 *  标题/标签照常可搜。 */
function previewBody(body: string): string {
  if (!body.startsWith("---\n") && !body.startsWith("---\r\n")) return body;
  const match = /\r?\n---\r?\n/.exec(body.slice(3));
  return match ? body.slice(3 + match.index + match[0].length) : body;
}

/** 一个归属域（目录）→ 索引行。rel 为键；正文小写化，未命中正文时行仍保留
 *  （search_text 为空 = 只靠文件名 LIKE 命中）。 */
export function buildArtifactIndexRows(base: string): Array<{
  rel: string;
  name: string;
  preview: string;
  searchText: string;
}> {
  const rows: Array<{ rel: string; name: string; preview: string; searchText: string }> = [];
  for (const [rel, info] of listArtifactFiles(base)) {
    const body = extractArtifactText(info.abs, basename(rel));
    const compact = previewBody(body).replace(/\s+/g, " ").trim();
    rows.push({
      rel,
      name: basename(rel),
      preview: compact.slice(0, PREVIEW_RADIUS * 2 + 20),
      searchText: body.toLowerCase().slice(0, ARTIFACT_MAX_TEXT_BYTES),
    });
  }
  return rows;
}

/** 目录域水位增量（产物单会话目录 / 资料库根共用）：目录 mtime 不透传子树
 *  变化，所以水位键 = 目录内「最大文件 mtime + 文件数」——两者任一变化即重扫。 */
export function artifactWatermark(base: string): number {
  const files = listArtifactFiles(base);
  // 水位 = 有序 (rel, mtime) 列表的 FNV-1a 哈希，不是 max(mtime)+文件数：
  // 改名/移动保持 mtime 且文件数不变，旧水位会漏掉整次变更，搜索继续返回旧
  // 路径（kb_read 随即找不到文件）。哈希对增删改/改名都敏感。
  let hash = 0x811c9dc5;
  const entries = [...files.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const [rel, info] of entries) {
    const key = `${rel}\u0000${info.mtimeMs}`;
    for (let i = 0; i < key.length; i += 1) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x0a;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 文件域刷新互斥（与会话域分开；文件域扫描更重，不互相拖住） */
let artifactsInFlight: Promise<void> | null = null;
/** 上次索引的资料库根：换根时水位可能碰巧相同，必须强制重灌一次 */
let lastLibraryBase: string | null = null;

/**
 * 产物 + 资料库文件索引的增量回填：水位 = max(mtime)+文件数。
 * 已删会话的产物域由 refreshSearchIndex 对账（dropSessionSearchIndex 亦清）；
 * 资料库换根时旧键 __library__ 全量重灌覆盖，无残留问题。
 */
export async function refreshArtifactsIndex(): Promise<void> {
  if (artifactsInFlight) return artifactsInFlight;
  artifactsInFlight = (async () => {
    try {
      const scanned = new Map(
        (await searchArtifactsScanList()).map((r) => [r.ownerKey, r.mtime]),
      );
      const liveOwners = new Set<string>();
      // 任务产物域：每会话一个目录（目录缺失 = 跳过，不清水位——
      // 首次写文件前目录本就不存在）
      for (const session of await sessionList()) {
        // 与 resolve.ts 同一条路径段校验：id 来自索引行（正常是 UUID），但
        // 拼进文件系统路径前必须限为单段——非法 id 直接跳过而不是走出工作区
        const seg = taskSessionSeg(session.id);
        if (!seg) continue;
        const base = join(taskWorkspaceBase(), seg);
        try {
          if (!statSync(base).isDirectory()) continue;
        } catch {
          continue;
        }
        liveOwners.add(session.id);
        const mark = artifactWatermark(base);
        if (scanned.get(session.id) === mark) continue;
        await searchArtifactsUpsert(session.id, buildArtifactIndexRows(base));
        await searchArtifactsScanSet(session.id, mark);
      }
      // 资料库域：单根哨兵键
      const libBase = await artifactLibraryBase();
      if (libBase) {
        try {
          if (statSync(libBase).isDirectory()) {
            liveOwners.add(ARTIFACT_OWNER_LIBRARY);
            const mark = artifactWatermark(libBase);
            const rootChanged = lastLibraryBase !== libBase;
            lastLibraryBase = libBase;
            if (rootChanged || scanned.get(ARTIFACT_OWNER_LIBRARY) !== mark) {
              await searchArtifactsUpsert(ARTIFACT_OWNER_LIBRARY, buildArtifactIndexRows(libBase));
              await searchArtifactsScanSet(ARTIFACT_OWNER_LIBRARY, mark);
            }
          }
        } catch {
          /* 根不存在/不可读：跳过 */
        }
      }
      // 已删会话/已移除域的残留（__library__ 保留判定在上面）
      for (const stale of scanned.keys()) {
        if (!liveOwners.has(stale)) await searchArtifactsDelete(stale);
      }
    } catch (err) {
      logErr("artifact-index refresh failed:", err);
    } finally {
      artifactsInFlight = null;
    }
  })();
  return artifactsInFlight;
}

/**
 * 默认页（空查询）的最近产物：只读已建好的文件索引（不触发全量回填——
 * 那是首次 search 的职责）。索引为空 = 返回空数组，前端不展示该组。
 */
export async function recentArtifacts(limit: number) {
  return searchArtifactsRecent(limit);
}

/** 会话删除时清产物域（知识索引拥有文件域的完整生命周期）。 */
export async function deleteArtifactsIndex(ownerKey: string): Promise<void> {
  await searchArtifactsDelete(ownerKey);
}
