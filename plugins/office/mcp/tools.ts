/**
 * Office 文档 MCP 工具实现（stdio server 见 server.ts）。
 *
 * 设计取向：面板是唯一的写入者与渲染者，agent 只经文件协作——所有工具都作用于
 * 工作区里的 office 文档（`.deck.canvas.json` / `.sheet.univer.json` / `.doc.univer.json`），
 * 原子落盘后宿主会推给已打开的面板，用户的编辑也会防抖写回同一文件。
 *
 * 工具分四类：
 * - 发现/读取：list_docs、read_doc（deck 摘要·图表·整档 / sheet 摘要·单元格矩阵 / doc 结构化摘要）
 * - 局部写入：patch_chart（图表数据样式）、patch_sheet（A1 定位写值/公式）、
 *   patch_doc（段落级 append/replace/delete）、patch_deck（元素白名单 patch + 页级操作）
 * - 整档：write_doc（整档）、create_doc（按 kind 生成骨架，不覆盖已有文件）
 * - 实时：watch_doc（长轮询，等面板写盘后返回变更摘要，是「面板 → agent」的拉取通道）
 *
 * 局部 patch 与整档 write 的分工：能 patch 就 patch——只动目标字段，天然保留用户
 * 的样式/合并/冻结等（整档 write 需要先 read 全量，覆盖风险高）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CHART_KINDS,
  CHART_LABEL_POS,
  CHART_LEGEND_POS,
  CHART_MAX_LABELS,
  CHART_MAX_POINTS,
  CHART_MAX_SERIES,
  CHART_MAX_TASKS,
  CHART_THEMES,
  CHART_VARIANTS,
  PAGE_SIZES,
  SLIDE_TRANSITIONS,
  blankFrame,
  nextFramePos,
  parseEl as parseDeckEl,
  parseRun as parseDeckRun,
  type ChartEl,
  type ChartKind,
  type PagePreset,
} from "../ui/src/doc";
import { chartKindPatch } from "../ui/src/chart/spec";
import { buildTemplateFrame, TEMPLATE_THEMES } from "../ui/src/templates";
import { deckSeed, docSeed, safeDocName, sheetSeed } from "../ui/src/seeds";
import { docToText } from "../ui/src/doc/txt";

export type ToolCtx = { workspace: string };

type Spec = Record<string, unknown>;
type Json = Record<string, unknown>;

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 可同步返回，也可返回 Promise（watch_doc 要长轮询）——server.ts 一律 await */
  run: (args: Spec, ctx: ToolCtx) => unknown;
};

/* ------------------------------------------------------------------ */
/* 基础：路径 / 读写 / 版本                                              */
/* ------------------------------------------------------------------ */

const SUFFIXES = {
  deck: ".deck.canvas.json",
  sheet: ".sheet.univer.json",
  doc: ".doc.univer.json",
} as const;
type DocKind = keyof typeof SUFFIXES;

const MAX_LIST = 60;
const MAX_LIST_DEPTH = 2;
const MAX_FULL_CHARS = 200_000;
const MAX_WRITE_BYTES = 20 * 1024 * 1024;
const MAX_SUMMARY_ELEMENTS = 120;
/** read_doc view:cells 单次返回的单元格上限（超出截断，提示用 range 分段） */
const MAX_CELLS_VIEW = 4000;
/** patch_sheet 单次写入单元格上限 */
const MAX_PATCH_CELLS = 5000;
/** patch_doc 单次 op 上限 / doc 摘要段落数上限 */
const MAX_DOC_OPS = 200;
const MAX_DOC_PARAGRAPHS = 200;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const sha = (text: string): string => createHash("sha1").update(text).digest("hex").slice(0, 12);

function kindOf(abs: string): DocKind | null {
  const lower = abs.toLowerCase();
  for (const [kind, suffix] of Object.entries(SUFFIXES) as [DocKind, string][]) {
    if (lower.endsWith(suffix)) return kind;
  }
  return null;
}

function resolveDocPath(raw: unknown, ctx: ToolCtx): { abs: string; kind: DocKind } {
  const p = str(raw)?.trim();
  if (!p) throw new Error("path 不能为空");
  const abs = path.isAbsolute(p) ? p : path.resolve(ctx.workspace, p);
  const kind = kindOf(abs);
  if (!kind) {
    throw new Error(
      `path 必须以 ${Object.values(SUFFIXES).join(" / ")} 结尾（office 文档的扩展名约定）：${p}`,
    );
  }
  return { abs, kind };
}

function relPath(abs: string, ctx: ToolCtx): string {
  const rel = path.relative(ctx.workspace, abs);
  return (rel && !rel.startsWith("..") ? rel : abs).split(path.sep).join("/");
}

function readText(abs: string): string {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    throw new Error(`文件不存在或不可读：${abs}（先用 list_docs 找档）`);
  }
}

function loadJson(abs: string): { doc: Json; version: string } {
  const text = readText(abs);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`文件不是合法 JSON：${abs}（面板可能正在写盘，稍后重试或用 write_doc 修复）`);
  }
  if (!isObj(doc)) throw new Error(`文档顶层需为对象：${abs}`);
  return { doc, version: sha(text) };
}

