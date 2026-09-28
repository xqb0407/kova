/**
 * DesignDoc v1 数据模型（schema 的权威文档在 skills/ui-design/SKILL.md，agent 据此读写）。
 *
 * Figma 式文档树：文档 = 页面（pages）→ 图层树（nodes）。节点坐标一律是
 * **父容器局部坐标**（页面级 = 画布绝对坐标；frame/group 子节点 = 相对框左上角），
 * 这与 slide-canvas 的 CanvasDoc（objects 绝对 + frames 页框双容器、画板只是矩形）
 * 是两种模型——本面板是独立的设计引擎，不共用无限画布文档。
 *
 * 解析入口 parseDesignDoc 对任意 JSON 容错：能救的救（缺省/弱类型转换/钳制），
 * 救不了的丢弃该节点——面板永不白屏，agent 写坏也只丢局部。
 * id 全局唯一由 normalize 兜底补齐；group 的包围盒由子节点并集派生（见 geometry.ts）。
 */

export const DOC_VERSION = 1;

/* ---------------- 通用类型 ---------------- */

export type FillType = "solid" | "linear" | "radial";

export type GradientStop = { at: number; color: string };

export type Fill = {
  type: FillType;
  /** 缺省 true；false = 隐藏但保留（Figma 的眼睛） */
  visible?: boolean;
  /** solid：#rgb/#rrggbb/#rrggbbaa */
  color?: string;
  /** 0..1（缺省 1），乘在该 fill 的颜色上 */
  opacity?: number;
  /** 渐变色标（at 升序归一，2–8 个） */
  stops?: GradientStop[];
  /** 线性渐变角（度，顺时针；0 = 自上而下） */
  angle?: number;
  /** 径向圆心（0..1 局部比例，缺省 0.5/0.5） */
  center?: { x: number; y: number };
};

export type StrokeAlign = "inside" | "center" | "outside";
export type StrokeStyle = "solid" | "dashed" | "dotted";

export type Stroke = {
  color: string;
  width: number;
  align?: StrokeAlign; // 缺省 center
  style?: StrokeStyle; // 缺省 solid
  visible?: boolean; // 缺省 true
};

export type Effect =
  | { type: "drop-shadow"; visible?: boolean; color: string; x: number; y: number; blur: number }
  | { type: "inner-shadow"; visible?: boolean; color: string; x: number; y: number; blur: number }
  | { type: "layer-blur"; visible?: boolean; blur: number };

export type TextRun = {
  text: string;
  color?: string;
  size?: number;
  /** CSS 字重（400 常规 / 500 中等 / 600 半粗 / 700 粗体） */
  weight?: number;
  italic?: boolean;
  underline?: boolean;
  font?: string; // 字体族（缺省跟随界面字体）
};

export type NodeType =
  | "frame"
  | "group"
  | "rect"
  | "ellipse"
  | "triangle"
  | "diamond"
  | "pentagon"
  | "hexagon"
  | "star"
  | "line"
  | "arrow"
  | "text"
  | "image";

export const SHAPE_TYPES: readonly NodeType[] = [
  "rect",
  "ellipse",
  "triangle",
  "diamond",
  "pentagon",
  "hexagon",
  "star",
];
export const LINE_TYPES: readonly NodeType[] = ["line", "arrow"];

/** line/arrow 走向（bbox 局部）：0=↘（缺省）1=↗ 2=↖ 3=↙（同 CanvasDoc 对角语义） */
export type LineDir = 0 | 1 | 2 | 3;

type NodeBase = {
  id: string;
  name: string;
  /** 父容器局部坐标；页面级 = 画布绝对坐标；rotation 绕盒中心 */
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number; // 度
  opacity?: number; // 0..1 缺省 1
  visible?: boolean; // 缺省 true
  locked?: boolean; // 缺省 false
  /** 圆角：统一值或 [tl,tr,br,bl]；0..4096 */
  radius?: number | [number, number, number, number];
  effects?: Effect[];
  /** 原型交互：单击本节点后跳转 to 指向的画板（全档任意 frame id，跨页可用；死链渲染时忽略） */
  onTap?: { to: string };
};

