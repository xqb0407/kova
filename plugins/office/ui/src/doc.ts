/**
 * CanvasDoc v2 数据模型（schema 的权威文档在 skills/slides/SKILL.md，agent 据此读写）。
 *
 * 真·无限画布：文档 = 画布级元素 objects（绝对坐标）+ 页框 frames（Figma 式层级容器，
 * 框内元素保持局部坐标，拖动页框内容自动跟随）。PPT 只是 frames 里 type:"slide" 的框；
 * 导出/放映只认这些页框（数组序=页序），objects 不进 pptx。
 *
 * 解析入口 parseDoc 对任意 JSON 容错：能救的救（字段缺省/弱类型转换），
 * 救不了的丢弃该元素——面板永不白屏，agent 写坏也只丢局部。
 * v1（{slides:[…]}）在这里透明迁移为 v2：slides → 等距网格摆放的 frames，
 * 之后写回一律 v2。宿主只把 JSON 当字符串透传，schema 演进纯插件侧。
 */

export const DOC_VERSION = 2;

/** 画布级容器的哨兵 id（selection 的 containerId 用它表示「直接落在画布上」） */
export const CANVAS_ROOT = "root";

export type TextAlign = "left" | "center" | "right";
export type TextVAlign = "top" | "middle" | "bottom";

export type TextRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  color?: string; // #rrggbb
  size?: number; // artboard 像素
  font?: string; // 字体族白名单见 SKILL.md
  underline?: boolean;
};

export type TextEl = {
  kind: "text";
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  runs: TextRun[];
  align?: TextAlign;
  vAlign?: TextVAlign;
  opacity?: number;
  rotation?: number;
};

export type ShapeKind =
  | "rect"
  | "diamond"
  | "ellipse"
  | "line"
  | "arrow"
  | "double-arrow"
  | "triangle"
  | "trapezoid"
  | "pentagon"
  | "hexagon"
  | "star";

/** 线类形状（共用对角几何 + curve 弧度 + 连线绑定） */
export const LINE_SHAPE_KINDS: readonly ShapeKind[] = ["line", "arrow", "double-arrow"];

/** line/arrow 对角方向（起点→终点，bbox 局部坐标）：0=↘（缺省）1=↗ 2=↖ 3=↙ */
export type LineDir = 0 | 1 | 2 | 3;

/** 线类折点（相对包围盒左上角，[x, y]，一位小数）。pts≥3 时线身走折线，curve 被忽略。 */
export type LinePt = [number, number];

/** 折线点数封顶（载入/写入时截断，防文档爆炸） */
export const LINE_MAX_POINTS = 200;

/** 折线点列解析：≥3 个有限 [x,y]（一位小数、封顶截断；坏点跳过）；否则 undefined = 旧对角语义 */
export function parseLinePts(raw: unknown): LinePt[] | undefined {
  if (!Array.isArray(raw) || raw.length < 3) return undefined;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const out: LinePt[] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = p[0];
    const y = p[1];
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push([r1(x), r1(y)]);
    if (out.length >= LINE_MAX_POINTS) break;
  }
  return out.length >= 3 ? out : undefined;
}

/** 边框样式（描边画法）：与 DOM border-style / SVG dash / pptx dashType 同构 */
export type StrokeStyle = "solid" | "dashed" | "dotted";

export type ShapeEl = {
  kind: "shape";
  id: string;
  shape: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  /** 边框样式：实线/虚线/点线（缺省实线） */
  strokeStyle?: StrokeStyle;
  /** line/arrow 画向（拖拽绘制时起点→尾点）；其余形状无意义。缺省 = 0（左上→右下） */
  dir?: LineDir;
  /** 线类弧度：控制点偏移 / 弦长，[-1,1]，>0 水平线上拱。缺省 = 0（直）。适用 line/arrow/double-arrow。
   *  折线（pts≥3 点）时忽略 */
  curve?: number;
  /** 线类折点列（bbox 局部坐标；首点 = 线起点、末点 = 线终点，可携带绑定）。
   *  缺省/2 点 = 旧 bbox+dir(+curve) 对角语义；≥3 点 = 折线（curve 失效）。
   *  四轨渲染 / 命中 / 绑定同步共用；改点必走 rebasePoly 保持 bbox=点并集 */
  pts?: LinePt[];
  /** 连线绑定：起点/终点吸附的**同容器**元素 id（仅线类形状有意义）。
   *  几何由 syncBoundArrows 在提交/撤销/载入时按被绑元素边缘锚点重算，
   *  移动元素连线跟随；手动缩放/旋转线段即解除绑定 */
  startBind?: string;
  endBind?: string;
  radius?: number;
  opacity?: number;
  rotation?: number;
};

