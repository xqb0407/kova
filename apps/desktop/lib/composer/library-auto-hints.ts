"use client";

/**
 * 资料库自动召回的两块共用逻辑：
 *
 * - **发送保底**：ThreadController 在发送汇聚点拿用户原文跑一次轻量检索，
 *   命中就把「可能的资料库笔记」以隐藏块交给模型（只有标题/相对路径，不塞正文）；
 * - **输入框建议**：composer 防抖后显示前几条，点击插入 `:library` 芯片。
 *
 * 两者都不能直接拿整句去 `searchLibrary`：现有索引是子串匹配，整句自然语言
 * 基本命中不了。这里先用 token/bigram 提取关键词，再对最近条目做本地打分。
 */
import { unstable_defaultDirectiveFormatter } from "@assistant-ui/core";
import type { LibraryIndexEntry } from "@/lib/workspace/library-index";
import { searchLibrary } from "@/lib/workspace/library-index";
import { stripLibraryContextBlocks } from "@/lib/pi/prompt-notices";
import { collectLibraryReferences } from "./library-reference";

/** 过短的文本没有检索价值（「好」「继续」） */
const MIN_QUERY_CHARS = 2;
const MAX_QUERY_CHARS = 500;
const MAX_TERMS = 16;
const MIN_RANK_SCORE = 4;

/** 高频功能词/意图词：匹配到它们只会把所有笔记都翻出来 */
const STOP_TERMS = new Set([
  "这个", "那个", "这些", "那些", "怎么", "什么", "为何", "如何", "可以",
  "帮我", "一下", "一个", "我们", "你们", "他们", "是不", "不是", "有没",
  "没有", "需要", "现在", "然后", "如果", "因为", "所以", "但是", "就是",
  "还是", "已经", "可能", "应该", "记得", "之前", "上次", "刚才", "笔记",
  "资料", "文档", "东西", "问题", "内容", "保存", "存为", "提到", "说过",
  "what", "about", "note", "notes", "saved", "earlier", "remember",
  "please", "could", "would", "should", "there", "their", "this", "that",
  "with", "from", "have", "does", "your", "you", "the", "and", "for",
  "继续", "好的", "收到", "谢谢", "明白", "不用", "稍等", "先这样",
]);

/** 原文 → 纯文本查询（剥掉芯片/隐藏块；命令与 @ 提及不触发） */
export function autoHintText(input: string): string {
  if (!input.trim()) return "";
  const segments = unstable_defaultDirectiveFormatter.parse(input);
  const plain = stripLibraryContextBlocks(
    segments
      .map((segment) => (segment.kind === "text" ? segment.text : ""))
      .join(" "),
  )
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length < MIN_QUERY_CHARS) return "";
  if (plain.startsWith("/") || plain.startsWith("@")) return "";
  return plain.slice(0, MAX_QUERY_CHARS);
}

/** 关键词切分：中文滑窗 bigram（2-4 字词保留自身），英文按空白分词 */
export function hintTerms(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (const word of words) {
    if (/[\u3400-\u9fff]/u.test(word)) {
      for (let i = 0; i < word.length - 1; i += 1) {
        const term = word.slice(i, i + 2);
        if (!STOP_TERMS.has(term)) out.add(term);
      }
      if (word.length <= 4 && !STOP_TERMS.has(word)) out.add(word);
    } else if (word.length >= 3 && !STOP_TERMS.has(word)) {
      out.add(word);
    }
    if (out.size >= MAX_TERMS) break;
  }
  return [...out].slice(0, MAX_TERMS);
}

/**
 * 对最近条目做本地打分：标题 > 标签 > 文件名 > rel。返回 Top N；
 * 低于阈值不返回，避免把无关笔记塞进输入框或模型上下文。
 */
export function rankHintEntries(
  entries: readonly LibraryIndexEntry[],
  text: string,
  excludeRels: ReadonlySet<string> = new Set(),
  limit = 3,
): LibraryIndexEntry[] {
  const terms = hintTerms(text);
  if (terms.length === 0) return [];
  const scored: { entry: LibraryIndexEntry; score: number }[] = [];
  for (const entry of entries) {
    if (excludeRels.has(entry.rel)) continue;
    const title = entry.title.toLowerCase();
    const name = entry.name.toLowerCase();
    const rel = entry.rel.toLowerCase();
    const tags = entry.tags.map((tag) => tag.toLowerCase());
    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) score += 8 + term.length;
      else if (tags.some((tag) => tag.includes(term))) score += 5 + term.length;
      else if (name.includes(term)) score += 4 + term.length;
      else if (rel.includes(term)) score += 2;
    }
    if (score >= MIN_RANK_SCORE) scored.push({ entry, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.entry.lastUsed ?? 0) - (a.entry.lastUsed ?? 0) ||
      (b.entry.modified ?? "").localeCompare(a.entry.modified ?? ""),
  );
  return scored.slice(0, limit).map((row) => row.entry);
}

/** 发送保底/输入框建议共用：最近条目里挑相关的（空查询走 15s 缓存） */
export async function suggestLibraryEntries(
  text: string,
  excludeRels: ReadonlySet<string> = new Set(),
  limit = 3,
): Promise<LibraryIndexEntry[]> {
  const query = autoHintText(text);
  if (!query) return [];
  try {
    const result = await searchLibrary("", { fresh: false });
    return rankHintEntries(result.entries, query, excludeRels, limit);
  } catch {
    return [];
  }
}

/** 发送端的隐藏块：只有标题/相对路径，正文仍由模型自己 kb_read */
export function buildLibraryHintsBlock(
  hints: readonly LibraryIndexEntry[],
  boundary: string,
): string {
  if (hints.length === 0) return "";
  const clean = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
  return [
    `[[library-hints:${boundary}]]`,
    "Possibly relevant library notes the user saved earlier (titles only; read with kb_read source=library before relying on them):",
    ...hints.map(
      (hit) => `- ${clean(hit.title || hit.name)} (path: ${clean(hit.rel)})`,
    ),
    `[[/library-hints:${boundary}]]`,
  ].join("\n");
}

/** 发送前预取：纯文本 + 已引用/已提示去重，返回隐藏块与本次提示的 rel */
export async function prefetchLibraryAutoHints(
  parts: readonly { type: string; text?: string }[],
  options: { excludeRels?: ReadonlySet<string> } = {},
): Promise<{ block: string; rels: string[] } | null> {
  const text = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n");
  if (!autoHintText(text)) return null;
  const userRefs = new Set(
    collectLibraryReferences(text).map((item) => item.ref.rel),
  );
  const exclude = new Set([...(options.excludeRels ?? []), ...userRefs]);
  const hints = await suggestLibraryEntries(text, exclude, 2);
  if (hints.length === 0) return null;
  const rels = hints.map((hit) => hit.rel);
  const boundary = Math.random().toString(36).slice(2, 10);
  const block = buildLibraryHintsBlock(hints, boundary);
  return { block, rels };
}
