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
  blankDoc,
  findNode,
  newFrame,
  newNode,
  parseDesignDoc,
  serializeDoc,
  solid,
  uid,
  walkNodes,
  type DesignDoc,
  type DesignNode,
  type Effect,
  type Fill,
  type FrameNode,
  type GroupNode,
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
  "hexagon", "star", "line", "arrow", "text", "image",
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
    if (o.type !== "solid" && o.type !== "linear" && o.type !== "radial") {
      throw new Error(`${label}[${i}].type 需为 solid|linear|radial`);
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
  applyCommon(node, spec);
  return node;
}

/** 类型相关字段（fill/fills/stroke/strokes/runs/align/dir/src/fit/clip）在构造后套用 */
function applyTypeFields(node: DesignNode, spec: Spec): void {
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
  if (node.type === "frame" && typeof spec.clip === "boolean") node.clip = spec.clip;
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
  if (f.type === "solid") return f.color ?? "#000000";
  const stops = (f.stops ?? []).map((s) => s.color).join("→");
  return `${f.type}(${stops})`;
}

function nodeSummary(n: DesignNode, depth: number): Record<string, unknown> {
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
  if ("children" in n && n.children.length > 0) {
    out.childCount = n.children.length;
    if (depth > 0) out.children = n.children.map((c) => nodeSummary(c, depth - 1));
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
    nodes: page.nodes.map((n) => nodeSummary(n, Math.max(0, Math.round(depth)))),
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
  for (const spec of listRaw) {
    const node = buildNode(spec);
    if (findNode(doc, node.id)) throw new Error(`id 已存在：${node.id}（换一个或删掉 id 字段）`);
    applyTypeFields(node, spec);
    const explicit = num(spec.x) !== undefined && num(spec.y) !== undefined;
    insertNode(doc, parent, page, node, explicit);
    created.push({ id: node.id, type: node.type, name: node.name, x: node.x, y: node.y, w: node.w, h: node.h });
  }
  saveDoc(abs, doc);
  return { path: relPath(abs, ctx), pageId: page.id, created };
}

function opUpdateNodes(args: Spec, ctx: ToolCtx): unknown {
  const abs = resolveDocPath(args.path, ctx);
  const { doc } = loadDoc(abs);
  const updates = Array.isArray(args.updates) ? (args.updates as Spec[]) : null;
  if (!updates || updates.length === 0) throw new Error("updates 需要至少一项：[{ id, ...要改的字段 }]");
  const applied: string[] = [];
  for (const patch of updates) {
    const id = str(patch.id)?.trim();
    if (!id) throw new Error("updates 里每一项都需要 id");
    const loc = findOrThrow(doc, id);
    const node = loc.node;
    if (patch.name !== undefined) {
      const v = str(patch.name);
      if (v === undefined) throw new Error(`${id}: name 需为字符串`);
      node.name = v;
    }
    for (const key of ["x", "y", "w", "h", "rotation", "opacity"] as const) {
      const v = patch[key];
      if (v === undefined) continue;
      const n = num(v);
      if (n === undefined) throw new Error(`${id}: ${key} 需为数字`);
      node[key] = key === "opacity" ? Math.min(1, Math.max(0, n)) : n;
    }
    const dx = num(patch.dx);
    if (dx !== undefined) node.x = round1(node.x + dx);
    const dy = num(patch.dy);
    if (dy !== undefined) node.y = round1(node.y + dy);
    if (patch.visible !== undefined) {
      if (typeof patch.visible !== "boolean") throw new Error(`${id}: visible 需为布尔`);
      node.visible = patch.visible;
    }
    if (patch.locked !== undefined) {
      if (typeof patch.locked !== "boolean") throw new Error(`${id}: locked 需为布尔`);
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
    applied.push(id);
  }
  saveDoc(abs, doc);
  return { path: relPath(abs, ctx), updated: applied };
}

function opDeleteNodes(args: Spec, ctx: ToolCtx): unknown {
  const abs = resolveDocPath(args.path, ctx);
  const { doc } = loadDoc(abs);
  const ids = Array.isArray(args.ids) ? args.ids.filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) throw new Error("ids 需要至少一个节点 id");
  const removed: string[] = [];
  for (const id of ids) {
    const loc = findNode(doc, id);
    if (!loc) throw new Error(`节点不存在：${id}`);
    loc.siblings.splice(loc.index, 1);
    removed.push(id);
  }
  saveDoc(abs, doc);
  return { path: relPath(abs, ctx), removed };
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
  },
  required: ["type"],
};

const PATH_SCHEMA = { type: "string", description: `设计档路径（*.uidesign.json；绝对或相对工作区）` };

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
      "读设计档：默认返回当前页的图层树摘要（id/类型/名字/盒/填充/文字…，depth 控制展开层数）；给 nodeId 返回该节点完整 JSON；raw:true 返回整档。编辑前先读，拿最新 id。",
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
      "按 id 批量改节点（原子）：x/y 是绝对局部坐标，dx/dy 是相对位移；可改 name/w/h/rotation/opacity/visible/locked/radius/effects/onTap 与类型字段（fill/fills/stroke/strokes/text/runs/align/vAlign/lineHeight/letterSpacing/dir/src/fit/clip）。",
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
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);