/** 原子落盘：临时文件 + rename，避免面板轮询读到半截 JSON */
function saveJson(abs: string, doc: Json): { version: string; bytes: number } {
  const text = JSON.stringify(doc, null, 2) + "\n";
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_WRITE_BYTES) throw new Error(`文档过大（${bytes} 字节 > ${MAX_WRITE_BYTES}），拒绝写入`);
  const tmp = `${abs}.tmp-mcp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, abs);
  return { version: sha(text), bytes };
}

/* ------------------------------------------------------------------ */
/* 摘要视图（控制返回体积；agent 先读摘要再按 id 深入）                    */
/* ------------------------------------------------------------------ */

function textOfRuns(v: unknown): string {
  if (!Array.isArray(v)) return "";
  return v
    .map((r) => (isObj(r) ? str(r.text) ?? "" : ""))
    .join("")
    .trim();
}

function chartBrief(el: Json): Json {
  const series = Array.isArray(el.series) ? el.series : [];
  return {
    chart: str(el.chart) ?? "bar",
    ...(str(el.variant) ? { variant: el.variant } : {}),
    labels: Array.isArray(el.labels) ? el.labels.length : 0,
    series: series.map((s) => {
      const so = isObj(s) ? s : {};
      const data = Array.isArray(so.data) ? so.data.length : 0;
      const points = Array.isArray(so.points) ? so.points.length : 0;
      return { name: str(so.name) ?? "", points: points || data };
    }),
    ...(Array.isArray(el.tasks) ? { tasks: el.tasks.length } : {}),
  };
}

function elBrief(el: Json): Json {
  const out: Json = { id: el.id, kind: el.kind, box: [el.x, el.y, el.w, el.h] };
  const text = textOfRuns(el.runs);
  if (text) out.text = text.slice(0, 80);
  if (el.kind === "chart") out.chart = chartBrief(el);
  return out;
}

function deckSummary(doc: Json): Json {
  const frames = Array.isArray(doc.frames) ? doc.frames : [];
  let shown = 0;
  const out = frames.map((f, i) => {
    const fo = isObj(f) ? f : {};
    const elements = Array.isArray(fo.elements) ? fo.elements : [];
    const room = Math.max(0, MAX_SUMMARY_ELEMENTS - shown);
    const listed = elements.slice(0, room).filter(isObj).map(elBrief);
    shown += listed.length;
    return {
      id: str(fo.id) ?? `s${i + 1}`,
      name: str(fo.name) ?? "",
      size: [fo.w, fo.h],
      ...(str(fo.background) ? { background: fo.background } : {}),
      elements: listed,
      ...(elements.length > listed.length ? { elementsTruncated: elements.length - listed.length } : {}),
    };
  });
  return {
    kind: "deck",
    name: str(isObj(doc.meta) ? doc.meta.name : undefined) ?? "",
    frames: out,
    ...(Array.isArray(doc.objects) && doc.objects.length > 0 ? { canvasObjects: doc.objects.length } : {}),
  };
}

function sheetSummary(doc: Json): Json {
  const sheets = isObj(doc.sheets) ? doc.sheets : {};
  const order = Array.isArray(doc.sheetOrder) ? doc.sheetOrder : Object.keys(sheets);
  return {
    kind: "sheet",
    name: str(doc.name) ?? "",
    sheets: order.map((id) => {
      const so = isObj(sheets[String(id)]) ? (sheets[String(id)] as Json) : {};
      const cellData = isObj(so.cellData) ? so.cellData : {};
      let filled = 0;
      for (const row of Object.values(cellData)) filled += isObj(row) ? Object.keys(row).length : 0;
      return { id, name: str(so.name) ?? String(id), rowCount: so.rowCount, columnCount: so.columnCount, filledCells: filled };
    }),
  };
}

function docParagraphs(doc: Json): { text: string; style?: Json }[] {
  const body = isObj(doc.body) ? doc.body : {};
  const ds = typeof body.dataStream === "string" ? body.dataStream : "";
  if (!ds) return [];
  // 机械规则（skills/doc）：\r 终结段落，结尾 "\r\n" 的 \n 是节分隔符（全文唯一）
  const core = ds.endsWith("\r\n") ? ds.slice(0, -2) : ds;
  const texts = core.split("\r");
  const rawParas = (Array.isArray(body.paragraphs) ? body.paragraphs : []).filter(isObj);
  return texts.map((text, i) => {
    const style = rawParas[i]?.paragraphStyle;
    return { text, ...(isObj(style) ? { style } : {}) };
  });
}

function docSummary(doc: Json): Json {
  const paras = docParagraphs(doc);
  const chars = paras.reduce((n, p) => n + p.text.length, 0);
  return {
    kind: "doc",
    name: str(doc.title) ?? str(doc.name) ?? "",
    chars,
    paragraphs: paras.length,
    list: paras.slice(0, MAX_DOC_PARAGRAPHS).map((p, i) => ({
      i,
      text: p.text.slice(0, 80),
      ...(p.style ? { style: p.style } : {}),
    })),
    ...(paras.length > MAX_DOC_PARAGRAPHS ? { truncated: `段落超过 ${MAX_DOC_PARAGRAPHS}，只列前 ${MAX_DOC_PARAGRAPHS} 段` } : {}),
  };
}

function summaryOf(doc: Json, kind: DocKind): Json {
  if (kind === "deck") return deckSummary(doc);
  if (kind === "sheet") return sheetSummary(doc);
  return docSummary(doc);
}

function chartsOf(doc: Json): Json[] {
  const frames = Array.isArray(doc.frames) ? doc.frames : [];
  const out: Json[] = [];
  const collect = (elements: unknown, frameId: string): void => {
    if (!Array.isArray(elements)) return;
    for (const el of elements) {
      if (isObj(el) && el.kind === "chart") out.push({ ...el, frameId });
    }
  };
  frames.forEach((f, i) => {
    const fo = isObj(f) ? f : {};
    collect(fo.elements, str(fo.id) ?? `s${i + 1}`);
  });
  if (Array.isArray(doc.objects)) collect(doc.objects, "canvas");
  return out;
}

/* ------------------------------------------------------------------ */
/* sheet：A1 定位 / 单元格矩阵视图 / 局部写入                             */
/* ------------------------------------------------------------------ */

/** "A"→0，"AB"→27；非法返回 null */
function colToIndex(letters: string): number | null {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    if (ch < "A" || ch > "Z") return null;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n > 0 ? n - 1 : null;
}

function indexToCol(i: number): string {
  let n = i + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** "B2" / "A1:C10" → 0 基行列范围；非法返回 null */
function parseA1Range(range: string): { r0: number; c0: number; r1: number; c1: number } | null {
  const m = /^([A-Za-z]{1,3})([1-9][0-9]*)(?::([A-Za-z]{1,3})([1-9][0-9]*))?$/.exec(range.trim());
  if (!m) return null;
  const c0 = colToIndex(m[1]!);
  const r0 = Number(m[2]) - 1;
  const c1 = m[3] ? colToIndex(m[3]) : c0;
  const r1 = m[4] ? Number(m[4]) - 1 : r0;
  if (c0 === null || c1 === null || r0 < 0 || r1 < 0) return null;
  return { r0: Math.min(r0, r1), c0: Math.min(c0, c1), r1: Math.max(r0, r1), c1: Math.max(c0, c1) };
}

/** cellData 的实际使用范围（含 v/f/s 任一内容的最大行列）；空表返回 null */
function usedRange(cellData: Json): { r1: number; c1: number } | null {
  let r1 = -1;
  let c1 = -1;
  for (const [r, cols] of Object.entries(cellData)) {
    if (!isObj(cols)) continue;
    const ri = Number(r);
    if (!Number.isFinite(ri)) continue;
    for (const c of Object.keys(cols)) {
      const cell = (cols as Json)[c];
      if (isObj(cell) && (cell.v !== undefined || cell.f !== undefined || cell.s !== undefined)) {
        const ci = Number(c);
        if (Number.isFinite(ci) && ri > r1) r1 = ri;
        if (Number.isFinite(ci) && ci > c1) c1 = ci;
      }
    }
  }
  return r1 >= 0 && c1 >= 0 ? { r1, c1 } : null;
}

/** 按 id 或名称选 sheet；缺省取 sheetOrder 第一张 */
function pickSheet(doc: Json, sheetArg: string | undefined): { id: string; sheet: Json } {
  const sheets = isObj(doc.sheets) ? doc.sheets : {};
  const order = (Array.isArray(doc.sheetOrder) ? doc.sheetOrder : Object.keys(sheets)).map(String);
  if (sheetArg) {
    if (isObj(sheets[sheetArg])) return { id: sheetArg, sheet: sheets[sheetArg] as Json };
    const byName = order.find((k) => str((isObj(sheets[k]) ? (sheets[k] as Json) : {}).name) === sheetArg);
    if (byName && isObj(sheets[byName])) return { id: byName, sheet: sheets[byName] as Json };
    throw new Error(`sheet 不存在："${sheetArg}"（read_doc 摘要里拿 id/名称）`);
  }
  const first = order.find((k) => isObj(sheets[k]));
  if (!first) throw new Error("工作簿没有 sheet（用 write_doc 先建骨架）");
  return { id: first, sheet: sheets[first] as Json };
}

function cellsView(doc: Json, args: Spec): Json {
  const { id, sheet } = pickSheet(doc, str(args.sheet)?.trim());
  const cellData = isObj(sheet.cellData) ? sheet.cellData : {};
  let r0 = 0;
  let c0 = 0;
  let r1: number;
  let c1: number;
  const rangeArg = str(args.range)?.trim();
  if (rangeArg) {
    const r = parseA1Range(rangeArg);
    if (!r) throw new Error(`range 不合法："${rangeArg}"（示例 A1:C10 或 B2）`);
    ({ r0, c0, r1, c1 } = r);
  } else {
    const used = usedRange(cellData);
    if (!used) {
      return { kind: "sheet", sheet: { id, name: str(sheet.name) ?? id }, range: null, rows: [], note: "空表" };
    }
    r1 = used.r1;
    c1 = used.c1;
  }
  let truncated = false;
  if ((r1 - r0 + 1) * (c1 - c0 + 1) > MAX_CELLS_VIEW) {
    // 装不下就砍行数（保持完整列），并提示用 range 分段
    const fitRows = Math.max(1, Math.floor(MAX_CELLS_VIEW / (c1 - c0 + 1)));
    r1 = r0 + fitRows - 1;
    truncated = true;
  }
  const rows: (Json | null)[][] = [];
  for (let r = r0; r <= r1; r++) {
    const row: (Json | null)[] = [];
    const rowObj = isObj(cellData[String(r)]) ? (cellData[String(r)] as Json) : {};
    for (let c = c0; c <= c1; c++) {
      const cell = rowObj[String(c)];
      row.push(
        isObj(cell) && (cell.v !== undefined || cell.f !== undefined || cell.s !== undefined)
          ? { ...(cell.v !== undefined ? { v: cell.v } : {}), ...(cell.f !== undefined ? { f: cell.f } : {}), ...(cell.s !== undefined ? { s: cell.s } : {}) }
          : null,
      );
    }
    rows.push(row);
  }
  return {
    kind: "sheet",
    sheet: { id, name: str(sheet.name) ?? id, rowCount: sheet.rowCount, columnCount: sheet.columnCount },
    range: { from: `${indexToCol(c0)}${r0 + 1}`, to: `${indexToCol(c1)}${r1 + 1}` },
    rows,
    ...(truncated ? { truncated: `超出 ${MAX_CELLS_VIEW} 格上限，只返回到第 ${r1 + 1} 行；用 range 参数分段取` } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 图表字段校验（与 ui/src/doc.ts 的 ChartSpec v2 对齐）                  */
/* ------------------------------------------------------------------ */

function finiteArray(v: unknown, label: string, max: number): number[] {
  if (!Array.isArray(v)) throw new Error(`${label} 需为数字数组`);
  if (v.length > max) throw new Error(`${label} 最多 ${max} 项（当前 ${v.length}）`);
  return v.map((n, i) => {
    const x = typeof n === "number" ? n : Number(n);
    if (!Number.isFinite(x)) throw new Error(`${label}[${i}] 不是有限数字：${String(n)}`);
    return x;
  });
}

function hexList(v: unknown, label: string): string[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error(`${label} 需为非空颜色数组`);
  return v.map((c, i) => {
    const s = str(c)?.trim() ?? "";
    if (!/^#[0-9a-f]{3,8}$/i.test(s)) throw new Error(`${label}[${i}] 不是 #rrggbb 颜色：${String(c)}`);
    return s;
  });
}

