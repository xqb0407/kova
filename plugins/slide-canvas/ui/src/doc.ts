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

export type ShapeKind = "rect" | "ellipse" | "line" | "arrow";

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

export type El = TextEl | ShapeEl | ImageEl | MermaidEl | DrawEl;

/** 目前唯一的框类型：PPT 页。未来扩新框型时导出/放映只认 "slide" */
export type FrameType = "slide";

export type Frame = {
  id: string;
  x: number; // 画布绝对坐标
  y: number;
  w: number;
  h: number;
  type: FrameType;
  name?: string; // 标签（缩略图/画布角标），缺省显示页码
  background: string; // #rrggbb 或 CSS 渐变串（导出时降级为纯色）
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
  meta: { name: string; pagePreset: PagePreset };
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

export function blankDoc(preset: PagePreset = "16:9", name = "演示文稿"): CanvasDoc {
  return {
    version: DOC_VERSION,
    meta: { name, pagePreset: preset },
    objects: [],
    frames: [blankFrame(preset, { x: TIDY_PAD, y: TIDY_PAD })],
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

const SHAPES = new Set(["rect", "ellipse", "line", "arrow"]);
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

function parseEl(v: unknown): El | null {
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
    const el: ShapeEl = withGeom(
      {
        kind: "shape" as const,
        shape: SHAPES.has(str(o.shape)) ? (o.shape as ShapeKind) : "rect",
        ...(fill ? { fill } : {}),
        ...(stroke ? { stroke } : {}),
        ...(sw !== undefined ? { strokeWidth: Math.min(40, Math.max(0, sw)) } : {}),
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
  return null;
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
  return {
    id: str(o.id) || uid("s"),
    x: num(o.x),
    y: num(o.y),
    w,
    h,
    type: "slide",
    ...(name ? { name } : {}),
    background: HEX.test(bg) || bg.includes("gradient") ? bg : "#ffffff",
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
    meta: { name: str(meta.name, "演示文稿"), pagePreset: preset },
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