/** 纯几何盒形状判别子集（区别于 NodeType 全集，供联合类型可辨识收窄用） */
export type BoxShapeType = "rect" | "ellipse" | "triangle" | "diamond" | "pentagon" | "hexagon" | "star";

export type ShapeNode = NodeBase & { type: BoxShapeType; fills: Fill[]; strokes: Stroke[] };
export type LineNode = NodeBase & {
  type: "line" | "arrow";
  dir?: LineDir;
  strokes: Stroke[];
};
export type TextNode = NodeBase & {
  type: "text";
  runs: TextRun[];
  align?: "left" | "center" | "right"; // 缺省 left
  vAlign?: "top" | "middle" | "bottom"; // 缺省 top
  lineHeight?: number; // 倍数，缺省 1.4
  letterSpacing?: number; // px，缺省 0
};
export type ImageNode = NodeBase & {
  type: "image";
  src: string; // workspace 相对路径（通常在 <档名>-assets/ 下）
  fit?: "cover" | "contain" | "stretch"; // 缺省 cover
  strokes?: Stroke[];
};
export type GroupNode = NodeBase & {
  type: "group";
  /** 子节点坐标相对组包围盒左上角；组自身 x/y/w/h 由子节点并集派生 */
  children: DesignNode[];
};
export type FrameNode = NodeBase & {
  type: "frame";
  children: DesignNode[];
  /** frame 的底色走 fills（Figma 语义） */
  fills: Fill[];
  strokes?: Stroke[];
  /** 缺省 true：内容超框裁切（约定只写 clip:false，序列化幂等） */
  clip?: boolean;
  /** 设备预设键（仅记录来源；几何改动不重置） */
  preset?: string;
};

export type DesignNode = GroupNode | FrameNode | TextNode | ImageNode | LineNode | ShapeNode;

export type Page = { id: string; name: string; nodes: DesignNode[] };

export type DesignDoc = {
  version: number;
  meta: { name: string; kind: "uidesign" };
  activePage: string;
  pages: Page[];
};

/* ---------------- 设备预设 ---------------- */

export type DevicePreset = { w: number; h: number; label: string; group: string };

export const DEVICE_PRESETS: Record<string, DevicePreset> = {
  "ios-375": { w: 375, h: 812, label: "iOS · 375×812", group: "手机" },
  "ios-390": { w: 390, h: 844, label: "iOS · 390×844", group: "手机" },
  "android-360": { w: 360, h: 800, label: "Android · 360×800", group: "手机" },
  "tablet-768": { w: 768, h: 1024, label: "平板 · 768×1024", group: "平板" },
  "desktop-1440": { w: 1440, h: 900, label: "桌面 · 1440×900", group: "桌面" },
  "watch-168": { w: 168, h: 184, label: "手表 · 168×184", group: "其他" },
};
export const DEVICE_ORDER = Object.keys(DEVICE_PRESETS);

/* ---------------- 构造 ---------------- */

let uidCounter = 0;
export function uid(prefix = "n"): string {
  uidCounter = (uidCounter + 1) % 0xffffff;
  return `${prefix}${Date.now().toString(36)}${uidCounter.toString(36)}`;
}

export const solid = (color: string, opacity = 1): Fill =>
  opacity < 1 ? { type: "solid", color, opacity } : { type: "solid", color };

export function blankDoc(name = "UI 设计"): DesignDoc {
  const pageId = uid("p");
  return {
    version: DOC_VERSION,
    meta: { name, kind: "uidesign" },
    activePage: pageId,
    pages: [{ id: pageId, name: "页面 1", nodes: [] }],
  };
}

export function newFrame(opts: {
  name?: string;
  w: number;
  h: number;
  x?: number;
  y?: number;
  preset?: string;
  background?: string;
}): FrameNode {
  return {
    id: uid("f"),
    type: "frame",
    name: opts.name ?? opts.preset ?? "画板",
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    w: clamp(opts.w, 1, 20000),
    h: clamp(opts.h, 1, 20000),
    fills: [solid(opts.background ?? "#ffffff")],
    ...(opts.preset ? { preset: opts.preset } : {}),
    children: [],
  };
}