export type ImageFit = "cover" | "contain" | "stretch";

export type ImageEl = {
  kind: "image";
  id: string;
  src: string; // workspace 相对路径（通常在 <deck>-assets/ 下）
  x: number;
  y: number;
  w: number;
  h: number;
  fit?: ImageFit;
  radius?: number;
  opacity?: number;
  rotation?: number;
};

/** mermaid 图表元素：code 为 mermaid 源码（flowchart/sequence/pie…），随主题渲染 */
export type MermaidTheme = "default" | "dark" | "neutral" | "follow";

export type MermaidEl = {
  kind: "mermaid";
  id: string;
  code: string;
  x: number;
  y: number;
  w: number;
  h: number;
  theme?: MermaidTheme;
  opacity?: number;
  rotation?: number;
};

export const DEFAULT_MERMAID_CODE = "graph TD\n  A[开始] --> B{判断}\n  B -->|是| C[执行]\n  B -->|否| D[跳过]\n  C --> E[结束]\n  D --> E";

/** 新建 embed 的起始地址（iframe 友好、免登录可见内容，插入即可看到效果） */
export const DEFAULT_EMBED_URL = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";

/** 新建 svg 元素的起始源码（工具栏插入后双击/Inspector 里替换成真实内容） */
export const DEFAULT_SVG_CODE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 180"><rect width="240" height="180" rx="16" fill="#166534"/><circle cx="120" cy="90" r="44" fill="#f4f692"/></svg>';

/** 钢笔手绘：points 是相对包围盒左上角的采样点列（渲染/缩放按 w/h 拉伸点集） */
export type DrawPoint = [number, number];

export type DrawEl = {
  kind: "draw";
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  points: DrawPoint[];
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  rotation?: number;
};

/** 手绘点集封顶（超出写入时抽稀），防文档爆炸 */
export const DRAW_MAX_POINTS = 2000;

/**
 * 内嵌网页元素（tldraw/Excalidraw 式 URL embed）：url 解析成白名单 provider 的
 * embed 地址后以 iframe 呈现；命中不了的 provider 原样 iframe 兜底。
 * 沙箱继承自面板（allow-scripts，不透明源）→ 嵌入页无 Cookie/登录态。
 */
export type EmbedEl = {
  kind: "embed";
  id: string;
  url: string; // http(s) 绝对地址
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string; // 角标/导出占位显示名（缺省用 provider 名）
  opacity?: number;
  rotation?: number;
};

/** 内嵌 SVG 源码元素（同 mermaid「源码即内容」：矢量进档，不经资产文件） */
export type SvgEl = {
  kind: "svg";
  id: string;
  code: string; // <svg>…</svg> 完整源码
  x: number;
  y: number;
  w: number;
  h: number;
  opacity?: number;
  rotation?: number;
};

/* ---------------- 表格 ---------------- */

export const TABLE_MAX_ROWS = 100;
export const TABLE_MAX_COLS = 30;
export const TABLE_MAX_CELL = 500;

export type TableEl = {
  kind: "table";
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rows: string[][]; // 单元格文本（rows[行][列]；行数即行数，列数取首行）
  colWidths?: number[]; // 列宽权重（与列数对齐，缺省均分）
  header?: boolean; // 首行表头样式（加粗 + 底色），缺省 true
  size?: number; // 字号 px，缺省 18
  fill?: string; // 单元格底色，缺省 #ffffff
  headerFill?: string; // 表头底色，缺省 #eef0f2
  stroke?: string; // 网格线色，缺省 #d4d4d8
  color?: string; // 文字色，缺省 #1d1d1f
  opacity?: number;
  rotation?: number;
};

export const DEFAULT_TABLE_ROWS: string[][] = [
  ["列 A", "列 B", "列 C"],
  ["", "", ""],
  ["", "", ""],
];

/* ---------------- 数据图表 ---------------- */

export type ChartKind = "bar" | "line" | "pie" | "doughnut";
export const CHART_KINDS: readonly ChartKind[] = ["bar", "line", "pie", "doughnut"];

export type ChartSeries = { name: string; data: number[] };

