/**
 * Markdown 预览的标题目录（锚点定位）。
 *
 * 纯函数：从渲染后的标题文本生成稳定 id 与目录项，不碰 DOM。FileViewer 负责
 * 把 id 写回标题元素并做滚动高亮；这里只保证「同一篇文章两次生成的 id 一致」。
 */

export type TocEntry = { id: string; label: string; level: number };

export type TocHeading = { text: string; level: number };

/** 标题 → 稳定锚点：保留中英文与数字，其余字符折叠成连字符 */
export function headingSlug(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** 目录项比较：避免 MutationObserver 每次重扫都造新数组触发整棵预览重渲染 */
export function tocEqual(
  a: readonly TocEntry[],
  b: readonly TocEntry[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (entry, index) =>
        entry.id === b[index]?.id &&
        entry.label === b[index]?.label &&
        entry.level === b[index]?.level,
    )
  );
}

/** 标题序列 → 目录项；空标题跳过，同名标题用 -2/-3 去重，级别夹到 1..6 */
export function buildTocEntries(headings: readonly TocHeading[]): TocEntry[] {
  const used = new Map<string, number>();
  const out: TocEntry[] = [];
  for (const heading of headings) {
    const label = heading.text.replace(/\s+/g, " ").trim();
    if (!label) continue;
    const base = headingSlug(label) || "section";
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    out.push({
      id: seen === 0 ? `md-${base}` : `md-${base}-${seen + 1}`,
      label: label.slice(0, 80),
      level: Math.min(6, Math.max(1, Math.trunc(heading.level) || 1)),
    });
  }
  return out;
}
