/**
 * 笔记页面图标：存在 Markdown frontmatter 的 `icon` 字段里，
 * 不污染正文，也不依赖资料库数据库（文件搬走图标还在）。
 *
 * 只做最小行级编辑：保留其它 frontmatter 行与原有换行风格，
 * 不重新序列化 YAML。
 */

const FRONTMATTER_RE =
  /^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;

const ICON_LINE_RE = /^\s*icon\s*:\s*(.*?)\s*$/;

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const head = value[0];
    const tail = value[value.length - 1];
    if ((head === '"' && tail === '"') || (head === "'" && tail === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** 读取 frontmatter.icon；没有或为空返回 null */
export function readNoteIcon(markdown: string): string | null {
  const match = FRONTMATTER_RE.exec(markdown);
  if (!match) return null;
  for (const line of (match[2] ?? "").split(/\r?\n/)) {
    const icon = ICON_LINE_RE.exec(line);
    if (icon) {
      const value = stripQuotes(icon[1] ?? "").trim();
      return value || null;
    }
  }
  return null;
}

/**
 * 设置/移除页面图标。
 * - 没有 frontmatter 时自动补一个最小块；
 * - 已有 frontmatter 时只替换/删除 icon 行，其它字段与正文原样保留；
 * - 移除最后一个字段时把空 frontmatter 一起删掉。
 */
export function setNoteIcon(markdown: string, icon: string | null): string {
  const value = icon?.trim() ?? "";
  const match = FRONTMATTER_RE.exec(markdown);

  if (!match) {
    if (!value) return markdown;
    return `---\nicon: ${value}\n---\n\n${markdown.replace(/^\uFEFF/, "")}`;
  }

  const [, head, block, tail] = match;
  // `block` 不含定界行，CRLF 要从整个匹配块判断
  const eol = match[0].includes("\r\n") ? "\r\n" : "\n";
  const lines = block
    ? block.split(/\r?\n/).filter((line) => !ICON_LINE_RE.test(line))
    : [];

  if (value) lines.push(`icon: ${value}`);

  if (lines.every((line) => !line.trim())) {
    // 除 icon 外没有别的元数据：连同空 frontmatter 一起清掉
    return markdown.slice(match[0].length).replace(/^\r?\n/, "");
  }

  return `${head}${lines.join(eol)}${tail}${markdown.slice(match[0].length)}`;
}
