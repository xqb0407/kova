/**
 * UI 设计画布的 MCP 控制面（实现层）。
 *
 * 每个工具都是「读盘 → parseDesignDoc 容错解析 → 变更 → normalizeGroups → serializeDoc
 * → 原子落盘」——与面板共用同一套文档模型 / 几何 / 对齐语义（ui/src/doc.ts、
 * ui/src/geometry.ts），因此 MCP 改出来的稿子和面板手改的完全同构，面板 ~半秒内
 * 轮询到磁盘变更自动重渲染（见桌面端 plugin-panel-host 的外部刷新）。
 *
 * 坐标约定与文档模型一致：节点 x/y 是**父容器局部坐标**（页面级 = 画布绝对坐标）。
 * `path` 参数支持绝对路径，或相对 ctx.workspace（sidecar 经 KOVA_WORKSPACE 传入）解析。
 * server.ts 只负责 stdio JSON-RPC 协议与分发表。
 */
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEVICE_PRESETS,
  bakeInstanceNodes,
  blankDoc,
  collectVarRefs,
  componentBounds,
  findComponent,
  findNode,
  instanceView,
  newFrame,
  newNode,
  parseDesignDoc,
  patchInstancePath,
  remapVarColors,
  serializeDoc,
  solid,
  uid,
  walkNodes,
  type ComponentDef,
  type DesignDoc,
  type DesignNode,
  type Effect,
  type Fill,
  type FrameNode,
  type GroupNode,
  type IconNode,
  type InstanceNode,
  type LineDir,
  type NodeType,
  type Page,
  type Stroke,
  type TextRun,
} from "../ui/src/doc";
import {
  aabbRotated,
  applyAlign,
  normalizeGroups,
  round1,
  unionBox,
  worldBoxOf,
  type AlignMode,
  type Box,
} from "../ui/src/geometry";
import { renderDocPng } from "./render";
import { exportBundle, saveToWorkspace } from "./export";
import type { ExportFormat } from "../ui/src/bundle";
import { resolveIconName, searchIcons, DEFAULT_ICON } from "../ui/src/icons";
import { normalizeBlendMode } from "../ui/src/doc";
import { mergeImportedDoc } from "../ui/src/merge";
import { booleanPath, isBoolShape, normalizeBoolOp } from "../ui/src/boolean";
import { reflowWithin } from "../ui/src/layout";
import type { FrameLayout } from "../ui/src/doc";

export type ToolCtx = { workspace: string };

type Spec = Record<string, unknown>;

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Spec, ctx: ToolCtx) => unknown;
};

/* ------------------------------------------------------------------ */
/* 基础：路径 / 读写 / 页面定位                                          */
/* ------------------------------------------------------------------ */

const DOC_SUFFIX = ".uidesign.json";
const MAX_LIST = 60;
const MAX_LIST_DEPTH = 2;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
/** 非空字符串字段的首个命中 */
function pickStr(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function resolveDocPath(raw: unknown, ctx: ToolCtx): string {
  const p = str(raw)?.trim();
  if (!p) throw new Error("path 不能为空");
  const abs = path.isAbsolute(p) ? p : path.resolve(ctx.workspace, p);
  if (!abs.toLowerCase().endsWith(DOC_SUFFIX)) {
    throw new Error(`path 必须以 ${DOC_SUFFIX} 结尾（UI 设计档的扩展名约定）：${p}`);
  }
  return abs;
}

function relPath(abs: string, ctx: ToolCtx): string {
  const rel = path.relative(ctx.workspace, abs);
  return (rel && !rel.startsWith("..") ? rel : abs).split(path.sep).join("/");
}

function loadDoc(abs: string): { doc: DesignDoc; warnings: string[] } {
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    throw new Error(`文件不存在或不可读：${abs}（用 list_docs 找档，或 create_doc 建档）`);
  }
  const res = parseDesignDoc(text);
  if (res.fatal) {
    throw new Error(`文档不是合法设计档 JSON（${abs}）：${res.warnings.join("；")}。先 read 文件修复，或换 path`);
  }
  return { doc: res.doc, warnings: res.warnings };
}

/** 原子落盘：临时文件 + rename，避免面板轮询读到半截 JSON */
function saveDoc(abs: string, doc: DesignDoc): void {
  normalizeGroups(doc);
  const out = serializeDoc(doc);
  const tmp = `${abs}.tmp-mcp`;
  writeFileSync(tmp, out, "utf8");
  renameSync(tmp, abs);
}

function pickPage(doc: DesignDoc, page?: unknown): Page {
  const key = str(page)?.trim();
  if (key) {
    const hit = doc.pages.find((p) => p.id === key || p.name === key);
    if (!hit) throw new Error(`页面不存在："${key}"（可用 id 或名称；先 read_doc 看页面列表）`);
    return hit;
  }
  return doc.pages.find((p) => p.id === doc.activePage) ?? doc.pages[0]!;
}

function findOrThrow(doc: DesignDoc, id: string) {
  const loc = findNode(doc, id);
  if (!loc) throw new Error(`节点不存在：${id}（先 read_doc 拿最新 id）`);
  return loc;
}

/* ------------------------------------------------------------------ */
/* 节点构造（add_nodes / create_doc.frames 共用）                        */
/* ------------------------------------------------------------------ */

const NODE_TYPES: NodeType[] = [
  "frame", "group", "rect", "ellipse", "triangle", "diamond", "pentagon",
  "hexagon", "star", "line", "arrow", "text", "image", "icon", "vector", "instance",
];

const DEFAULT_BOX: Partial<Record<NodeType, { w: number; h: number }>> = {
  rect: { w: 120, h: 80 },
  ellipse: { w: 120, h: 80 },
  triangle: { w: 100, h: 88 },
  diamond: { w: 100, h: 100 },
  pentagon: { w: 100, h: 96 },
  hexagon: { w: 100, h: 88 },
  star: { w: 100, h: 96 },
  text: { w: 240, h: 24 },
  line: { w: 160, h: 2 },
  arrow: { w: 160, h: 2 },
  image: { w: 240, h: 160 },
  icon: { w: 24, h: 24 },
  vector: { w: 100, h: 100 },
  frame: { w: 390, h: 844 },
  group: { w: 100, h: 100 },
};

function parseRadiusInput(v: unknown): number | [number, number, number, number] {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number")) {
    return [v[0], v[1], v[2], v[3]] as [number, number, number, number];
  }
  throw new Error('radius 需为数字或 [左上,右上,右下,左下] 四元数组');
}

function fillColor(v: unknown): string | undefined {
  const s = str(v);
  return s && s.trim() ? s.trim() : undefined;
}

/** layout 入参归一：mode 必填 h|v；padding 数字=四边；Figma/CSS 对齐别名照收；非法值可读报错 */
function parseLayoutInput(v: unknown): FrameLayout {
  if (!v || typeof v !== "object") throw new Error('layout 需为对象，如 { "mode": "h", "gap": 12, "padding": 16, "main": "between", "cross": "center" }');
  const o = v as Record<string, unknown>;
  const modeRaw = str(o.mode ?? o.direction)?.trim().toLowerCase();
  const mode = modeRaw === "h" || modeRaw === "horizontal" || modeRaw === "row" ? "h" : modeRaw === "v" || modeRaw === "vertical" || modeRaw === "column" ? "v" : null;
  if (!mode) throw new Error('layout.mode 需为 "h"（横向）或 "v"（纵向）');
  const lo: FrameLayout = { mode };
  const gap = num(o.gap ?? o.itemSpacing ?? o.spacing);
  if (gap !== undefined) {
    if (gap < 0 || gap > 2000) throw new Error("layout.gap 需在 0..2000");
    lo.gap = gap;
  }
  const p = o.padding;
  if (p !== undefined) {
    if (typeof p === "number") {
      if (p < 0 || p > 1000) throw new Error("layout.padding 需在 0..1000");
      lo.padding = [p, p, p, p];
    } else if (Array.isArray(p) && p.length === 4 && p.every((x) => typeof x === "number")) {
      const q = p as number[];
      if (q.some((x) => x < 0 || x > 1000)) throw new Error("layout.padding 各边需在 0..1000");
      lo.padding = [q[0], q[1], q[2], q[3]];
    } else {
      throw new Error("layout.padding 需为数字（四边统一）或 [上,右,下,左]");
    }
  }
  const mainMap: Record<string, FrameLayout["main"]> = {
    start: "start", min: "start", "flex-start": "start",
    center: "center", middle: "center",
    end: "end", max: "end", "flex-end": "end",
    between: "between", "space-between": "between",
  };
  const main = mainMap[str(o.main ?? o.primaryAxisAlignItems ?? o.justifyContent)?.trim().toLowerCase() ?? ""];
  if (main !== undefined) lo.main = main;
  const crossMap: Record<string, FrameLayout["cross"]> = {
    start: "start", min: "start", "flex-start": "start",
    center: "center", middle: "center",
    end: "end", max: "end", "flex-end": "end",
    stretch: "stretch", fill: "stretch",
  };
  const cross = crossMap[str(o.cross ?? o.counterAxisAlignItems ?? o.alignItems)?.trim().toLowerCase() ?? ""];
  if (cross !== undefined) lo.cross = cross;
  if (o.wrap === true) lo.wrap = true;
  else if (o.wrap === false || o.wrap === "false") delete lo.wrap;
  const hugMap: Record<string, "main" | "cross" | "both" | undefined> = {
    main: "main", cross: "cross", both: "both", all: "both",
    none: undefined, fixed: undefined, "": undefined,
  };
  const hug = hugMap[str(o.hug ?? o.sizing)?.trim().toLowerCase() ?? ""];
  if (hug !== undefined) lo.hug = hug;
  else if (o.hug === null) delete lo.hug;
  return lo;
}

/** 结构性变更（影响布局的）字段：update_nodes 命中其一且祖先链有布局画板 → 自动重排 */
const LAYOUT_SENSITIVE = ["layout", "grow", "w", "h", "visible", "name"] as const;

/** 原型跳转入参：{ to: 画板id }；null/false = 清除跳转 */
function parseOnTapInput(v: unknown): { to: string } | null {
  if (v === null || v === false) return null;
  const to = str((v as Record<string, unknown> | null)?.to);
  if (!to || !to.trim()) throw new Error('onTap 需为 { "to": "顶层画板id" }（或 null 清除）');
  return { to: to.trim().slice(0, 120) };
}

function firstSolidColor(fills: unknown): string | undefined {
  if (!Array.isArray(fills)) return undefined;
  for (const f of fills) {
    if (f && typeof f === "object") {
      const o = f as Record<string, unknown>;
      if (o.type === "solid" && typeof o.color === "string") return o.color;
    }
  }
  return undefined;
}

function asFills(v: unknown, label: string): Fill[] {
  if (!Array.isArray(v)) throw new Error(`${label} 需为数组`);
  return v.map((f, i) => {
    if (!f || typeof f !== "object") throw new Error(`${label}[${i}] 需为对象`);
    const o = f as Record<string, unknown>;
    if (o.type === "image") {
      const src = [o.src, (o as Record<string, unknown>).image, (o as Record<string, unknown>).url].find(
        (x) => typeof x === "string" && x.trim(),
      );
      if (typeof src !== "string") throw new Error(`${label}[${i}].src 需为图片路径（workspace 相对）`);
      return { ...o, src } as unknown as Fill;
    }
    if (o.type !== "solid" && o.type !== "linear" && o.type !== "radial") {
      throw new Error(`${label}[${i}].type 需为 solid|linear|radial|image`);
    }
    return o as unknown as Fill;
  });
}

