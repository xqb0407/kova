// 迁移自桌面端 apps/desktop/lib/pi/web-search.ts（2026-10-03，逐行同源，
// 面板活动层的引用资料解析共用一份口径）。
/**
 * WebSearch 结果文本 → 结构化条目（消息行展开用）。
 * sidecar（http-tools.ts renderSearchResults）在能解析时会把结果装配成固定格式：
 *   Web search results for "query":\n\n- 标题\n  https://…\n  摘要\n\n…
 * 解析不出条目时回退为原始文本——那种情况这里也返回 null，行渲染落回原始输出框。
 * （不 import sidecar 包：那是独立 Node 进程的工程，web 端只共享字符串约定。）
 */
export type WebSearchItem = {
  title: string;
  url?: string;
  snippet?: string;
};

const HEADER_RE = /^Web search results for ".*":\n+/;

export function parseWebSearchResults(
  text: string,
): WebSearchItem[] | null {
  const header = text.match(HEADER_RE);
  if (!header) return null;
  const blocks = text
    .slice(header[0].length)
    .split(/\n{2,}/)
    .filter((b) => b.trim().length > 0);
  const items: WebSearchItem[] = [];
  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    const title = lines[0]?.replace(/^[-•]\s*/, "").trim();
    if (!title) continue;
    let url: string | undefined;
    const snippetLines: string[] = [];
    for (const line of lines.slice(1)) {
      if (!url && /^https?:\/\//.test(line)) {
        url = line;
        continue;
      }
      // (source: x) 尾注并入摘要意义不大，丢弃
      if (/^\(source:/.test(line)) continue;
      snippetLines.push(line);
    }
    items.push({ title, url, snippet: snippetLines.join(" ") || undefined });
  }
  return items.length > 0 ? items : null;
}
