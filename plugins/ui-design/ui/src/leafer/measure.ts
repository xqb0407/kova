/** 字体测量（canvas 与 DOM 同一字体引擎）：leafer 文本排版与 SVG 导出共用 */
import type { MeasureFn } from "./scene";

export function makeMeasure(): MeasureFn {
  const ctx = document.createElement("canvas").getContext("2d");
  const widthCache = new Map<string, number>();
  const metricsCache = new Map<string, { ascent: number; descent: number }>();
  return (text, fontCss) => {
    const size = parseFloat(fontCss.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? "16") || 16;
    if (!ctx) return { width: text.length * size * 0.5, ascent: size * 0.8, descent: size * 0.2 };
    if (ctx.font !== fontCss) ctx.font = fontCss;
    const wk = text + "|" + fontCss;
    let width = widthCache.get(wk);
    if (width === undefined) {
      width = ctx.measureText(text).width;
      widthCache.set(wk, width);
    }
    let metrics = metricsCache.get(fontCss);
    if (!metrics) {
      const m = ctx.measureText(" ");
      metrics = { ascent: m.fontBoundingBoxAscent ?? size * 0.8, descent: m.fontBoundingBoxDescent ?? size * 0.2 };
      metricsCache.set(fontCss, metrics);
    }
    return { width, ascent: metrics.ascent, descent: metrics.descent };
  };
}
