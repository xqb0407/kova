/**
 * 资料库/知识检索的纯函数与共享类型。
 *
 * 不依赖 React、sidecar、文件系统；桌面渲染层与 sidecar 共用同一套排序口径。
 */

/** 资料库条目最小形状（渲染层 LibraryIndexEntry 可结构兼容）。 */
export interface KnowledgeEntry {
  rel: string;
  name: string;
  modified?: string | null;
  title: string;
  tags: string[];
  lastUsed?: number;
}

/** 最近排序：最近使用 ∪ 最近修改。 */
function byRecency<T extends KnowledgeEntry>(a: T, b: T): number {
  return (
    (b.lastUsed ?? 0) - (a.lastUsed ?? 0) ||
    (b.modified ?? "").localeCompare(a.modified ?? "")
  );
}

function isNoteEntry(rel: string): boolean {
  return /\.(md|markdown|knote)$/iu.test(rel);
}

function scoreEntry(entry: KnowledgeEntry, needle: string): number {
  if (entry.title.toLowerCase().includes(needle)) return 400;
  const tagNeedle = needle.replace(/^#/, "");
  if (entry.tags.some((tag) => tag.includes(tagNeedle))) return 300;
  if (entry.name.toLowerCase().includes(needle)) return 200;
  if (entry.rel.toLowerCase().includes(needle)) return 100;
  return 0;
}

function preferPrefixFirst<T extends KnowledgeEntry>(
  entries: T[],
  prefix: string | undefined,
): T[] {
  if (!prefix) return entries;
  const inScope: T[] = [];
  const rest: T[] = [];
  for (const entry of entries) {
    (entry.rel.startsWith(prefix) ? inScope : rest).push(entry);
  }
  return [...inScope, ...rest];
}

/** 过滤 + 排序：空 query 笔记优先 + 修改时间；非空按标题 > 标签 > 文件名 > rel。 */
export function rankLibraryEntries<T extends KnowledgeEntry>(
  entries: readonly T[],
  query: string,
  opts?: { preferPrefix?: string },
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    const notes = entries.filter((entry) => isNoteEntry(entry.rel)).sort(byRecency);
    const others = entries.filter((entry) => !isNoteEntry(entry.rel)).sort(byRecency);
    return preferPrefixFirst([...notes, ...others], opts?.preferPrefix);
  }
  const scored = entries
    .map((entry) => ({ entry, score: scoreEntry(entry, needle) }))
    .filter((row) => row.score > 0);
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.entry.lastUsed ?? 0) - (a.entry.lastUsed ?? 0) ||
      (b.entry.modified ?? "").localeCompare(a.entry.modified ?? ""),
  );
  return preferPrefixFirst(
    scored.map((row) => row.entry),
    opts?.preferPrefix,
  );
}

const MAX_TERMS = 16;
const MIN_RANK_SCORE = 4;

/** 高频功能词/意图词：匹配到它们只会把所有笔记都翻出来。 */
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

/** 关键词切分：中文滑窗 bigram（2-4 字词保留自身），英文按空白分词。 */
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

/** 对条目做本地打分：标题 > 标签 > 文件名 > rel；低于阈值不返回。 */
export function rankHintEntries<T extends KnowledgeEntry>(
  entries: readonly T[],
  text: string,
  excludeRels: ReadonlySet<string> = new Set(),
  limit = 3,
  preferPrefix?: string,
): T[] {
  const terms = hintTerms(text);
  if (terms.length === 0) return [];
  const scored: { entry: T; score: number }[] = [];
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
  if (preferPrefix) {
    const inScope: { entry: T; score: number }[] = [];
    const rest: { entry: T; score: number }[] = [];
    for (const row of scored) {
      (row.entry.rel.startsWith(preferPrefix) ? inScope : rest).push(row);
    }
    return [...inScope, ...rest].slice(0, limit).map((row) => row.entry);
  }
  return scored.slice(0, limit).map((row) => row.entry);
}