function asStrokes(v: unknown, label: string): Stroke[] {
  if (Array.isArray(v)) return v as Stroke[];
  const o = v as Record<string, unknown> | null;
  if (o && typeof o === "object") {
    const color = fillColor(o.color) ?? "#111111";
    const width = num(o.width) ?? 1;
    return [{ ...(o as object), color, width } as Stroke];
  }
  const color = fillColor(v);
  if (color) return [{ color, width: 1 }];
  throw new Error(`${label} 需为颜色字符串、描边对象或数组`);
}

function asRuns(spec: Spec): TextRun[] {
  if (Array.isArray(spec.runs)) {
    return spec.runs.map((r, i) => {
      if (!r || typeof r !== "object" || typeof (r as Record<string, unknown>).text !== "string") {
        throw new Error(`runs[${i}] 需为 { text, size?, color?, weight? } 对象`);
      }
      return r as TextRun;
    });
  }
  if (typeof spec.text === "string") {
    const run: TextRun = { text: spec.text };
    const size = num(spec.size);
    if (size !== undefined) run.size = size;
    const color = fillColor(spec.color);
    if (color !== undefined) run.color = color;
    const weight = num(spec.weight);
    if (weight !== undefined) run.weight = weight;
    return [run];
  }
  return [{ text: "文本", size: 16, color: "#111111" }];
}

function applyCommon(node: DesignNode, spec: Spec): void {
  if (spec.radius !== undefined) node.radius = parseRadiusInput(spec.radius);
  const rotation = num(spec.rotation);
  if (rotation !== undefined) node.rotation = rotation;
  const opacity = num(spec.opacity);
  if (opacity !== undefined) node.opacity = Math.min(1, Math.max(0, opacity));
  if (typeof spec.visible === "boolean") node.visible = spec.visible;
  if (typeof spec.locked === "boolean") node.locked = spec.locked;

  if (Array.isArray(spec.effects)) node.effects = spec.effects as Effect[];
  if (spec.onTap !== undefined) {
    const t = parseOnTapInput(spec.onTap);
    if (t) node.onTap = t;
    else delete node.onTap;
  }
}

/** spec → 设计节点；风格字段接受「shorthand（fill/stroke/text）」与「原样数组合集（fills/strokes/runs）」两式 */
function buildNode(spec: Spec, opts?: { id?: string }): DesignNode {
  const type = str(spec.type)?.trim() as NodeType | undefined;
  if (!type || !NODE_TYPES.includes(type)) {
    throw new Error(`type 必须是 ${NODE_TYPES.join(" / ")} 之一，收到 "${String(spec.type)}"`);
  }
  if (type === "group") throw new Error("group 不能直接构造：用 group_nodes 把现有节点成组");
  const id = str(spec.id)?.trim() || (opts?.id ?? undefined);
  const name = str(spec.name);
  const bare = !name && !id && type !== "text";
  const x = num(spec.x) ?? 0;
  const y = num(spec.y) ?? 0;
  let node: DesignNode;
  if (type === "frame") {
    const presetKey = str(spec.preset)?.trim();
    const preset = presetKey ? DEVICE_PRESETS[presetKey] : undefined;
    if (presetKey && !preset) {
      throw new Error(`未知设备预设 "${presetKey}"（可用：${Object.keys(DEVICE_PRESETS).join(" / ")}）`);
    }
    node = newFrame({
      name: name ?? preset?.label,
      w: num(spec.w) ?? preset?.w ?? 390,
      h: num(spec.h) ?? preset?.h ?? 844,
      x,
      y,
      preset: presetKey,
      background: fillColor(spec.fill) ?? firstSolidColor(spec.fills),
    });
  } else {
    node = newNode(
      type,
      { x, y, w: num(spec.w) ?? DEFAULT_BOX[type]?.w ?? 120, h: num(spec.h) ?? DEFAULT_BOX[type]?.h ?? 80 },
      name,
    );
  }
  if (id) node.id = id;
  // vector 构造：path 必填；w/h 缺省用路径坐标包围盒
  if (node.type === "vector") {
    const d = pickStr(spec as Record<string, unknown>, "path", "d");
    if (!d) throw new Error('vector 需要 path 字段（SVG d 字符串，如 "M0 0L100 0L50 100Z"）');
    (node as { path: string }).path = d.slice(0, 40000);
    if (num(spec.w) === undefined || num(spec.h) === undefined) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const m of d.matchAll(/(-?\d+(?:\.\d+)?)[, ](-?\d+(?:\.\d+)?)/g)) {
        xs.push(Number(m[1]));
        ys.push(Number(m[2]));
      }
      if (xs.length) {
        const x0 = Math.min(...xs);
        const y0 = Math.min(...ys);
        node.w = Math.max(1, Math.round(Math.max(...xs) - x0));
        node.h = Math.max(1, Math.round(Math.max(...ys) - y0));
      }
    }
  }
  // icon 构造：icon/iconName/glyph 显式优先；只给 name 且能解析成图标也认（AI 常写 {"type":"icon","name":"home"}）
  if (node.type === "icon") {
    const ic = node as IconNode;
    const wanted = str(spec.icon) ?? str(spec.iconName) ?? str(spec.glyph) ?? (resolveIconName(name ?? "") ? name : undefined) ?? "";
    const resolved = resolveIconName(wanted);
    ic.icon = resolved ?? wanted ?? DEFAULT_ICON;
    if (!name) node.name = resolved ?? "图标";
    const color = fillColor(spec.color) ?? fillColor(spec.tint);
    if (color) ic.color = color;
    const sw = num(spec.strokeWidth);
    if (sw !== undefined) ic.strokeWidth = Math.min(12, Math.max(0.25, sw));
  }
  // instance 构造：componentId（别名 component/componentRef）必填；overrides 原样透传（解析端再净化）
  if (node.type === "instance") {
    const inst = node as InstanceNode;
    const ref = pickStr(spec, "componentId", "component", "componentRef", "mainComponent");
    if (!ref) throw new Error('instance 节点需要 componentId 字段（用 list_components 查本档组件；没有就先用 create_component）');
    inst.componentId = ref.trim();
    if (spec.overrides && typeof spec.overrides === "object" && !Array.isArray(spec.overrides)) {
      inst.overrides = spec.overrides as Record<string, Record<string, unknown>>;
    }
  }
  applyCommon(node, spec);
  return node;
}

/** 类型相关字段（fill/fills/stroke/strokes/runs/align/dir/src/fit/clip/grow/mask/blend/flip）在构造后套用 */
function applyTypeFields(node: DesignNode, spec: Spec): void {
  const gr = num(spec.grow);
  if (gr !== undefined) {
    if (gr > 0) node.grow = Math.min(100, Math.max(0, gr));
    else delete node.grow;
  }
  if (typeof spec.mask === "boolean") {
    if (spec.mask) node.mask = true;
    else delete node.mask;
  }
  if (spec.blendMode !== undefined) {
    const b = normalizeBlendMode(spec.blendMode);
    if (spec.blendMode !== null && b === undefined && spec.blendMode !== "normal" && spec.blendMode !== "") {
      throw new Error(`blendMode 无法识别："${String(spec.blendMode).slice(0, 40)}"（可用 multiply/screen/overlay/darken/lighten/color-dodge/color-burn/hard-light/soft-light/difference/exclusion/hue/saturation/color/luminosity）`);
    }
    if (b) node.blendMode = b;
    else delete node.blendMode;
  }
  if (typeof spec.flipX === "boolean") {
    if (spec.flipX) node.flipX = true;
    else delete node.flipX;
  }
  if (typeof spec.flipY === "boolean") {
    if (spec.flipY) node.flipY = true;
    else delete node.flipY;
  }
  if (spec.fill !== undefined || spec.fills !== undefined) {
    if (!("fills" in node)) throw new Error(`${node.type} 不支持 fill/fills（节点 ${node.id}）`);
    node.fills = spec.fills !== undefined ? asFills(spec.fills, "fills") : [solid(fillColor(spec.fill) ?? "#d9d9d9")];
  }
  if (spec.stroke !== undefined || spec.strokes !== undefined) {
    if (!("strokes" in node) || node.strokes === undefined) {
      throw new Error(`${node.type} 不支持 stroke/strokes（节点 ${node.id}）`);
    }
    node.strokes = spec.strokes !== undefined ? asStrokes(spec.strokes, "strokes") : asStrokes(spec.stroke, "stroke");
  }
  if (node.type === "text") {
    if (typeof spec.text === "string" || Array.isArray(spec.runs)) node.runs = asRuns(spec);
    const align = str(spec.align);
    if (align) {
      if (align !== "left" && align !== "center" && align !== "right") throw new Error('align 需为 left|center|right');
      node.align = align;
    }
    const vAlign = str(spec.vAlign);
    if (vAlign) {
      if (vAlign !== "top" && vAlign !== "middle" && vAlign !== "bottom") throw new Error("vAlign 需为 top|middle|bottom");
      node.vAlign = vAlign;
    }
    const lineHeight = num(spec.lineHeight);
    if (lineHeight !== undefined) node.lineHeight = lineHeight;
    const letterSpacing = num(spec.letterSpacing);
    if (letterSpacing !== undefined) node.letterSpacing = letterSpacing;
  }
  if (node.type === "line" || node.type === "arrow") {
    const dir = num(spec.dir);
    if (dir !== undefined) {
      if (dir < 0 || dir > 3) throw new Error("dir 需为 0..3（0=↘ 1=↗ 2=↖ 3=↙）");
      node.dir = Math.round(dir) as LineDir;
    }
  }
  if (node.type === "image") {
    const src = str(spec.src);
    if (src !== undefined) node.src = src;
    const fit = str(spec.fit);
    if (fit) {
      if (fit !== "cover" && fit !== "contain" && fit !== "stretch") throw new Error("fit 需为 cover|contain|stretch");
      node.fit = fit;
    }
  }
  if (node.type === "icon") {
    const ic = node as IconNode;
    const wanted = str(spec.icon) ?? str(spec.iconName) ?? str(spec.glyph);
    if (wanted !== undefined) {
      const resolved = resolveIconName(wanted);
      ic.icon = resolved ?? wanted;
      if (!resolved) throw new Error(`未知图标名 "${wanted}"：先用 list_icons 搜可用名字（模糊匹配也行）`);
    }
    const color = fillColor(spec.color) ?? fillColor(spec.tint);
    if (color) ic.color = color;
    const sw = num(spec.strokeWidth);
    if (sw !== undefined) ic.strokeWidth = Math.min(12, Math.max(0.25, sw));
  }
  if (node.type === "vector") {
    const d = pickStr(spec as Record<string, unknown>, "path", "d");
    if (d !== undefined) (node as { path: string }).path = d.slice(0, 40000);
  }
  if (node.type === "frame") {
    if (spec.clip !== undefined && typeof spec.clip === "boolean") node.clip = spec.clip;
    if (spec.layout !== undefined) {
      if (spec.layout === null) {
        delete node.layout;
      } else {
        node.layout = parseLayoutInput(spec.layout);
      }
    }
  }
}

/** 省略 x/y 时的自动落位：容器内叠在最后一个子节点下方；页面级横排在现有节点右侧 */
function autoPlace(doc: DesignDoc, parent: DesignNode | null, page: Page, node: DesignNode): { x: number; y: number } {
  if (parent && "children" in parent && parent.children.length > 0) {
    const kids = parent.children;
    const bottom = Math.max(...kids.map((k) => k.y + k.h));
    const left = Math.min(...kids.map((k) => k.x));
    return { x: round1(left), y: round1(bottom + 16) };
  }
  if (parent) return { x: 0, y: 0 };
  const list = page.nodes;
  if (list.length === 0) return { x: 0, y: 0 };
  const right = Math.max(...list.map((n) => n.x + n.w));
  const top = Math.min(...list.map((n) => n.y));
  return { x: round1(right + 80), y: round1(top) };
}