function mapSeries(v: unknown): Json[] {
  if (!Array.isArray(v)) throw new Error("series 需为数组");
  if (v.length > CHART_MAX_SERIES) throw new Error(`series 最多 ${CHART_MAX_SERIES} 个（当前 ${v.length}）`);
  return v.map((s, i) => {
    if (!isObj(s)) throw new Error(`series[${i}] 需为对象`);
    const out: Json = { name: str(s.name) ?? `系列 ${i + 1}`, data: finiteArray(s.data ?? [], `series[${i}].data`, CHART_MAX_POINTS) };
    if (Array.isArray(s.points)) {
      const points = s.points.slice(0, CHART_MAX_POINTS).map((p, j) => {
        if (!isObj(p)) throw new Error(`series[${i}].points[${j}] 需为 {x,y,size?}`);
        return { x: finiteArray([p.x], `series[${i}].points[${j}].x`, 1)[0], y: finiteArray([p.y], `series[${i}].points[${j}].y`, 1)[0], ...(num(p.size) !== undefined ? { size: num(p.size) } : {}) };
      });
      out.points = points;
    }
    const type = str(s.type);
    if (type) {
      if (!["bar", "line", "area"].includes(type)) throw new Error(`series[${i}].type 只能是 bar/line/area`);
      out.type = type;
    }
    const color = str(s.color);
    if (color) {
      if (!/^#[0-9a-f]{3,8}$/i.test(color)) throw new Error(`series[${i}].color 不是 #rrggbb 颜色`);
      out.color = color;
    }
    return out;
  });
}

function mapTasks(v: unknown): Json[] {
  if (!Array.isArray(v)) throw new Error("tasks 需为数组");
  if (v.length > CHART_MAX_TASKS) throw new Error(`tasks 最多 ${CHART_MAX_TASKS} 条（当前 ${v.length}）`);
  return v.map((t, i) => {
    if (!isObj(t)) throw new Error(`tasks[${i}] 需为对象`);
    const start = num(t.start);
    const end = num(t.end);
    if (start === undefined || end === undefined) throw new Error(`tasks[${i}] 需有数字 start/end`);
    const progress = num(t.progress);
    return {
      name: str(t.name) ?? `任务 ${i + 1}`,
      start,
      end,
      ...(progress !== undefined ? { progress: Math.min(1, Math.max(0, progress)) } : {}),
    };
  });
}

/** 只收允许的 ChartSpec 字段；未知字段忽略（避免 agent 把布局字段误写进图表规格） */
function chartPatchFrom(args: Spec): Json {
  const patch: Json = {};
  if (args.chart !== undefined) {
    const k = str(args.chart) ?? "";
    if (!(CHART_KINDS as readonly string[]).includes(k)) throw new Error(`chart 类型不支持："${k}"；可用：${CHART_KINDS.join(", ")}`);
    patch.chart = k;
  }
  if (args.variant !== undefined) {
    const v = str(args.variant) ?? "";
    if (!(CHART_VARIANTS as readonly string[]).includes(v)) throw new Error(`variant 只能是 ${CHART_VARIANTS.join(" / ")}`);
    patch.variant = v;
  }
  if (args.labels !== undefined) {
    if (!Array.isArray(args.labels)) throw new Error("labels 需为字符串数组");
    if (args.labels.length > CHART_MAX_LABELS) throw new Error(`labels 最多 ${CHART_MAX_LABELS} 个`);
    patch.labels = args.labels.map((x, i) => {
      const s = str(x);
      if (s === undefined) throw new Error(`labels[${i}] 需为字符串`);
      return s.slice(0, 40);
    });
  }
  if (args.series !== undefined) patch.series = mapSeries(args.series);
  if (args.tasks !== undefined) patch.tasks = mapTasks(args.tasks);
  if (args.colors !== undefined) patch.colors = hexList(args.colors, "colors");
  if (args.legend !== undefined) {
    if (!isObj(args.legend)) throw new Error("legend 需为 {show?, position?}");
    const out: Json = {};
    if (args.legend.show !== undefined) out.show = args.legend.show === true;
    const pos = str(args.legend.position);
    if (pos) {
      if (!(CHART_LEGEND_POS as readonly string[]).includes(pos)) throw new Error(`legend.position 只能是 ${CHART_LEGEND_POS.join(" / ")}`);
      out.position = pos;
    }
    patch.legend = out;
  }
  if (args.dataLabels !== undefined) {
    if (!isObj(args.dataLabels)) throw new Error("dataLabels 需为 {show?, position?, format?}");
    const out: Json = {};
    if (args.dataLabels.show !== undefined) out.show = args.dataLabels.show === true;
    const pos = str(args.dataLabels.position);
    if (pos) {
      if (!(CHART_LABEL_POS as readonly string[]).includes(pos)) throw new Error(`dataLabels.position 只能是 ${CHART_LABEL_POS.join(" / ")}`);
      out.position = pos;
    }
    const fmt = str(args.dataLabels.format);
    if (fmt) out.format = fmt;
    patch.dataLabels = out;
  }
  if (args.smooth !== undefined) patch.smooth = args.smooth === true;
  if (args.size !== undefined) {
    const n = num(args.size);
    if (n === undefined) throw new Error("size 需为数字");
    patch.size = Math.min(48, Math.max(6, Math.round(n)));
  }
  if (args.theme !== undefined) {
    const t = str(args.theme) ?? "";
    if (!(CHART_THEMES as readonly string[]).includes(t)) throw new Error(`theme 只能是 ${CHART_THEMES.join(" / ")}`);
    patch.theme = t;
  }
  if (args.axes !== undefined) {
    if (!isObj(args.axes)) throw new Error("axes 需为 {x?: {...}, y?: {...}}");
    patch.axes = args.axes;
  }
  return patch;
}

/* ------------------------------------------------------------------ */
/* 工具实现                                                             */
/* ------------------------------------------------------------------ */

function opListDocs(args: Spec, ctx: ToolCtx): unknown {
  const dirArg = str(args.dir)?.trim();
  const root = dirArg ? path.resolve(ctx.workspace, dirArg) : ctx.workspace;
  const kindFilter = str(args.kind) as DocKind | undefined;
  if (kindFilter && !(kindFilter in SUFFIXES)) throw new Error(`kind 只能是 deck / sheet / doc`);
  const docs: Json[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_LIST_DEPTH || docs.length >= MAX_LIST) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (docs.length >= MAX_LIST) return;
      if (name === "node_modules" || name.startsWith(".")) continue;
      const abs = path.join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(abs, depth + 1);
        continue;
      }
      const kind = kindOf(name);
      if (!kind || (kindFilter && kind !== kindFilter)) continue;
      const entry: Json = { path: relPath(abs, ctx), kind };
      try {
        const st = statSync(abs);
        entry.size = st.size;
        entry.mtime = Math.round(st.mtimeMs);
        const { doc, version } = loadJson(abs);
        entry.version = version;
        if (kind === "deck") {
          entry.name = str(isObj(doc.meta) ? doc.meta.name : undefined) ?? "";
          const frames = Array.isArray(doc.frames) ? doc.frames : [];
          entry.frames = frames.length;
          entry.charts = chartsOf(doc).length;
        } else if (kind === "sheet") {
          const s = sheetSummary(doc);
          entry.name = s.name;
          entry.sheets = (s.sheets as unknown[]).length;
        }
      } catch {
        entry.corrupt = true;
      }
      docs.push(entry);
    }
  };
  walk(root, 0);
  return { workspace: ctx.workspace, dir: relPath(root, ctx), docs, truncated: docs.length >= MAX_LIST };
}

