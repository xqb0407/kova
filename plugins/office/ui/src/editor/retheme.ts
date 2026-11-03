/**
 * 整份换肤（WPS「应用主题到全部页」）：把文档里出现的颜色按**语义角色**映射到目标
 * 主题 token，而不是粗暴覆盖——保留设计意图（标题/次要文字/强调色/面板底）。
 *
 * 规则（确定性，便于测试与撤销）：
 * 1. 页背景：全部页框 → tokens.bg（换肤的首要语义）。
 * 2. 强调色：文档里出现频次最高的两个**饱和色**（sat ≥ 0.3）→ tokens.accent / accent2；
 *    其余饱和色保持原样（避免把图表多色系列洗掉）。
 * 3. 文字中性色：按旧页底的明暗极性映射到 ink/sub/faint
 *    （浅底：越深越重要；深底：越浅越重要）。
 * 4. 形状填充：饱和色按强调色规则；中性浅色 → panel / panelAlt；深色 → ink。
 * 5. 形状描边：饱和色按强调色规则；中性 → line（浅）/ ink（深）。
 * 6. 非 hex（none / 渐变串）与图片等元素原样保留；入参不被修改（深拷贝）。
 */
import type { CanvasDoc, El, Frame, ShapeEl, TextEl } from "../doc";
import type { ThemeTokens } from "../templates";

/* ---------------- 颜色工具 ---------------- */

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** 相对明度（0 黑 – 1 白；sRGB 加权，足够做角色判断） */
export function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0.5;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

/** 饱和度（0 灰 – 1 纯色） */
export function saturation(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  return max === 0 ? 0 : (max - min) / max;
}

const isHex = (c: string | undefined): c is string => !!c && hexToRgb(c) !== null;
/** 强调色判定：既要饱和、又要足够亮——深藏青这类「有色相但仍属墨色」的不算强调色 */
const isSaturated = (c: string): boolean => {
  const rgb = hexToRgb(c);
  return !!rgb && Math.max(...rgb) >= 64 && saturation(c) >= 0.3;
};

/** 文档里出现的全部颜色（计数） */
function collectColors(doc: CanvasDoc): Map<string, number> {
  const count = new Map<string, number>();
  const add = (c: string | undefined) => {
    if (!isHex(c)) return;
    const key = c.toLowerCase();
    count.set(key, (count.get(key) ?? 0) + 1);
  };
  for (const f of doc.frames) {
    add(f.background);
    for (const el of f.elements) {
      if (el.kind === "text") for (const r of el.runs) add(r.color);
      else if (el.kind === "shape") {
        add(el.fill);
        add(el.stroke);
      }
    }
  }
  for (const el of doc.objects) {
    if (el.kind === "text") for (const r of el.runs) add(r.color);
    else if (el.kind === "shape") {
      add(el.fill);
      add(el.stroke);
    }
  }
  return count;
}

/** 频次排序的饱和色 → 主题强调色映射（第 1/2 名 → accent/accent2，其余不变） */
function accentMap(doc: CanvasDoc, tokens: ThemeTokens): Map<string, string> {
  const stats = collectColors(doc);
  const ranked = [...stats.entries()]
    .filter(([c]) => isSaturated(c))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([c]) => c);
  const map = new Map<string, string>();
  if (ranked[0]) map.set(ranked[0], tokens.accent);
  if (ranked[1]) map.set(ranked[1], tokens.accent2);
  return map;
}

/** 旧页底（频次最高的页框背景） */
function dominantBackground(doc: CanvasDoc): string {
  const counts = new Map<string, number>();
  for (const f of doc.frames) {
    if (!isHex(f.background)) continue;
    const k = f.background.toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best = "#ffffff";
  let n = 0;
  for (const [c, v] of counts) {
    if (v > n) {
      best = c;
      n = v;
    }
  }
  return best;
}

type Ctx = { oldBg: string; oldDark: boolean; tokens: ThemeTokens; accents: Map<string, string> };

function mapTextColor(color: string | undefined, ctx: Ctx): string | undefined {
  if (!isHex(color)) return color;
  const c = color.toLowerCase();
  if (ctx.accents.has(c)) return ctx.accents.get(c);
  if (c === ctx.oldBg) return ctx.tokens.bg; // 旧「与底色同色」的隐藏文字保持隐藏意图
  const L = luminance(c);
  if (ctx.oldDark) {
    if (L >= 0.66) return ctx.tokens.ink;
    if (L >= 0.4) return ctx.tokens.sub;
    return ctx.tokens.faint;
  }
  if (L <= 0.32) return ctx.tokens.ink;
  if (L <= 0.62) return ctx.tokens.sub;
  return ctx.tokens.faint;
}

function mapShapeFill(color: string | undefined, ctx: Ctx): string | undefined {
  if (!isHex(color)) return color;
  const c = color.toLowerCase();
  if (ctx.accents.has(c)) return ctx.accents.get(c);
  if (c === ctx.oldBg) return ctx.tokens.bg;
  const L = luminance(c);
  if (L >= 0.82) return ctx.tokens.panel;
  if (L >= 0.55) return ctx.tokens.panelAlt;
  if (L <= 0.3) return ctx.tokens.ink;
  return color; // 中间调填充没有语义对应，保留原色
}

function mapShapeStroke(color: string | undefined, ctx: Ctx): string | undefined {
  if (!isHex(color)) return color;
  const c = color.toLowerCase();
  if (ctx.accents.has(c)) return ctx.accents.get(c);
  const L = luminance(c);
  return L >= 0.6 ? ctx.tokens.line : ctx.tokens.ink;
}

function rethemeEl(el: El, ctx: Ctx): El {
  if (el.kind === "text") {
    const text: TextEl = {
      ...el,
      runs: el.runs.map((r) => {
        const next = mapTextColor(r.color, ctx);
        const out = { ...r };
        if (next) out.color = next;
        else delete out.color;
        return out;
      }),
    };
    return text;
  }
  if (el.kind === "shape") {
    const shape: ShapeEl = { ...el };
    const fill = mapShapeFill(el.fill, ctx);
    const stroke = mapShapeStroke(el.stroke, ctx);
    if (fill) shape.fill = fill;
    else delete shape.fill;
    if (stroke) shape.stroke = stroke;
    else delete shape.stroke;
    return shape;
  }
  return el;
}

function rethemeFrame(frame: Frame, ctx: Ctx): Frame {
  return {
    ...frame,
    background: ctx.tokens.bg,
    elements: frame.elements.map((el) => rethemeEl(el, ctx)),
  };
}

/** 整份换肤：返回新文档（入参不变） */
export function rethemeDoc(doc: CanvasDoc, tokens: ThemeTokens): CanvasDoc {
  const oldBg = dominantBackground(doc);
  const ctx: Ctx = {
    oldBg,
    oldDark: luminance(oldBg) < 0.5,
    tokens,
    accents: accentMap(doc, tokens),
  };
  return {
    ...doc,
    frames: doc.frames.map((f) => rethemeFrame(f, ctx)),
    objects: doc.objects.map((el) => rethemeEl(el, ctx)),
  };
}
