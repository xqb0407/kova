/**
 * leafer/scene.ts：DesignDoc 节点树 → leafer 场景规格（纯函数，无 leafer/DOM 依赖，可单测）。
 *
 * 输出的 SceneNode 树用 leafer 属性名书写（group/rect/ellipse/path/line/image/text），
 * DesignStage 只做 tag→class 映射 + 按 key diff patch（命令式，引用稳定）。
 *
 * 坐标/变换契约（回写收敛的地基，与 ledger.ts 互逆）：
 *  ① 每个设计节点的根 group 恒 `around:"center"`、显式 width/height；
 *     x = 父盒左上角基准局部坐标 + w/2（即外接框中心落在父内层空间的位置）。
 *  ② rotation/scaleX/scaleY/skewX/skewY 恒全量给出：editor 的 TransformTool 直接乘写，
 *     恒等值不进 spec 就清不掉编辑器残留变换（提交后画面跳变）。
 *  ③ editable 只打在节点根 group：命中任何视觉子件都会爬回根 group（editor 选择轨）；
 *     locked 节点 editable:false（画布不可选，图层面板仍可选）。
 *  ④ 容器（frame/group）根 group hitChildren:false：点容器空白处选容器本身，点中子节点
 *     选子节点；双击 deep-select 交 @leafer-in/editor 的 openInner 钻入。
 *
 * 多填充/多描边：同几何逐层叠绘（leafer 每元素一个 fill/stroke）。
 */
import {
  HAS_FILL_BOX,
  type DesignNode,
  type Effect,
  type Fill,
  type GradientStop,
  type LineDir,
  type Page,
  type Stroke,
  type TextRun,
} from "../doc";

export type MeasureFn = (text: string, fontCss: string) => { width: number; ascent: number; descent: number };
export type AssetView = { status: "loading" } | { status: "ready"; url: string } | { status: "missing" };

export type SceneCtx = {
  measure: MeasureFn;
  asset: (path: string) => AssetView;
  /** 画布底色（frame 无填充时的对照）；仅占位，节点自身不画底 */
};

export type SceneTag = "group" | "rect" | "ellipse" | "path" | "line" | "image" | "text";

export type SceneNode = {
  tag: SceneTag;
  /** 全局唯一稳定 key：元素根 = node.id；子视觉件 = node.id#… */
  key: string;
  props: Record<string, unknown>;
  children?: SceneNode[];
};

const FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif";
const LINE_HEIGHT = 1.4;

/** leafer 基线偏移：Text（lineHeight=fs）基线落在 y + 0.85fs，反推 CSS 基线对齐 */
const BASELINE_K = 0.85;

/* ---------------- 填充 → leafer paint ---------------- */

function stopArr(stops: GradientStop[]): { offset: number; color: string }[] {
  return stops.map((s) => ({ offset: s.at, color: s.color }));
}

/** 单个 Fill → leafer paint 对象（含 opacity；不可见返回 null，调用方已过滤，这里兜底） */
export function fillToPaint(f: Fill): Record<string, unknown> | null {
  if (f.visible === false) return null;
  const op = f.opacity !== undefined && f.opacity < 1 ? f.opacity : undefined;
  if (f.type === "solid") return { type: "solid", color: f.color ?? "#000000", ...(op !== undefined ? { opacity: op } : {}) };
  if (f.type === "linear") {
    const a = ((f.angle ?? 270) * Math.PI) / 180; // 0=自上而下 → 单位方向 (−sin, cos)
    const sx = Math.sin(a) / 2;
    const cy = Math.cos(a) / 2;
    return {
      type: "linear",
      from: { x: 0.5 + sx, y: 0.5 + cy },
      to: { x: 0.5 - sx, y: 0.5 - cy },
      stops: stopArr(f.stops ?? []),
      ...(op !== undefined ? { opacity: op } : {}),
    };
  }
  const c = f.center ?? { x: 0.5, y: 0.5 };
  return {
    type: "radial",
    from: { x: c.x, y: c.y },
    to: { x: c.x + 0.5, y: c.y + 0.5 },
    stops: stopArr(f.stops ?? []),
    ...(op !== undefined ? { opacity: op } : {}),
  };
}

