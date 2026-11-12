/**
 * 全局搜索索引（sidecar 派生投影，宿主持有表）：
 * - 会话域（session_blocks）：JSONL 转录 → 消息级行，水位 = 转录 mtime。
 * 文件域（artifact_blocks：任务产物 + 资料库）已迁到 knowledge/artifact-index。
 * 正文真值永远在转录文件/产物文件；两张索引表都可弃、清空后全量重建。
 *
 * 触发点都是 fire-and-forget（persist 尾部 / truncate_session / delete_session）：
 * 索引最多滞后一轮，绝不阻塞消息流；失败 logErr 静默——搜索不可用不该拖垮会话。
 *
 * 抽取范围仅覆盖会话消息；文件域的文本抽取规则见 knowledge/artifact-index。
 */
import {
  statSync,
} from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import {
  isAutoContinueText,
  isCapabilityReminderText,
  isGoalInternalText,
} from "pi-protocol";
import { readTranscript } from "../sessions/transcript";
import { sessionPath } from "../storage/storage";
import {
  searchBlocksDelete,
  searchBlocksScanList,
  searchBlocksScanSet,
  searchBlocksUpsert,
  sessionList,
  type SessionSearchResult,
  sessionSearch,
} from "../storage/hostdb";
import {
  deleteArtifactsIndex,
  refreshArtifactsIndex,
} from "../knowledge/artifact-index";
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

/** 资料库隐藏上下文块（引用路径/笔记正文/自动召回提示）：只给模型看，
 *  不进会话搜索索引，否则每轮自动召回都会把这些标题变成全库可搜的噪音。 */
const LIBRARY_CONTEXT_BLOCK_RE =
  /\[\[library-(?:refs|notes|hints)(?::[^\]]+)?\]\][\s\S]*?\[\[\/library-(?:refs|notes|hints)(?::[^\]]+)?\]\]/g;

/**
 * 单条消息 → 索引文本（未小写化）。空串 = 该行无可搜内容（纯 thinking /
 * 纯 image），调用方跳过落行。
 */
export function extractSearchText(msg: Message): string {
  if (msg.role === "user") {
    const text = userText(msg).replace(LIBRARY_CONTEXT_BLOCK_RE, "").trim();
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
  await deleteArtifactsIndex(sessionId);
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