/** 起始档：三块设备画板横排（首页 / 关键流程 / 详情），进面板即可开画 */
export function starterDoc(name: string, presetKey: string): DesignDoc {
  const doc = blankDoc(name);
  const p = DEVICE_PRESETS[presetKey] ?? DEVICE_PRESETS["ios-375"];
  const titles = ["首页", "关键流程", "详情"];
  const gap = Math.max(80, Math.round(p.w * 0.32));
  doc.pages[0]!.nodes = titles.map((t, i) =>
    newFrame({ name: t, w: p.w, h: p.h, x: i * (p.w + gap), preset: presetKey }),
  );
  return doc;
}

/** 各节点类型的默认样式工厂（新建元素/agent 范例共用） */
export function newNode(type: NodeType, box: { x: number; y: number; w: number; h: number }, name?: string): DesignNode {
  const base = { id: uid(type[0]!), name: name ?? TYPE_LABELS[type] ?? type, ...box };
  switch (type) {
    case "text":
      return { ...base, type: "text", runs: [{ text: "文本", size: 16, color: "#111111" }] };
    case "image":
      return { ...base, type: "image", src: "" };
    case "frame":
      return { ...base, type: "frame", fills: [solid("#ffffff")], children: [] };
    case "group":
      return { ...base, type: "group", children: [] };
    case "line":
    case "arrow":
      return { ...base, type, strokes: [{ color: "#111111", width: 2 }] };
    default:
      return { ...base, type: type as BoxShapeType, fills: [solid("#d9d9d9")], strokes: [] };
  }
}

export const TYPE_LABELS: Partial<Record<NodeType, string>> = {
  frame: "画板",
  group: "组",
  rect: "矩形",
  ellipse: "椭圆",
  triangle: "三角形",
  diamond: "菱形",
  pentagon: "五边形",
  hexagon: "六边形",
  star: "星形",
  line: "直线",
  arrow: "箭头",
  text: "文本",
  image: "图片",
};

/** 该类型是否带填充盒（检视器分区显隐的依据之一） */
export const HAS_FILL_BOX: Record<NodeType, boolean> = {
  frame: true,
  rect: true,
  ellipse: true,
  triangle: true,
  diamond: true,
  pentagon: true,
  hexagon: true,
  star: true,
  group: false,
  line: false,
  arrow: false,
  text: false,
  image: false,
};

/* ---------------- 树工具 ---------------- */

/** 深度优先（父在子前）遍历；跳过 visible=false 由调用方自理 */
export function* walkNodes(nodes: DesignNode[]): Generator<DesignNode> {
  for (const n of nodes) {
    yield n;
    if ("children" in n) yield* walkNodes(n.children);
  }
}

export function* walkPages(doc: DesignDoc): Generator<Page> {
  yield* doc.pages;
}

/** 全树遍历（含所有页面），附所属页 id */
export function* walkDoc(doc: DesignDoc): Generator<{ pageId: string; node: DesignNode }> {
  for (const page of doc.pages) for (const node of walkNodes(page.nodes)) yield { pageId: page.id, node };
}

export type NodeLocation = {
  node: DesignNode;
  /** 所在子数组引用（改动直接 map/splice 它） */
  siblings: DesignNode[];
  index: number;
  /** 父节点（页面级为 null） */
  parent: DesignNode | null;
  pageId: string;
};

/** 按 id 定位（含跨页查找——id 全局唯一由 normalize 保证） */
export function findNode(doc: DesignDoc, id: string): NodeLocation | null {
  for (const page of doc.pages) {
    const loc = findInList(page.nodes, id, page.id, null);
    if (loc) return loc;
  }
  return null;
}

function findInList(list: DesignNode[], id: string, pageId: string, parent: DesignNode | null): NodeLocation | null {
  for (let i = 0; i < list.length; i++) {
    const n = list[i]!;
    if (n.id === id) return { node: n, siblings: list, index: i, parent, pageId };
    if ("children" in n) {
      const hit = findInList(n.children, id, pageId, n);
      if (hit) return hit;
    }
  }
  return null;
}