/* ---------------- 描边 → 视觉件属性 ---------------- */

const DASH: Record<NonNullable<Stroke["style"]>, number[] | undefined> = {
  solid: undefined,
  dashed: [6, 4],
  dotted: [2, 3],
};

function strokeProps(s: Stroke): Record<string, unknown> | null {
  if (s.visible === false || s.width <= 0) return null;
  const dash = DASH[s.style ?? "solid"];
  return {
    stroke: s.color,
    strokeWidth: s.width,
    strokeAlign: s.align ?? "center",
    ...(dash ? { dashPattern: dash } : {}),
  };
}

/* ---------------- 效果 → shadow / innerShadow ---------------- */

export function effectsToProps(effects?: Effect[]): Record<string, unknown> {
  if (!effects || effects.length === 0) return {};
  const drop: unknown[] = [];
  const inner: unknown[] = [];
  for (const e of effects) {
    if (e.visible === false) continue;
    if (e.type === "drop-shadow") drop.push({ x: e.x, y: e.y, blur: e.blur, color: e.color });
    else if (e.type === "inner-shadow") inner.push({ x: e.x, y: e.y, blur: e.blur, color: e.color });
    // layer-blur：leafer 原生 blur 需 filter 支持，v1 暂不渲染（保留在模型）
  }
  const out: Record<string, unknown> = {};
  if (drop.length) out.shadow = drop.length === 1 ? drop[0] : drop;
  if (inner.length) out.innerShadow = inner.length === 1 ? inner[0] : inner;
  return out;
}

/* ---------------- 圆角 ---------------- */

export function radiusProp(n: DesignNode): number | number[] | undefined {
  if (n.radius === undefined) return undefined;
  return n.radius;
}

/* ---------------- 多边形路径 ---------------- */

