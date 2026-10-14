/**
 * 文本自动增高：文本内容/字号变化后按 leafer 同款行盒模型估算自然高度（只增不减），
 * 防止内容溢出固定 h 被裁切。度量用离屏 canvas（仅 DOM 运行时触达）；
 * textNaturalH 纯函数可测（注入假 measure）。
 */
import { layoutTextRuns, type MeasureFn } from "./leafer/scene";
import { TEXT_LINE_HEIGHT, resolveRuns } from "./viewspec";
import type { TextEl } from "./doc";
import type { RunSpec } from "./viewspec";

let mctx: CanvasRenderingContext2D | null = null;
function m(): CanvasRenderingContext2D {
  if (!mctx) {
    const cv = document.createElement("canvas");
    cv.width = 8;
    cv.height = 8;
    mctx = cv.getContext("2d")!;
  }
  return mctx;
}

/** DOM 度量（fontBoundingBox 缺省回落 0.8/0.2 经验值） */
export const domMeasure: MeasureFn = (text, fontCss) => {
  const c = m();
  c.font = fontCss;
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(fontCss)?.[1] ?? 24);
  const probe = c.measureText("中");
  return {
    width: c.measureText(text).width,
    ascent: probe.fontBoundingBoxAscent || size * 0.8,
    descent: probe.fontBoundingBoxDescent || size * 0.2,
  };
};

/**
 * 自然高度 = Σ 行盒（每行 = 行内最大字号 × TEXT_LINE_HEIGHT；above+below 恒等于行高）
 * + 2px 余量。空 runs 按 24px 一行兜底。
 */
export function textNaturalH(runs: RunSpec[], w: number, measure: MeasureFn): number {
  const frags = layoutTextRuns(runs, Math.max(1, w), 100000, "left", "top", measure);
  if (frags.length === 0) return 24;
  const lines = new Map<number, number>(); // baseline → 行内最大字号
  for (const f of frags) lines.set(f.baseline, Math.max(lines.get(f.baseline) ?? 0, f.run.fontSize));
  let total = 0;
  for (const fs of lines.values()) total += fs * TEXT_LINE_HEIGHT;
  return Math.round(total + 2);
}

/** TextEl 便捷：需要的新 h（只增不减——用户手动给大的 h 保持原样） */
export function fittedTextHeight(el: TextEl, measure: MeasureFn): number {
  return Math.max(el.h, textNaturalH(resolveRuns(el), el.w, measure));
}