function opReadDoc(args: Spec, ctx: ToolCtx): unknown {
  const { abs, kind } = resolveDocPath(args.path, ctx);
  const { doc, version } = loadJson(abs);
  const rel = relPath(abs, ctx);
  const elementId = str(args.elementId)?.trim();
  if (elementId) {
    const hit = [...chartsOf(doc), ...(Array.isArray(doc.frames) ? doc.frames.flatMap((f) => (isObj(f) && Array.isArray(f.elements) ? f.elements : [])) : [])]
      .filter(isObj)
      .find((el) => el.id === elementId);
    if (!hit) throw new Error(`元素不存在："${elementId}"（先 read_doc 摘要拿最新 id）`);
    return { path: rel, version, element: hit };
  }
  const view = str(args.view) ?? "summary";
  if (view === "full") {
    const text = JSON.stringify(doc, null, 2);
    return {
      path: rel,
      version,
      doc: text.length > MAX_FULL_CHARS ? undefined : doc,
      chars: text.length,
      ...(text.length > MAX_FULL_CHARS ? { truncated: true, hint: "整档过大：改用 view:summary 或 view:chart 分段读取" } : {}),
    };
  }
  if (view === "chart") return { path: rel, version, charts: chartsOf(doc) };
  if (view === "cells") {
    if (kind !== "sheet") throw new Error("view:cells 只作用于 sheet 文档");
    return { path: rel, version, ...cellsView(doc, args) };
  }
  if (view !== "summary") throw new Error(`view 只能是 summary / chart / cells / full`);
  return { path: rel, version, ...summaryOf(doc, kind) };
}

function opWriteDoc(args: Spec, ctx: ToolCtx): unknown {
  const { abs, kind } = resolveDocPath(args.path, ctx);
  const doc = args.doc;
  if (!isObj(doc)) throw new Error("doc 需为文档 JSON 对象（不是字符串）");
  if (kind === "deck") {
    if (!Array.isArray(doc.frames) && !Array.isArray(doc.slides)) throw new Error("deck 文档需有 frames 数组（或旧版 slides）");
  } else if (kind === "sheet") {
    if (!isObj(doc.sheets)) throw new Error("sheet 文档需有 sheets 对象（Univer 快照）");
  }
  const { version, bytes } = saveJson(abs, doc);
  return { path: relPath(abs, ctx), version, bytes, ...summaryOf(doc, kind) };
}

function opPatchChart(args: Spec, ctx: ToolCtx): unknown {
  const { abs, kind } = resolveDocPath(args.path, ctx);
  if (kind !== "deck") throw new Error("patch_chart 只作用于 deck 文档（.deck.canvas.json）");
  const elementId = str(args.elementId)?.trim();
  if (!elementId) throw new Error("elementId 不能为空（从 read_doc 摘要或 view:chart 拿）");
  const { doc } = loadJson(abs);
  const patch = chartPatchFrom(args);
  if (Object.keys(patch).length === 0) throw new Error("没有要修改的图表字段（chart/labels/series/variant/…）");

  const frames = Array.isArray(doc.frames) ? doc.frames : [];
  let target: Json | null = null;
  let frameId = "";
  for (const f of frames) {
    if (!isObj(f) || !Array.isArray(f.elements)) continue;
    for (const el of f.elements) {
      if (isObj(el) && el.kind === "chart" && el.id === elementId) {
        target = el;
        frameId = str(f.id) ?? "";
      }
    }
  }
  if (!target) throw new Error(`图表元素不存在："${elementId}"（先 read_doc 拿最新 id；新建图表请用 write_doc）`);
  // 切类型时把数据换成目标类型可消费的形状（散点↔类目互换），与面板 chartKindPatch 同源
  const nextKind = str(patch.chart) as ChartKind | undefined;
  if (nextKind) {
    const merged = { ...target, ...patch };
    const base = {
      series: Array.isArray(merged.series) ? merged.series : [],
      labels: Array.isArray(merged.labels) ? merged.labels : [],
      tasks: Array.isArray(merged.tasks) ? merged.tasks : [],
    } as unknown as ChartEl;
    const adapt = chartKindPatch(base, nextKind) as unknown as Json;
    for (const key of ["series", "labels", "tasks"] as const) {
      const v = adapt[key];
      if (v !== undefined) patch[key] = v;
    }
  }
  Object.assign(target, patch);
  const { version } = saveJson(abs, doc);
  return {
    path: relPath(abs, ctx),
    version,
    frameId,
    chart: { id: target.id, ...chartBrief(target), labels: target.labels, series: target.series, ...(target.tasks ? { tasks: target.tasks } : {}) },
  };
}

/* ------------------------------------------------------------------ */
/* 局部写入：patch_sheet / patch_doc / patch_deck / create_doc           */
/* ------------------------------------------------------------------ */

