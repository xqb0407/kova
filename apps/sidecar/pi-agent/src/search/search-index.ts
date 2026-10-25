/**
 * 全局搜索索引（sidecar 派生投影，宿主持有表）：
 * - 会话域（session_blocks）：JSONL 转录 → 消息级行，水位 = 转录 mtime；
 * - 文件域（artifact_blocks）：任务产物目录 + 资料库根 → 文件级行，
 *   水位 = max(文件 mtime)+文件数；ownerKey = sessionId 或 __library__。
 * 正文真值永远在转录文件/产物文件；两张索引表都可弃、清空后全量重建。
 *
 * 触发点都是 fire-and-forget（persist 尾部 / truncate_session / delete_session）：
 * 索引最多滞后一轮，绝不阻塞消息流；失败 logErr 静默——搜索不可用不该拖垮会话。
 *
 * 抽取范围（search_text，全部小写化拼接）：
 * - user：content 全部 text 块（注入的 auto-continue / goal 内部文本与 toUiMessage
 *   同款隐藏——它们不是用户说过的话，搜出来是噪音）；
 * - assistant：全部 text 块 + toolCall 的「名称 + 参数摘要」（≤256 字符）；
 * - toolResult：toolName + 输出 text 截前 1KB（工具输出是体量与噪音的主要来源，
 *   截断保住"上次那个报错在哪个会话"的召回，又不让索引膨胀）；
 * - 文件域：文本扩展名取正文截 64KB，二进制/媒体只进文件名索引。
 */
import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { extname, join, basename, resolve } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  isAutoContinueText,
  isCapabilityReminderText,
  isGoalInternalText,
} from "pi-protocol";
import { readTranscript } from "../sessions/transcript";
import { sessionPath } from "../storage/storage";
import {
  ARTIFACT_OWNER_LIBRARY,
  searchArtifactsDelete,
  searchArtifactsRecent,
  searchArtifactsScanList,
  searchArtifactsScanSet,
  searchArtifactsUpsert,
  searchBlocksDelete,
  searchBlocksScanList,
  searchBlocksScanSet,
  searchBlocksUpsert,
  sessionList,
  type SessionSearchResult,
  sessionSearch,
} from "../storage/hostdb";
import { taskSessionSeg, taskWorkspaceBase } from "../sessions/resolve";
import { logErr } from "../log";

/** 单条消息索引文本上限：正常一条 assistant 消息远小于此，只拦 runaway */
const MAX_SEARCH_TEXT = 4 * 1024;
/** toolCall 参数摘要上限 */
const MAX_TOOL_ARGS = 256;
/** toolResult 输出进入索引的截断长度 */
const MAX_TOOL_OUTPUT = 1024;
/** preview 片段半径（needle 两侧各取多少字符） */
const PREVIEW_RADIUS = 60;
/** 单会话单次重灌的行数上限（防 runaway；正常与会话消息数同阶） */
const MAX_ROWS_PER_SESSION = 5000;

export type SearchBlockRow = {
  seq: number;
  role: string;
  preview: string;
  searchText: string;
};

/** user content → 文本（string 直出；块数组取全部 text；image 等忽略） */
function userText(msg: Extract<Message, { role: "user" }>): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** 工具参数对象 → 一行摘要（键值对平铺，保持插入序；值截断） */
function toolArgsSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (parts.length >= 8) break;
    const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
    if (!text) continue;
    parts.push(`${key}:${text.slice(0, 80)}`);
  }
  return parts.join(" ").slice(0, MAX_TOOL_ARGS);
}

/**
 * 单条消息 → 索引文本（未小写化）。空串 = 该行无可搜内容（纯 thinking /
 * 纯 image），调用方跳过落行。
 */