export type ChartEl = {
  kind: "chart";
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  chart?: ChartKind; // 缺省 bar（纵向柱状）
  labels: string[]; // 类目（饼/环 = 扇区名）
  series: ChartSeries[]; // 饼/环只取 series[0]
  colors?: string[]; // 系列色（饼/环 = 扇区色），按序循环
  showLegend?: boolean; // 底部图例，缺省 false
  size?: number; // 标签字号 px，缺省 12
  opacity?: number;
  rotation?: number;
};

/** 图表默认色板（与新建元素默认色同源：森林绿 CTA + 淡黄起手） */
export const CHART_PALETTE: readonly string[] = [
  "#166534",
  "#f4f692",
  "#0a84ff",
  "#ff9f0a",
  "#bf5af2",
  "#ff3b30",
  "#30d158",
  "#64d2ff",
];

export const DEFAULT_CHART_LABELS: string[] = ["一月", "二月", "三月", "四月"];
export const DEFAULT_CHART_SERIES: ChartSeries[] = [
  { name: "系列 A", data: [12, 19, 8, 15] },
  { name: "系列 B", data: [6, 10, 14, 7] },
];

export type El = (TextEl | ShapeEl | ImageEl | MermaidEl | DrawEl | EmbedEl | SvgEl | TableEl | ChartEl) & {
  /** 编辑组：同容器内同 groupId 的元素一起选中/移动/删除（一层，不嵌套）；导出时无感知 */
  groupId?: string;
};

/** 目前唯一的框类型：PPT 页。未来扩新框型时导出/放映只认 "slide" */
export type FrameType = "slide";

/** 页切换动画：放映/导出「进入本页」时生效；缺省 slide（横向推入）。pptx 导出 zoom 近似为淡入 */
export type SlideTransition = "none" | "slide" | "fade" | "zoom";
export const SLIDE_TRANSITIONS: readonly SlideTransition[] = ["none", "slide", "fade", "zoom"];

export type Frame = {
  id: string;
  x: number; // 画布绝对坐标
  y: number;
  w: number;
  h: number;
  type: FrameType;
  name?: string; // 标签（缩略图/画布角标），缺省显示页码
  background: string; // #rrggbb 或 CSS 渐变串（导出时降级为纯色）
  transition?: SlideTransition; // 进入本页的切换动画（缺省 slide，不落字段）
  elements: El[]; // 框内局部坐标
};

export type PagePreset = "16:9" | "4:3" | "A4L";

export const PAGE_SIZES: Record<PagePreset, { w: number; h: number; label: string }> = {
  "16:9": { w: 1280, h: 720, label: "16:9" },
  "4:3": { w: 1024, h: 768, label: "4:3" },
  A4L: { w: 1123, h: 794, label: "A4 横向" },
};

export type CanvasDoc = {
  version: number;
  meta: { name: string; pagePreset: PagePreset; kind?: DocKind };
  objects: El[]; // 画布级元素：绝对坐标，直接落在无限空间
  frames: Frame[];
};

/* ---------------- 构造 ---------------- */

let uidCounter = 0;
export function uid(prefix = "e"): string {
  uidCounter += 1;
  return `${prefix}${Date.now().toString(36)}${uidCounter.toString(36)}`;
}

export const TIDY_GAP = 56;
export const TIDY_PAD = 80;

/** 页框整齐网格归位（纯函数、幂等）：位置只由数组序 + 框尺寸决定 */
export function tidyLayout(doc: CanvasDoc): CanvasDoc {
  const n = doc.frames.length;
  if (n === 0) return doc;
  const maxW = Math.max(...doc.frames.map((f) => f.w));
  const maxH = Math.max(...doc.frames.map((f) => f.h));
  // 偏横排的网格：约 1.6 行高时取列数（n=2→2 列 1 行，n=4→2 列 2 行，n=9→3 列 3 行）
  const cols = Math.max(1, Math.ceil(Math.sqrt(n / 1.6)));
  const frames = doc.frames.map((f, i) => ({
    ...f,
    x: TIDY_PAD + (i % cols) * (maxW + TIDY_GAP),
    y: TIDY_PAD + Math.floor(i / cols) * (maxH + TIDY_GAP),
  }));
  return { ...doc, frames };
}