function opPatchSheet(args: Spec, ctx: ToolCtx): unknown {
  const { abs, kind } = resolveDocPath(args.path, ctx);
  if (kind !== "sheet") throw new Error("patch_sheet 只作用于 sheet 文档（.sheet.univer.json）");
  const { doc } = loadJson(abs);
  const { id, sheet } = pickSheet(doc, str(args.sheet)?.trim());
  const setCells = args.setCells;
  if (!isObj(setCells) || Object.keys(setCells).length === 0) {
    throw new Error('setCells 需为非空对象：{ "A1": 123 | "文本" | { f: "=SUM(A1:A9)" } }（null = 清空该格内容）');
  }
  if (Object.keys(setCells).length > MAX_PATCH_CELLS) {
    throw new Error(`setCells 一次最多 ${MAX_PATCH_CELLS} 格（当前 ${Object.keys(setCells).length}）`);
  }
  const cellData = isObj(sheet.cellData) ? { ...sheet.cellData } : {};
  let maxR = -1;
  let maxC = -1;
  for (const [addr, val] of Object.entries(setCells)) {
    const pos = parseA1Range(addr);
    if (!pos || pos.r0 !== pos.r1 || pos.c0 !== pos.c1) {
      throw new Error(`单元格地址不合法："${addr}"（单个地址，示例 A1 / AB12）`);
    }
    const r = pos.r0;
    const c = pos.c0;
    const rowObj = isObj(cellData[String(r)]) ? { ...(cellData[String(r)] as Json) } : {};
    const prev = isObj(rowObj[String(c)]) ? (rowObj[String(c)] as Json) : {};
    let cell: Json;
    if (isObj(val)) {
      const f = str(val.f);
      if (f === undefined) throw new Error(`${addr} 对象形式需有 f 字段（公式，如 "=SUM(A1:A9)"）`);
      cell = { ...prev, f: f.startsWith("=") ? f : `=${f}` };
      if (val.v !== undefined) cell.v = val.v;
      else delete cell.v; // 旧缓存值随公式作废，交给面板重算回填
    } else if (typeof val === "number" || typeof val === "string" || typeof val === "boolean") {
      cell = { ...prev, v: val };
      delete cell.f;
    } else if (val === null) {
      cell = { ...prev };
      delete cell.v;
      delete cell.f;
    } else {
      throw new Error(`${addr} 的值类型不支持：${typeof val}（数字/字符串/布尔 / {f} / null）`);
    }
    if (!("v" in cell) && !("f" in cell) && !("s" in cell)) delete rowObj[String(c)];
    else rowObj[String(c)] = cell;
    if (Object.keys(rowObj).length === 0) delete cellData[String(r)];
    else cellData[String(r)] = rowObj;
    maxR = Math.max(maxR, r);
    maxC = Math.max(maxC, c);
  }
  if (maxR >= 0) {
    if (maxR + 1 > (num(sheet.rowCount) ?? 0)) sheet.rowCount = maxR + 1;
    if (maxC + 1 > (num(sheet.columnCount) ?? 0)) sheet.columnCount = maxC + 1;
  }
  sheet.cellData = cellData;
  const { version } = saveJson(abs, doc);
  return {
    path: relPath(abs, ctx),
    version,
    sheet: { id, name: str(sheet.name) ?? id },
    applied: Object.keys(setCells).length,
    rowCount: sheet.rowCount,
    columnCount: sheet.columnCount,
  };
}

/** 段落起始偏移（第 i 段起点 = 前面各段字符数 + 1 的累加） */
function cumStarts(lens: number[]): number[] {
  const out: number[] = [];
  let n = 0;
  for (const l of lens) {
    out.push(n);
    n += l + 1;
  }
  return out;
}

function opPatchDoc(args: Spec, ctx: ToolCtx): unknown {
  const { abs, kind } = resolveDocPath(args.path, ctx);
  if (kind !== "doc") throw new Error("patch_doc 只作用于 doc 文档（.doc.univer.json）");
  const { doc } = loadJson(abs);
  const body = isObj(doc.body) ? doc.body : {};
  if (Array.isArray(body.customBlocks) && body.customBlocks.length > 0) {
    throw new Error("该文档包含高级块（表格/图片等），patch_doc 暂不支持，请用 write_doc 整档改");
  }
  const ds = typeof body.dataStream === "string" ? body.dataStream : "";
  if (!ds) throw new Error("文档缺 body.dataStream（先用 write_doc 建骨架）");
  const core = ds.endsWith("\r\n") ? ds.slice(0, -2) : ds;
  const rawParas = (Array.isArray(body.paragraphs) ? body.paragraphs : []).filter(isObj);
  type P = { text: string; style?: Json };
  const paras: P[] = core.split("\r").map((text, i) => {
    const style = rawParas[i]?.paragraphStyle;
    return { text, ...(isObj(style) ? { style: style as Json } : {}) };
  });
  // 行内样式按段归属：完全落在某段文字范围内的 remap 偏移保留；跨段/被改段落的丢弃
  const runs: { st: number; ed: number; ts?: Json }[] = (Array.isArray(body.textRuns) ? body.textRuns : [])
    .filter(isObj)
    .map((r) => ({ st: num(r.st) ?? -1, ed: num(r.ed) ?? -1, ...(r.ts !== undefined ? { ts: r.ts as Json } : {}) }))
    .filter((r) => r.st >= 0 && r.ed > r.st);
  let paraStarts = cumStarts(paras.map((p) => p.text.length));
  let runsByPara: { st: number; ed: number; ts?: Json }[][] = paras.map((_, i) =>
    runs
      .filter((r) => r.st >= paraStarts[i]! && r.ed <= paraStarts[i]! + paras[i]!.text.length)
      .map((r) => ({ st: r.st - paraStarts[i]!, ed: r.ed - paraStarts[i]!, ...(r.ts !== undefined ? { ts: r.ts } : {}) })),
  );

  const ops = (Array.isArray(args.ops) ? args.ops : []).filter(isObj);
  if (ops.length === 0) throw new Error('ops 需为非空数组：[{op:"append"|"replace"|"delete", ...}]');
  if (ops.length > MAX_DOC_OPS) throw new Error(`ops 一次最多 ${MAX_DOC_OPS} 条（当前 ${ops.length}）`);
  for (const op of ops) {
    const kindOp = str(op.op);
    const idx = num(op.paragraph);
    if (kindOp === "append") {
      const text = str(op.text);
      if (text === undefined) throw new Error("append 需有 text（段落文本）");
      paras.push({ text });
      paraStarts = cumStarts(paras.map((p) => p.text.length));
      runsByPara.push([]);
    } else if (kindOp === "replace") {
      if (idx === undefined || idx < 0 || idx >= paras.length) {
        throw new Error(`replace 的 paragraph 越界：${String(op.paragraph)}（当前 0..${paras.length - 1}）`);
      }
      const text = str(op.text);
      if (text === undefined) throw new Error("replace 需有 text（新段落全文）");
      paras[idx] = { text, ...(paras[idx]!.style ? { style: paras[idx]!.style } : {}) };
      runsByPara[idx] = []; // 改写段落的行内样式不保留（段落级样式 namedStyleType 保留）
    } else if (kindOp === "delete") {
      if (idx === undefined || idx < 0 || idx >= paras.length) {
        throw new Error(`delete 的 paragraph 越界：${String(op.paragraph)}（当前 0..${paras.length - 1}）`);
      }
      paras.splice(idx, 1);
      runsByPara.splice(idx, 1);
      paraStarts = cumStarts(paras.map((p) => p.text.length));
    } else {
      throw new Error(`op 只支持 append / replace / delete："${kindOp}"`);
    }
  }
  if (paras.length === 0) throw new Error("操作后没有段落了（至少保留一段；清空请逐段 replace 为空文本）");
  // 重建（机械规则同 skills/doc）：段落 \r 连接 + 结尾 \r\n；startIndex 累加；节分隔指向末尾 \n
  const dataStream = paras.map((p) => p.text).join("\r") + "\r\n";
  const newParagraphs: Json[] = [];
  const newRuns: Json[] = [];
  let offset = 0;
  paras.forEach((p, i) => {
    newParagraphs.push({ startIndex: offset, ...(p.style ? { paragraphStyle: p.style } : {}) });
    for (const r of runsByPara[i] ?? []) {
      newRuns.push({ st: offset + r.st, ed: offset + r.ed, ...(r.ts ? { ts: r.ts } : {}) });
    }
    offset += p.text.length + 1;
  });
  doc.body = {
    ...body,
    dataStream,
    paragraphs: newParagraphs,
    sectionBreaks: [{ startIndex: dataStream.length - 1 }],
    textRuns: newRuns,
  };
  const { version } = saveJson(abs, doc);
  return { path: relPath(abs, ctx), version, ...docSummary(doc) };
}