export function extractSearchText(msg: Message): string {
  if (msg.role === "user") {
    const text = userText(msg);
    // 与 toUiMessage 同款隐藏：注入行不是用户说的话（含能力收尾提醒哨兵）
    if (
      !text.trim() ||
      isAutoContinueText(text) ||
      isGoalInternalText(text) ||
      isCapabilityReminderText(text)
    )
      return "";
    return text.slice(0, MAX_SEARCH_TEXT);
  }
  if (msg.role === "assistant") {
    const parts: string[] = [];
    for (const c of msg.content) {
      if (c.type === "text" && c.text.trim()) parts.push(c.text);
      else if (c.type === "toolCall") {
        const summary = toolArgsSummary(c.arguments);
        parts.push(summary ? `[工具 ${c.name}] ${summary}` : `[工具 ${c.name}]`);
      }
      // thinking 不进索引：内部推理，搜索价值低、体量大
    }
    return parts.join("\n").slice(0, MAX_SEARCH_TEXT);
  }
  if (msg.role === "toolResult") {
    const output = msg.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .slice(0, MAX_TOOL_OUTPUT);
    if (!output.trim()) return "";
    return `[${msg.toolName} 结果] ${output}`.slice(0, MAX_SEARCH_TEXT);
  }
  return ""; // system 不落盘，防御性兜底
}

/** 把切点吸附到 UTF-8 字符边界（按字节切中文/emoji 会产生乱码） */
function floorCharBoundary(text: string, index: number): number {
  if (index >= text.length) return text.length;
  while (index > 0 && (text.charCodeAt(index) & 0xc0) === 0x80) index--;
  return index;
}

function ceilCharBoundary(text: string, index: number): number {
  if (index >= text.length) return text.length;
  while (index < text.length && (text.charCodeAt(index) & 0xc0) === 0x80) index++;
  return index;
}

/** 命中附近片段：压平空白，needle 前后各取 PREVIEW_RADIUS 字符 */
export function searchPreview(text: string, needle: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const lower = compact.toLowerCase();
  const index = lower.indexOf(needle.toLowerCase());
  if (index < 0) return compact.slice(0, PREVIEW_RADIUS * 2);
  const start = Math.max(0, index - PREVIEW_RADIUS);
  const end = Math.min(compact.length, index + needle.length + PREVIEW_RADIUS);
  let preview = compact.slice(floorCharBoundary(compact, start), ceilCharBoundary(compact, end));
  if (start > 0) preview = `…${preview}`;
  if (end < compact.length) preview = `${preview}…`;
  return preview;
}

/** 单会话转录 → 索引行（seq 对齐转录文件内的消息行编号） */
export function buildSessionIndexRows(sessionId: string): SearchBlockRow[] {
  const rows: SearchBlockRow[] = [];
  for (const { seq, agent } of readTranscript(sessionId)) {
    if (rows.length >= MAX_ROWS_PER_SESSION) break;
    const raw = extractSearchText(agent);
    if (!raw.trim()) continue;
    rows.push({
      seq,
      role: (agent as { role?: string }).role ?? "",
      preview: raw.replace(/\s+/g, " ").trim().slice(0, PREVIEW_RADIUS * 2 + 20),
      searchText: raw.toLowerCase(),
    });
  }
  return rows;
}

/** 索引器内的刷新互斥：连发的 persist 触发合并成一次全量检查 */
let refreshInFlight: Promise<void> | null = null;

/**
 * 水位增量回填（幂等）：mtime 与 search_scan 不一致的会话整扫重灌，
 * 已删会话清残留。首次（表空）= 全量回填，之后每次只处理脏会话。
 */