function insertNode(doc: DesignDoc, parent: DesignNode | null, page: Page, node: DesignNode, explicitPos: boolean): void {
  if (!explicitPos) {
    const pos = autoPlace(doc, parent, page, node);
    node.x = pos.x;
    node.y = pos.y;
  }
  if (parent && "children" in parent) parent.children.push(node);
  else page.nodes.push(node);
}

/* ------------------------------------------------------------------ */
/* 摘要（read_doc 用）                                                  */
/* ------------------------------------------------------------------ */

function firstFillLabel(fills: Fill[]): string {
  const f = fills.find((x) => x.visible !== false);
  if (!f) return "(hidden)";
  if (f.type === "image") return `image(${(f.src ?? "").slice(0, 40)})`;
  if (f.type === "solid") return f.color ?? "#000000";
  const stops = (f.stops ?? []).map((s) => s.color).join("→");
  return `${f.type}(${stops})`;
}

function nodeSummary(n: DesignNode, depth: number, doc?: DesignDoc): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: n.id,
    type: n.type,
    name: n.name,
    x: round1(n.x),
    y: round1(n.y),
    w: round1(n.w),
    h: round1(n.h),
  };
  if (n.rotation) out.rotation = n.rotation;
  if (n.opacity !== undefined && n.opacity !== 1) out.opacity = n.opacity;
  if (n.visible === false) out.visible = false;
  if (n.locked === true) out.locked = true;
  if (n.mask) out.mask = true;
  if (n.radius !== undefined) out.radius = n.radius;
  if (n.onTap) out.onTap = n.onTap;
  if ("fills" in n && n.fills.length > 0) out.fill = firstFillLabel(n.fills);
  if ("strokes" in n && n.strokes && n.strokes.length > 0 && n.strokes[0]) {
    out.stroke = `${n.strokes[0].color}/${n.strokes[0].width}`;
  }
  if (n.type === "text") {
    const text = n.runs.map((r) => r.text).join("");
    out.text = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    out.fontSize = n.runs[0]?.size ?? 16;
  }
  if (n.type === "line" || n.type === "arrow") out.dir = n.dir ?? 0;
  if (n.type === "image") out.src = n.src;
  if (n.grow) out.grow = n.grow;
  if (n.blendMode) out.blendMode = n.blendMode;
  if (n.flipX) out.flipX = true;
  if (n.flipY) out.flipY = true;
  if (n.type === "frame" && n.layout) out.layout = n.layout;
  if (n.type === "vector") out.d = `${n.path.slice(0, 80)}${n.path.length > 80 ? "…" : ""}`;
  if (n.type === "icon") {
    out.icon = n.icon;
    out.color = n.color ?? "#111111";
    out.strokeWidth = n.strokeWidth ?? 2;
    if (!resolveIconName(n.icon)) out.invalidIcon = true;
  }
  if (n.type === "instance") {
    const inst = n as InstanceNode;
    out.componentId = inst.componentId;
    const comp = doc ? findComponent(doc, inst.componentId) : null;
    if (comp) out.component = comp.name;
    else out.missingComponent = true;
    const ovKeys = Object.keys(inst.overrides ?? {});
    if (ovKeys.length) out.overridden = ovKeys;
    // 内部结构以解析视图呈现，id 即可寻址（"实例id/内部id"）；update_nodes 直接改 → 存为覆盖
    const view = doc ? instanceView(doc, inst) : null;
    if (view) {
      out.childCount = view.length;
      if (depth > 0) out.children = view.map((c) => nodeSummary(c, depth - 1, doc));
      return out;
    }
    return out;
  }
  if ("children" in n && n.children.length > 0) {
    out.childCount = n.children.length;
    if (depth > 0) out.children = n.children.map((c) => nodeSummary(c, depth - 1, doc));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 工具实现                                                             */
/* ------------------------------------------------------------------ */

function opListDocs(args: Spec, ctx: ToolCtx): unknown {
  const dirArg = str(args.dir)?.trim();
  const root = dirArg ? path.resolve(ctx.workspace, dirArg) : ctx.workspace;
  const docs: Array<Record<string, unknown>> = [];
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
      if (!name.toLowerCase().endsWith(DOC_SUFFIX)) continue;
      const entry: Record<string, unknown> = { path: relPath(abs, ctx) };
      try {
        const { doc } = loadDoc(abs);
        const page = pickPage(doc);
        let nodes = 0;
        for (const _ of walkNodes(page.nodes)) nodes++;
        entry.name = doc.meta.name;
        entry.pages = doc.pages.length;
        entry.frames = page.nodes.filter((n) => n.type === "frame").length;
        entry.nodes = nodes;
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
  const abs = resolveDocPath(args.path, ctx);
  const { doc, warnings } = loadDoc(abs);
  if (args.raw === true) return { path: relPath(abs, ctx), warnings, doc };
  if (str(args.nodeId)) {
    const loc = findOrThrow(doc, str(args.nodeId)!);
    return { path: relPath(abs, ctx), warnings, node: JSON.parse(JSON.stringify(loc.node)) };
  }
  const page = pickPage(doc, args.page);
  const depth = num(args.depth) ?? 3;
  return {
    path: relPath(abs, ctx),
    name: doc.meta.name,
    activePage: doc.activePage,
    warnings,
    pages: doc.pages.map((p) => ({ id: p.id, name: p.name, active: p.id === doc.activePage })),
    page: { id: page.id, name: page.name },
    nodes: page.nodes.map((n) => nodeSummary(n, Math.max(0, Math.round(depth)), doc)),
    ...(doc.components?.length ? { components: doc.components.map((c) => ({ id: c.id, name: c.name })) } : {}),
  };
}

function opCreateDoc(args: Spec, ctx: ToolCtx): unknown {
  const abs = resolveDocPath(args.path, ctx);
  const overwrite = args.overwrite === true;
  if (!overwrite) {
    try {
      statSync(abs);
      throw new Error(`文件已存在：${relPath(abs, ctx)}（要覆盖请传 overwrite: true，或换 path）`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("文件已存在")) throw err;
    }
  }
  const name = str(args.name)?.trim() || path.basename(abs).replace(/\.uidesign\.json$/i, "");
  const doc = blankDoc(name);
  const page = doc.pages[0]!;
  const pageName = str(args.pageName)?.trim();
  if (pageName) page.name = pageName;
  const frames = Array.isArray(args.frames) ? (args.frames as Spec[]) : null;
  if (frames && frames.length > 0) {
    let cursorX = 0;
    for (const f of frames) {
      const node = buildNode({ ...f, type: "frame" }) as FrameNode;
      applyTypeFields(node, f);
      if (num(f.x) === undefined) node.x = cursorX;
      if (num(f.y) === undefined) node.y = 0;
      cursorX = node.x + node.w + Math.max(80, Math.round(node.w * 0.32));
      page.nodes.push(node);
    }
  } else {
    const presetKey = str(args.preset)?.trim() || "ios-390";
    const preset = DEVICE_PRESETS[presetKey];
    if (!preset) throw new Error(`未知设备预设 "${presetKey}"（可用：${Object.keys(DEVICE_PRESETS).join(" / ")}）`);
    page.nodes.push(newFrame({ name: "首页", w: preset.w, h: preset.h, x: 0, y: 0, preset: presetKey }));
  }
  writeFileSync(abs, serializeDoc(doc), "utf8");
  return {
    path: relPath(abs, ctx),
    pageId: page.id,
    frames: page.nodes.map((n) => ({ id: n.id, name: n.name, x: n.x, y: n.y, w: n.w, h: n.h })),
    hint: "面板未打开时，可调用 open_plugin_panel(plugin=\"ui-design\", panel=\"design\", path=…) 让用户看到它",
  };
}

function opAddNodes(args: Spec, ctx: ToolCtx): unknown {
  const abs = resolveDocPath(args.path, ctx);
  const { doc } = loadDoc(abs);
  const page = pickPage(doc, args.page);
  const parentId = str(args.parent)?.trim();
  let parent: DesignNode | null = null;
  if (parentId) {
    const loc = findOrThrow(doc, parentId);
    if (!("children" in loc.node)) throw new Error(`parent ${parentId}（${loc.node.type}）不是可容纳子节点的容器`);
    parent = loc.node;
  }
  const listRaw = Array.isArray(args.nodes) ? (args.nodes as Spec[]) : args.node !== undefined ? [args.node as Spec] : null;
  if (!listRaw || listRaw.length === 0) throw new Error("nodes 需要至少一个节点规格（数组）");
  if (listRaw.length > 80) throw new Error("单次最多添加 80 个节点，分批调用");
  const created: Array<Record<string, unknown>> = [];
  const reflowIds = new Set<string>();
  let reflowed = false;
  for (const spec of listRaw) {
    const node = buildNode(spec);
    if (findNode(doc, node.id)) throw new Error(`id 已存在：${node.id}（换一个或删掉 id 字段）`);
    if (node.type === "instance") {
      const comp = findComponent(doc, (node as InstanceNode).componentId);
      if (!comp) throw new Error(`组件不存在：${(node as InstanceNode).componentId}（list_components 查现有组件，或 create_component 从节点新建）`);
      // w/h 都没给 → 取主档包围盒（1:1 实例，agent 不必自己算）
      if (num(spec.w) === undefined && num(spec.h) === undefined) {
        const b = componentBounds(comp);
        node.w = Math.max(1, b.w);
        node.h = Math.max(1, b.h);
      }
    }
    applyTypeFields(node, spec);
    const explicit = num(spec.x) !== undefined && num(spec.y) !== undefined;
    insertNode(doc, parent, page, node, explicit);
    created.push({ id: node.id, type: node.type, name: node.name, x: node.x, y: node.y, w: node.w, h: node.h });
    reflowIds.add(node.id);
  }
  if (args.reflow !== false) {
    for (const c of created) {
      const rid = str(c.id)!;
      if (reflowWithin(page.nodes, rid)) reflowed = true;
    }
  }
  saveDoc(abs, doc);
  return { path: relPath(abs, ctx), pageId: page.id, created, reflowed };
}

/** 把 patch 里的通用/类型字段套到节点上（就地改）；idLabel 仅用于报错文案 */
function applyUpdateFields(node: DesignNode, patch: Spec, idLabel: string): void {
  if (patch.name !== undefined) {
    const v = str(patch.name);
    if (v === undefined) throw new Error(`${idLabel}: name 需为字符串`);
    node.name = v;
  }
  for (const key of ["x", "y", "w", "h", "rotation", "opacity"] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    const n = num(v);
    if (n === undefined) throw new Error(`${idLabel}: ${key} 需为数字`);
    node[key] = key === "opacity" ? Math.min(1, Math.max(0, n)) : n;
  }
  const dx = num(patch.dx);
  if (dx !== undefined) node.x = round1(node.x + dx);
  const dy = num(patch.dy);
  if (dy !== undefined) node.y = round1(node.y + dy);
  if (patch.visible !== undefined) {
    if (typeof patch.visible !== "boolean") throw new Error(`${idLabel}: visible 需为布尔`);
    node.visible = patch.visible;
  }
  if (patch.locked !== undefined) {
    if (typeof patch.locked !== "boolean") throw new Error(`${idLabel}: locked 需为布尔`);
    node.locked = patch.locked;
  }
  if (patch.radius !== undefined) node.radius = parseRadiusInput(patch.radius);
  if (patch.effects !== undefined) node.effects = patch.effects as Effect[];
  if (patch.onTap !== undefined) {
    const t = parseOnTapInput(patch.onTap);
    if (t) node.onTap = t;
    else delete node.onTap;
  }
  applyTypeFields(node, patch);
}

/** 就地把树中该 id 的实例节点换成 next（只搜页面树顶层实例，实例 id 全局唯一） */
function replaceInstanceInPages(doc: DesignDoc, instId: string, next: DesignNode): boolean {
  const walk = (list: DesignNode[]): boolean => {
    for (let i = 0; i < list.length; i++) {
      if (list[i]!.id === instId) {
        list[i] = next;
        return true;
      }
      const kids = (list[i] as { children?: DesignNode[] }).children;
      if (kids && walk(kids)) return true;
    }
    return false;
  };
  for (const p of doc.pages) if (walk(p.nodes)) return true;
  return false;
}

/** 实例内部寻址（"实例id/内部id…"）的更新：视图坐标补丁 → patchInstancePath 存覆盖表 */
function updateInstanceInternal(doc: DesignDoc, id: string, patch: Spec): void {
  const s = id.indexOf("/");
  const ownerId = id.slice(0, s);
  const ownerLoc = findOrThrow(doc, ownerId);
  if (ownerLoc.node.type !== "instance") throw new Error(`${ownerId} 不是实例，无法寻址其内部（正确形态："实例id/内部id"）`);
  const viewLoc = findOrThrow(doc, id); // 视图节点（已烘焙/重编号，可安全就地改作补丁收集）
  const target = { ...viewLoc.node } as DesignNode;
  applyUpdateFields(target, patch, id);
  const src = viewLoc.node as unknown as Record<string, unknown>;
  const dst = target as unknown as Record<string, unknown>;
  const obj: Record<string, unknown> = {};
  for (const k of Object.keys(dst)) {
    if (k === "id" || k === "type" || k === "children") continue;
    if (dst[k] !== src[k]) obj[k] = dst[k];
  }
  if (!Object.keys(obj).length) return;
  const next = patchInstancePath(doc, ownerLoc.node as InstanceNode, id.slice(s + 1).split("/").filter(Boolean), obj);
  if (!next) throw new Error(`${id}：内部路径解析失败（id 是否来自最新 read_doc？字段是否可覆盖？）`);
  if (!replaceInstanceInPages(doc, ownerId, next)) throw new Error(`实例 ${ownerId} 不在页面树中`);
}

function opUpdateNodes(args: Spec, ctx: ToolCtx): unknown {
  const abs = resolveDocPath(args.path, ctx);
  const { doc } = loadDoc(abs);
  const updates = Array.isArray(args.updates) ? (args.updates as Spec[]) : null;
  if (!updates || updates.length === 0) throw new Error("updates 需要至少一项：[{ id, ...要改的字段 }]");
  const applied: string[] = [];
  const reflowIds = new Set<string>();
  for (const patch of updates) {
    const id = str(patch.id)?.trim();
    if (!id) throw new Error("updates 里每一项都需要 id");
    if (id.includes("/")) {
      updateInstanceInternal(doc, id, patch);
      applied.push(id);
      continue;
    }
    const loc = findOrThrow(doc, id);
    applyUpdateFields(loc.node, patch, id);
    applied.push(id);
    if (LAYOUT_SENSITIVE.some((k) => patch[k] !== undefined)) reflowIds.add(id);
  }
  let reflowed = false;
  if (args.reflow !== false) {
    for (const pg of doc.pages) {
      for (const id of reflowIds) {
        if (reflowWithin(pg.nodes, id)) reflowed = true;
      }
    }
  }
  saveDoc(abs, doc);
  return { path: relPath(abs, ctx), updated: applied, reflowed };
}

function opDeleteNodes(args: Spec, ctx: ToolCtx): unknown {
  const abs = resolveDocPath(args.path, ctx);
  const { doc } = loadDoc(abs);
  const ids = Array.isArray(args.ids) ? args.ids.filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) throw new Error("ids 需要至少一个节点 id");
  const removed: string[] = [];
  const reflowIds = new Set<string>();
  for (const id of ids) {
    if (id.includes("/")) throw new Error(`实例内部节点不能删除（${id}）：拓扑由主档决定；要自由删改请先用 edit_component 的 detach`);
    const loc = findNode(doc, id);
    if (!loc) throw new Error(`节点不存在：${id}`);
    const parentId = loc.parent?.id ?? null;
    loc.siblings.splice(loc.index, 1);
    removed.push(id);
    if (parentId) reflowIds.add(parentId);
  }
  let reflowed = false;
  if (args.reflow !== false) {
    for (const pg of doc.pages) {
      for (const pid of reflowIds) {
        if (reflowWithin(pg.nodes, pid)) reflowed = true;
      }
    }
  }
  saveDoc(abs, doc);
  return { path: relPath(abs, ctx), removed, reflowed };
}

function opGroupNodes(args: Spec, ctx: ToolCtx): unknown {
  const abs = resolveDocPath(args.path, ctx);
  const { doc } = loadDoc(abs);
  const ids = Array.isArray(args.ids) ? args.ids.filter((x): x is string => typeof x === "string") : [];
  if (ids.length < 2) throw new Error("group 至少需要两个节点 id");
  const locs = ids.map((id) => findOrThrow(doc, id));
  const siblings = locs[0]!.siblings;
  if (!locs.every((l) => l.siblings === siblings)) {
    throw new Error("只能把同一容器（同层）里的节点成组");
  }
  const boxes = locs.map((l) =>
    aabbRotated({ x: l.node.x, y: l.node.y, w: l.node.w, h: l.node.h }, l.node.rotation ?? 0),
  );
  const box = unionBox(boxes);
  if (!box) throw new Error("无法计算成组包围盒");
  const insertAt = Math.min(...locs.map((l) => l.index));
  const group: GroupNode = {
    id: uid("g"),
    type: "group",
    name: str(args.name)?.trim() || "组",
    x: round1(box.x),
    y: round1(box.y),
    w: round1(box.w),
    h: round1(box.h),
    children: [],
  };
  const ordered = [...locs].sort((a, b) => a.index - b.index);
  for (const l of ordered) {
    siblings.splice(siblings.indexOf(l.node), 1);
    l.node.x = round1(l.node.x - group.x);
    l.node.y = round1(l.node.y - group.y);
    group.children.push(l.node);
  }
  siblings.splice(insertAt, 0, group);
  saveDoc(abs, doc);
  return { path: relPath(abs, ctx), groupId: group.id, children: group.children.map((c) => c.id) };
}

function opUngroupNodes(args: Spec, ctx: ToolCtx): unknown {
  const abs = resolveDocPath(args.path, ctx);
  const { doc } = loadDoc(abs);
  const ids = Array.isArray(args.ids) ? args.ids.filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) throw new Error("ids 需要至少一个组 id");
  const released: string[] = [];
  for (const id of ids) {
    const loc = findOrThrow(doc, id);
    if (loc.node.type !== "group") throw new Error(`不是组节点：${id}（${loc.node.type}）`);
    const g = loc.node;
    if (g.rotation) throw new Error(`组 ${id} 带旋转（${g.rotation}°），先把 rotation 设为 0 再拆组`);
    const opacity = g.opacity ?? 1;
    const kids = g.children.map((c) => {
      c.x = round1(c.x + g.x);
      c.y = round1(c.y + g.y);
      if (opacity !== 1) c.opacity = round1((c.opacity ?? 1) * opacity * 100) / 100;
      return c;
    });
    loc.siblings.splice(loc.index, 1, ...kids);
    released.push(...kids.map((k) => k.id));
  }
  saveDoc(abs, doc);
  return { path: relPath(abs, ctx), children: released };
}

