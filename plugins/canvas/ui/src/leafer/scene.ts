/**
 * leafer/scene.ts：doc → 场景节点规格（纯函数、无 leafer/DOM 依赖，可单测）。
 *
 * 输出的 SceneNode 树用 leafer 节点的属性名书写（rect/ellipse/line/path/image/text/box/group），
 * LeaferStage 只做 tag → class 映射 + 按 key diff patch。视觉派生一律走 viewspec，
 * 与 DOM 渲染器同源；文本换行/行排在 DOM 语义下自行测量排版（leafer-ui 无富文本 Span）。
 */
import { isAnimatedSvg, mermaidErrorText } from "../mermaid";
import { PROVIDER_LABELS, resolveEmbed } from "../providers";
import { type CanvasDoc, type El, type EmbedEl, type ImageEl, type MermaidEl, type ShapeEl, type SvgEl, type TableEl, type TextEl } from "../doc";
import {
  pathMidpoint,
  FONT_STACK,
  TEXT_LINE_HEIGHT,
  chartSpec,
  drawSpec,
  elBox,
  imageFit,
  lineEnds,
  curveArrow,
  isPolyline,
  polyLocal,
  POLY_SHAPES,
  polygonPoints,
  resolveRuns,
  shapeSpec,
  strokeDash,
  tableSpec,
  textLayout,
  type ChartPrim,
  type PolyShape,
  type RunSpec,
} from "../viewspec";

/* ---------------- 类型 ---------------- */

export type MeasureFn = (text: string, fontCss: string) => { width: number; ascent: number; descent: number };

export type AssetView = { status: "loading" } | { status: "ready"; url: string } | { status: "missing" };
export type MermaidView =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; url: string };
/** svg 源码元素的光栅化视图（Leafer 轨经 <img> 光栅化后贴图，同 mermaid 管线） */
export type SvgView = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; url: string };

export type SceneChrome = {
  /** 选择系墨色（--ink）：editor 轨选择框/把手描边，与 DOM 轨 .sc-selbox 同色 */
  ink: string;
};

export type SceneCtx = {
  measure: MeasureFn;
  asset: (path: string) => AssetView;
  mermaid: (el: MermaidEl) => MermaidView;
  svg: (el: SvgEl) => SvgView;
  chrome: SceneChrome;
  /** 当前视口缩放（draw 非缩放描边补偿用） */
  zoom: number;
};

export type SceneTag = "group" | "box" | "rect" | "ellipse" | "line" | "path" | "image" | "text";

export type SceneNode = {
  tag: SceneTag;
  /** 全局唯一、稳定：patch diff 的 key（元素级 = el.id；子节点 = el.id#…） */
  key: string;
  props: Record<string, unknown>;
  children?: SceneNode[];
};

/* ---------------- 文本排版（DOM 语义复刻） ----------------
 * 对齐 render.tsx TextElView：盒宽内换行（word-break: break-word）、pre-wrap 保留
 * \n 与空格、CSS 行盒模型（行盒 = 各 run 半距盒堆叠 above+below，基线共享）、
 * 水平 align 作用于每行、垂直 vAlign 作用于整段。 */

/** baseline = 段落盒顶到该行基线的距离（leafer 侧再按 0.85fs 反推节点 y） */
export type TextFrag = { text: string; x: number; baseline: number; run: RunSpec };

/** CJK 及全角标点：逐字可断 */
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u3000-\u303f]/;

/** 词切分：空白逐字符（pre-wrap 保留每个空格）；CJK 逐字；其余按词不可断 */
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

export function fontCssOf(r: RunSpec): string {
  return `${r.italic ? "italic " : ""}${r.bold ? "700 " : ""}${r.fontSize}px ${r.fontFamily}`;
}

