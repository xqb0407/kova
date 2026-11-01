/**
 * Office 文档 MCP 工具实现（stdio server 见 server.ts）。
 *
 * 设计取向：面板是唯一的写入者与渲染者，agent 只经文件协作——所有工具都作用于
 * 工作区里的 office 文档（`.deck.canvas.json` / `.sheet.univer.json` / `.doc.univer.json`），
 * 原子落盘后宿主会推给已打开的面板，用户的编辑也会防抖写回同一文件。
 *
 * 工具分三类：
 * - 发现/读取：list_docs、read_doc（摘要 / 图表 / 整档）
 * - 写入：write_doc（整档）、patch_chart（按元素 id 改图表数据与样式）
 * - 实时：watch_doc（长轮询，等面板写盘后返回变更摘要，是「面板 → agent」的拉取通道）
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
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
  type ChartEl,
  type ChartKind,
} from "../ui/src/doc";
import { chartKindPatch } from "../ui/src/chart/spec";

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

function docSummary(doc: Json): Json {
  return { kind: "doc", keys: Object.keys(doc), name: str(doc.name) ?? "" };
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
  if (view !== "summary") throw new Error(`view 只能是 summary / chart / full`);
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
      "读 Office 文档。默认 view:summary 返回结构摘要（deck=页框与元素 id/kind/盒/文字前 80 字/图表类型与系列名；sheet=工作表与填充单元格数）；view:chart 返回所有图表的完整 ChartSpec；view:full 返回整档 JSON（超过 20 万字符会拒绝并提示分段）；给 elementId 只返回该元素完整 JSON。编辑/推数据前先读，拿最新 id 与 version。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        view: { type: "string", description: "summary（默认）/ chart / full" },
        elementId: { type: "string", description: "只看某个元素（含图表完整规格）" },
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