/** 全档画板（各页顶层 frame，页序 + 树序）——原型预览/导出/跳转目标列表共用 */
export function allFrames(doc: DesignDoc): { pageId: string; frame: FrameNode }[] {
  const out: { pageId: string; frame: FrameNode }[] = [];
  for (const p of doc.pages)
    for (const n of p.nodes) if (n.type === "frame") out.push({ pageId: p.id, frame: n });
  return out;
}

/* ---------------- 容错解析 ---------------- */

/** fatal=true：整档不可用（JSON 解析失败/不是对象），返回的是空白档占位——
 *  调用方必须显示损坏横幅并禁止回写，绝不能用占位内容覆盖盘上坏档 */
export type ParseResult = { doc: DesignDoc; warnings: string[]; fatal: boolean };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const num = (v: unknown, d = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d;
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const bool = (v: unknown, d = false): boolean => (typeof v === "boolean" ? v : d);
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const colorOr = (v: unknown, d: string): string => (typeof v === "string" && HEX.test(v) ? v : d);
const opacity01 = (v: unknown, d = 1): number => (v === undefined ? d : clamp(num(v, d), 0, 1));

function parseFill(raw: unknown): Fill | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const type = o.type === "linear" || o.type === "radial" ? (o.type as FillType) : o.type === "solid" || o.type === undefined ? "solid" : null;
  if (!type) return null;
  const f: Fill = { type };
  if (o.visible === false) f.visible = false;
  const op = opacity01(o.opacity, 1);
  if (op < 1) f.opacity = op;
  if (type === "solid") {
    f.color = colorOr(o.color, "#d9d9d9");
  } else {
    const stops: GradientStop[] = [];
    if (Array.isArray(o.stops)) {
      for (const s of o.stops) {
        if (typeof s !== "object" || s === null) continue;
        const so = s as Record<string, unknown>;
        stops.push({ at: clamp(num(so.at, 0), 0, 1), color: colorOr(so.color, "#000000") });
        if (stops.length >= 8) break;
      }
    }
    if (stops.length === 0) stops.push({ at: 0, color: "#4f46e5" }, { at: 1, color: "#06b6d4" });
    stops.sort((a, b) => a.at - b.at);
    f.stops = stops;
    if (type === "linear") {
      const a = num(o.angle, 0);
      if (a !== 0) f.angle = ((a % 360) + 360) % 360;
    } else {
      const c = typeof o.center === "object" && o.center !== null ? (o.center as Record<string, unknown>) : null;
      if (c && (typeof c.x === "number" || typeof c.y === "number")) {
        f.center = { x: clamp(num(c.x, 0.5), 0, 1), y: clamp(num(c.y, 0.5), 0, 1) };
      }
    }
  }
  return f;
}

function parseStrokes(raw: unknown): Stroke[] {
  if (!Array.isArray(raw)) return [];
  const out: Stroke[] = [];
  for (const s of raw) {
    if (typeof s !== "object" || s === null) continue;
    const so = s as Record<string, unknown>;
    const st: Stroke = { color: colorOr(so.color, "#111111"), width: clamp(num(so.width, 1), 0, 40) };
    if (so.align === "inside" || so.align === "outside") st.align = so.align;
    if (so.style === "dashed" || so.style === "dotted") st.style = so.style;
    if (so.visible === false) st.visible = false;
    out.push(st);
    if (out.length >= 4) break;
  }
  return out;
}

function parseEffects(raw: unknown): Effect[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: Effect[] = [];
  for (const e of raw) {
    if (typeof e !== "object" || e === null) continue;
    const eo = e as Record<string, unknown>;
    if (eo.type === "drop-shadow" || eo.type === "inner-shadow") {
      out.push({
        type: eo.type,
        visible: eo.visible === false ? false : undefined,
        color: colorOr(eo.color, "#000000"),
        x: clamp(num(eo.x, 0), -200, 200),
        y: clamp(num(eo.y, 4), -200, 200),
        blur: clamp(num(eo.blur, 12), 0, 200),
      });
    } else if (eo.type === "layer-blur") {
      out.push({ type: "layer-blur", visible: eo.visible === false ? false : undefined, blur: clamp(num(eo.blur, 8), 0, 100) });
    }
    if (out.length >= 4) break;
  }
  return out.length ? out : undefined;
}