/** 新框落点：现有框并集的右侧一排（无框则画布起点） */
export function nextFramePos(frames: Frame[]): { x: number; y: number } {
  if (frames.length === 0) return { x: TIDY_PAD, y: TIDY_PAD };
  const right = Math.max(...frames.map((f) => f.x + f.w));
  const top = Math.min(...frames.map((f) => f.y));
  return { x: right + TIDY_GAP, y: top };
}

export function blankFrame(preset: PagePreset = "16:9", at?: { x: number; y: number }): Frame {
  const { w, h } = PAGE_SIZES[preset];
  return {
    id: uid("s"),
    x: at?.x ?? TIDY_PAD,
    y: at?.y ?? TIDY_PAD,
    w,
    h,
    type: "slide",
    background: "#ffffff",
    elements: [],
  };
}

/** 标题版式页框：一页居中大标题 + 副题（页菜单「新建 → 标题页」与 SKILL 示例共用形状） */
export function titleFrame(
  preset: PagePreset = "16:9",
  title = "点击编辑标题",
  subtitle = "",
  at?: { x: number; y: number },
): Frame {
  const f = blankFrame(preset, at);
  const cw = f.w;
  f.elements.push({
    kind: "text",
    id: uid("t"),
    x: cw * 0.1,
    y: f.h * 0.32,
    w: cw * 0.8,
    h: f.h * 0.2,
    runs: [{ text: title, bold: true, size: 64, color: "#111827" }],
    align: "center",
    vAlign: "middle",
  });
  f.elements.push({
    kind: "text",
    id: uid("t"),
    x: cw * 0.15,
    y: f.h * 0.55,
    w: cw * 0.7,
    h: f.h * 0.12,
    runs: [{ text: subtitle || "副标题", size: 28, color: "#6b7280" }],
    align: "center",
    vAlign: "middle",
  });
  return f;
}

/**
 * 钢笔笔迹的「自然点盒」：点集本身的宽高（≥1）。渲染/导出用它做 viewBox，
 * 拉伸填满元素 w×h——resize 只改包围盒、不改点集也能两者一致。
 */
export function drawNaturalBox(el: DrawEl): { w: number; h: number } {
  let mx = 1;
  let my = 1;
  for (const [x, y] of el.points) {
    if (x > mx) mx = x;
    if (y > my) my = y;
  }
  return { w: mx, h: my };
}

/**
 * 钢笔笔迹提交：任意坐标系（画布或页框局部）的点列 → 归一化的 draw 元素。
 * 包围盒平移为元素 (x,y)，点集相对包围盒、0.1px 取整；超点数上限均匀抽稀。
 * 少于 2 点返回 null。渲染按自然点盒拉伸到元素 w/h，因此调整大小无需改点集。
 */
export function drawFromPoints(pts: readonly DrawPoint[], opts?: { stroke?: string; strokeWidth?: number }): DrawEl | null {
  if (pts.length < 2) return null;
  let list = pts;
  if (list.length > DRAW_MAX_POINTS) {
    const step = list.length / DRAW_MAX_POINTS;
    const thinned: DrawPoint[] = Array.from({ length: DRAW_MAX_POINTS }, (_, i) => list[Math.floor(i * step)]!);
    thinned[thinned.length - 1] = list[list.length - 1]!;
    list = thinned;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of list) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const r = (v: number) => Math.round(v * 10) / 10;
  const el: DrawEl = {
    kind: "draw",
    id: uid("d"),
    x: r(minX),
    y: r(minY),
    w: Math.max(1, r(maxX - minX)),
    h: Math.max(1, r(maxY - minY)),
    points: list.map(([x, y]) => [r(x - minX), r(y - minY)] as DrawPoint),
  };
  if (opts?.stroke) el.stroke = opts.stroke;
  if (opts?.strokeWidth !== undefined) el.strokeWidth = opts.strokeWidth;
  return el;
}

/**
 * 文档类型：新建时选定（白板=无限画布只编辑 objects；幻灯片=逐页编辑页框），
 * 入档 meta.kind，打开即按它决定界面，不再有运行时切换。
 */
export type DocKind = "board" | "deck" | "ui";

/**
 * 打开文档时的界面类型：优先文档自带的 meta.kind；老档缺失时按内容亲和推断
 * （纯页框→幻灯片，否则白板），保证历史档打开不"换壳"。
 */
export function docKindOf(doc: CanvasDoc): DocKind {
  if (doc.meta.kind === "board" || doc.meta.kind === "deck" || doc.meta.kind === "ui") return doc.meta.kind;
  if (doc.objects.length === 0 && doc.frames.length > 0) return "deck";
  return "board";
}

