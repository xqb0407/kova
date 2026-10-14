/**
 * 主题视觉预览的纯提取器（管理页预览对话框样例卡用；不进渲染、可单测）。
 *
 * 59 份品牌 DESIGN.md 的写法各异，但普遍有：正文内反引号 hex 色（`#EFDF00`）
 * 与 `### Font Family` 小节（列表 `- **Display**: \`X\`` 或表头含 Font 的表行）。
 * 这里只做宽松提取：色板 = accents 优先、不足从正文按首次出现去重补齐；
 * 字体 = Font Family 小节内 角色→字体名 对（至多 4 个），全库没有小节则空。
 */

const HEX_RE = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

/** 归一 hex（三位展开、统一小写）；非法返回 null */
export function normalizeHex(raw: string): string | null {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(raw.trim());
  if (!m) return null;
  const body = m[1];
  const full = body.length === 3 ? body.split("").map((c) => c + c).join("") : body;
  return `#${full.toLowerCase()}`;
}

/** 正文里出现的 hex 色（首次出现序、大小写去重）；accents 在前且不重复计 */
export function extractThemePalette(accents: string[], doc: string, limit = 6): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of accents) {
    const h = normalizeHex(a);
    if (h && !seen.has(h)) {
      seen.add(h);
      out.push(h);
    }
  }
  for (const m of doc.matchAll(HEX_RE)) {
    const h = normalizeHex(m[0]);
    if (h && !seen.has(h)) {
      seen.add(h);
      out.push(h);
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

export type ThemeFontSample = { role: string; name: string };

const FONT_SECTION_RE = /^#{2,4}\s*Font Family\s*$/im;

/** 取 `### Font Family` 小节文本（到下条标题为止）；无小节返回 null */
function fontSection(doc: string): string | null {
  const m = FONT_SECTION_RE.exec(doc);
  if (!m) return null;
  const after = doc.slice(m.index + m[0].length);
  const next = /^#{1,4}\s/m.exec(after);
  return (next ? after.slice(0, next.index) : after).slice(0, 2000);
}

/** 字体源串里的字体名：优先反引号词，退裸文本首段；回退栈取第一个 */
function fontNameFrom(src: string): string | null {
  const t = /`([^`\n]+)`/.exec(src);
  const v = (t ? t[1] : src).split(",")[0].trim().replace(/^["']|["']$/g, "");
  return /^[A-Za-z][A-Za-z0-9 '+.-]{0,39}$/.test(v) ? v : null;
}

/**
 * Font Family 小节里的 角色→字体 对（Display/Body/Code/H1…），至多 4 对。
 * 认两种行形：`- **Display**: \`X\`…` 与表行 `| **Heading** | \`X\` | 32px |`。
 */
export function extractThemeFonts(doc: string): ThemeFontSample[] {
  const section = fontSection(doc);
  if (!section) return [];
  const out: ThemeFontSample[] = [];
  const seen = new Set<string>();
  for (const raw of section.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let role = "";
    let fontSrc = "";
    if (line.startsWith("|")) {
      const cells = line.split("|").map((s) => s.trim()).filter(Boolean);
      if (cells.length < 2) continue;
      role = cells[0].replace(/\*/g, "");
      fontSrc = cells[1];
    } else {
      const m = /^[-*]\s+(\*\*([^*]+)\*\*|[^:]+):(.*)$/.exec(line);
      if (!m) continue;
      role = (m[2] ?? m[1] ?? "").trim();
      fontSrc = m[3];
    }
    if (!role || /^role$/i.test(role)) continue; // 表头行
    const font = fontNameFrom(fontSrc);
    if (!font) continue;
    const key = font.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role, name: font });
    if (out.length >= 4) break;
  }
  return out;
}

/** 色块上用什么文字色可读（W3C 相对亮度，深浅二值） */
export function readableTextOn(hex: string): string {
  const h = normalizeHex(hex)?.slice(1);
  if (!h) return "#000";
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) > 0.42 ? "#111" : "#fff";
}
