/**
 * 主题色计算（纯函数，可单测）：hex 归一、可读文字色、亮度适配。
 * 这里不引入色彩库——主题只需要在两个模式里把用户挑的颜色调到可用亮度，
 * HSL 足够，且结果仍是 hex，方便写回 CSS 变量。
 */

export type Rgb = { r: number; g: number; b: number };
export type Hsl = { h: number; s: number; l: number };

/** 归一 hex（三位展开、统一小写）；非法返回 null */
export function normalizeHex(raw: string): string | null {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(raw.trim());
  if (!m) return null;
  const body = m[1];
  const full =
    body.length === 3
      ? body
          .split("")
          .map((c) => c + c)
          .join("")
      : body;
  return `#${full.toLowerCase()}`;
}

export function hexToRgb(hex: string): Rgb | null {
  const h = normalizeHex(hex);
  if (!h) return null;
  return {
    r: Number.parseInt(h.slice(1, 3), 16),
    g: Number.parseInt(h.slice(3, 5), 16),
    b: Number.parseInt(h.slice(5, 7), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const to = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** hex → css rgba（壁纸开启时底色要能透出壁纸） */
export function hexToRgba(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const a = Math.max(0, Math.min(1, alpha));
  return `rgb(${rgb.r} ${rgb.g} ${rgb.b} / ${Math.round(a * 1000) / 1000})`;
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    let tn = t;
    if (tn < 0) tn += 1;
    if (tn > 1) tn -= 1;
    if (tn < 1 / 6) return p + (q - p) * 6 * tn;
    if (tn < 1 / 2) return q;
    if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * 把任意强调色夹到当前模式可用的亮度区间：浅色模式压在中等深度（保证
 * 白底上的按钮、链接有对比），深色模式提亮（保证黑底上不糊）。色相与
 * 饱和度保留，所以用户选的颜色仍然是它本人。
 */
export function adaptAccent(hex: string, mode: "light" | "dark"): string | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const hsl = rgbToHsl(rgb);
  const l = mode === "light" ? clamp(hsl.l, 0.34, 0.62) : clamp(hsl.l, 0.58, 0.78);
  return rgbToHex(hslToRgb({ ...hsl, l }));
}

/**
 * 色块上用什么文字色可读（W3C 相对亮度，深浅二值）。
 * 阈值取黑白对比相等的交点 L≈0.179：高于它黑字对比更高，低于它白字更高。
 * 旧值 0.42 会让 #7c5cff 这类中亮度色错误地落白字（黑字对比其实更高）。
 */
export function readableTextOn(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return "#000";
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
  return luminance > 0.179 ? "#111" : "#fff";
}

export function isHexColor(raw: unknown): raw is string {
  return typeof raw === "string" && normalizeHex(raw) !== null;
}