/** 新文档 = 空白板（objects/frames 皆空）：白板直接开画；幻灯片随后建首页 */
export function blankDoc(preset: PagePreset = "16:9", name = "演示文稿", kind: DocKind = "board"): CanvasDoc {
  return {
    version: DOC_VERSION,
    meta: { name, pagePreset: preset, kind },
    objects: [],
    frames: [],
  };
}

/* ---------------- 容错解析 ---------------- */

const num = (v: unknown, d = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d;
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const bool = (v: unknown): boolean => v === true;
const optNum = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const HEX = /^#[0-9a-fA-F]{3,8}$/;
const colorOr = (v: unknown, ok: (c: string) => boolean, d?: string): string | undefined => {
  if (typeof v !== "string") return d;
  return ok(v) ? v : d;
};

/**
 * CSS 颜色串是否偏暗：取首个 #rgb/#rrggbb/#rrggbbaa 的 RGB，按 Rec.709 亮度 < 0.45 判暗。
 * 用于新建元素默认色随页背景自适应（深色页给浅色线/字）。非颜色串按浅色。
 */
export function isDarkColor(css: string | undefined | null): boolean {
  const m = css ? /#([0-9a-f]{6}|[0-9a-f]{3})[0-9a-f]{0,2}(?![0-9a-f])/i.exec(css) : null;
  if (!m) return false;
  const h = m[1]!.length === 3 ? m[1]!.split("").map((c) => c + c).join("") : m[1]!;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.45;
}

function parseRun(r: unknown): TextRun | null {
  if (typeof r === "string") return { text: r };
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const text = str(o.text);
  if (!text && text !== "") return null;
  const run: TextRun = { text };
  if (bool(o.bold)) run.bold = true;
  if (bool(o.italic)) run.italic = true;
  if (bool(o.underline)) run.underline = true;
  const size = optNum(o.size);
  if (size !== undefined && size > 0 && size <= 400) run.size = size;
  const color = colorOr(o.color, (c) => HEX.test(c));
  if (color) run.color = color;
  const font = str(o.font);
  if (font && font.length <= 64) run.font = font;
  return run;
}

function baseGeom(o: Record<string, unknown>, idPrefix: string) {
  const opacity = optNum(o.opacity);
  return {
    id: str(o.id) || uid(idPrefix),
    x: num(o.x),
    y: num(o.y),
    w: Math.max(1, num(o.w, 100)),
    h: Math.max(1, num(o.h, 40)),
    opacity: opacity === undefined ? undefined : Math.min(1, Math.max(0, opacity)),
    rotation: optNum(o.rotation),
  };
}

const SHAPES = new Set([
  "rect",
  "diamond",
  "ellipse",
  "line",
  "arrow",
  "double-arrow",
  "triangle",
  "trapezoid",
  "pentagon",
  "hexagon",
  "star",
]);
const ALIGNS = new Set(["left", "center", "right"]);
const VALIGNS = new Set(["top", "middle", "bottom"]);
const FITS = new Set(["cover", "contain", "stretch"]);
const MERMAID_THEMES = new Set(["default", "dark", "neutral", "follow"]);

type Geom = ReturnType<typeof baseGeom>;

/** 几何基字段铺进元素；undefined 的可选键删除，保持 JSON 干净 */
function withGeom<T extends object>(el: T, g: Geom): T & Geom {
  const merged: Record<string, unknown> = { ...el } as Record<string, unknown>;
  for (const [k, v] of Object.entries(g)) if (v !== undefined) merged[k] = v;
  return merged as T & Geom;
}

function parseElBase(v: unknown): El | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const g = baseGeom(o, "e");
  if (o.kind === "text") {
    const runsRaw = Array.isArray(o.runs) ? o.runs : typeof o.text === "string" ? [o.text] : [];
    const runs = runsRaw.map(parseRun).filter((r): r is TextRun => !!r);
    if (runs.length === 0) runs.push({ text: "文本" });
    const el: TextEl = withGeom({ kind: "text" as const, runs, id: "", x: 0, y: 0, w: 0, h: 0 }, g) as TextEl;
    if (ALIGNS.has(str(o.align))) el.align = o.align as TextAlign;
    if (VALIGNS.has(str(o.vAlign))) el.vAlign = o.vAlign as TextVAlign;
    return el;
  }
  if (o.kind === "shape") {
    const fill = colorOr(o.fill, (c) => HEX.test(c) || c === "none");
    const stroke = colorOr(o.stroke, (c) => HEX.test(c) || c === "none");
    const sw = optNum(o.strokeWidth);
    const r = optNum(o.radius);
    // 历史兼容：curve-arrow（独立弧度箭头种类）已退役 → 迁移为普通 arrow + curve 弧度
    const legacyCurveShape = str(o.shape) === "curve-arrow";
    const shape: ShapeKind = legacyCurveShape ? "arrow" : SHAPES.has(str(o.shape)) ? (o.shape as ShapeKind) : "rect";
    // 绑定/弧度仅对线类形状有意义；容器解析在 syncBoundArrows，这里只透传 id
    const lineShape = shape === "line" || shape === "arrow" || shape === "double-arrow";
    const curve =
      typeof o.curve === "number" && Number.isFinite(o.curve)
        ? Math.max(-1, Math.min(1, o.curve))
        : legacyCurveShape
          ? 0.3 // 旧 curve-arrow 缺省弧度
          : undefined;
    // 折线点列仅线类透传；成立时弧度不再参与渲染，一并丢弃保持文档干净
    const pts = lineShape ? parseLinePts(o.pts) : undefined;
    const el: ShapeEl = withGeom(
      {
        kind: "shape" as const,
        shape,
        ...(fill ? { fill } : {}),
        ...(stroke ? { stroke } : {}),
        ...(sw !== undefined ? { strokeWidth: Math.min(40, Math.max(0, sw)) } : {}),
        ...(o.strokeStyle === "dashed" || o.strokeStyle === "dotted" || o.strokeStyle === "solid" ? { strokeStyle: o.strokeStyle as StrokeStyle } : {}),
        ...(typeof o.dir === "number" && o.dir >= 1 && o.dir <= 3 ? { dir: Math.trunc(o.dir) as LineDir } : {}),
        ...(pts ? {} : curve !== undefined ? { curve } : {}),
        ...(pts ? { pts } : {}),
        ...(lineShape && str(o.startBind) ? { startBind: str(o.startBind) } : {}),
        ...(lineShape && str(o.endBind) ? { endBind: str(o.endBind) } : {}),
        ...(r !== undefined ? { radius: Math.max(0, r) } : {}),
        id: "",
        x: 0,
        y: 0,
        w: 0,
        h: 0,
      },
      g,
    ) as ShapeEl;
    return el;
  }
  if (o.kind === "image") {
    const src = str(o.src);
    if (!src) return null;
    const r = optNum(o.radius);
    const el: ImageEl = withGeom(
      {
        kind: "image" as const,
        src,
        ...(FITS.has(str(o.fit)) ? { fit: o.fit as ImageFit } : {}),
        ...(r !== undefined ? { radius: Math.max(0, r) } : {}),
        id: "",
        x: 0,
        y: 0,
        w: 0,
        h: 0,
      },
      g,
    ) as ImageEl;
    return el;
  }
  if (o.kind === "mermaid") {
    const code = str(o.code);
    if (!code) return null;
    const el: MermaidEl = withGeom(
      {
        kind: "mermaid" as const,
        code,
        ...(MERMAID_THEMES.has(str(o.theme)) ? { theme: o.theme as MermaidTheme } : {}),
        id: "",
        x: 0,
        y: 0,
        w: 0,
        h: 0,
      },
      g,
    ) as MermaidEl;
    return el;
  }
  if (o.kind === "draw") {
    const points: DrawPoint[] = [];
    if (Array.isArray(o.points)) {
      for (const raw of o.points) {
        if (!Array.isArray(raw) || raw.length < 2) continue;
        const x = num(raw[0], NaN);
        const y = num(raw[1], NaN);
        if (Number.isFinite(x) && Number.isFinite(y)) points.push([x, y]);
        if (points.length >= DRAW_MAX_POINTS) break;
      }
    }
    if (points.length < 2) return null; // 少于两点不成线，丢弃
    const stroke = colorOr(o.stroke, (c) => HEX.test(c) || c === "none");
    const sw = optNum(o.strokeWidth);
    const el: DrawEl = withGeom(
      {
        kind: "draw" as const,
        points,
        ...(stroke ? { stroke } : {}),
        ...(sw !== undefined ? { strokeWidth: Math.min(40, Math.max(0.5, sw)) } : {}),
        id: "",
        x: 0,
        y: 0,
        w: 0,
        h: 0,
      },
      g,
    ) as DrawEl;
    return el;
  }
  if (o.kind === "embed") {
    const url = str(o.url).trim();
    if (!/^https?:\/\//i.test(url)) return null; // 只收 http(s) 绝对地址
    const title = str(o.title).slice(0, 120);
    const el: EmbedEl = withGeom(
      {
        kind: "embed" as const,
        url,
        ...(title ? { title } : {}),
        id: "",
        x: 0,
        y: 0,
        w: 0,
        h: 0,
      },
      g,
    ) as EmbedEl;
    return el;
  }
  if (o.kind === "svg") {
    const code = str(o.code).trim();
    // 宽松校验：成对的 svg 根标签即可，解析失败由渲染层兜底提示
    if (!/^<svg[\s>]/i.test(code) || !/<\/svg>\s*$/i.test(code)) return null;
    const el: SvgEl = withGeom(
      {
        kind: "svg" as const,
        code,
        id: "",
        x: 0,
        y: 0,
        w: 0,
        h: 0,
      },
      g,
    ) as SvgEl;
    return el;
  }
  if (o.kind === "table") {
    const rawRows = Array.isArray(o.rows) ? o.rows : [];
    const rows: string[][] = [];
    for (const r of rawRows) {
      if (!Array.isArray(r)) continue;
      rows.push(r.slice(0, TABLE_MAX_COLS).map((c) => str(c).slice(0, TABLE_MAX_CELL)));
      if (rows.length >= TABLE_MAX_ROWS) break;
    }
    if (rows.length === 0) rows.push(...DEFAULT_TABLE_ROWS);
    const colW = Array.isArray(o.colWidths)
      ? o.colWidths
          .map((n) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0))
          .filter((n) => n > 0)
          .slice(0, TABLE_MAX_COLS)
      : [];
    const fill = colorOr(o.fill, (c) => HEX.test(c));
    const headerFill = colorOr(o.headerFill, (c) => HEX.test(c));
    const stroke = colorOr(o.stroke, (c) => HEX.test(c));
    const color = colorOr(o.color, (c) => HEX.test(c));
    const size = optNum(o.size);
    const el: TableEl = withGeom(
      {
        kind: "table" as const,
        rows,
        ...(colW.length > 0 ? { colWidths: colW } : {}),
        ...(o.header === false ? { header: false } : {}),
        ...(size !== undefined ? { size: Math.min(96, Math.max(8, size)) } : {}),
        ...(fill ? { fill } : {}),
        ...(headerFill ? { headerFill } : {}),
        ...(stroke ? { stroke } : {}),
        ...(color ? { color } : {}),
        id: "",
        x: 0,
        y: 0,
        w: 0,
        h: 0,
      },
      g,
    ) as TableEl;
    return el;
  }
  if (o.kind === "chart") {
    const labels = (Array.isArray(o.labels) ? o.labels : [])
      .slice(0, 50)
      .map((l) => str(l).slice(0, 40))
      .filter((l) => l.length > 0);
    const series: ChartSeries[] = [];
    if (Array.isArray(o.series)) {
      for (const s of o.series) {
        if (!s || typeof s !== "object") continue;
        const so = s as Record<string, unknown>;
        const data: number[] = [];
        if (Array.isArray(so.data)) {
          for (const d of so.data) {
            const n = typeof d === "number" ? d : Number(str(d));
            if (Number.isFinite(n)) data.push(n);
            if (data.length >= 200) break;
          }
        }
        if (data.length > 0) series.push({ name: str(so.name, "系列").slice(0, 60), data });
        if (series.length >= 10) break;
      }
    }
    if (labels.length === 0 || series.length === 0) return null;
    const colors = Array.isArray(o.colors)
      ? o.colors.filter((c): c is string => typeof c === "string" && HEX.test(c)).slice(0, 16)
      : [];
    const kind = CHART_KINDS.includes(str(o.chart) as ChartKind) ? (str(o.chart) as ChartKind) : undefined;
    const size = optNum(o.size);
    const el: ChartEl = withGeom(
      {
        kind: "chart" as const,
        labels,
        series,
        ...(kind ? { chart: kind } : {}),
        ...(colors.length > 0 ? { colors } : {}),
        ...(o.showLegend === true ? { showLegend: true } : {}),
        ...(size !== undefined ? { size: Math.min(48, Math.max(6, size)) } : {}),
        id: "",
        x: 0,
        y: 0,
        w: 0,
        h: 0,
      },
      g,
    ) as ChartEl;
    return el;
  }
  return null;
}