const ALIGN_MODES: AlignMode[] = ["left", "hcenter", "right", "top", "vcenter", "bottom", "hdist", "vdist"];

function opAlignNodes(args: Spec, ctx: ToolCtx): unknown {
  const abs = resolveDocPath(args.path, ctx);
  const { doc } = loadDoc(abs);
  const ids = Array.isArray(args.ids) ? args.ids.filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) throw new Error("ids 需要至少一个节点 id");
  const mode = str(args.mode)?.trim() as AlignMode | undefined;
  if (!mode || !ALIGN_MODES.includes(mode)) {
    throw new Error(`mode 需为 ${ALIGN_MODES.join(" / ")}`);
  }
  let ref: Box | null = null;
  const refArg = str(args.ref)?.trim();
  if (refArg && refArg !== "selection") {
    const loc = findOrThrow(doc, refArg);
    ref = worldBoxOf(doc, loc.node.id);
    if (!ref) throw new Error(`参照节点无法计算包围盒：${refArg}`);
  }
  const moved = applyAlign(doc, ids, mode, ref);
  const unchanged = ids.filter((id) => !moved.includes(id));
  saveDoc(abs, doc);
  return { path: relPath(abs, ctx), moved, unchanged };
}

function opStackNodes(args: Spec, ctx: ToolCtx): unknown {
  const abs = resolveDocPath(args.path, ctx);
  const { doc } = loadDoc(abs);
  const ids = Array.isArray(args.ids) ? args.ids.filter((x): x is string => typeof x === "string") : [];
  if (ids.length < 2) throw new Error("stack 至少需要两个节点 id");
  const direction = str(args.direction)?.trim();
  if (direction !== "row" && direction !== "column") throw new Error("direction 需为 row（横排）| column（竖排）");
  const gap = num(args.gap) ?? 16;
  const cross = str(args.cross)?.trim() ?? "start";
  if (cross !== "start" && cross !== "center" && cross !== "end") {
    throw new Error("cross 需为 start|center|end（交叉轴对齐）");
  }
  const entries = ids.map((id) => {
    const loc = findOrThrow(doc, id);
    const wb = worldBoxOf(doc, id);
    if (!wb) throw new Error(`节点无法计算包围盒：${id}`);
    return { loc, wb, dx: 0, dy: 0 };
  });
  if (direction === "row") entries.sort((a, b) => a.wb.x - b.wb.x);
  else entries.sort((a, b) => a.wb.y - b.wb.y);
  const crossMinX = Math.min(...entries.map((e) => e.wb.x));
  const crossMaxX = Math.max(...entries.map((e) => e.wb.x + e.wb.w));
  const crossMinY = Math.min(...entries.map((e) => e.wb.y));
  const crossMaxY = Math.max(...entries.map((e) => e.wb.y + e.wb.h));
  let cursorX = entries[0]!.wb.x;
  let cursorY = entries[0]!.wb.y;
  for (const e of entries) {
    if (direction === "row") {
      e.dx = cursorX - e.wb.x;
      cursorX += e.wb.w + gap;
      if (cross === "start") e.dy = crossMinY - e.wb.y;
      else if (cross === "center") e.dy = (crossMinY + crossMaxY) / 2 - (e.wb.y + e.wb.h / 2);
      else e.dy = crossMaxY - (e.wb.y + e.wb.h);
    } else {
      e.dy = cursorY - e.wb.y;
      cursorY += e.wb.h + gap;
      if (cross === "start") e.dx = crossMinX - e.wb.x;
      else if (cross === "center") e.dx = (crossMinX + crossMaxX) / 2 - (e.wb.x + e.wb.w / 2);
      else e.dx = crossMaxX - (e.wb.x + e.wb.w);
    }
  }
  for (const e of entries) {
    e.loc.node.x = round1(e.loc.node.x + e.dx);
    e.loc.node.y = round1(e.loc.node.y + e.dy);
  }
  saveDoc(abs, doc);
  return { path: relPath(abs, ctx), order: entries.map((e) => e.loc.node.id) };
}