function parseRadius(raw: unknown): number | [number, number, number, number] | undefined {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw === 0) return undefined;
    return clamp(raw, 0, 4096);
  }
  if (Array.isArray(raw) && raw.length === 4) {
    const v = raw.map((r) => clamp(num(r, 0), 0, 4096));
    return v.some((r) => r !== 0) ? [v[0]!, v[1]!, v[2]!, v[3]!] : undefined;
  }
  return undefined;
}

function parseRun(raw: unknown): TextRun | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.text !== "string") return null;
  const r: TextRun = { text: o.text.slice(0, 20000) };
  if (o.color !== undefined) r.color = colorOr(o.color, "#111111");
  if (o.size !== undefined) r.size = clamp(num(o.size, 16), 1, 400);
  if (o.weight !== undefined) r.weight = clamp(num(o.weight, 400), 100, 1000);
  if (o.italic === true) r.italic = true;
  if (o.underline === true) r.underline = true;
  if (typeof o.font === "string" && o.font.trim()) r.font = o.font.slice(0, 120);
  return r;
}

function parseNode(raw: unknown, seenIds: Set<string>): DesignNode | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const t = o.type;
  const isLine = t === "line" || t === "arrow";
  const isBox = t === "rect" || t === "ellipse" || t === "triangle" || t === "diamond" || t === "pentagon" || t === "hexagon" || t === "star";
  if (t !== "frame" && t !== "group" && t !== "text" && t !== "image" && !isLine && !isBox) return null;

  let id = str(o.id);
  if (!id || seenIds.has(id)) id = uid(t[0]!);
  seenIds.add(id);

  const base: NodeBase = {
    id,
    name: str(o.name, TYPE_LABELS[t as NodeType] ?? String(t)).slice(0, 120),
    x: clamp(num(o.x), -100000, 100000),
    y: clamp(num(o.y), -100000, 100000),
    w: clamp(num(o.w, 100), 1, 20000),
    h: clamp(num(o.h, 100), 1, 20000),
  };
  const rot = num(o.rotation, 0);
  if (rot !== 0) base.rotation = ((rot % 360) + 360) % 360;
  const op = opacity01(o.opacity, 1);
  if (op < 1) base.opacity = op;
  if (o.visible === false) base.visible = false;
  if (o.locked === true) base.locked = true;
  const radius = parseRadius(o.radius);
  if (radius !== undefined) base.radius = radius;
  const effects = parseEffects(o.effects);
  if (effects) base.effects = effects;
  if (typeof o.onTap === "object" && o.onTap !== null) {
    const to = str((o.onTap as Record<string, unknown>).to);
    if (to) base.onTap = { to: to.slice(0, 120) };
  }

  if (t === "frame" || t === "group") {
    const children = parseChildren(o.children, seenIds);
    if (t === "group") return { ...base, type: "group", children };
    const node: FrameNode = { ...base, type: "frame", children, fills: parseFills(o.fills) };
    const strokes = parseStrokes(o.strokes);
    if (strokes.length) node.strokes = strokes;
    if (o.clip === false) node.clip = false;
    if (typeof o.preset === "string" && o.preset in DEVICE_PRESETS) node.preset = o.preset;
    return node;
  }
  if (t === "text") {
    const rawRuns = Array.isArray(o.runs) ? o.runs : [{ text: str(o.text, "文本") }];
    const runs = rawRuns.map(parseRun).filter((r): r is TextRun => r !== null);
    const node: TextNode = { ...base, type: "text", runs: runs.length ? runs.slice(0, 64) : [{ text: "文本" }] };
    if (o.align === "center" || o.align === "right") node.align = o.align;
    if (o.vAlign === "middle" || o.vAlign === "bottom") node.vAlign = o.vAlign;
    if (typeof o.lineHeight === "number") node.lineHeight = clamp(o.lineHeight, 0.5, 4);
    if (typeof o.letterSpacing === "number") node.letterSpacing = clamp(o.letterSpacing, -20, 40);
    return node;
  }
  if (t === "image") {
    const node: ImageNode = { ...base, type: "image", src: str(o.src).slice(0, 600) };
    if (o.fit === "contain" || o.fit === "stretch") node.fit = o.fit;
    const strokes = parseStrokes(o.strokes);
    if (strokes.length) node.strokes = strokes;
    return node;
  }
  if (isLine) {
    const node: LineNode = { ...base, type: t, strokes: parseStrokes(o.strokes) };
    if (!node.strokes.length) node.strokes = [{ color: "#111111", width: 2 }];
    const d = num(o.dir, 0);
    if (d === 1 || d === 2 || d === 3) node.dir = d as LineDir;
    return node;
  }
  const node: ShapeNode = { ...base, type: t as BoxShapeType, fills: parseFills(o.fills), strokes: parseStrokes(o.strokes) };
  return node;
}

