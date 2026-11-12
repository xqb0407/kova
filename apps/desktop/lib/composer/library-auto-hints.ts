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
import { hintTerms, rankHintEntries } from "knowledge-core";
import { collectLibraryReferences } from "./library-reference";

export { hintTerms, rankHintEntries };

/** 过短的文本没有检索价值（「好」「继续」） */
const MIN_QUERY_CHARS = 2;
const MAX_QUERY_CHARS = 500;

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

/** 发送保底/输入框建议共用：最近条目里挑相关的（空查询走 15s 缓存）。
 *  preferPrefix = 当前工作空间的 rel 前缀（如「项目/demo/」），命中者优先。 */
export async function suggestLibraryEntries(
  text: string,
  excludeRels: ReadonlySet<string> = new Set(),
  limit = 3,
  preferPrefix?: string,
): Promise<LibraryIndexEntry[]> {
  const query = autoHintText(text);
  if (!query) return [];
  try {
    const result = await searchLibrary("", { fresh: false });
    return rankHintEntries(result.entries, query, excludeRels, limit, preferPrefix);
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

/** 发送前预取：纯文本 + 已引用/已提示去重，返回隐藏块与本次提示的 rel。
 *  options.preferPrefix = 当前工作空间前缀（会话有项目时传入，命中者优先）。 */
export async function prefetchLibraryAutoHints(
  parts: readonly { type: string; text?: string }[],
  options: { excludeRels?: ReadonlySet<string>; preferPrefix?: string } = {},
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
  const hints = await suggestLibraryEntries(text, exclude, 2, options.preferPrefix);
  if (hints.length === 0) return null;
  const rels = hints.map((hit) => hit.rel);
  const boundary = Math.random().toString(36).slice(2, 10);
  const block = buildLibraryHintsBlock(hints, boundary);
  return { block, rels };
}