const REORDER_MODES = ["front", "back", "forward", "backward"] as const;

function opReorderNodes(args: Spec, ctx: ToolCtx): unknown {
  const abs = resolveDocPath(args.path, ctx);
  const { doc } = loadDoc(abs);
  const ids = Array.isArray(args.ids) ? args.ids.filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) throw new Error("ids 需要至少一个节点 id");
  const mode = str(args.mode)?.trim() as (typeof REORDER_MODES)[number] | undefined;
  if (!mode || !REORDER_MODES.includes(mode)) throw new Error(`mode 需为 ${REORDER_MODES.join(" / ")}`);
  for (const id of ids) {
    const loc = findOrThrow(doc, id);
    const { siblings, index } = loc;
    const [node] = siblings.splice(index, 1);
    if (!node) continue;
    const target =
      mode === "front" ? siblings.length
      : mode === "back" ? 0
      : mode === "forward" ? Math.min(siblings.length, index + 1)
      : Math.max(0, index - 1);
    siblings.splice(target, 0, node);
  }
  saveDoc(abs, doc);
  return { path: relPath(abs, ctx), reordered: ids, mode };
}

function opEditPages(args: Spec, ctx: ToolCtx): unknown {
  const abs = resolveDocPath(args.path, ctx);
  const { doc } = loadDoc(abs);
  const action = str(args.action)?.trim();
  if (action === "add") {
    const name = str(args.name)?.trim() || `页面 ${doc.pages.length + 1}`;
    const page: Page = { id: uid("p"), name, nodes: [] };
    doc.pages.push(page);
    saveDoc(abs, doc);
    return { path: relPath(abs, ctx), added: { id: page.id, name: page.name } };
  }
  if (action === "rename" || action === "activate" || action === "remove") {
    const page = pickPage(doc, args.pageId ?? args.page);
    if (action === "rename") {
      const name = str(args.name)?.trim();
      if (!name) throw new Error("rename 需要 name");
      page.name = name;
    } else if (action === "activate") {
      doc.activePage = page.id;
    } else {
      if (doc.pages.length <= 1) throw new Error("最后一页不能删除");
      doc.pages = doc.pages.filter((p) => p.id !== page.id);
      if (doc.activePage === page.id) doc.activePage = doc.pages[0]!.id;
    }
    saveDoc(abs, doc);
    return { path: relPath(abs, ctx), pageId: page.id, pages: doc.pages.map((p) => ({ id: p.id, name: p.name, active: p.id === doc.activePage })) };
  }
  throw new Error('action 需为 add|rename|remove|activate');
}

/* ------------------------------------------------------------------ */
/* 工具表（server.ts 的 tools/list 与 dispatch 共用）                    */
/* ------------------------------------------------------------------ */

const NODE_SPEC_SCHEMA: {
  type: "object";
  description: string;
  properties: Record<string, unknown>;
  required: string[];
} = {
  type: "object",
  description:
    "节点规格。type 必填；x/y/w/h 省略时自动落位/取默认尺寸（画板 390×844、矩形 120×80、文本 240×24…）。" +
    "风格两式皆可：shorthand（fill:'#0d99ff'、stroke:{color,width}、text:'按钮' + size/color/weight）或原样数组（fills/strokes/runs）。",
  properties: {
    type: { type: "string", enum: NODE_TYPES.filter((t) => t !== "group") },
    id: { type: "string", description: "可选：显式指定 id（全局唯一）" },
    name: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    w: { type: "number" },
    h: { type: "number" },
    rotation: { type: "number", description: "度，绕盒中心" },
    opacity: { type: "number", description: "0..1" },
    visible: { type: "boolean" },
    locked: { type: "boolean" },
    radius: { description: "数字或 [左上,右上,右下,左下]" },
    onTap: { description: '原型交互：{ "to": "顶层画板id" } 单击跳转（跨页可）；null = 清除' },
    fill: { type: "string", description: "纯色简写：#rgb/#rrggbb/#rrggbbaa" },
    fills: { type: "array", description: "Fill[]（solid/linear/radial，见 SKILL.md）" },
    stroke: { description: "描边简写：颜色字符串或 { color, width, align, style }" },
    strokes: { type: "array" },
    effects: { type: "array", description: "Effect[]（drop-shadow/inner-shadow/layer-blur）" },
    text: { type: "string", description: "text 节点简写：单 run 文本" },
    runs: { type: "array", description: "text 节点：TextRun[] 混排" },
    size: { type: "number", description: "text 简写字号（配 text 用）" },
    color: { type: "string", description: "text 简写颜色（配 text 用）" },
    weight: { type: "number", description: "text 简写字重（配 text 用）" },
    align: { type: "string", enum: ["left", "center", "right"] },
    vAlign: { type: "string", enum: ["top", "middle", "bottom"] },
    lineHeight: { type: "number" },
    letterSpacing: { type: "number" },
    dir: { type: "number", enum: [0, 1, 2, 3], description: "line/arrow 走向：0=↘ 1=↗ 2=↖ 3=↙" },
    src: { type: "string", description: "image：workspace 相对路径" },
    fit: { type: "string", enum: ["cover", "contain", "stretch"] },
    preset: { type: "string", description: "frame：设备预设键（ios-390 / android-360 / desktop-1440…）" },
    clip: { type: "boolean", description: "frame：是否裁切超框内容（缺省 true）" },
    componentId: { type: "string", description: "instance：主档组件 id（list_components 可查）；w/h 省略时取主档包围盒" },
    overrides: { description: 'instance：内部节点覆盖表 { "内部id": { 字段: 值 } }（如 { "t1": { "text": "提交" } }）' },
  },
  required: ["type"],
};

/** 解析目标顶层节点 id：给了 ids 用之，否则当前页全部可见顶层节点 */
function targetTopLevelIds(page: Page, raw: unknown): string[] {
  const wanted = Array.isArray(raw) ? raw.map(str).filter((s): s is string => !!s) : [];
  return wanted.length > 0 ? wanted : page.nodes.filter((n) => n.visible !== false).map((n) => n.id);
}

/** 子树里 icon 名无效的节点数（截图文本反馈给 agent，促其用 list_icons 修正） */
function countUnknownIcons(nodes: DesignNode[]): number {
  let n = 0;
  const walk = (list: DesignNode[]): void => {
    for (const nd of list) {
      if (nd.type === "icon" && !resolveIconName(nd.icon)) n++;
      if (nd.type === "frame" || nd.type === "group") walk(nd.children);
    }
  };
  walk(nodes);
  return n;
}

/** boolean_nodes：布尔运算（union/subtract/intersect/exclude）→ 烤平为 vector 节点 */
function opBooleanNodes(args: Spec, ctx: ToolCtx): unknown {
  const abs = resolveDocPath(args.path, ctx);
  const { doc } = loadDoc(abs);
  const page = pickPage(doc, args.page);
  const ids = Array.isArray(args.ids) ? (args.ids as unknown[]).map(str).filter((x): x is string => !!x) : [];
  if (ids.length < 2) throw new Error("布尔运算需要至少 2 个节点 id（同容器同层）");
  const op = normalizeBoolOp(args.operation ?? args.op ?? "union");
  if (!op) throw new Error(`operation 需为 union/subtract/intersect/exclude（收到 "${String(args.operation)}"）`);

  const locs = ids.map((id) => findOrThrow(doc, id));
  if (locs.some((l) => l.siblings !== locs[0]!.siblings)) {
    throw new Error("只能对同一容器（同层）里的形状做布尔运算");
  }
  for (const l of locs) {
    if (!isBoolShape(l.node)) {
      throw new Error(`节点 ${l.node.id}（${l.node.type}）不支持布尔运算：支持 rect/ellipse/triangle/diamond/pentagon/hexagon/star/vector`);
    }
  }
  const first = locs[0]!.node as DesignNode & { fills?: unknown; strokes?: unknown };
  const { d, bbox } = booleanPath(op, locs.map((l) => l.node));
  if (!d) throw new Error("布尔结果为空（形状被完全减没/无交集），未创建节点");

  const vector = {
    id: uid("v"),
    type: "vector" as const,
    name: str(args.name)?.trim() || ({ union: "并集", subtract: "减去", intersect: "交集", exclude: "排除" } as Record<string, string>)[op]!,
    x: bbox.x,
    y: bbox.y,
    w: bbox.w,
    h: bbox.h,
    path: d,
    fills: JSON.parse(JSON.stringify((first as { fills?: unknown }).fills ?? [{ type: "solid", color: "#d9d9d9" }])),
    strokes: JSON.parse(JSON.stringify((first as { strokes?: unknown }).strokes ?? [])),
  };

  // 在最底层节点位置插入结果，移除原节点
  const insertAt = Math.min(...locs.map((l) => l.index));
  for (const l of locs) l.siblings.splice(l.siblings.indexOf(l.node), 1);
  locs[0]!.siblings.splice(insertAt, 0, vector);
  saveDoc(abs, doc);
  return { path: relPath(abs, ctx), operation: op, id: vector.id, x: vector.x, y: vector.y, w: vector.w, h: vector.h, replaced: ids };
}

/** apply_layout：手动触发重排（改了 x/y/加删节点后想让布局画板重新接管时用） */
function opApplyLayout(args: Spec, ctx: ToolCtx): unknown {
  const abs = resolveDocPath(args.path, ctx);
  const { doc } = loadDoc(abs);
  const page = pickPage(doc, args.page);
  const targetId = str(args.id)?.trim();
  const reflowedFrames: string[] = [];
  let changed = false;
  const targets: string[] = targetId ? [targetId] : page.nodes.flatMap((n) => (n.type === "frame" && n.layout ? [n.id] : []));
  if (targetId) {
    const loc = findOrThrow(doc, targetId);
    if (loc.node.type !== "frame") throw new Error(`id ${targetId}（${loc.node.type}）不是画板（frame）`);
  }
  for (const tid of targets) {
    if (reflowWithin(page.nodes, tid)) changed = true;
    const f = page.nodes.find((n) => n.id === tid);
    if (f) reflowedFrames.push(tid);
  }
  if (changed) saveDoc(abs, doc);
  return { path: relPath(abs, ctx), reflowed: reflowedFrames, changed };
}

/** list_icons：搜索内置 lucide 图标名（icon 节点的 icon 字段取值） */
function opListIcons(args: Spec): unknown {
  const q = str(args.query)?.trim() ?? "";
  const limit = Math.min(Math.max(num(args.limit) ?? 40, 1), 100);
  const icons = searchIcons(q, limit);
  return { query: q, count: icons.length, icons };
}

/** 底色解析：缺省 def；transparent/none → null（透明），其余原样（#rgb/#rrggbb…） */
function bgOf(raw: unknown, def: string | null): string | null {
  const t = str(raw)?.trim().toLowerCase();
  if (!t) return def;
  if (t === "transparent" || t === "none") return null;
  return t;
}

function parseFormats(raw: unknown): ExportFormat[] | undefined {
  const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : undefined;
  if (!arr) return undefined;
  const set = new Set<ExportFormat>();
  for (const v of arr) {
    const s = str(v)?.trim().toLowerCase();
    if (s === "png" || s === "svg" || s === "html" || s === "source" || s === "code") set.add(s);
  }
  return set.size ? [...set] : undefined;
}