export function layoutTextRuns(
  runs: RunSpec[],
  w: number,
  h: number,
  align: "left" | "center" | "right",
  vAlign: "top" | "middle" | "bottom",
  measure: MeasureFn,
): TextFrag[] {
  type Item = { run: RunSpec; text: string; width: number };
  /** CSS 行盒：above = 基线以上最大贡献，below = 基线以下最大贡献（各 run 半距模型取最大） */
  type Line = { items: Item[]; width: number; above: number; below: number };
  const lines: Line[] = [];
  let line: Line = { items: [], width: 0, above: 0, below: 0 };
  const flush = () => {
    lines.push(line);
    line = { items: [], width: 0, above: 0, below: 0 };
  };
  const grow = (r: RunSpec) => {
    const lh = r.fontSize * TEXT_LINE_HEIGHT;
    const m = measure("", fontCssOf(r));
    const above = (lh + m.ascent - m.descent) / 2;
    const below = (lh - m.ascent + m.descent) / 2;
    if (above > line.above) line.above = above;
    if (below > line.below) line.below = below;
  };
  const pushItem = (r: RunSpec, text: string, width: number) => {
    line.items.push({ run: r, text, width });
    grow(r);
    line.width += width;
  };
  let touched = false;

  for (const r of runs) {
    const css = fontCssOf(r);
    const paras = r.text.split("\n");
    paras.forEach((para, pi) => {
      if (pi > 0) flush();
      touched = true;
      if (para === "") {
        // 空段落仍占一行行高（pre-wrap 语义）
        grow(r);
        return;
      }
      for (const tok of tokenize(para)) {
        let text = tok;
        let tw = measure(text, css).width;
        if (line.items.length > 0 && line.width + tw > w) flush();
        // 单词比盒宽还长：逐字符硬断（break-word），每行至少保留一个字符
        while (tw > w) {
          // cut 下限 1：单字符超宽时 text.length-1 = 0 会切出空 head、text 永不缩短（死循环）
          let cut = Math.max(1, text.length - 1);
          while (cut > 1 && measure(text.slice(0, cut), css).width > w) cut--;
          const head = text.slice(0, cut);
          pushItem(r, head, measure(head, css).width);
          text = text.slice(cut);
          tw = measure(text, css).width;
          if (tw > w) flush();
        }
        // 硬断收尾：head 可能已把行填满，余字另起一行（DOM 贪心逐行语义）
        if (text === "") continue; // 单字符超宽已被 head 吃完（cut 下限 1），别补空 frag
        if (line.items.length > 0 && line.width + tw > w) flush();
        pushItem(r, text, tw);
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
    const baseline = y + l.above; // 同行所有 run 共享基线
    for (const it of l.items) {
      frags.push({ text: it.text, x, baseline, run: it.run });
      x += it.width;
    }
    y += l.above + l.below;
  }
  return frags;
}

/** 便捷：从 TextEl 直接排版（盒尺寸取 elBox） */
export function layoutTextEl(el: TextEl, measure: MeasureFn): TextFrag[] {
  const b = elBox(el);
  const { align, vAlign } = textLayout(el);
  return layoutTextRuns(resolveRuns(el), b.w, b.h, align, vAlign, measure);
}

/* ---------------- 元素 → 节点 ---------------- */

/** 元素根 group 的公共属性 —— editor 轨的"恒等变换契约"，回写收敛的地基：
 * ① around 恒 center 且 x/y = 外接框中心（leafer 的 around 语义：x,y 是该锚点的落位，
 *    经 @leafer/math setLayout/getLayout 互逆证实）；旋转因此绕盒心，与 DOM 轨
 *    transform-origin:center 对齐（旧写法 x=el.x 会让旋转元素偏移半个盒）。
 * ② scaleX/scaleY/skew/rotation 恒全量给出：editor 的 TransformTool 直接乘写节点
 *    scaleX/rotation，而 LeaferStage 的 setNodeProps 只清理 oldProps 出现过的键——
 *    恒等值不进 spec，提交后就清不掉编辑器残留变换（回写后画面跳变）。
 * ③ editable:true 是 @leafer-in/editor 选择轨的开关：editor 的 findOne 只认
 *    leaf.editable（UI 默认 false），子节点不带该标记 → 点中任何笔划都会爬到元素根组。
 * ④ deckClamp = dragBounds:"parent"：页内拖拽限幅（core DragHelper 用父 #clip 的
 *    boxBounds 夹取移动），白板 objects 不夹（父层无界）。
 * DOM 交互轨不读这些属性，两轨互不影响。 */
function commonBoxProps(el: El, deckClamp: boolean): Record<string, unknown> {
  const b = elBox(el);
  const p: Record<string, unknown> = {
    x: b.x + b.w / 2,
    y: b.y + b.h / 2,
    around: "center",
    rotation: b.rotation ?? 0,
    scaleX: 1,
    scaleY: 1,
    skewX: 0,
    skewY: 0,
    editable: true,
  };
  if (b.opacity !== undefined) p.opacity = b.opacity;
  if (deckClamp) p.dragBounds = "parent";
  // editor 定制工具路由（@leafer-in/editor updateEditTool 按节点 editOuter 取工具名）：
  // 两点线/箭头 → 端点把手；折线（pts≥3）→ 顶点把手；注册见 leafer/editTools.ts
  if (el.kind === "shape" && (el.shape === "line" || el.shape === "arrow" || el.shape === "double-arrow")) {
    p.editOuter = isPolyline(el) ? "sc-poly" : "sc-line";
  }
  return p;
}

function imagePlaceholder(key: string, w: number, h: number, label: string): SceneNode {
  const fs = Math.min(18, Math.max(10, w / 12));
  return {
    tag: "group",
    key,
    props: {},
    children: [
      { tag: "rect", key: `${key}#ph`, props: { x: 0, y: 0, width: w, height: h, fill: "#eef0f2" } },
      {
        tag: "text",
        key: `${key}#pt`,
        props: {
          x: 0,
          y: 0,
          width: w,
          height: h,
          text: label,
          textAlign: "center",
          verticalAlign: "middle",
          fontSize: fs,
          lineHeight: fs,
          fill: "#9ca3af",
        },
      },
    ],
  };
}

/** ChartPrim → 场景节点。prim 文本语义：y=行垂直中心、x 按 anchor（DOM 用 dominant-baseline central，这里手动补偿） */
/**
 * 箭头头敞口 V 路径（Excalidraw 式，非实心三角）：与 DOM marker（viewBox 10×10、锚 (9,5)、markerWidth 7）
 * 同几何，但不闭合、由调用方描边。(ex,ey)=端点，(dx,dy)=单位朝向，mk=线宽（头翼/笔宽随线宽）
 */
function arrowHeadPath(ex: number, ey: number, dx: number, dy: number, mk: number): string {
  const k = 0.7 * mk;
  const nx = -dy;
  const ny = dx;
  const w1 = `${(ex - 9 * k * dx + 5 * k * nx).toFixed(1)},${(ey - 9 * k * dy + 5 * k * ny).toFixed(1)}`;
  const tp = `${(ex + k * dx).toFixed(1)},${(ey + k * dy).toFixed(1)}`;
  const w2 = `${(ex - 9 * k * dx - 5 * k * nx).toFixed(1)},${(ey - 9 * k * dy - 5 * k * ny).toFixed(1)}`;
  return `M${w1} L${tp} L${w2}`;
}

function chartPrimNode(p: ChartPrim, key: string, ctx: SceneCtx): SceneNode {
  switch (p.t) {
    case "rect":
      return { tag: "rect", key, props: { x: p.x, y: p.y, width: p.w, height: p.h, fill: p.fill } };
    case "line":
      return {
        tag: "line",
        key,
        props: { x: 0, y: 0, points: [p.x1, p.y1, p.x2, p.y2], stroke: p.stroke, strokeWidth: p.strokeWidth },
      };
    case "poly":
      return {
        tag: "line",
        key,
        props: { x: 0, y: 0, points: p.points.flat(), stroke: p.stroke, strokeWidth: p.strokeWidth, strokeJoin: "round", strokeCap: "round" },
      };
    case "path":
      return { tag: "path", key, props: { x: 0, y: 0, path: p.d, fill: p.fill } };
    case "circle":
      return { tag: "ellipse", key, props: { x: p.cx - p.r, y: p.cy - p.r, width: p.r * 2, height: p.r * 2, fill: p.fill } };
    case "text": {
      const w = ctx.measure(p.text, `${p.bold ? "700 " : ""}${p.size}px ${FONT_STACK}`).width;
      const x = p.anchor === "middle" ? p.x - w / 2 : p.anchor === "end" ? p.x - w : p.x;
      return {
        tag: "text",
        key,
        props: {
          x,
          y: p.y - p.size / 2,
          text: p.text,
          fontSize: p.size,
          lineHeight: p.size,
          fill: p.color,
          ...(p.bold ? { fontWeight: 700 } : {}),
        },
      };
    }
  }
}

export function buildElScene(el: El, ctx: SceneCtx, deckClamp = false): SceneNode {
  const b = elBox(el);
  const boxProps: Record<string, unknown> = { x: 0, y: 0, width: b.w, height: b.h };

  let children: SceneNode[];
  if (el.kind === "text") {
    const frags = layoutTextEl(el, ctx.measure);
    children = frags.map((f, i) => ({
      tag: "text" as const,
      key: `${el.id}#f${i}`,
      props: {
        x: f.x,
        // leafer Text（lineHeight=fs px）基线落在 y + 0.85fs（__baseLine = lh − (lh − 0.7fs)/2），反推节点 y 对齐 CSS 基线
        y: f.baseline - f.run.fontSize * 0.85,
        text: f.text,
        fontFamily: f.run.fontFamily,
        fontSize: f.run.fontSize,
        lineHeight: f.run.fontSize,
        fill: f.run.color,
        ...(f.run.bold ? { fontWeight: 700 } : {}),
        ...(f.run.italic ? { italic: true } : {}),
        ...(f.run.underline ? { textDecoration: "underline" } : {}),
      },
    }));
  } else if (el.kind === "shape") {
    const s = shapeSpec(el);
    if (s.shape === "line" || s.shape === "arrow" || s.shape === "double-arrow") {
      // 线身三态：折线（pts≥3 逐段）> 弧（curve≠0 二次贝塞尔）> 对角直线；直线段语义不变
      const poly = isPolyline(el as ShapeEl) ? polyLocal(el as ShapeEl) : null;
      const curved = !poly && ((el as ShapeEl).curve ?? 0) !== 0;
      const c = curved ? curveArrow(el as ShapeEl) : null;
      const ends = lineEnds(b.w, b.h, (el as ShapeEl).dir);
      children = poly
        ? [
            {
              tag: "path",
              key: `${el.id}#l`,
              props: {
                x: 0,
                y: 0,
                path: `M ${poly.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ")}`,
                fill: "transparent",
                stroke: s.lineColor,
                strokeWidth: s.strokeWidth,
                strokeCap: "round",
                strokeJoin: "round",
                ...(strokeDash(el as ShapeEl).length ? { dashPattern: strokeDash(el as ShapeEl) } : {}),
              },
            },
          ]
        : c
        ? [
            {
              tag: "path",
              key: `${el.id}#l`,
              props: {
                x: 0,
                y: 0,
                path: `M ${c.ax.toFixed(1)} ${c.ay.toFixed(1)} Q ${c.cx.toFixed(1)} ${c.cy.toFixed(1)} ${c.bx.toFixed(1)} ${c.by.toFixed(1)}`,
                // leafer 对 "none" 会回退默认黑填充（实心弓形 bug），透明才 truly 不填
                fill: "transparent",
                stroke: s.lineColor,
                strokeWidth: s.strokeWidth,
                strokeCap: "round",
                ...(strokeDash(el as ShapeEl).length ? { dashPattern: strokeDash(el as ShapeEl) } : {}),
              },
            },
          ]
        : [
            {
              tag: "line",
              key: `${el.id}#l`,
              props: {
                x: 0,
                y: 0,
                // leafer Line.points 只吃扁平 number[] 或 IPointData[]，嵌套 [x,y][] 解析失败（线整条消失）
                points: [ends.x1, ends.y1, ends.x2, ends.y2],
                stroke: s.lineColor,
                strokeWidth: s.strokeWidth,
                strokeCap: "round",
                ...(strokeDash(el as ShapeEl).length ? { dashPattern: strokeDash(el as ShapeEl) } : {}),
              },
            },
          ];
      // 箭头头：敞口 V 描边路径（与 DOM marker 同几何）；透明填充防 leafer "none" 回退黑
      // 头朝向 = 线端切线单位向量（折线：末/首段方向；弧：终点-控制点 / 起点-控制点；直线：对角向量）
      const mk = (el as ShapeEl).strokeWidth ?? 2;
      const tip = (() => {
        if (poly) {
          const n = poly.length;
          const [p0, p1, pe, ps] = [poly[0], poly[1], poly[n - 1], poly[n - 2]];
          const le = Math.hypot(pe.x - ps.x, pe.y - ps.y) || 1;
          const ls = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
          return {
            end: { x: pe.x, y: pe.y, dx: (pe.x - ps.x) / le, dy: (pe.y - ps.y) / le },
            start: { x: p0.x, y: p0.y, dx: (p0.x - p1.x) / ls, dy: (p0.y - p1.y) / ls },
          };
        }
        if (c) {
          const le = Math.hypot(c.bx - c.cx, c.by - c.cy) || 1;
          const ls = Math.hypot(c.ax - c.cx, c.ay - c.cy) || 1;
          return {
            end: { x: c.bx, y: c.by, dx: (c.bx - c.cx) / le, dy: (c.by - c.cy) / le },
            start: { x: c.ax, y: c.ay, dx: (c.ax - c.cx) / ls, dy: (c.ay - c.cy) / ls },
          };
        }
        const len = Math.hypot(ends.x2 - ends.x1, ends.y2 - ends.y1) || 1;
        const ux = (ends.x2 - ends.x1) / len;
        const uy = (ends.y2 - ends.y1) / len;
        return {
          end: { x: ends.x2, y: ends.y2, dx: ux, dy: uy },
          start: { x: ends.x1, y: ends.y1, dx: -ux, dy: -uy },
        };
      })();
      const headNode = (ex: number, ey: number, dx: number, dy: number, key: string) => ({
        tag: "path" as const,
        key,
        props: { x: 0, y: 0, path: arrowHeadPath(ex, ey, dx, dy, mk), fill: "transparent", stroke: s.lineColor, strokeWidth: mk, strokeCap: "round", strokeJoin: "round" },
      });
      if (s.shape === "arrow" || s.shape === "double-arrow") {
        children.push(headNode(tip.end.x, tip.end.y, tip.end.dx, tip.end.dy, `${el.id}#h`));
      }
      if (s.shape === "double-arrow") {
        children.push(headNode(tip.start.x, tip.start.y, tip.start.dx, tip.start.dy, `${el.id}#h1`));
      }
      // 线上标签：路径中点上方，色随线身；measure 居中定位（leafer Text align 不按锚点居中）
      if ((el as ShapeEl).label) {
        const m = pathMidpoint(el as ShapeEl);
        const text = (el as ShapeEl).label as string;
        const lw = ctx.measure(text, `400 12px ${FONT_STACK}`).width;
        children.push({
          tag: "text",
          key: `${el.id}#lb`,
          props: { x: m.x - lw / 2, y: m.y - 6 - 0.85 * 12, text, fontSize: 12, fill: s.lineColor, fontFamily: FONT_STACK, pointerEvents: "none" },
        });
      }
    } else if (s.shape === "diamond") {
      // 菱形=bbox 四中点连线（DOM 用 <polygon>，此处用 path 保持同几何；子节点恒局部 0,0）
      children = [
        {
          tag: "path",
          key: `${el.id}#s`,
          props: {
            x: 0,
            y: 0,
            path: `M${(b.w / 2).toFixed(1)},0 L${b.w.toFixed(1)},${(b.h / 2).toFixed(1)} L${(b.w / 2).toFixed(1)},${b.h.toFixed(1)} L0,${(b.h / 2).toFixed(1)} Z`,
            ...(s.fill ? { fill: s.fill } : {}),
            ...(s.stroke ? { stroke: s.stroke, strokeWidth: s.strokeWidth, strokeAlign: "inside" } : {}),
            ...(strokeDash(el as ShapeEl).length ? { dashPattern: strokeDash(el as ShapeEl) } : {}),
          },
        },
      ];
    } else if (POLY_SHAPES.includes(s.shape as PolyShape)) {
      // 多边形形状：viewspec 顶点 → path（DOM 用 <polygon>，同几何）
      const pts = polygonPoints(s.shape as PolyShape, b.w, b.h);
      const d = `M${pts.map(([x, y]) => `${x},${y}`).join(" L")} Z`;
      children = [
        {
          tag: "path",
          key: `${el.id}#s`,
          props: {
            x: 0,
            y: 0,
            path: d,
            ...(s.fill ? { fill: s.fill } : {}),
            ...(s.stroke ? { stroke: s.stroke, strokeWidth: s.strokeWidth, strokeAlign: "inside" } : {}),
            ...(strokeDash(el as ShapeEl).length ? { dashPattern: strokeDash(el as ShapeEl) } : {}),
          },
        },
      ];
    } else {
      children = [
        {
          tag: s.shape === "ellipse" ? "ellipse" : "rect",
          key: `${el.id}#s`,
          props: {
            ...boxProps,
            ...(s.fill ? { fill: s.fill } : {}),
            ...(s.stroke ? { stroke: s.stroke, strokeWidth: s.strokeWidth, strokeAlign: "inside" } : {}),
            ...(s.shape === "rect" && (el as ShapeEl).radius ? { cornerRadius: (el as ShapeEl).radius } : {}),
            ...(strokeDash(el as ShapeEl).length ? { dashPattern: strokeDash(el as ShapeEl) } : {}),
          },
        },
      ];
    }
  } else if (el.kind === "image") {
    const im = el as ImageEl;
    const st = ctx.asset(im.src);
    // viewspec fit → leafer 图像填充画模式的（contain 在 leafer 里叫 fit）。
    // 注意：mode 不是 Image 元素属性——url 简写会硬编码 stretch；裁切语义只存在于 fill 画对象里。
    const fitted = imageFit(im);
    const mode = fitted === "contain" ? "fit" : fitted === "fill" ? "stretch" : "cover";
    if (st.status === "ready") {
      children = [
        {
          tag: "image",
          key: `${el.id}#i`,
          props: { ...boxProps, fill: { type: "image", url: st.url, mode }, ...(im.radius ? { cornerRadius: im.radius } : {}) },
        },
      ];
    } else {
      children = [imagePlaceholder(`${el.id}#p`, b.w, b.h, st.status === "loading" ? "加载中…" : "∅ 图片缺失")];
    }
  } else if (el.kind === "mermaid") {
    const mv = ctx.mermaid(el);
    if (mv.status === "ready") {
      children = [{ tag: "image", key: `${el.id}#m`, props: { ...boxProps, fill: { type: "image", url: mv.url, mode: "fit" } } }];
    } else if (mv.status === "error") {
      const fs = Math.min(16, Math.max(10, b.w / 30));
      children = [
        {
          tag: "text",
          key: `${el.id}#m`,
          props: {
            ...boxProps,
            text: `mermaid 语法错误：${mermaidErrorText((el as MermaidEl).code, mv.message)}（双击编辑代码）`,
            textAlign: "center",
            verticalAlign: "middle",
            fontSize: fs,
            lineHeight: fs,
            fill: "#ff3b30",
          },
        },
      ];
    } else {
      children = [
        {
          tag: "text",
          key: `${el.id}#m`,
          props: { ...boxProps, text: "图表渲染中…", textAlign: "center", verticalAlign: "middle", fontSize: 14, lineHeight: 14, fill: "#9ca3af" },
        },
      ];
    }
  } else if (el.kind === "svg") {
    // 动画 SVG（SMIL/CSS）：canvas 光栅化会冻在第一帧 → 只画占位底，
    // 真身由 CanvasStage 的 DOM 浮层 <img> 呈现（<img> 里声明式动画照常播放）
    if (isAnimatedSvg((el as SvgEl).code)) {
      children = [
        {
          tag: "rect",
          key: `${el.id}#emb`,
          props: { ...boxProps, fill: "#f6f7f4", stroke: "rgba(0,0,0,0.08)", strokeWidth: 1 },
        },
        {
          tag: "text",
          key: `${el.id}#s`,
          props: { ...boxProps, text: "SVG 动画", textAlign: "center", verticalAlign: "middle", fontSize: 14, lineHeight: 14, fill: "#9ca3af" },
        },
      ];
      return { tag: "group", key: el.id, props: commonBoxProps(el, deckClamp), children };
    }
    const sv = ctx.svg(el as SvgEl);
    if (sv.status === "ready") {
      children = [{ tag: "image", key: `${el.id}#s`, props: { ...boxProps, fill: { type: "image", url: sv.url, mode: "fit" } } }];
    } else if (sv.status === "error") {
      const fs = Math.min(16, Math.max(10, b.w / 30));
      children = [
        {
          tag: "text",
          key: `${el.id}#s`,
          props: {
            ...boxProps,
            text: `SVG 无法渲染：${sv.message}`,
            textAlign: "center",
            verticalAlign: "middle",
            fontSize: fs,
            lineHeight: fs,
            fill: "#ff3b30",
          },
        },
      ];
    } else {
      children = [
        {
          tag: "text",
          key: `${el.id}#s`,
          props: { ...boxProps, text: "SVG 渲染中…", textAlign: "center", verticalAlign: "middle", fontSize: 14, lineHeight: 14, fill: "#9ca3af" },
        },
      ];
    }
  } else if (el.kind === "embed") {
    // iframe 进不了 canvas：Leafer 轨只画占位底，真实网页由 CanvasStage 的 DOM 浮层叠加
    const em = el as EmbedEl;
    const label = `${em.title || PROVIDER_LABELS[resolveEmbed(em.url).provider]} · 网页`;
    children = [
      {
        tag: "rect",
        key: `${el.id}#emb`,
        props: { ...boxProps, fill: "#f6f7f4", stroke: "rgba(0,0,0,0.08)", strokeWidth: 1 },
      },
      {
        tag: "text",
        key: `${el.id}#emt`,
        props: {
          x: 0,
          y: 0,
          width: b.w,
          height: b.h,
          text: label,
          textAlign: "center",
          verticalAlign: "middle",
          fontSize: 14,
          lineHeight: 14,
          fill: "#9ca3af",
        },
      },
    ];
  } else if (el.kind === "table") {
    // 网格 = 每格描边矩形叠加 + 单元文本（宽定 box 居中，超宽省略号截断，与 DOM overflow hidden 同语义）
    const t = tableSpec(el as TableEl);
    const css = `${t.size}px ${FONT_STACK}`;
    const pad = Math.min(10, t.size * 0.6);
    const clip = (text: string, maxW: number) => {
      if (!text || ctx.measure(text, css).width <= maxW) return text;
      let s = text;
      while (s.length > 1 && ctx.measure(`${s}…`, css).width > maxW) s = s.slice(0, -1);
      return `${s}…`;
    };
    const nodes: SceneNode[] = [];
    t.rows.forEach((row, r) => {
      const isHead = r === 0 && t.header;
      for (let c = 0; c < t.cols; c++) {
        const cx = t.colX[c] ?? 0;
        const cw = (t.colX[c + 1] ?? el.w) - cx;
        nodes.push({
          tag: "rect",
          key: `${el.id}#c${r}-${c}`,
          props: { x: cx, y: r * t.rowH, width: cw, height: t.rowH, fill: isHead ? t.headerFill : t.fill, stroke: t.stroke, strokeWidth: 1 },
        });
        const txt = row[c] ?? "";
        const maxW = Math.max(4, cw - pad * 2);
        if (txt) {
          nodes.push({
            tag: "text",
            key: `${el.id}#t${r}-${c}`,
            props: {
              x: cx + pad,
              y: r * t.rowH,
              width: maxW,
              height: t.rowH,
              text: clip(txt, maxW),
              textAlign: "center",
              verticalAlign: "middle",
              fontSize: t.size,
              lineHeight: t.size,
              fill: t.color,
              ...(isHead ? { fontWeight: 700 } : {}),
            },
          });
        }
      }
    });
    children = nodes;
  } else if (el.kind === "chart") {
    children = chartSpec(el).map((p, i) => chartPrimNode(p, `${el.id}#p${i}`, ctx));
  } else {
    // draw：viewBox 拉伸语义 → 点集按轴比缩放；non-scaling-stroke → 描边宽除以视口缩放
    const s = drawSpec(el);
    const sx = s.naturalW > 0 ? b.w / s.naturalW : 1;
    const sy = s.naturalH > 0 ? b.h / s.naturalH : 1;
    const d = el.points
      .map(([x, y], i) => `${i === 0 ? "M" : "L"}${(x * sx).toFixed(1)},${(y * sy).toFixed(1)}`)
      .join(" ");
    children = [
      {
        tag: "path",
        key: `${el.id}#d`,
        props: {
          x: 0,
          y: 0,
          path: d,
          stroke: s.color,
          strokeWidth: ctx.zoom > 0 ? s.strokeWidth / ctx.zoom : s.strokeWidth,
          strokeCap: "round",
          strokeJoin: "round",
        },
      },
    ];
  }

  return { tag: "group", key: el.id, props: commonBoxProps(el, deckClamp), children };
}

/* ---------------- 整幕 ---------------- */

function applyLive(el: El, live: Map<string, Partial<El>> | undefined): El {
  const p = live?.get(el.id);
  return p ? ({ ...el, ...p } as El) : el;
}

export type SceneInput = {
  doc: CanvasDoc;
  live?: Map<string, Partial<El>>;
  ctx: SceneCtx;
};

/** 世界层 children = objects（画布级元素） */
export function buildScene(input: SceneInput): SceneNode {
  const { doc, live, ctx } = input;
  const children: SceneNode[] = [
    {
      tag: "group",
      key: "objects",
      props: {},
      children: doc.objects.map((el) => buildElScene(applyLive(el, live), ctx)),
    },
  ];
  return { tag: "group", key: "world", props: { x: 0, y: 0 }, children };
}