/** 解析包装：基础字段 + groupId（编辑组，一层不嵌套，导出无感知） */
function parseEl(v: unknown): El | null {
  const el = parseElBase(v);
  if (!el) return null;
  const raw = (v as Record<string, unknown>).groupId;
  const gid = typeof raw === "string" ? raw.trim().slice(0, 64) : "";
  if (gid) (el as { groupId?: string }).groupId = gid;
  return el;
}

/** v1 的 slide 与 v2 的 frame 形状兼容（缺 x/y 落 0，迁移路径统一 tidy 落位） */
function parseFrame(v: unknown): Frame | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const w = Math.min(8000, Math.max(100, num(o.w, 1280)));
  const h = Math.min(8000, Math.max(100, num(o.h, 720)));
  const bg = str(o.background, "#ffffff");
  const name = str(o.name);
  const elementsRaw = Array.isArray(o.elements) ? o.elements : [];
  const tr = (SLIDE_TRANSITIONS as readonly string[]).includes(typeof o.transition === "string" ? o.transition : "")
    ? (o.transition as SlideTransition)
    : undefined;
  return {
    id: str(o.id) || uid("s"),
    x: num(o.x),
    y: num(o.y),
    w,
    h,
    type: "slide",
    ...(name ? { name } : {}),
    background: HEX.test(bg) || bg.includes("gradient") ? bg : "#ffffff",
    ...(tr && tr !== "slide" ? { transition: tr } : {}), // 缺省即 slide，避免存量文档多写一个键
    elements: elementsRaw.map(parseEl).filter((e): e is El => !!e),
  };
}