/**
 * 截图：画布内容 → PNG 图像块。SVG 构建与面板导出同一份（ui/src/svg.ts），
 * 光栅化走 resvg-js（bun 侧），文本折行为近似测量——观感与面板所见基本一致。
 * 返回 { mcpContent } 包装，server.ts 原样透进 result.content（image 块经宿主
 * 2MiB/白名单闸门后作为模型可见图片上屏）。给了 saveTo 则顺带落盘一份 PNG 并回报路径。
 */
function opScreenshotDoc(args: Spec, ctx: ToolCtx): unknown {
  const abs = resolveDocPath(args.path, ctx);
  const { doc } = loadDoc(abs);
  const page = pickPage(doc, args.page);
  const ids = targetTopLevelIds(page, args.ids);
  const maxDim = Math.min(Math.max(num(args.maxDim) ?? 1600, 320), 4096);
  const scale = Math.min(Math.max(num(args.scale) ?? 2, 0.5), 4);
  const r = renderDocPng(ctx.workspace, doc, ids, {
    maxDim,
    scale,
    background: bgOf(args.background, "#ffffff"),
  });
  if (!r) throw new Error(`页面「${page.name}」没有可见的顶层节点可截图（hidden 节点会被跳过）`);
  const parts = [
    `画布截图：页面「${page.name}」${ids.length} 个顶层节点，设计盒 ${r.boxW}×${r.boxH}，` +
      `输出 PNG ${r.width}×${r.height}（${Math.max(1, Math.round(r.png.byteLength / 1024))}KB）`,
  ];
  if (r.missingImages > 0) parts.push(`${r.missingImages} 张位图资产读不到，已画占位`);
  const badIcons = countUnknownIcons(
    ids.map((id) => findNode(doc, id)?.node).filter((n): n is DesignNode => !!n && n.visible !== false),
  );
  if (badIcons > 0) parts.push(`${badIcons} 个 icon 节点的图标名无效（画的是占位，用 list_icons 查正确名字后 update_nodes 改 icon 字段）`);
  const save = str(args.saveTo)?.trim();
  if (save) parts.push(`已保存到 ${saveToWorkspace(ctx.workspace, save, Buffer.from(r.png))}`);
  return {
    mcpContent: [
      { type: "text" as const, text: parts.join("；") },
      { type: "image" as const, data: Buffer.from(r.png).toString("base64"), mimeType: "image/png" },
    ],
  };
}

/**
 * 导出工程包：把画布落盘成多文件目录（源档副本 + 逐画板 PNG/SVG + 外链 assets/ +
 * index.html 原型 + manifest.json），返回全部静态文件的工作区相对路径清单。
 * 与面板「导出工程包」共用 ui/src/bundle.ts 装配器，产物结构一致。
 */
function opExportDoc(args: Spec, ctx: ToolCtx): unknown {
  const abs = resolveDocPath(args.path, ctx);
  const { doc } = loadDoc(abs);
  const page = pickPage(doc, args.page);
  const ids = targetTopLevelIds(page, args.ids);
  const maxDim = Math.min(Math.max(num(args.maxDim) ?? 4096, 320), 16384);
  const scale = Math.min(Math.max(num(args.scale) ?? 2, 0.5), 8);
  const summary = exportBundle(ctx.workspace, abs, doc, page, ids, {
    dir: str(args.dir)?.trim() || undefined,
    formats: parseFormats(args.format),
    maxDim,
    scale,
    background: bgOf(args.background, null),
  });
  return {
    ...summary,
    hint: `已导出到目录「${summary.dir}/」，共 ${summary.files.length} 个文件；index.html 可直接用浏览器打开体验原型。`,
  };
}

/* ------------------------------------------------------------------ */
/* 组件与实例（主档资产表 / instance 节点）                                */
/* ------------------------------------------------------------------ */

/** 子树 id 重发（分离实例用；烘焙产物带 "实例id/…" 前缀，进树前必须换新 id） */
function reidNode(n: DesignNode): DesignNode {
  const c = { ...n, id: uid(n.type[0]!) } as DesignNode;
  if ("children" in c) c.children = c.children.map(reidNode);
  return c;
}

/** 全档实例计数（页面树 + 各主档内部）；给 compId 只数该组件的实例 */
function countInstances(doc: DesignDoc, compId?: string): number {
  let n = 0;
  const walk = (list: DesignNode[]): void => {
    for (const x of list) {
      if (x.type === "instance" && (!compId || (x as InstanceNode).componentId === compId)) n++;
      if ("children" in x) walk(x.children);
    }
  };
  for (const p of doc.pages) walk(p.nodes);
  for (const c of doc.components ?? []) walk(c.nodes);
  return n;
}