/* ---------------- patch_deck：元素白名单 patch + 页级操作 ---------------- */

function locateDeckElement(doc: Json, elementId: string): { list: Json[]; el: Json; containerId: string } | null {
  const frames = Array.isArray(doc.frames) ? doc.frames : [];
  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi]!;
    if (!isObj(f) || !Array.isArray(f.elements)) continue;
    const els = f.elements as unknown[];
    const idx = els.findIndex((e) => isObj(e) && (e as Json).id === elementId);
    if (idx >= 0) return { list: els as Json[], el: els[idx] as Json, containerId: str(f.id) ?? `s${fi + 1}` };
  }
  const objects = Array.isArray(doc.objects) ? (doc.objects as unknown[]) : [];
  const oi = objects.findIndex((e) => isObj(e) && (e as Json).id === elementId);
  if (oi >= 0) return { list: objects as Json[], el: objects[oi] as Json, containerId: "canvas" };
  return null;
}

const DECK_NUM_FIELDS = ["x", "y", "w", "h", "opacity", "rotation", "lineHeight", "strokeWidth", "radius", "curve"] as const;
const DECK_ALIGN_SET = new Set(["left", "center", "right"]);
const DECK_VALIGN_SET = new Set(["top", "middle", "bottom"]);
const DECK_STROKE_SET = new Set(["solid", "dashed", "dotted"]);

function deckElementPatch(patch: Json): Json {
  const out: Json = {};
  for (const k of DECK_NUM_FIELDS) {
    if (patch[k] === undefined) continue;
    const n = num(patch[k]);
    if (n === undefined) throw new Error(`patch.${k} 需为数字`);
    out[k] = n;
  }
  if (patch.align !== undefined) {
    if (!DECK_ALIGN_SET.has(String(patch.align))) throw new Error("patch.align 只能是 left/center/right");
    out.align = patch.align;
  }
  if (patch.vAlign !== undefined) {
    if (!DECK_VALIGN_SET.has(String(patch.vAlign))) throw new Error("patch.vAlign 只能是 top/middle/bottom");
    out.vAlign = patch.vAlign;
  }
  if (patch.strokeStyle !== undefined) {
    if (!DECK_STROKE_SET.has(String(patch.strokeStyle))) throw new Error("patch.strokeStyle 只能是 solid/dashed/dotted");
    out.strokeStyle = patch.strokeStyle;
  }
  for (const k of ["fill", "stroke"] as const) {
    if (patch[k] === undefined) continue;
    const s = str(patch[k]);
    if (s === undefined || s.length > 300) throw new Error(`patch.${k} 需为颜色字符串（#rrggbb / none / 渐变串 ≤300 字）`);
    out[k] = s;
  }
  if (patch.runs !== undefined) {
    if (!Array.isArray(patch.runs)) {
      throw new Error("patch.runs 需为 TextRun 数组：[{text, bold?, italic?, underline?, size?, color?, font?}]");
    }
    // doc.parseRun 对缺 text 的对象宽容回退成空文本 run——patch 语义下这是 agent 漏写字段，显式拒绝
    const runs = patch.runs.map((r, i) => {
      if (typeof r !== "string" && !(isObj(r) && typeof r.text === "string")) {
        throw new Error(`patch.runs[${i}] 不合法（text 必填；size/color/font 取值见 deck SKILL）`);
      }
      const parsed = parseDeckRun(r);
      if (parsed === null) throw new Error(`patch.runs[${i}] 不合法（text 必填；size/color/font 取值见 deck SKILL）`);
      return parsed;
    });
    out.runs = runs;
  }
  return out;
}

function resolvePageIndex(frames: Json[], args: Spec): number {
  const frameId = str(args.frameId)?.trim();
  if (frameId) {
    const i = frames.findIndex((f) => isObj(f) && str(f.id) === frameId);
    if (i < 0) throw new Error(`页不存在：frameId "${frameId}"（read_doc 摘要拿页 id）`);
    return i;
  }
  const idx = num(args.index);
  if (idx === undefined) throw new Error("需要 index（0 起页序）或 frameId 定位页");
  if (idx < 0 || idx >= frames.length) throw new Error(`index 越界：${idx}（当前 ${frames.length} 页）`);
  return idx;
}