/** 任意 JSON → CanvasDoc（含 v1→v2 迁移）；null = 根本不是文档对象（新建/报错由调用方决定） */
export function parseDoc(json: unknown): CanvasDoc | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const meta = (o.meta ?? {}) as Record<string, unknown>;
  const preset = (["16:9", "4:3", "A4L"] as const).find((p) => p === meta.pagePreset) ?? "16:9";
  const base = {
    version: DOC_VERSION,
    meta: {
      name: str(meta.name, "演示文稿"),
      pagePreset: preset,
      ...(meta.kind === "board" || meta.kind === "deck" || meta.kind === "ui" ? { kind: meta.kind as DocKind } : {}),
    },
  };
  if (Array.isArray(o.frames)) {
    const frames = o.frames.map(parseFrame).filter((f): f is Frame => !!f);
    const objects = (Array.isArray(o.objects) ? o.objects : [])
      .map(parseEl)
      .filter((e): e is El => !!e);
    return { ...base, objects, frames };
  }
  if (Array.isArray(o.slides)) {
    // v1 迁移：slides → frames，等距网格落位后持久化（此后位置由用户拖拽决定）
    const frames = o.slides.map(parseFrame).filter((f): f is Frame => !!f);
    return tidyLayout({ ...base, objects: [], frames });
  }
  return null;
}

