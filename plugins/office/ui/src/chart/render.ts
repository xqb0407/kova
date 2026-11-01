/**
 * 图表渲染：ECharts SSR → SVG 字符串（一次数学、一份像素）。
 *
 * 画布（DOM <img> / Leafer image fill）、SVG/HTML 导出、pptx 图片兜底、MCP 预览
 * 全部消费这里的同一份 SVG，因此不存在「屏幕上一套、导出另一套」的漂移。
 * 缓存按「元素 id + 尺寸 + 全部影响像素的字段」命中（见 spec.ts chartRenderKey），
 * 拖动缩放时沿用旧图、松手后按新尺寸重渲染。
 */
import * as echarts from "echarts/core";
import { BarChart, CustomChart, FunnelChart, HeatmapChart, LineChart, PieChart, RadarChart, ScatterChart, TreemapChart } from "echarts/charts";
import { GridComponent, LegendComponent, VisualMapComponent } from "echarts/components";
import { LegacyGridContainLabel } from "echarts/features";
import { SVGRenderer } from "echarts/renderers";
import type { ChartEl } from "../doc";
import { chartOption } from "./option";
import { chartRenderKey } from "./spec";

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  RadarChart,
  FunnelChart,
  TreemapChart,
  HeatmapChart,
  CustomChart,
  GridComponent,
  LegendComponent,
  VisualMapComponent,
  LegacyGridContainLabel,
  SVGRenderer,
]);

export type ChartRender = {
  /** 完整 SVG 源码（含 xmlns），可直接内嵌/落盘 */
  svg: string;
  /** data URL（DOM <img> / Leafer image fill 用） */
  url: string;
  w: number;
  h: number;
};

const CACHE_MAX = 240;
const cache = new Map<string, { svg: string; url: string }>();

/** SVG → data URL（UTF-8 安全：中文无需 base64） */
export function chartSvgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function remember(key: string, svg: string): { svg: string; url: string } {
  const url = chartSvgDataUrl(svg);
  cache.set(key, { svg, url });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return { svg, url };
}

/** 图表 → SVG（同步、带缓存；SSR 渲染不需要 DOM） */
export function chartRender(el: ChartEl, w = el.w, h = el.h): ChartRender {
  const W = Math.max(1, Math.round(w));
  const H = Math.max(1, Math.round(h));
  const key = chartRenderKey(el, W, H);
  const hit = cache.get(key);
  if (hit) return { ...hit, w: W, h: H };
  let svg = "";
  let inst: ReturnType<typeof echarts.init> | null = null;
  try {
    inst = echarts.init(null, null, { renderer: "svg", ssr: true, width: W, height: H });
    inst.setOption(chartOption(el));
    svg = inst.renderToSVGString({ useViewBox: true });
  } catch {
    svg = "";
  } finally {
    inst?.dispose();
  }
  if (!svg) {
    // 渲染失败兜底：占位框（不抛错，面板永不白屏）
    svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
      `<rect width="${W}" height="${H}" fill="#f6f7f4"/></svg>`;
  }
  return { ...remember(key, svg), w: W, h: H };
}

/** 清空渲染缓存（文档切换/主题批量变更时用） */
export function clearChartCache(): void {
  cache.clear();
}