function nGon(w: number, h: number, sides: number, startDeg: number): string {
  const cx = w / 2;
  const cy = h / 2;
  const pts: string[] = [];
  for (let i = 0; i < sides; i++) {
    const a = ((startDeg + (360 / sides) * i) * Math.PI) / 180;
    pts.push(`${(cx + cx * Math.cos(a)).toFixed(2)},${(cy + cy * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join(" L")} Z`;
}

function starPath(w: number, h: number): string {
  const cx = w / 2;
  const cy = h / 2;
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 1 : 0.4;
    const a = ((-90 + i * 36) * Math.PI) / 180;
    pts.push(`${(cx + cx * r * Math.cos(a)).toFixed(2)},${(cy + cy * r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join(" L")} Z`;
}

function diamondPath(w: number, h: number): string {
  return `M${(w / 2).toFixed(2)},0 L${w.toFixed(2)},${(h / 2).toFixed(2)} L${(w / 2).toFixed(2)},${h} L0,${(h / 2).toFixed(2)} Z`;
}

function trianglePath(w: number, h: number): string {
  return `M${(w / 2).toFixed(2)},0 L${w.toFixed(2)},${h.toFixed(2)} L0,${h.toFixed(2)} Z`;
}

/** 形状类型 → path d（无则 null = 用原生 rect/ellipse） */
export function shapePath(type: string, w: number, h: number): string | null {
  switch (type) {
    case "triangle":
      return trianglePath(w, h);
    case "diamond":
      return diamondPath(w, h);
    case "pentagon":
      return nGon(w, h, 5, -90);
    case "hexagon":
      return nGon(w, h, 6, -90);
    case "star":
      return starPath(w, h);
    default:
      return null;
  }
}

/* ---------------- 文本排版（DOM break-word 语义复刻） ---------------- */

type RunSpec = {
  text: string;
  color: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  font: string;
};

const CJK = /[⺀-鿿豈-﫿︰-﹏＀-｠　-〿]/;

function* tokenize(s: string): Generator<string> {
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (/\s/.test(ch) || CJK.test(ch)) {
      yield ch;
      i++;
      continue;
    }
    const start = i;
    while (i < s.length && !/\s/.test(s[i]!) && !CJK.test(s[i]!)) i++;
    yield s.slice(start, i);
  }
}

function fontCssOf(r: RunSpec): string {
  return `${r.italic ? "italic " : ""}${r.bold ? "700 " : ""}${r.fontSize}px ${r.font}`;
}

export type TextFrag = { text: string; x: number; baseline: number; run: RunSpec };

/** 盒宽内贪心折行 + CSS 行盒模型（ascent/descent 共享基线），水平/垂直对齐 */
export function layoutText(
  runs: RunSpec[],
  w: number,
  h: number,
  align: "left" | "center" | "right",
  vAlign: "top" | "middle" | "bottom",
  lineHeightMul: number,
  measure: MeasureFn,
): TextFrag[] {
  type Item = { run: RunSpec; text: string; width: number };
  type Line = { items: Item[]; width: number; above: number; below: number };
  const lines: Line[] = [];
  let line: Line = { items: [], width: 0, above: 0, below: 0 };
  const flush = () => {
    lines.push(line);
    line = { items: [], width: 0, above: 0, below: 0 };
  };
  const grow = (r: RunSpec) => {
    const lh = r.fontSize * lineHeightMul;
    const m = measure("", fontCssOf(r));
    const above = (lh + m.ascent - m.descent) / 2;
    const below = (lh - m.ascent + m.descent) / 2;
    if (above > line.above) line.above = above;
    if (below > line.below) line.below = below;
  };
  const push = (r: RunSpec, text: string, width: number) => {
    line.items.push({ run: r, text, width });
    grow(r);
    line.width += width;
  };
  let touched = false;

  for (const r of runs) {
    const css = fontCssOf(r);
    r.text.split("\n").forEach((para, pi) => {
      if (pi > 0) flush();
      touched = true;
      if (para === "") {
        grow(r);
        return;
      }
      for (const tok of tokenize(para)) {
        let text = tok;
        let tw = measure(text, css).width;
        if (line.items.length > 0 && line.width + tw > w) flush();
        while (tw > w) {
          let cut = Math.max(1, text.length - 1);
          while (cut > 1 && measure(text.slice(0, cut), css).width > w) cut--;
          const head = text.slice(0, cut);
          push(r, head, measure(head, css).width);
          text = text.slice(cut);
          tw = measure(text, css).width;
          if (tw > w) flush();
        }
        if (text === "") continue;
        if (line.items.length > 0 && line.width + tw > w) flush();
        push(r, text, tw);
      }
    });
  }
  if (touched && (line.items.length > 0 || line.above + line.below > 0)) flush();
  if (lines.length === 0) return [];

  const total = lines.reduce((s, l) => s + l.above + l.below, 0);
  let y = 0;
  if (vAlign === "middle") y = (h - total) / 2;
  else if (vAlign === "bottom") y = h - total;
  const frags: TextFrag[] = [];
  for (const l of lines) {
    let x = 0;
    if (align === "center") x = (w - l.width) / 2;
    else if (align === "right") x = w - l.width;
    const baseline = y + l.above;
    for (const it of l.items) {
      frags.push({ text: it.text, x, baseline, run: it.run });
      x += it.width;
    }
    y += l.above + l.below;
  }
  return frags;
}

export function runsToSpec(runs: TextRun[]): RunSpec[] {
  return runs.map((r) => ({
    text: r.text,
    color: r.color ?? "#111111",
    fontSize: r.size ?? 14,
    bold: (r.weight ?? 400) >= 600,
    italic: !!r.italic,
    font: r.font ?? FONT_STACK,
  }));
}

/* ---------------- 线端点 ---------------- */

const DIR_CORNERS: Record<LineDir, [[number, number], [number, number]]> = {
  0: [[0, 0], [1, 1]],
  1: [[0, 1], [1, 0]],
  2: [[1, 1], [0, 0]],
  3: [[1, 0], [0, 1]],
};

/** line/arrow：盒局部起终点角（比例 × 盒宽高）；arrow 头在终点 */
export function lineEnds(
  dir: LineDir,
  w: number,
  h: number,
): { x1: number; y1: number; x2: number; y2: number } {
  const [s, e] = DIR_CORNERS[dir];
  return { x1: s[0] * w, y1: s[1] * h, x2: e[0] * w, y2: e[1] * h };
}

/** 箭头实心头路径（终点处，随 stroke 着色，fill） */
export function arrowHeadPath(x2: number, y2: number, x1: number, y1: number, size: number): string {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const a1 = ang + Math.PI - 0.42;
  const a2 = ang + Math.PI + 0.42;
  const p1x = x2 + size * Math.cos(a1);
  const p1y = y2 + size * Math.sin(a1);
  const p2x = x2 + size * Math.cos(a2);
  const p2y = y2 + size * Math.sin(a2);
  return `M${x2.toFixed(2)},${y2.toFixed(2)} L${p1x.toFixed(2)},${p1y.toFixed(2)} L${p2x.toFixed(2)},${p2y.toFixed(2)} Z`;
}

/* ---------------- 节点根 group 属性 ---------------- */

function rootGroupProps(node: DesignNode, container: boolean, clip = false): Record<string, unknown> {
  return {
    x: node.x + node.w / 2,
    y: node.y + node.h / 2,
    width: node.w,
    height: node.h,
    around: "center",
    rotation: node.rotation || 0,
    scaleX: 1,
    scaleY: 1,
    skewX: 0,
    skewY: 0,
    opacity: node.opacity ?? 1,
    visible: node.visible !== false,
    editable: !node.locked,
    ...(container ? { hitChildren: false } : {}),
    // 画板裁切（clip:false 显式放行）：溢出内容不可见也不参与命中
    ...(clip ? { overflow: "hide" } : {}),
  };
}

/** 逐层叠绘同几何视觉件（fills 各一 + strokes 各一），返回子节点数组 */
function paintChildren(
  id: string,
  kind: "rect" | "ellipse" | "path",
  node: DesignNode,
  fills: Fill[],
  strokes: Stroke[],
  d?: string,
): SceneNode[] {
  const out: SceneNode[] = [];
  // 内层原点 = 节点盒左上角（around 只重释 x/y 语义，不移子空间）→ 一律 x:0,y:0
  const geo: Record<string, unknown> =
    kind === "path" ? { x: 0, y: 0, path: d } : { x: 0, y: 0, width: node.w, height: node.h };
  const rad = radiusProp(node);
  if (kind !== "path" && rad !== undefined) geo.cornerRadius = rad;
  const fx = effectsToProps(node.effects);
  fills.forEach((f, i) => {
    const paint = fillToPaint(f);
    if (!paint) return;
    out.push({ tag: kind, key: `${id}#f${i}`, props: { ...geo, fill: paint, ...fx } });
  });
  strokes.forEach((s, i) => {
    const sp = strokeProps(s);
    if (!sp) return;
    out.push({ tag: kind, key: `${id}#s${i}`, props: { ...geo, ...sp } });
  });
  return out;
}

/* ---------------- 主构建 ---------------- */

function buildNode(node: DesignNode, ctx: SceneCtx): SceneNode {
  if (node.type === "group") {
    const children = node.children.map((c) => buildNode(c, ctx));
    return { tag: "group", key: node.id, props: rootGroupProps(node, true), children };
  }
  if (node.type === "frame") {
    const kids: SceneNode[] = [];
    // frame 底色/描边（Figma：frame 自身可填色）
    if (HAS_FILL_BOX.frame) {
      kids.push(...paintChildren(`${node.id}`, "rect", node, node.fills, node.strokes ?? []));
    }
    for (const c of node.children) kids.push(buildNode(c, ctx));
    return { tag: "group", key: node.id, props: rootGroupProps(node, true, node.clip !== false), children: kids };
  }
  if (node.type === "text") {
    const frags = layoutText(
      runsToSpec(node.runs),
      node.w,
      node.h,
      node.align ?? "left",
      node.vAlign ?? "top",
      node.lineHeight ?? LINE_HEIGHT,
      ctx.measure,
    );
    const children: SceneNode[] = frags.map((f, i) => ({
      tag: "text",
      key: `${node.id}#t${i}`,
      props: {
        x: f.x,
        y: f.baseline - f.run.fontSize * BASELINE_K,
        text: f.text,
        fontSize: f.run.fontSize,
        lineHeight: f.run.fontSize,
        fill: f.run.color,
        fontFamily: f.run.font,
        ...(f.run.bold ? { fontWeight: 700 } : {}),
        ...(f.run.italic ? { italic: true } : {}),
        ...(node.letterSpacing ? { letterSpacing: node.letterSpacing } : {}),
      },
    }));
    // 无折行内容也放一个空占位保证 key 稳定
    if (children.length === 0) children.push({ tag: "text", key: `${node.id}#t0`, props: { text: "", opacity: 0 } });
    return { tag: "group", key: node.id, props: rootGroupProps(node, false), children };
  }
  if (node.type === "image") {
    const view = ctx.asset(node.src);
    const children: SceneNode[] = [];
    const rad = radiusProp(node);
    if (view.status === "ready") {
      children.push({
        tag: "rect",
        key: `${node.id}#img`,
        props: {
          x: 0,
          y: 0,
          width: node.w,
          height: node.h,
          ...(rad !== undefined ? { cornerRadius: rad } : {}),
          fill: { type: "image", url: view.url, mode: node.fit === "contain" ? "fit" : node.fit === "stretch" ? "stretch" : "cover" },
          ...effectsToProps(node.effects),
        },
      });
    } else {
      const label = view.status === "loading" ? "加载中…" : "图片缺失";
      children.push({ tag: "rect", key: `${node.id}#img-ph`, props: { x: 0, y: 0, width: node.w, height: node.h, fill: "#f1f3f5", ...(rad !== undefined ? { cornerRadius: rad } : {}) } });
      const fs = Math.min(16, Math.max(10, node.w / 14));
      children.push({
        tag: "text",
        key: `${node.id}#img-lb`,
        props: { x: 0, y: 0, width: node.w, height: node.h, text: label, textAlign: "center", verticalAlign: "middle", fontSize: fs, lineHeight: fs, fill: "#9aa0a6" },
      });
    }
    (node.strokes ?? []).forEach((s, i) => {
      const sp = strokeProps(s);
      if (sp) children.push({ tag: "rect", key: `${node.id}#s${i}`, props: { x: 0, y: 0, width: node.w, height: node.h, ...(rad !== undefined ? { cornerRadius: rad } : {}), ...sp } });
    });
    return { tag: "group", key: node.id, props: rootGroupProps(node, false), children };
  }
  if (node.type === "line" || node.type === "arrow") {
    const { x1, y1, x2, y2 } = lineEnds((node.dir ?? 0) as LineDir, node.w, node.h);
    const children: SceneNode[] = [];
    const strokes = node.strokes.length ? node.strokes : [{ color: "#111111", width: 2 }];
    strokes.forEach((s, i) => {
      const sp = strokeProps(s);
      if (!sp) return;
      // leafer Line：points 相对自身原点，原点摆在盒左上角
      children.push({ tag: "line", key: `${node.id}#l${i}`, props: { x: 0, y: 0, points: [x1, y1, x2, y2], ...sp } });
      if (node.type === "arrow") {
        const head = arrowHeadPath(x2, y2, x1, y1, Math.max(6, s.width * 3));
        children.push({ tag: "path", key: `${node.id}#h${i}`, props: { x: 0, y: 0, path: head, fill: s.color } });
      }
    });
    return { tag: "group", key: node.id, props: rootGroupProps(node, false), children };
  }
  // 形状：rect/ellipse/多边形（此分支 node 必为 ShapeNode；前面各类型均已 return）
  const shape = node as Extract<DesignNode, { fills: Fill[]; strokes: Stroke[] }> & { type: string };
  const d = shapePath(shape.type, node.w, node.h);
  const kind: "rect" | "ellipse" | "path" = d ? "path" : shape.type === "ellipse" ? "ellipse" : "rect";
  const children = paintChildren(shape.id, kind, shape, shape.fills, shape.strokes);
  return { tag: "group", key: node.id, props: rootGroupProps(node, false), children };
}

/** 页面 → 顶层节点场景列表（各自带局部坐标，落在 world group 内） */
export function buildPageScene(page: Page, ctx: SceneCtx): SceneNode[] {
  return page.nodes.map((n) => buildNode(n, ctx));
}