/* ---------------- 几何 ---------------- */

export type Box = { x: number; y: number; w: number; h: number };

export const elBox = (el: El): Box => ({ x: el.x, y: el.y, w: el.w, h: el.h });

export function serializeDoc(doc: CanvasDoc): string {
  return JSON.stringify(doc, null, 2);
}

/** 放映/导出的页序：只认 type:"slide" 的页框，数组序=页序 */
export const slideFrames = (doc: CanvasDoc): Frame[] => doc.frames.filter((f) => f.type === "slide");

/** 换页尺寸：所有页框内元素按中心保持、x/y/w/h 同比缩放；objects 与框位置不动 */
export function resizeFrames(doc: CanvasDoc, preset: PagePreset): CanvasDoc {
  const { w, h } = PAGE_SIZES[preset];
  return {
    ...doc,
    meta: { ...doc.meta, pagePreset: preset },
    frames: doc.frames.map((f) => {
      const fx = w / f.w;
      const fy = h / f.h;
      return {
        ...f,
        w,
        h,
        elements: f.elements.map((el) => ({
          ...el,
          x: Math.round(el.x * fx),
          y: Math.round(el.y * fy),
          w: Math.max(1, Math.round(el.w * fx)),
          h: Math.max(1, Math.round(el.h * fy)),
        })),
      };
    }),
  };
}
