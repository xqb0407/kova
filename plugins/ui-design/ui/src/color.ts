/**
 * 颜色解析与对比度（lint 的唯一颜色依赖；纯函数，无 DOM）。
 *
 * 文档里的颜色经 parseDesignDoc 的 colorOr 归一后只会是 #rgb / #rrggbb /
 * #rrggbbaa 或 "var:<id>" 变量引用；本模块额外容忍 rgb()/rgba()，以便直接吃
 * 程序构造的文档。变量引用不是本模块的事——调用方先用 resolveVarColor 解开。
 *
 * 对比度按 WCAG 2.x 相对亮度公式算；半透明前景必须先 compositeOver 压到背景上
 * 再比，否则 rgba(0,0,0,.3) 这类会算出偏高的假通过。
 */

export type RGBA = { r: number; g: number; b: number; a: number };

const HEX = /^#([0-9a-f]{3,8})$/i;
const FUNC = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i;

const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", gray: "#808080", grey: "#808080",
  red: "#ff0000", blue: "#0000ff", green: "#008000", yellow: "#ffff00",
  orange: "#ffa500", purple: "#800080", pink: "#ffc0cb", brown: "#a52a2a",
  silver: "#c0c0c0", navy: "#000080", teal: "#008080", lime: "#00ff00",
  cyan: "#00ffff", magenta: "#ff00ff",
};

const clamp255 = (v: number): number => Math.min(255, Math.max(0, Math.round(v)));
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

const chan = (s: string): number => (s.endsWith("%") ? (Number(s.slice(0, -1)) / 100) * 255 : Number(s));

/** 颜色串 → RGBA（a 为 0..1）。无法解析（transparent、none、var: 引用、脏值）返回 null。 */
export function parseColor(input: string | null | undefined): RGBA | null {
  if (typeof input !== "string") return null;
  const s = input.trim().toLowerCase();
  if (!s || s === "transparent" || s === "none" || s.startsWith("var:")) return null;

  const hex = HEX.exec(s) ?? (NAMED[s] ? HEX.exec(NAMED[s]) : null);
  if (hex) {
    const h = hex[1]!;
    const dup = (c: string): number => parseInt(c + c, 16);
    const pair = (i: number): number => parseInt(h.slice(i, i + 2), 16);
    if (h.length === 3) return { r: dup(h[0]!), g: dup(h[1]!), b: dup(h[2]!), a: 1 };
    if (h.length === 4) return { r: dup(h[0]!), g: dup(h[1]!), b: dup(h[2]!), a: pair(3) / 255 };
    if (h.length === 6) return { r: pair(0), g: pair(2), b: pair(4), a: 1 };
    if (h.length === 8) return { r: pair(0), g: pair(2), b: pair(4), a: pair(6) / 255 };
    return null;
  }

  const m = FUNC.exec(s);
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
  return {
    r: clamp255(chan(m[1]!)),
    g: clamp255(chan(m[2]!)),
    b: clamp255(chan(m[3]!)),
    a: clamp01(Number.isFinite(alpha) ? alpha : 1),
  };
}

/** WCAG 相对亮度（sRGB 去伽马 + 0.2126R + 0.7152G + 0.0722B） */
export function relativeLuminance(c: RGBA): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** 半透明前景压到不透明背景上（Porter-Duff over，预乘前的直通口径） */
export function compositeOver(fg: RGBA, bg: RGBA): RGBA {
  if (fg.a >= 1) return { ...fg, a: 1 };
  const a = fg.a + bg.a * (1 - fg.a);
  if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
    a: 1,
  };
}

/** 两色对比度 1..21；任一为 null 返回 null */
export function contrastRatio(a: RGBA, b: RGBA): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** 色相 0..360（无彩色返回 null）；lint 判「紫色渐变」用 */
export function hueOf(c: RGBA): number | null {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 1e-6) return null;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** toHex 便于把解析结果回写成 issue detail 里的可比对色值 */
export function toHex(c: RGBA): string {
  const p = (v: number): string => clamp255(v).toString(16).padStart(2, "0");
  return `#${p(c.r)}${p(c.g)}${p(c.b)}`;
}

/**
 * 前景/背景两个颜色串 → 有效对比度。fg 半透明时先压到 bg 上。
 * 任一无法解析（如仍是 var: 引用或 transparent）返回 null，调用方跳过该判定。
 */
export function effectiveContrast(fgRaw: string, bgRaw: string): { ratio: number; fg: string; bg: string } | null {
  const fg = parseColor(fgRaw);
  const bg = parseColor(bgRaw);
  if (!fg || !bg) return null;
  const flat = compositeOver(fg, bg);
  return { ratio: contrastRatio(flat, { ...bg, a: 1 }), fg: toHex(flat), bg: toHex(bg) };
}