export async function refreshSearchIndex(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const sessions = await sessionList();
      const liveIds = new Set(sessions.map((s) => s.id));
      const scanned = new Map(
        (await searchBlocksScanList()).map((r) => [r.sessionId, r.mtime]),
      );
      for (const session of sessions) {
        let mtime = 0;
        try {
          mtime = statSync(sessionPath(session.id)).mtimeMs;
        } catch {
          continue; // 索引行与文件短暂不一致：跳过，下轮再对账
        }
        if (scanned.get(session.id) === mtime) continue;
        const rows = buildSessionIndexRows(session.id);
        await searchBlocksUpsert(session.id, rows);
        await searchBlocksScanSet(session.id, mtime);
      }
      // 已删会话的残留索引行与水位
      for (const stale of scanned.keys()) {
        if (!liveIds.has(stale)) await searchBlocksDelete(stale);
      }
    } catch (err) {
      logErr("search-index refresh failed:", err);
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/** 会话删除时清索引：块行 + mtime 水位一起走（session_delete 调用） */
export async function dropSessionSearchIndex(sessionId: string): Promise<void> {
  await searchBlocksDelete(sessionId);
  // 会话产物目录的文件索引一并清（artifact 域水位由 refreshArtifactsIndex 对账）
  await searchArtifactsDelete(sessionId);
}

/* ---------------------- 文件域索引：产物 + 资料库 ---------------------- */

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

function artifactLibraryBase(): string {
  return process.env.PI_LIBRARY_ROOT
    ? resolve(process.env.PI_LIBRARY_ROOT)
    : "";
}

/**
 * 递归列出一个文件域目录（深度/数量双上限，跳过依赖目录）。
 * 返回 rel（POSIX）→ 绝对路径与 mtime。
 */
function listArtifactFiles(base: string): Map<string, { abs: string; mtimeMs: number }> {
  const out = new Map<string, { abs: string; mtimeMs: number }>();
  const walk = (rel: string, depth: number): void => {
    if (out.size >= ARTIFACT_MAX_FILES) return;
    const abs = rel ? join(base, ...rel.split("/")) : base;
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.size >= ARTIFACT_MAX_FILES) return;
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
  return out;
}

/** 单文件抽取：文本扩展名取正文（截断），其余只索引文件名 */
function extractArtifactText(abs: string, name: string): string {
  const ext = extname(name).toLowerCase();
  if (!ARTIFACT_TEXT_EXTS.has(ext)) return "";
  try {
    const stat = statSync(abs);
    if (stat.size > 2 * 1024 * 1024) return ""; // 超大文本不索引正文
    const buf = readFileSync(abs);
    const cut = buf.subarray(0, Math.min(buf.length, ARTIFACT_MAX_TEXT_BYTES));
    const text = cut.toString("utf8");
    if (text.includes("\u0000")) return ""; // 二进制伪装成文本扩展名
    return text;
  } catch {
    return "";
  }
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
    const compact = body.replace(/\s+/g, " ").trim();
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
function artifactWatermark(base: string): number {
  const files = listArtifactFiles(base);
  let latest = 0;
  let count = 0;
  for (const info of files.values()) {
    latest = Math.max(latest, info.mtimeMs);
    count += 1;
  }
  return latest + count;
}

/** 文件域刷新互斥（与会话域分开；文件域扫描更重，不互相拖住） */
let artifactsInFlight: Promise<void> | null = null;

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
      const libBase = artifactLibraryBase();
      if (libBase) {
        try {
          if (statSync(libBase).isDirectory()) {
            liveOwners.add(ARTIFACT_OWNER_LIBRARY);
            const mark = artifactWatermark(libBase);
            if (scanned.get(ARTIFACT_OWNER_LIBRARY) !== mark) {
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

/**
 * 面向查询的入口：先增量刷新（会话域 + 文件域），再走宿主 session_search。
 * 同时把查询写入搜索历史（去重保最新；空查询不记）。
 * 查询失败向上抛——调用方（协议层）决定降级展示。
 */
export async function searchSessions(query: string, limit = 200): Promise<SessionSearchResult> {
  const needle = query.trim().toLowerCase();
  if (!needle) return { sessions: [], messages: [], artifacts: [], truncated: false };
  await Promise.all([refreshSearchIndex(), refreshArtifactsIndex()]);
  // 历史不在这里记：防抖查询会逐字符入库（"跑"→"跑起"→"跑起来"全进历史）。
  // 记录点 = 渲染层"打开某条结果"（search_history_add 命令），代表一次真实检索。
  // 传原始 needle：LIKE 转义由 hostdb.sessionSearch 产出 likeNeedle（配 SQL 的
  // ESCAPE），instr 路径必须拿原始词——这里预转义会让 %/_ 查询双路全失效
  return sessionSearch(needle, limit);
}