/** 在主档树里按原始 id 找节点（带兄弟定位；覆盖寻址与主档编辑共用） */
function findInMaster(list: DesignNode[], id: string): { node: DesignNode; siblings: DesignNode[]; index: number } | null {
  for (let i = 0; i < list.length; i++) {
    const n = list[i]!;
    if (n.id === id) return { node: n, siblings: list, index: i };
    if ("children" in n) {
      const hit = findInMaster(n.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

function opListComponents(args: Spec, ctx: ToolCtx): unknown {
  const abs = resolveDocPath(args.path, ctx);
  const { doc } = loadDoc(abs);
  return {
    path: relPath(abs, ctx),
    components: (doc.components ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      nodeCount: c.nodes.length,
      masterNodeIds: c.nodes.map((n) => n.id),
      bounds: componentBounds(c),
      instances: countInstances(doc, c.id),
    })),
    hint: (doc.components?.length ?? 0) === 0 ? "本档还没有组件：create_component 可把现有节点转成组件（原位变实例）" : undefined,
  };
}

/** create_component：把 1+ 个同容器节点转成主档组件，原位替换为一个 1:1 实例 */
function opCreateComponent(args: Spec, ctx: ToolCtx): unknown {
  const abs = resolveDocPath(args.path, ctx);
  const { doc } = loadDoc(abs);
  const ids = Array.isArray(args.ids) ? args.ids.map(str).filter((x): x is string => !!x) : [];
  if (!ids.length) throw new Error("ids 需要至少一个节点 id（放进组件的节点）");
  if (ids.some((id) => id.includes("/"))) throw new Error("不能取实例内部节点创建组件（先 detach）");
  const locs = ids.map((id) => findOrThrow(doc, id));
  if (!locs.every((l) => l.siblings === locs[0]!.siblings)) throw new Error("多节点创建组件时必须在同一容器同层");
  const name = str(args.name)?.trim() || locs[0]!.node.name || "组件";
  const master = locs.map((l) => structuredClone(l.node)); // 保留原 id：实例覆盖/主档编辑都按它寻址
  const b = unionBox(master.map((m) => ({ x: m.x, y: m.y, w: m.w, h: m.h })));
  if (!b) throw new Error("无法计算组件包围盒");
  const comp: ComponentDef = { id: uid("c"), name, nodes: master };
  const inst: InstanceNode = {
    id: str(args.instanceId)?.trim() || uid("i"),
    type: "instance",
    name,
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
    componentId: comp.id,
  };
  const insertAt = Math.min(...locs.map((l) => l.index));
  for (const l of locs) l.siblings.splice(l.siblings.indexOf(l.node), 1);
  locs[0]!.siblings.splice(insertAt, 0, inst);
  doc.components = [...(doc.components ?? []), comp];
  saveDoc(abs, doc);
  return {
    path: relPath(abs, ctx),
    componentId: comp.id,
    instanceId: inst.id,
    name,
    bounds: b,
    masterNodeIds: master.map((m) => m.id),
    hint: `改实例内部：update_nodes id="${inst.id}/<内部id>"（字段是显示坐标/视图口径，自动存为覆盖）；改主档：edit_component action=patch_master；再插一个实例：edit_component action=insert`,
  };
}

/** edit_component：insert / detach / reset_overrides / patch_master / rename / remove */
function opEditComponent(args: Spec, ctx: ToolCtx): unknown {
  const abs = resolveDocPath(args.path, ctx);
  const { doc } = loadDoc(abs);
  const action = str(args.action)?.trim();

  if (action === "insert") {
    const compId = str(args.componentId)?.trim();
    if (!compId) throw new Error("insert 需要 componentId");
    const comp = findComponent(doc, compId);
    if (!comp) throw new Error(`组件不存在：${compId}（list_components 查 id）`);
    const page = pickPage(doc, args.page);
    const b = componentBounds(comp);
    const inst: InstanceNode = {
      id: str(args.instanceId)?.trim() || uid("i"),
      type: "instance",
      name: comp.name,
      x: 0,
      y: 0,
      w: Math.max(1, b.w),
      h: Math.max(1, b.h),
      componentId: comp.id,
    };
    const hasPos = num(args.x) !== undefined && num(args.y) !== undefined;
    if (hasPos) {
      inst.x = num(args.x)!;
      inst.y = num(args.y)!;
    } else {
      const pos = autoPlace(doc, null, page, inst);
      inst.x = pos.x;
      inst.y = pos.y;
    }
    page.nodes.push(inst as DesignNode);
    saveDoc(abs, doc);
    return { path: relPath(abs, ctx), inserted: { id: inst.id, name: inst.name, x: inst.x, y: inst.y, w: inst.w, h: inst.h }, pageId: page.id };
  }

  if (action === "detach") {
    const id = str(args.nodeId)?.trim();
    if (!id || id.includes("/")) throw new Error("detach 需要顶层实例的 nodeId（不含 / 内部路径）");
    const loc = findOrThrow(doc, id);
    if (loc.node.type !== "instance") throw new Error(`不是实例：${id}（${loc.node.type}）`);
    const baked = bakeInstanceNodes(doc, loc.node as InstanceNode);
    if (!baked || !baked.length) throw new Error(`实例 ${id} 的主档缺失，无法分离`);
    const flat = baked.map(reidNode);
    loc.siblings.splice(loc.index, 1, ...flat);
    saveDoc(abs, doc);
    return { path: relPath(abs, ctx), detached: id, nodeIds: flat.map((n) => n.id) };
  }

  if (action === "reset_overrides") {
    const id = str(args.nodeId)?.trim();
    if (!id || id.includes("/")) throw new Error("reset_overrides 需要顶层实例的 nodeId");
    const loc = findOrThrow(doc, id);
    if (loc.node.type !== "instance") throw new Error(`不是实例：${id}（${loc.node.type}）`);
    delete (loc.node as InstanceNode).overrides;
    saveDoc(abs, doc);
    return { path: relPath(abs, ctx), reset: id };
  }

  if (action === "patch_master") {
    const compId = str(args.componentId)?.trim();
    const nodeId = str(args.nodeId)?.trim();
    if (!compId || !nodeId) throw new Error("patch_master 需要 componentId 与 nodeId（主档内节点 id）");
    const comp = findComponent(doc, compId);
    if (!comp) throw new Error(`组件不存在：${compId}`);
    const hit = findInMaster(comp.nodes, nodeId);
    if (!hit) throw new Error(`主档 ${compId} 里没有节点 ${nodeId}（read_doc 的 masterNodeIds 或 list_components 查）`);
    applyUpdateFields(hit.node, args, `${compId}/${nodeId}`);
    saveDoc(abs, doc);
    return { path: relPath(abs, ctx), patchedMaster: nodeId, componentId: compId, instancesAffected: countInstances(doc, compId) };
  }

  if (action === "rename") {
    const compId = str(args.componentId)?.trim();
    const name = str(args.name)?.trim();
    if (!compId || !name) throw new Error("rename 需要 componentId 与 name");
    const comp = findComponent(doc, compId);
    if (!comp) throw new Error(`组件不存在：${compId}`);
    comp.name = name.slice(0, 120);
    saveDoc(abs, doc);
    return { path: relPath(abs, ctx), componentId: compId, name: comp.name };
  }

  if (action === "remove") {
    const compId = str(args.componentId)?.trim();
    if (!compId) throw new Error("remove 需要 componentId");
    const comp = findComponent(doc, compId);
    if (!comp) throw new Error(`组件不存在：${compId}`);
    let refs = 0;
    if (args.detach === true) {
      // 先把引用该组件的实例全部烘焙成静态子树，再删主档（不留占位）
      const bakeList = (list: DesignNode[]): void => {
        for (let i = 0; i < list.length; i++) {
          const n = list[i]!;
          if (n.type === "instance" && (n as InstanceNode).componentId === compId) {
            const baked = bakeInstanceNodes(doc, n as InstanceNode);
            if (baked) {
              list.splice(i, 1, ...baked.map(reidNode));
              refs++;
              i += baked.length - 1;
              continue;
            }
          }
          if ("children" in n) bakeList(n.children);
        }
      };
      for (const p of doc.pages) bakeList(p.nodes);
    } else {
      refs = countInstances(doc, compId);
    }
    doc.components = (doc.components ?? []).filter((c) => c.id !== compId);
    saveDoc(abs, doc);
    return {
      path: relPath(abs, ctx),
      removed: compId,
      instances: refs,
      note: args.detach === true ? "引用实例已烘焙为普通图层" : refs > 0 ? `${refs} 个引用实例将显示为「组件缺失」占位（要保留内容请带 detach:true 重做）` : undefined,
    };
  }

  throw new Error("action 需为 insert|detach|reset_overrides|patch_master|rename|remove");
}

/** import_doc：把另一份设计档并入目标档（页可选子集；id 全量重发 + 实例/覆盖引用重映射，与面板「导入设计档」同一实现 ui/src/merge.ts） */
function opImportDoc(args: Spec, ctx: ToolCtx): unknown {
  const abs = resolveDocPath(args.path, ctx);
  const fromAbs = resolveDocPath(args.from, ctx);
  if (path.resolve(abs) === path.resolve(fromAbs)) throw new Error("导入源与目标不能是同一份文件");
  const { doc: target } = loadDoc(abs);
  const { doc: incoming } = loadDoc(fromAbs);
  const pageNames = Array.isArray(args.pageNames) ? args.pageNames.map(str).filter((x): x is string => !!x) : undefined;
  const merged = mergeImportedDoc(target, incoming, pageNames?.length ? { pageNames } : undefined);
  saveDoc(abs, merged.doc);
  return {
    path: relPath(abs, ctx),
    from: relPath(fromAbs, ctx),
    importedPages: merged.pages,
    importedComponents: merged.components,
    importedNodes: merged.nodes,
    warnings: merged.warnings,
    hint: "新页追加在末尾、activePage 未切换；面板半秒内自动刷新。用户侧这是一步可撤销的外部写（⌘Z 可回退本次导入）",
  };
}

const PATH_SCHEMA = { type: "string", description: `设计档路径（*.uidesign.json；绝对或相对工作区）` };

/** edit_variables：共享颜色变量 list / set（新建或更新，改值全稿联动）/ delete（可选 detach 烘焙） */
function opEditVariables(args: Spec, ctx: ToolCtx): unknown {
  const abs = resolveDocPath(args.path, ctx);
  const { doc } = loadDoc(abs);
  const action = str(args.action) ?? "list";
  if (action === "list") {
    const usage = collectVarRefs(doc);
    const variables = (doc.variables ?? []).map((v) => ({ ...v, usage: usage.get(v.id) ?? 0 }));
    const dangling = [...usage.keys()].filter((id) => !(doc.variables ?? []).some((v) => v.id === id));
    return {
      path: relPath(abs, ctx),
      variables,
      ...(dangling.length ? { danglingRefs: dangling.map((id) => `var:${id}`), note: "这些引用没有对应变量（画布显示警示粉）；重新 set 同 id 可接回，或删引用改回普通色值" } : {}),
      hint: "绑定方式：update_nodes 把颜色字段写成 \"var:<变量id>\"；set 改 value 即全稿换色",
    };
  }
  if (action === "set") {
    const name = (str(args.name) ?? "").trim();
    const value = str(args.value);
    const id = str(args.id);
    const vars = [...(doc.variables ?? [])];
    if (id) {
      const hit = vars.find((v) => v.id === id);
      if (!hit) throw new Error(`变量不存在：${id}（edit_variables action:list 查现有 id）`);
      if (value !== undefined) hit.value = value;
      if (name) hit.name = name.slice(0, 60);
      if (args.desc !== undefined) {
        const d = str(args.desc);
        if (d) hit.desc = d.slice(0, 200);
        else delete hit.desc;
      }
      saveDoc(abs, doc);
      return { path: relPath(abs, ctx), variable: hit, usage: collectVarRefs(doc).get(hit.id) ?? 0, note: "值改动实时联动全部绑定处（画布半秒内刷新）" };
    }
    if (!name) throw new Error("新建变量需要 name（或给 id 更新现有变量）");
    const taken = new Set(vars.map((v) => v.name));
    if (taken.has(name)) throw new Error(`变量名已存在：${name}（list 查重名变量的 id 后用 id 更新，或换个名字）`);
    const desc = str(args.desc);
    const def: { id: string; name: string; value: string; desc?: string } = {
      id: uid("v"),
      name: name.slice(0, 60),
      value: value ?? "#0d99ff",
      ...(desc ? { desc: desc.slice(0, 200) } : {}),
    };
    vars.push(def);
    saveDoc(abs, { ...doc, variables: vars });
    return { path: relPath(abs, ctx), variable: def, note: `绑定：颜色字段写 "var:${def.id}"` };
  }
  if (action === "delete") {
    const id = str(args.id);
    if (!id) throw new Error("delete 需要变量 id（edit_variables action:list 查）");
    const vars = doc.variables ?? [];
    const hit = vars.find((v) => v.id === id);
    if (!hit) throw new Error(`变量不存在：${id}`);
    const usage = collectVarRefs(doc).get(id) ?? 0;
    let note: string;
    if (args.detach === true && usage > 0) {
      const map = new Map([[id, hit.value]]);
      for (const p of doc.pages) remapVarColors(p.nodes, map);
      for (const c of doc.components ?? []) remapVarColors(c.nodes, map);
      note = `已把 ${usage} 处引用烘焙为色值 ${hit.value} 后删除变量`;
    } else {
      note = usage > 0 ? `${usage} 处引用将显示为警示粉（要保色值先 detach:true）` : "该变量没有被引用";
    }
    saveDoc(abs, { ...doc, variables: vars.filter((v) => v.id !== id) });
    return { path: relPath(abs, ctx), removed: id, usage, note };
  }
  throw new Error("action 需为 list|set|delete");
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "list_docs",
    description:
      "列出工作区里的 UI 设计档（*.uidesign.json，根目录 + 两层子目录，最多 60 份），带画板/节点计数与损坏标记。找不到目标文档时先用它。",
    inputSchema: {
      type: "object",
      properties: { dir: { type: "string", description: "可选：限定子目录（相对工作区）" } },
    },
    run: opListDocs,
  },
  {
    name: "read_doc",
    description:
      "读设计档：默认返回当前页的图层树摘要（id/类型/名字/盒/填充/文字…，depth 控制展开层数）；给 nodeId 返回该节点完整 JSON；raw:true 返回整档。编辑前先读，拿最新 id。实例节点会展开其解析视图，children 的 id 形如 \"实例id/内部id\" 可直接用于 update_nodes 改覆盖。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        page: { type: "string", description: "页面 id 或名称（缺省当前活跃页）" },
        nodeId: { type: "string", description: "只看某个节点（含子树完整 JSON）" },
        depth: { type: "number", description: "子节点展开层数，缺省 3" },
        raw: { type: "boolean", description: "true = 返回整档原始 JSON" },
      },
      required: ["path"],
    },
    run: opReadDoc,
  },
  {
    name: "create_doc",
    description:
      "新建一份 *.uidesign.json：默认按设备预设（缺省 ios-390）建一块「首页」画板；也可给 frames 一次建多块（x 省略时自动横排、间距按画板宽 32%）。已存在同名文件会报错（除非 overwrite:true）。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        name: { type: "string", description: "文档名（缺省取文件名）" },
        preset: { type: "string", description: "设备预设键：ios-375/ios-390/android-360/tablet-768/desktop-1440/watch-168" },
        pageName: { type: "string" },
        frames: { type: "array", description: "画板列表 [{ name?, preset?, w?, h?, x?, y?, fill? }]", items: NODE_SPEC_SCHEMA },
        overwrite: { type: "boolean", description: "true = 覆盖已存在的文件" },
      },
      required: ["path"],
    },
    run: opCreateDoc,
  },
  {
    name: "add_nodes",
    description:
      "往设计档加节点（一次最多 80 个，原子落盘）。parent 给画板/组 id 则坐标是**画板内局部坐标**（相对画板左上角）；省略 parent 则加在页面顶层。x/y 都省略时自动落位（容器内叠在最后一个子节点下方 +16，页面级排在现有节点右侧 +80）。风格字段见 node 规格。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        page: { type: "string", description: "页面 id 或名称（缺省活跃页）" },
        parent: { type: "string", description: "父容器节点 id（frame/group）；省略=页面顶层" },
        nodes: { type: "array", items: NODE_SPEC_SCHEMA, description: "节点规格数组" },
        node: NODE_SPEC_SCHEMA,
      },
      required: ["path"],
    },
    run: opAddNodes,
  },
  {
    name: "update_nodes",
    description:
      "按 id 批量改节点（原子）：x/y 是绝对局部坐标，dx/dy 是相对位移；可改 name/w/h/rotation/opacity/visible/locked/radius/effects/onTap 与类型字段（fill/fills/stroke/strokes/text/runs/align/vAlign/lineHeight/letterSpacing/dir/src/fit/clip）。" +
      "id 也支持实例内部寻址 \"实例id/内部id[/更深…]\"（read_doc 会展开实例并给出这些 id）：字段用**显示坐标**，改动自动存为该实例的覆盖，不影响其他实例。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        updates: {
          type: "array",
          description: "更新项数组 [{ id, ...要改的字段 }]",
          items: { type: "object", properties: { id: { type: "string" }, ...NODE_SPEC_SCHEMA.properties }, required: ["id"] },
        },
      },
      required: ["path", "updates"],
    },
    run: opUpdateNodes,
  },
  {
    name: "delete_nodes",
    description: "按 id 删除节点（含子树）。",
    inputSchema: {
      type: "object",
      properties: { path: PATH_SCHEMA, ids: { type: "array", items: { type: "string" } } },
      required: ["path", "ids"],
    },
    run: opDeleteNodes,
  },
  {
    name: "group_nodes",
    description: "把同层（同一容器）的多个节点打成组；子节点坐标自动换算为组内局部坐标，组盒由子节点并集派生。",
    inputSchema: {
      type: "object",
      properties: { path: PATH_SCHEMA, ids: { type: "array", items: { type: "string" } }, name: { type: "string" } },
      required: ["path", "ids"],
    },
    run: opGroupNodes,
  },
  {
    name: "ungroup_nodes",
    description: "拆组：子节点坐标换算回父容器局部系，组透明度乘入子节点。带旋转的组请先把 rotation 设为 0。",
    inputSchema: {
      type: "object",
      properties: { path: PATH_SCHEMA, ids: { type: "array", items: { type: "string" } } },
      required: ["path", "ids"],
    },
    run: opUngroupNodes,
  },
  {
    name: "align_nodes",
    description:
      "对齐/分布：left|hcenter|right|top|vcenter|bottom（≥2 个节点），hdist|vdist（≥3 个，等间距分布）。ref 省略=按选择集并盒对齐；给节点 id=按该节点（如画板）边界对齐。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        ids: { type: "array", items: { type: "string" } },
        mode: { type: "string", enum: ALIGN_MODES },
        ref: { type: "string", description: "参照节点 id（如画板）；'selection' 或省略 = 选择集并盒" },
      },
      required: ["path", "ids", "mode"],
    },
    run: opAlignNodes,
  },
  {
    name: "stack_nodes",
    description:
      "把一组节点按当前顺序排成一行/一列（主轴首节点保持原位，依次以 gap 排开；交叉轴按并盒 start|center|end 对齐）。列表/导航栏/卡片流排版用它，比手算坐标稳。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        ids: { type: "array", items: { type: "string" } },
        direction: { type: "string", enum: ["row", "column"] },
        gap: { type: "number", description: "间距，缺省 16" },
        cross: { type: "string", enum: ["start", "center", "end"], description: "交叉轴对齐，缺省 start" },
      },
      required: ["path", "ids", "direction"],
    },
    run: opStackNodes,
  },
  {
    name: "reorder_nodes",
    description: "调整层级（z 序）：front 置顶 / back 置底 / forward 上移一层 / backward 下移一层。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        ids: { type: "array", items: { type: "string" } },
        mode: { type: "string", enum: REORDER_MODES },
      },
      required: ["path", "ids", "mode"],
    },
    run: opReorderNodes,
  },
  {
    name: "edit_pages",
    description: "页面管理：add 新建 / rename 改名 / activate 切换活跃页 / remove 删除（最后一页不可删）。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        action: { type: "string", enum: ["add", "rename", "activate", "remove"] },
        pageId: { type: "string", description: "页面 id（rename/activate/remove 用）" },
        name: { type: "string", description: "add/rename 用" },
      },
      required: ["path", "action"],
    },
    run: opEditPages,
  },
  {
    name: "screenshot_doc",
    description:
      "把画布内容渲染成 PNG 截图并以 image 块返回（你直接看到渲染效果，非屏幕截图）。" +
      "缺省截当前页全部可见顶层节点（世界盒为画幅）；给 ids 只截指定节点（如单个画板）。" +
      "用于改稿后视觉自检：构图/配色/文字排布一眼核对，再决定是否继续微调。" +
      "给 saveTo 时同时把 PNG 写进工作区路径并回报。" +
      "注意：文字折行为近似测量，与面板可能有轻微差异；位图资产读不到会画灰色占位。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        page: { type: "string", description: "页面 id 或名称（缺省当前活跃页）" },
        ids: { type: "array", items: { type: "string" }, description: "只截这些节点（缺省 = 页面全部可见顶层节点）" },
        maxDim: { type: "number", description: "输出最长边像素上限，缺省 1600（320–4096）" },
        scale: { type: "number", description: "倍率上限，缺省 2（0.5–4）" },
        background: { type: "string", description: "画幅底色，缺省 #ffffff；transparent/none = 透明" },
        saveTo: { type: "string", description: "可选：把这张 PNG 另存到工作区相对路径（父目录自动建）" },
      },
      required: ["path"],
    },
    run: opScreenshotDoc,
  },
  {
    name: "export_doc",
    description:
      "导出**工程包**到工作区目录（多文件产物，非单文件）：源档副本 + 逐画板 PNG（可选 SVG）+ " +
      "外链位图 assets/ + index.html 交互原型（外链 assets/，非 dataURL 内联）+ manifest.json。" +
      "缺省目录 `<档名>-export/`（dir 可改）；缺省格式 png,html,source（format 数组可含 svg）。" +
      "返回全部静态文件的工作区相对路径清单——交付/展示时据此引用。index.html 浏览器打开即可点原型。" +
      "⚠️ 会向工作区写文件（不弹审批的 write 通道之外）；产物目录若已存在会被覆盖同名文件。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        page: { type: "string", description: "页面 id 或名称（缺省当前活跃页；包按此页的画板导出）" },
        ids: { type: "array", items: { type: "string" }, description: "只导这些顶层节点（缺省 = 页面全部可见顶层节点）" },
        dir: { type: "string", description: "包目录（工作区相对），缺省 `<档名>-export`" },
        format: {
          type: "array",
          items: { type: "string", enum: ["png", "svg", "html", "source", "code"] },
          description: "要产出的文件类型，缺省 [png,html,source]；code = 每画板一份 CSS 标注（Dev Mode）；manifest/源档恒含",
        },
        maxDim: { type: "number", description: "PNG 最长边像素上限，缺省 4096（文件不受内联 2MiB 约束）" },
        scale: { type: "number", description: "PNG 倍率上限，缺省 2（0.5–8）" },
        background: { type: "string", description: "PNG/SVG 画幅底色；缺省透明（画板自绘底）；给色值则铺底" },
      },
      required: ["path"],
    },
    run: opExportDoc,
  },
  {
    name: "list_icons",
    description:
      "搜索内置 lucide 图标名（1848 个，icon 节点的 icon 字段取值）：query 前缀/子串匹配并折算别名" +
      "（home→house）。add_nodes/ update_nodes 的 icon 字段必须是这里的名字，未知名字会画占位。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词，如 home / cart / arrow-left / user；省略返回字母序前 40 个" },
        limit: { type: "number", description: "返回数量上限，缺省 40，最大 100" },
      },
    },
    run: opListIcons,
  },
  {
    name: "apply_layout",
    description:
      "对画板重排**自动布局**：按 frame 的 layout 字段（mode/gap/padding/main/cross）与子节点 grow 重新计算" +
      "全部子节点位置尺寸（含嵌套布局画板与祖先链）。改结构后想强制重排、或手动挪过子项后恢复排布时用。" +
      "给 id 只排那一块；省略 = 重排当前页所有布局画板。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        id: { type: "string", description: "画板 id（须是 frame）；缺省重排当前页全部布局画板" },
        page: { type: "string", description: "页面 id 或名称（缺省当前活跃页）" },
      },
      required: ["path"],
    },
    run: opApplyLayout,
  },
  {
    name: "boolean_nodes",
    description:
      "布尔运算：把 2+ 个**同容器同层**的形状合并成一个新的 vector 矢量节点。" +
      "operation：union 并集（别名 merge/add）、subtract 减去（第一个节点减其余，别名 minus）、" +
      "intersect 交集、exclude 排除（别名 xor）。支持 rect/ellipse/三角/菱形/五边/六边/星形/vector；" +
      "结果烤平为路径（含第一个节点的填充描边），不再随原形状联动。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        ids: { type: "array", items: { type: "string" }, description: "参与运算的节点 id（≥2，同容器同层；subtract 时第一个为被保留的底形）" },
        operation: { type: "string", enum: ["union", "subtract", "intersect", "exclude"], description: "缺省 union" },
        name: { type: "string", description: "结果图层名（缺省按运算命名）" },
        page: { type: "string", description: "页面 id 或名称（缺省当前活跃页）" },
      },
      required: ["path", "ids"],
    },
    run: opBooleanNodes,
  },
  {
    name: "list_components",
    description:
      "列出设计档的组件主档（doc.components 资产表）：id/名字/内部节点 id 列表/包围盒/实例数。" +
      "配合 add_nodes 的 instance 节点与 update_nodes 的 \"实例id/内部id\" 寻址使用。",
    inputSchema: {
      type: "object",
      properties: { path: PATH_SCHEMA },
      required: ["path"],
    },
    run: opListComponents,
  },
  {
    name: "create_component",
    description:
      "把 1+ 个**同容器同层**的现有节点转成组件：节点整体移入主档资产表（保留原 id 供覆盖寻址），" +
      "原位替换为一个 1:1 实例。之后改所有实例的共同外观就 patch_master，改某个实例的文案/颜色用 " +
      "update_nodes 的 \"实例id/内部id\" 路径（自动存为覆盖）。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        ids: { type: "array", items: { type: "string" }, description: "放进组件的节点 id（≥1，同容器同层；不能是实例内部）" },
        name: { type: "string", description: "组件名（缺省取第一个节点名）" },
        instanceId: { type: "string", description: "可选：显式指定原位实例 id" },
      },
      required: ["path", "ids"],
    },
    run: opCreateComponent,
  },
  {
    name: "edit_component",
    description:
      "组件与实例的操作集。action 五选一之外还需：" +
      "insert = 从主档再插一个实例到页面（componentId；x/y 省略自动落位）；" +
      "detach = 分离实例为普通图层（nodeId，嵌套实例一并烘焙）；" +
      "reset_overrides = 清除实例全部覆盖回到主档原样（nodeId）；" +
      "patch_master = 改主档节点、全部实例实时联动（componentId + nodeId + 要改的字段，字段是主档原始坐标）；" +
      "rename / remove（remove 带 detach:true 时把引用实例先烘焙，避免留占位框）。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        action: { type: "string", enum: ["insert", "detach", "reset_overrides", "patch_master", "rename", "remove"] },
        componentId: { type: "string" },
        nodeId: { type: "string", description: "detach/reset_overrides=顶层实例 id；patch_master=主档内节点 id" },
        name: { type: "string" },
        page: { type: "string", description: "insert：目标页 id/名称（缺省活跃页）" },
        x: { type: "number", description: "insert：显式落位" },
        y: { type: "number" },
        detach: { type: "boolean", description: "remove：true = 引用实例烘焙为静态图层" },
        instanceId: { type: "string", description: "insert：显式实例 id" },
      },
      required: ["path", "action"],
    },
    run: opEditComponent,
  },
  {
    name: "import_doc",
    description:
      "把另一份 *.uidesign.json 并入目标档：页面追加到目标档尾部（pageNames 可按页 id/名称挑子集），" +
      "组件表一并合入；全部 id 重发、实例 componentId 与覆盖 key 引用同步重映射——面板「导入设计档」同款语义。" +
      "activePage 不变；面板约半秒内轮询到并自动刷新。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        from: { type: "string", description: "来源设计档路径（*.uidesign.json；绝对或相对工作区）" },
        pageNames: { type: "array", items: { type: "string" }, description: "只导入来源档这些页（id 或名称）；省略 = 全部" },
      },
      required: ["path", "from"],
    },
    run: opImportDoc,
  },
  {
    name: "edit_variables",
    description:
      "共享颜色变量（设计 token）：list 盘点（含每变量的引用次数）/ set 新建或更新（一次改动全稿联动——" +
      "所有绑定 \"var:<id>\" 的填充/描边/文字/图标颜色实时换色）/ delete 删除（默认引用就地变警示粉，" +
      "detach:true 把引用烘焙为当前色值后删）。节点侧绑定走 update_nodes 把颜色字段写成 \"var:<变量id>\" 即可，" +
      "画布/导出/CSS 三端一致解析。set 按 id 更新；新建时 name 不得与现有重名（会自动加序号去重）。",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_SCHEMA,
        action: { type: "string", enum: ["list", "set", "delete"], description: "list 盘点 / set 新建或更新 / delete 删除" },
        id: { type: "string", description: "set：要更新的变量 id（省略则新建）；delete：要删的变量 id" },
        name: { type: "string", description: "set：变量名（≤60 字符）" },
        value: { type: "string", description: "set：颜色值（hex/rgb()/色名；也可 \"var:<另一变量id>\" 链式引用）" },
        desc: { type: "string", description: "set：可选说明" },
        detach: { type: "boolean", description: "delete：true = 先把全部引用烘焙为变量当前值再删（不留坏引用）" },
      },
      required: ["path", "action"],
    },
    run: opEditVariables,
  },
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);
