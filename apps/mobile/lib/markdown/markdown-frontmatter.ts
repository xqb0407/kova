/**
 * Markdown YAML frontmatter 极简解析：识别文档开头的 `--- ... ---` 块，
 * 供渲染时把元数据拆成键值卡片、正文再走 markdown。
 *
 * 为什么不交给 remark/streamdown：CommonMark 没有 frontmatter 概念，
 * 首个 `---` 是水平线，后续连续行成一个段落、结尾 `---` 又把整段变成
 * setext 大标题——整块元数据会被渲染成巨型标题。
 *
 * 与主工程 `apps/desktop/lib/markdown/markdown-frontmatter.ts` 同源：两端
 * 共用同一份「只认常见子集、解析不了就整体当没有」的规则，免得同一篇文档
 * 在桌面端显示元信息卡片、在手机端显示成巨型标题。
 *
 * 只支持技能/文档文件里常见的子集：`key: value` 标量（含引号/内联数组）、
 * `- item` 块列表、`|`/`>` 块标量、`#` 注释与空行。出现任何解析不了的行
 * 整体返回 null（按无 frontmatter 处理，走原样渲染，不猜）。
 */

export type FrontmatterValue = string | string[];

export interface Frontmatter {
  /** 保序键值对（重复 key 后者覆盖前者，位置取首次出现） */
  entries: [string, FrontmatterValue][];
  /** 去掉 frontmatter 块后的原文（从闭合 `---` 的下一行起） */
  body: string;
}

/** 文档开头即 `---` 行；闭合行允许行尾空白，之后必须有行边界或文档结束 */
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** 纯键名：字母数字下划线开头，可含连字符/点/空格/CJK；拒绝 `*`、`:` 等 prose 常见字符 */
const KEY_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_\-. ]{0,63}$/u;

const BLOCK_SCALAR_RE = /^[|>][+-]?$/;

function stripQuotes(raw: string): string {
  if (raw.length >= 2) {
    const head = raw[0];
    const tail = raw[raw.length - 1];
    if ((head === '"' && tail === '"') || (head === "'" && tail === "'"))
      return raw.slice(1, -1);
  }
  return raw;
}

/** 内联 `[a, "b c"]` → 数组；带引号标量去引号；其余原样（含空串） */
function parseScalar(raw: string): FrontmatterValue {
  const t = raw.trim();
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((item) => stripQuotes(item.trim()))
      .filter((item) => item.length > 0);
  }
  return stripQuotes(t);
}

export function splitFrontmatter(text: string): Frontmatter | null {
  const m = FRONTMATTER_RE.exec(text.replace(/^\uFEFF/, ""));
  if (!m) return null;
  const block = m[1] ?? "";
  const body = text.slice(m[0].length);

  const lines = block.split(/\r?\n/);
  const entries: [string, FrontmatterValue][] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < lines.length) {
    const trimmed = (lines[i] ?? "").trim();
    if (!trimmed || trimmed.startsWith("#")) {
      i += 1;
      continue;
    }
    const colon = trimmed.indexOf(":");
    if (colon <= 0) return null;
    const key = stripQuotes(trimmed.slice(0, colon).trim());
    const rest = trimmed.slice(colon + 1).trim();
    if (!KEY_RE.test(key)) return null;

    let value: FrontmatterValue;
    if (BLOCK_SCALAR_RE.test(rest)) {
      // 块标量：收集后续更缩进的行，按换行拼接（卡片里 pre-wrap 展示）
      const collected: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^[ \t]+\S/.test(lines[j] ?? "")) {
        collected.push((lines[j] ?? "").trim());
        j += 1;
      }
      value = collected.join("\n");
      i = j;
    } else if (!rest) {
      // 空值：后面紧跟 `- item` 行则视作块列表，否则是空标量
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^-\s+/.test((lines[j] ?? "").trim())) {
        items.push(stripQuotes((lines[j] ?? "").trim().slice(2).trim()));
        j += 1;
      }
      value = items.length > 0 ? items : "";
      i = j;
    } else {
      value = parseScalar(rest);
      i += 1;
    }

    if (!seen.has(key)) {
      seen.add(key);
      entries.push([key, value]);
    } else {
      const idx = entries.findIndex(([k]) => k === key);
      if (idx >= 0) entries[idx] = [key, value];
    }
  }

  // 至少一条键值才认作 frontmatter：防止把开头 `---` 水平线 + prose + `---`
  // 的普通文档（setext 写法）误判成元数据块
  if (entries.length === 0) return null;
  return { entries, body };
}
