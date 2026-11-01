/**
 * 图表数据表的纯逻辑：粘贴解析 + 按类型写入网格。
 * 从 Excel / Numbers / Google Sheets 复制出来的是 TSV（多列）+ 换行（多行），
 * 这里把它落到「从当前焦点单元格起」的一小块区域，超出部分自动扩行/扩列。
 * 纯函数便于单测，组件只负责取焦点与 setState。
 */
import type { ChartPoint, ChartTask } from "../doc";

/** 数据面板的三种表结构：类目×系列 / 散点 / 甘特任务 */
export type ChartDataMode = "category" | "points" | "tasks";

export const chartDataModeOf = (kind: string | undefined): ChartDataMode =>
  kind === "gantt" ? "tasks" : kind === "scatter" || kind === "bubble" ? "points" : "category";

/** 形如 1,234 / 12,345.6 / ￥1,234 / -1,234% 的整格数字（不应被逗号拆开） */
const THOUSANDS_CELL = /^[-+]?[￥¥$€]?\d{1,3}(,\d{3})+(\.\d+)?%?$/;

/** 无 Tab 时按逗号分列，但把「千分位数字」的相邻片段合并回一个单元格 */
function splitCommaRow(line: string): string[] {
  const raw = line.split(",");
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    let cell = raw[i]!;
    while (i + 1 < raw.length && THOUSANDS_CELL.test(`${cell},${raw[i + 1]}`)) {
      cell = `${cell},${raw[++i]}`;
    }
    out.push(cell);
  }
  return out;
}

/** 剪贴板文本 → 行列网格：优先按 Tab（Excel），无 Tab 时按逗号；保留空行（只去尾随空行） */
export function parseClipGrid(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim().length === 0) lines.pop();
  const rows = lines.map((line) => (line.includes("\t") ? line.split("\t") : splitCommaRow(line)));
  return rows.map((cells) => cells.map((c) => c.trim()));
}

/** 粘贴是否值得接管（单个值仍交给输入框默认行为） */
export function isBlockPaste(grid: string[][]): boolean {
  return grid.length > 1 || (grid[0]?.length ?? 0) > 1;
}

/** 单元格数值：容忍千分位/货币符号/空格；`%` 可选择转小数（进度用） */
export function parseNumCell(raw: string, percentAsFraction = false): number | null {
  const t = raw.replace(/[,\s￥¥$€]/g, "");
  if (!t) return null;
  const pct = t.endsWith("%");
  const n = Number.parseFloat(pct ? t.slice(0, -1) : t);
  if (!Number.isFinite(n)) return null;
  return pct && percentAsFraction ? n / 100 : n;
}

export type Cell = { r: number; c: number };

export type CategoryGrid = { labels: string[]; names: string[]; data: number[][] };

/**
 * 类目表粘贴：c=0 写类目名，c>=1 写第 c-1 个系列的数值。
 * 行/列按需要扩展（新系列自动命名），已有数据保持。
 */
export function pasteCategory(labels: string[], names: string[], data: number[][], clip: string[][], at: Cell): CategoryGrid {
  const cols = Math.max(...clip.map((r) => r.length));
  const needRows = at.r + clip.length;
  const needSeries = at.c + cols - 1;
  const nextLabels = [...labels];
  const nextNames = [...names];
  const nextData = data.map((d) => [...d]);
  while (nextLabels.length < needRows) {
    nextLabels.push(`类目 ${nextLabels.length + 1}`);
    for (const d of nextData) d.push(0);
  }
  while (nextNames.length < needSeries) {
    nextNames.push(`系列 ${nextNames.length + 1}`);
    nextData.push(Array.from({ length: nextLabels.length }, () => 0));
  }
  for (const d of nextData) while (d.length < nextLabels.length) d.push(0);
  clip.forEach((row, dr) => {
    row.forEach((cell, dc) => {
      const r = at.r + dr;
      const c = at.c + dc;
      if (c === 0) {
        nextLabels[r] = cell.slice(0, 40);
        return;
      }
      const n = parseNumCell(cell);
      const target = nextData[c - 1];
      if (target && n !== null) target[r] = n;
    });
  });
  return { labels: nextLabels, names: nextNames, data: nextData };
}

/** 散点表粘贴：c=0 → x，c=1 → y，c=2 → size（空单元格保持原值） */
export function pastePoints(points: ChartPoint[], clip: string[][], at: Cell): ChartPoint[] {
  const cols = Math.max(...clip.map((r) => r.length));
  const next = points.map((p) => ({ ...p }));
  while (next.length < at.r + clip.length) next.push({ x: 0, y: 0 });
  clip.forEach((row, dr) => {
    row.forEach((cell, dc) => {
      const p = next[at.r + dr];
      const c = at.c + dc;
      if (!p || c > 2) return;
      const n = parseNumCell(cell);
      if (n === null) return;
      if (c === 0) p.x = n;
      else if (c === 1) p.y = n;
      else p.size = Math.max(0, n);
    });
  });
  return next;
}

/** 甘特表粘贴：c=0 名称、c=1 开始、c=2 结束、c=3 进度（支持 "40%" → 0.4） */
export function pasteTasks(tasks: ChartTask[], clip: string[][], at: Cell): ChartTask[] {
  const cols = Math.max(...clip.map((r) => r.length));
  const next = tasks.map((t) => ({ ...t }));
  while (next.length < at.r + clip.length) next.push({ name: "", start: 0, end: 0 });
  clip.forEach((row, dr) => {
    row.forEach((cell, dc) => {
      const t = next[at.r + dr];
      const c = at.c + dc;
      if (!t || c > 3) return;
      if (c === 0) {
        t.name = cell.slice(0, 40);
        return;
      }
      if (c === 1) {
        const n = parseNumCell(cell);
        if (n !== null) t.start = n;
      } else if (c === 2) {
        const n = parseNumCell(cell);
        if (n !== null) t.end = n;
      } else {
        const n = parseNumCell(cell, true);
        if (n !== null) t.progress = Math.min(1, Math.max(0, n));
      }
    });
  });
  return next;
}