function opPatchDeck(args: Spec, ctx: ToolCtx): unknown {
  const { abs, kind } = resolveDocPath(args.path, ctx);
  if (kind !== "deck") throw new Error("patch_deck 只作用于 deck 文档（.deck.canvas.json）");
  const { doc } = loadJson(abs);
  const frames = Array.isArray(doc.frames) ? (doc.frames as Json[]) : [];
  const op = str(args.op);
  switch (op) {
    case "element": {
      const elementId = str(args.elementId)?.trim();
      if (!elementId) throw new Error("elementId 不能为空（read_doc 摘要拿 id）");
      const hit = locateDeckElement(doc, elementId);
      if (!hit) throw new Error(`元素不存在："${elementId}"（先 read_doc 拿最新 id）`);
      const patch = isObj(args.patch) ? args.patch : null;
      if (!patch || Object.keys(patch).length === 0) {
        throw new Error("patch 需为非空对象（x/y/w/h/opacity/rotation/runs/fill/stroke/strokeWidth/strokeStyle/radius/curve/align/vAlign/lineHeight）");
      }
      const clean = deckElementPatch(patch);
      const merged = { ...hit.el, ...clean };
      // 面板解析器校验（坏字段丢弃语义与面板一致）；只做门槛，落盘保留未知字段（groupId 等）
      if (parseDeckEl(structuredClone(merged)) === null) throw new Error("patch 后元素不合法（被面板解析器拒绝），已放弃写入");
      Object.assign(hit.el, clean);
      const z = str(args.z);
      if (z !== undefined) {
        if (!["forward", "backward", "front", "back"].includes(z)) throw new Error("z 只能是 forward/backward/front/back");
        const i = hit.list.indexOf(hit.el);
        if (i >= 0) {
          hit.list.splice(i, 1);
          if (z === "front") hit.list.push(hit.el);
          else if (z === "back") hit.list.unshift(hit.el);
          else if (z === "forward") hit.list.splice(Math.min(hit.list.length, i + 1), 0, hit.el);
          else hit.list.splice(Math.max(0, i - 1), 0, hit.el);
        }
      }
      const { version } = saveJson(abs, doc);
      return { path: relPath(abs, ctx), version, containerId: hit.containerId, element: hit.el };
    }
    case "add_page": {
      const presetRaw = str(isObj(doc.meta) ? doc.meta.pagePreset : undefined) ?? "16:9";
      const preset: PagePreset = presetRaw in PAGE_SIZES ? (presetRaw as PagePreset) : "16:9";
      const layoutId = str(args.layoutId)?.trim();
      const themeId = str(args.themeId)?.trim() || TEMPLATE_THEMES[0]!.id;
      const at = nextFramePos(frames as unknown as Parameters<typeof nextFramePos>[0]);
      let frame: Json;
      if (layoutId) {
        const built = buildTemplateFrame(themeId, layoutId, preset, at);
        if (!built) throw new Error(`版式或主题不存在：layoutId="${layoutId}" themeId="${themeId}"（可用版式：cover/toc/section/cards3/quadrant/timeline/compare/stats/list/process/faq/table/quote/end）`);
        frame = built as unknown as Json;
      } else {
        frame = blankFrame(preset, at) as unknown as Json;
      }
      const after = num(args.index);
      const insertAt = after === undefined || after < 0 || after >= frames.length ? frames.length : after + 1;
      frames.splice(insertAt, 0, frame);
      doc.frames = frames;
      const { version } = saveJson(abs, doc);
      return { path: relPath(abs, ctx), version, frames: frames.length, index: insertAt, frameId: str(frame.id) ?? "" };
    }
    case "remove_page": {
      const idx = resolvePageIndex(frames, args);
      frames.splice(idx, 1);
      doc.frames = frames;
      const { version } = saveJson(abs, doc);
      return { path: relPath(abs, ctx), version, frames: frames.length, removed: idx };
    }
    case "move_page": {
      const from = num(args.from);
      const to = num(args.to);
      if (from === undefined || to === undefined || from < 0 || to < 0 || from >= frames.length || to >= frames.length) {
        throw new Error(`from/to 越界：${String(args.from)} → ${String(args.to)}（当前 0..${frames.length - 1}）`);
      }
      const [moved] = frames.splice(from, 1);
      frames.splice(to, 0, moved!);
      doc.frames = frames;
      const { version } = saveJson(abs, doc);
      return { path: relPath(abs, ctx), version, order: frames.map((f) => str(f.id) ?? "") };
    }
    case "set_page": {
      const idx = resolvePageIndex(frames, args);
      const page = frames[idx]!;
      const patch = isObj(args.patch) ? args.patch : null;
      if (!patch || Object.keys(patch).length === 0) throw new Error("patch 需为非空对象（background/transition/name）");
      if (patch.background !== undefined) {
        const bg = str(patch.background);
        if (bg === undefined || bg.length > 300) throw new Error("patch.background 需为颜色串（#rrggbb / 渐变 ≤300 字）");
        page.background = bg;
      }
      if (patch.transition !== undefined) {
        if (!(SLIDE_TRANSITIONS as readonly string[]).includes(String(patch.transition))) {
          throw new Error(`patch.transition 只能是 ${SLIDE_TRANSITIONS.join(" / ")}`);
        }
        page.transition = patch.transition;
      }
      if (patch.name !== undefined) {
        const name = str(patch.name);
        if (name === undefined || name.length > 60) throw new Error("patch.name 需为 ≤60 字的字符串");
        page.name = name;
      }
      const { version } = saveJson(abs, doc);
      return { path: relPath(abs, ctx), version, index: idx, page: { id: str(page.id) ?? "", name: str(page.name) ?? "", background: page.background, transition: page.transition } };
    }
    default:
      throw new Error(`op 只支持 element / add_page / remove_page / move_page / set_page："${op ?? ""}"`);
  }
}

function opCreateDoc(args: Spec, ctx: ToolCtx): unknown {
  const kind = str(args.kind);
  if (!kind || !(kind in SUFFIXES)) throw new Error("kind 只能是 deck / sheet / doc");
  const safe = safeDocName(str(args.name) ?? "");
  if (!safe) throw new Error("name 需非空且不含路径分隔符（空格会转成 -）");
  const rel = `${safe}${SUFFIXES[kind as DocKind]}`;
  const abs = path.resolve(ctx.workspace, rel);
  if (existsSync(abs)) throw new Error(`${rel} 已存在（换个名字，或直接 read_doc 后用 patch 工具改）`);
  const seed = kind === "deck" ? deckSeed(safe) : kind === "sheet" ? sheetSeed(safe) : docSeed(safe);
  const doc = JSON.parse(seed) as Json;
  const { version } = saveJson(abs, doc);
  return { path: rel, version, kind, ...summaryOf(doc, kind as DocKind) };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function opWatchDoc(args: Spec, ctx: ToolCtx): Promise<unknown> {
  const { abs, kind } = resolveDocPath(args.path, ctx);
  const rel = relPath(abs, ctx);
  const timeout = Math.min(120_000, Math.max(1_000, num(args.timeoutMs) ?? 25_000));
  const view = str(args.view) ?? "summary";
  let current = str(args.since)?.trim() || sha(readText(abs));
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await sleep(350);
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue; // 面板换绑/写盘瞬间可能短暂不可读
    }
    const version = sha(text);
    if (version === current) continue;
    current = version;
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return { path: rel, changed: true, version, error: "文件内容不是合法 JSON（面板可能正在写盘），稍后重试" };
    }
    if (!isObj(doc)) return { path: rel, changed: true, version, error: "文档顶层不是对象" };
    const payload =
      view === "full"
        ? { chars: text.length, ...(text.length <= MAX_FULL_CHARS ? { doc } : { truncated: true }) }
        : view === "chart"
          ? { charts: chartsOf(doc) }
          : summaryOf(doc, kind);
    return { path: rel, changed: true, version, ...payload };
  }
  return { path: rel, changed: false, version: current, timedOut: true, hint: "超时无变更；再次调用继续等待" };
}

/* ------------------------------------------------------------------ */
/* 工具清单                                                             */
/* ------------------------------------------------------------------ */

