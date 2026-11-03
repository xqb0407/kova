/**
 * 文档快照 → 自含 HTML（纯函数）。
 *
 * 用途：「导出 HTML」——保留标题层级与行内样式（粗/斜/下划线/字号/颜色/字体），
 * 浏览器打开后可 Ctrl/⌘+P 打印成 PDF（在 Univer OSS 没有 PDF 导出的情况下的兜底路径）。
 *
 * 解析规则与 skills/doc 的机械约定同源：dataStream 以 \r 分段落、结尾 "\r\n" 收尾
 * （\n 是节分隔符）；paragraphs.startIndex 与 textRuns 的 st/ed 都是 dataStream 偏移。
 * Univer 的 ts.cl.rgb 是 24 位整数色值，转成 #rrggbb。
 */

type RunTs = {
  bl?: number;
  it?: number;
  ul?: number;
  fs?: number;
  cl?: { rgb?: number };
  ff?: string;
};

export type DocRunLike = { st?: number; ed?: number; ts?: RunTs };
export type DocParagraphLike = { startIndex?: number; paragraphStyle?: { namedStyleType?: number } };
export type DocBodyLike = { dataStream?: string; paragraphs?: DocParagraphLike[]; textRuns?: DocRunLike[] };
export type DocSnapshotLike = { title?: string; body?: DocBodyLike };

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Univer 24 位整数色值 → #rrggbb */
export function rgbIntToHex(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, "0")}`;
}

function styleDecl(ts: RunTs): string {
  const decl: string[] = [];
  if (ts.bl) decl.push("font-weight:700");
  if (ts.it) decl.push("font-style:italic");
  if (ts.ul) decl.push("text-decoration:underline");
  if (ts.fs && ts.fs > 0) decl.push(`font-size:${ts.fs}px`);
  if (ts.cl && typeof ts.cl.rgb === "number") decl.push(`color:${rgbIntToHex(ts.cl.rgb)}`);
  if (ts.ff) decl.push(`font-family:${ts.ff.replace(/["<>]/g, "")},system-ui,sans-serif`);
  return decl.join(";");
}

/** namedStyleType → 标签：2 大标题 / 3 副标题 / 4 一级 / 5 二级 / 6 三级 */
const HEADING_TAG: Record<number, [string, string]> = {
  2: ["h1", "title"],
  3: ["h2", "subtitle"],
  4: ["h2", "heading-1"],
  5: ["h3", "heading-2"],
  6: ["h4", "heading-3"],
};

/** 段落文字（不含 \r 终结符）与起点偏移 */
function paragraphsOf(body: DocBodyLike): { text: string; start: number; style?: DocParagraphLike["paragraphStyle"] }[] {
  const ds = body.dataStream ?? "";
  if (!ds) return [{ text: "", start: 0 }];
  const core = ds.endsWith("\r\n") ? ds.slice(0, -2) : ds.endsWith("\r") ? ds.slice(0, -1) : ds;
  const texts = core.split("\r");
  const styles = Array.isArray(body.paragraphs) ? body.paragraphs : [];
  const out: { text: string; start: number; style?: DocParagraphLike["paragraphStyle"] }[] = [];
  let offset = 0;
  texts.forEach((text, i) => {
    out.push({ text, start: offset, ...(styles[i]?.paragraphStyle ? { style: styles[i].paragraphStyle } : {}) });
    offset += text.length + 1; // +1 = 段落的 \r
  });
  return out;
}

/** 把一段文字按 run 边界切成带样式的片段 */
function renderInline(text: string, start: number, end: number, runs: DocRunLike[]): string {
  if (text.length === 0) return "<br>";
  const boundaries = new Set<number>([start, end]);
  for (const r of runs) {
    const st = typeof r.st === "number" ? r.st : NaN;
    const ed = typeof r.ed === "number" ? r.ed : NaN;
    if (!Number.isFinite(st) || !Number.isFinite(ed) || ed <= st) continue;
    if (ed <= start || st >= end) continue;
    boundaries.add(Math.max(start, st));
    boundaries.add(Math.min(end, ed));
  }
  const points = [...boundaries].sort((a, b) => a - b);
  let html = "";
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (b <= a) continue;
    const piece = escapeHtml(text.slice(a - start, b - start));
    // 该片段生效的样式：覆盖它的 run 合并（后写的覆盖先写的同名字段）
    const active = runs.filter((r) => {
      const st = typeof r.st === "number" ? r.st : NaN;
      const ed = typeof r.ed === "number" ? r.ed : NaN;
      return Number.isFinite(st) && Number.isFinite(ed) && st <= a && ed >= b;
    });
    if (active.length === 0) {
      html += piece;
      continue;
    }
    const merged: RunTs = {};
    for (const r of active) Object.assign(merged, r.ts ?? {});
    const decl = styleDecl(merged);
    html += decl ? `<span style="${decl}">${piece}</span>` : piece;
  }
  return html;
}

/** 文档快照 → 完整 HTML 文档字符串 */
export function docToHtml(snapshot: DocSnapshotLike): string {
  const body = snapshot.body ?? {};
  const paras = paragraphsOf(body);
  const runs = (Array.isArray(body.textRuns) ? body.textRuns : []).filter(
    (r): r is DocRunLike => !!r && typeof r === "object",
  );
  const content = paras
    .map((p) => {
      const tag = p.style?.namedStyleType ? HEADING_TAG[p.style.namedStyleType] : undefined;
      const cls = tag ? ` class="${tag[1]}"` : "";
      const html = renderInline(p.text, p.start, p.start + p.text.length, runs);
      return `      <${tag?.[0] ?? "p"}${cls}>${html}</${tag?.[0] ?? "p"}>`;
    })
    .join("\n");
  const title = escapeHtml(snapshot.title ?? "未命名文档");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0;
    padding: 48px 24px;
    background: #f5f6f8;
    color: #1f2937;
    font-family: -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", Arial, sans-serif;
    line-height: 1.75;
    font-size: 15px;
  }
  article { max-width: 820px; margin: 0 auto; background: #fff; padding: 56px 64px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  p { margin: 0 0 0.6em; }
  h1 { font-size: 30px; line-height: 1.35; margin: 0 0 0.6em; }
  h2 { font-size: 24px; line-height: 1.4; margin: 1.2em 0 0.5em; }
  h3 { font-size: 19px; line-height: 1.45; margin: 1.1em 0 0.45em; }
  h4 { font-size: 16px; line-height: 1.5; margin: 1em 0 0.4em; }
  h1.subtitle { font-size: 22px; color: #4b5563; font-weight: 500; }
  @media print {
    body { background: #fff; padding: 0; }
    article { box-shadow: none; padding: 0; max-width: none; }
  }
</style>
</head>
<body>
  <article>
${content}
  </article>
</body>
</html>
`;
}