function parseFills(raw: unknown): Fill[] {
  if (!Array.isArray(raw)) return [];
  const out: Fill[] = [];
  for (const f of raw) {
    const p = parseFill(f);
    if (p) out.push(p);
    if (out.length >= 4) break;
  }
  return out;
}

function parseChildren(raw: unknown, seenIds: Set<string>): DesignNode[] {
  if (!Array.isArray(raw)) return [];
  const out: DesignNode[] = [];
  for (const c of raw) {
    const n = parseNode(c, seenIds);
    if (n) out.push(n);
    if (out.length >= 500) break;
  }
  return out;
}

function parsePage(raw: unknown, seenIds: Set<string>): Page | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  let id = str(o.id);
  if (!id || seenIds.has(id)) id = uid("p");
  seenIds.add(id);
  return { id, name: str(o.name, "页面").slice(0, 80), nodes: parseChildren(o.nodes, seenIds) };
}

/** 容错解析入口：坏档绝不抛错，能救多少救多少 */
export function parseDesignDoc(json: string): ParseResult {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { doc: blankDoc(), warnings: ["JSON 无法解析"], fatal: true };
  }
  if (typeof raw !== "object" || raw === null) return { doc: blankDoc(), warnings: ["文档不是对象"], fatal: true };
  const o = raw as Record<string, unknown>;
  const seenIds = new Set<string>();
  const meta = typeof o.meta === "object" && o.meta !== null ? (o.meta as Record<string, unknown>) : {};
  const pages: Page[] = [];
  if (Array.isArray(o.pages)) {
    for (const p of o.pages) {
      const page = parsePage(p, seenIds);
      if (page) pages.push(page);
      if (pages.length >= 20) break;
    }
  }
  if (pages.length === 0) pages.push({ id: uid("p"), name: "页面 1", nodes: [] });
  let activePage = str(o.activePage);
  if (!pages.some((p) => p.id === activePage)) activePage = pages[0]!.id;
  return {
    doc: {
      version: DOC_VERSION,
      meta: { name: str(meta.name, "UI 设计").slice(0, 120) || "UI 设计", kind: "uidesign" },
      activePage,
      pages,
    },
    warnings,
    fatal: false,
  };
}

export function serializeDoc(doc: DesignDoc): string {
  return JSON.stringify(doc, null, 2);
}

/* ---------------- 统计摘要（首页卡片用） ---------------- */

export type DocStats = { frames: number; nodes: number; previews: { x: number; y: number; w: number; h: number; bg: string }[] };

/** 当前页画板布局 + 全档节点数（宿主 listCanvasDocs 用同款规则，改这里记得同步） */
export function docStats(doc: DesignDoc): DocStats {
  const page = doc.pages.find((p) => p.id === doc.activePage) ?? doc.pages[0]!;
  let nodes = 0;
  for (const _ of walkDoc(doc)) nodes++;
  const previews: DocStats["previews"] = [];
  for (const n of page.nodes) {
    if (n.type !== "frame") continue;
    const first = n.fills.find((f) => f.type === "solid" && f.visible !== false);
    previews.push({ x: n.x, y: n.y, w: n.w, h: n.h, bg: first?.color ?? "#ffffff" });
    if (previews.length >= 24) break;
  }
  return { frames: previews.length, nodes, previews };
}