const PATH_SCHEMA = {
  type: "string",
  description: "文档路径：工作区相对或绝对，扩展名须为 .deck.canvas.json / .sheet.univer.json / .doc.univer.json",
};

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "list_docs",
    description:
      "列出工作区里的 Office 文档（deck 幻灯片 / sheet 表格 / doc 文档，根目录 + 两层子目录，最多 60 份），带名称、页数/图表数、版本哈希与损坏标记。找不到目标文档时先用它；返回的 version 可直接传给 watch_doc 的 since。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "可选：deck / sheet / doc，缺省全部" },
        dir: { type: "string", description: "可选：限定子目录（相对工作区）" },
      },
    },
    run: opListDocs,
  },
  {
    name: "read_doc",
    description:
      "读 Office 文档。deck 默认 view:summary 返回页框与元素摘要（id/kind/盒/文字前 80 字/图表概览），view:chart 返回所有图表完整 ChartSpec；" +
      "sheet 可用 view:cells 按区域返回单元格矩阵（v 计算值 / f 公式 / s 样式引用，参数 sheet=名称或 id、range=A1 区域，缺省 used-range）；" +
      "doc 的 view:summary 返回标题、字数与段落列表（每段前 80 字 + 段落样式）。" +
      "给 elementId 只返回该元素完整 JSON（deck）。编辑/推数据前先读，拿最新 id 与 version。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        view: { type: "string", description: "summary（默认）/ chart / cells（仅 sheet）/ full" },
        elementId: { type: "string", description: "只看某个元素（含图表完整规格；deck）" },
        sheet: { type: "string", description: "view:cells 时选工作表（名称或 id，缺省第一张）" },
        range: { type: "string", description: 'view:cells 的区域，A1 表示法（如 "A1:C10" 或 "B2"），缺省 used-range' },
      },
      required: ["path"],
    },
    run: opReadDoc,
  },
  {
    name: "write_doc",
    description:
      "整档写入 Office 文档（原子落盘，宿主会把新内容推给已打开的面板）。用于新建页/元素、批量重排、修表。写入前务必先 read_doc 拿最新内容再增量改，别凭空整档重写（会丢用户刚做的编辑）。sheet 需保留 Univer 快照（sheets/sheetOrder/styles 等），别精简成自定义格式。",
    inputSchema: {
      type: "object",
      properties: { path: PATH_SCHEMA, doc: { type: "object", description: "完整文档 JSON（对象，不是字符串）" } },
      required: ["path", "doc"],
    },
    run: opWriteDoc,
  },
  {
    name: "patch_chart",
    description:
      "按元素 id 更新幻灯片里的图表（ChartSpec v2）：chart 类型（bar/barH/line/area/combo/scatter/bubble/pie/doughnut/radar/funnel/treemap/heatmap/gantt）、labels、series（含 points/tasks）、variant（clustered/stacked/percent）、colors、legend、dataLabels、axes、smooth、size、theme。只写允许字段并校验规模上限；返回新 version，可直接给 watch_doc 的 since。这是 agent → 面板推数据的主通道。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        elementId: { type: "string", description: "图表元素 id（read_doc 摘要里 kind=chart 的元素）" },
        chart: { type: "string", description: `图表类型，可用：${CHART_KINDS.join(", ")}` },
        labels: { type: "array", items: { type: "string" }, description: `类目名（≤${CHART_MAX_LABELS}）` },
        series: {
          type: "array",
          description: `系列数组（≤${CHART_MAX_SERIES}）：{name, data:[数值]，scatter/bubble 用 points:[{x,y,size?}]，combo 可带 type:bar/line/area}`,
          items: { type: "object" },
        },
        tasks: {
          type: "array",
          description: `仅 gantt：{name, start, end, progress?}（≤${CHART_MAX_TASKS} 条，progress 0..1）`,
          items: { type: "object" },
        },
        variant: { type: "string", description: "bar/barH/area 的排布：clustered / stacked / percent" },
        colors: { type: "array", items: { type: "string" }, description: "系列色（饼/环=扇区色），#rrggbb" },
        legend: { type: "object", description: "{show:boolean, position:top/bottom/left/right}" },
        dataLabels: { type: "object", description: "{show:boolean, position:outside/inside/center/top, format?:\"{value}万\"}" },
        axes: { type: "object", description: "{x:{title,show,grid,rotate,min,max,format}, y:{同}}" },
        smooth: { type: "boolean", description: "折线/面积/组合折线平滑" },
        size: { type: "number", description: "图表字号 px（6–48）" },
        theme: { type: "string", description: "light / dark（跟随浅底/深底页）" },
      },
      required: ["path", "elementId"],
    },
    run: opPatchChart,
  },
  {
    name: "patch_sheet",
    description:
      "表格局部写入：按 A1 地址写值/公式（自动扩行列、保留既有样式引用/合并/冻结），null 清空该格内容。" +
      "公式 f 带 = 号（缺省会补）。只动 cellData，不碰 styles/sheetOrder —— 比整档 write_doc 安全得多，优先用这个。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        sheet: { type: "string", description: "工作表名称或 id（缺省第一张）" },
        setCells: {
          type: "object",
          description: '单元格映射：{ "A1": 120, "B1": "营收", "C1": { f: "=SUM(A1:B1)" }, "D9": null }',
          additionalProperties: true,
        },
      },
      required: ["path", "setCells"],
    },
    run: opPatchSheet,
  },
  {
    name: "patch_doc",
    description:
      "文档段落级写入：append（末尾追加）/ replace（按段落序号整段改写）/ delete（删段）。" +
      "内部按机械规则重算 dataStream/paragraphs/sectionBreaks/textRuns 偏移（\\r 段落终止、结尾 \\r\\n）；" +
      "replace 保留段落级样式（namedStyleType 标题级别）但丢弃行内样式；paragraph 序号即 read_doc 摘要 list 里的 i（0 起）。" +
      "含表格/图片高级块的文档不支持（报错提示走 write_doc）。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        ops: {
          type: "array",
          description: '操作数组（按序执行）：[{op:"append", text}, {op:"replace", paragraph: 2, text}, {op:"delete", paragraph: 5}]',
          items: { type: "object" },
        },
      },
      required: ["path", "ops"],
    },
    run: opPatchDoc,
  },
  {
    name: "patch_deck",
    description:
      "幻灯片局部写入。op=element：按 elementId 白名单改元素（x/y/w/h/opacity/rotation、runs 富文本、fill/stroke/strokeWidth/strokeStyle/radius/curve、align/vAlign/lineHeight），z 调层序（forward/backward/front/back）；" +
      "op=add_page：加页（可选 layoutId: cover/toc/section/cards3/quadrant/timeline/compare/stats/list/process/faq/table/quote/end + themeId，缺省空白页，index=插到该页之后）；" +
      "op=remove_page / move_page / set_page：删页/换序/改页背景·切换动画·页名（index 或 frameId 定位）。落盘前面板解析器校验，坏字段拒绝写入。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        op: { type: "string", description: "element / add_page / remove_page / move_page / set_page" },
        elementId: { type: "string", description: "op=element：元素 id（read_doc 摘要拿）" },
        patch: { type: "object", description: "op=element：字段补丁（白名单外字段忽略）；op=set_page：{background?, transition?, name?}" },
        z: { type: "string", description: "op=element 可选：forward / backward / front / back" },
        index: { type: "number", description: "页序（0 起）；add_page 时=插到该页之后，set_page/remove_page 时=定位" },
        frameId: { type: "string", description: "页 id（与 index 二选一）" },
        layoutId: { type: "string", description: "op=add_page：版式 id（缺省空白页）" },
        themeId: { type: "string", description: "op=add_page：主题 id（缺省第一个主题）" },
        from: { type: "number", description: "op=move_page：原页序" },
        to: { type: "number", description: "op=move_page：目标页序" },
      },
      required: ["path", "op"],
    },
    run: opPatchDeck,
  },
  {
    name: "create_doc",
    description:
      "新建 Office 文档（deck/sheet/doc），按 kind 生成骨架原子落盘（不覆盖已有文件）。" +
      "骨架落盘后宿主会自动打开对应面板并绑定；之后用 read_doc + patch_* 填内容。name 里的空格会转成 -。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "deck / sheet / doc" },
        name: { type: "string", description: "文档名（不含扩展名；如「季度汇报」）" },
      },
      required: ["kind", "name"],
    },
    run: opCreateDoc,
  },
  {
    name: "watch_doc",
    description:
      "长轮询等待文档变更（默认 25 秒，最多 120 秒）：面板里用户的编辑会防抖写回文件，本工具等到内容变化后立刻返回变更摘要（view 同 read_doc）。用 list_docs/read_doc 返回的 version 传 since，避免漏掉两次调用之间的改动。返回 changed:false + timedOut 时再调一次即可继续等。这是「面板 → agent」的实时拉取通道。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        since: { type: "string", description: "上次拿到的 version（缺省取调用时的当前版本）" },
        timeoutMs: { type: "number", description: "最长等待毫秒数（1000–120000，缺省 25000）" },
        view: { type: "string", description: "变更后返回的视图：summary（默认）/ chart / full" },
      },
      required: ["path"],
    },
    run: opWatchDoc,
  },
];
