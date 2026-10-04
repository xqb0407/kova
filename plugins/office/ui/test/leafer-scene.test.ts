import { describe, expect, test } from "bun:test";
import type { CanvasDoc, El, DrawEl, Frame, ImageEl, ShapeEl, TextEl } from "../src/doc";
import { buildElScene, buildScene, layoutTextRuns, type MeasureFn, type SceneCtx, type SceneNode } from "../src/leafer/scene";
import { resolveRuns } from "../src/viewspec";

/* 假 measure：宽 = 字符数 × 字号/2；ascent/descent = 字号 × 0.8 / × 0.2（行盒 above=0.975fs, below=0.375fs） */
const measure: MeasureFn = (_text, fontCss) => {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(fontCss)?.[1] ?? 16);
  return { width: _text.length * size * 0.5, ascent: size * 0.8, descent: size * 0.2 };
};

const baseCtx: SceneCtx = {
  measure,
  asset: () => ({ status: "loading" }),
  mermaid: () => ({ status: "loading" }),
  chrome: { stroke: "rgba(0,0,0,0.12)", ink: "#1d1d1f", primary: "#166534", shadow: null },
  zoom: 1,
};

function txtEl(over: Partial<TextEl> = {}): TextEl {
  return { kind: "text", id: "t1", x: 10, y: 20, w: 100, h: 60, runs: [{ text: "hello" }], ...over };
}

function findNode(root: SceneNode, pred: (n: SceneNode) => boolean): SceneNode | undefined {
  if (pred(root)) return root;
  for (const c of root.children ?? []) {
    const hit = findNode(c, pred);
    if (hit) return hit;
  }
  return undefined;
}

describe("layoutTextRuns", () => {
  test("单行：基线 = above（(lh + a − d)/2）", () => {
    const frags = layoutTextRuns(resolveRuns(txtEl({ runs: [{ text: "ab", size: 20 }] })), 100, 60, "left", "top", measure);
    expect(frags.length).toBe(1);
    expect(frags[0]!.x).toBe(0);
    expect(frags[0]!.baseline).toBeCloseTo(19.5, 5); // (27 + 16 − 4) / 2
    expect(frags[0]!.text).toBe("ab");
  });

  test("按词换行：装不下的词整体进下一行", () => {
    // 字号 10 → 每字符宽 5；盒宽 25。"aaaa"(20)+" "(5)=25 恰好，下一个"bbbb"放不下
    const runs = resolveRuns(txtEl({ runs: [{ text: "aaaa bbbb cccc", size: 10 }] }));
    const frags = layoutTextRuns(runs, 25, 60, "left", "top", measure);
    const lines = [...new Set(frags.map((f) => f.baseline))].sort((a, b) => a - b);
    expect(lines.length).toBe(3);
    expect(frags.filter((f) => f.baseline === lines[0]).map((f) => f.text)).toEqual(["aaaa", " "]);
    expect(frags.filter((f) => f.baseline === lines[1]).map((f) => f.text)).toEqual(["bbbb", " "]);
    expect(frags.filter((f) => f.baseline === lines[2]).map((f) => f.text)).toEqual(["cccc"]);
  });

  test("超长单词逐字符硬断（break-word）", () => {
    const runs = resolveRuns(txtEl({ runs: [{ text: "abcdefgh", size: 10 }] }));
    const frags = layoutTextRuns(runs, 15, 60, "left", "top", measure); // 每字符 5px，行最宽 3 字符
    expect(frags.map((f) => f.text)).toEqual(["abc", "def", "gh"]);
    expect(frags.map((f) => f.x)).toEqual([0, 0, 0]);
  });

  test("单字符比盒还宽：不死循环（cut 下限 1，超宽字符原样占一行）", () => {
    // 默认字号 24 → 字符宽 12 > 盒宽 10；旧实现 text.length-1=0 → head 恒空 → 死循环
    const runs = resolveRuns(txtEl({ runs: [{ text: "a" }] }));
    const frags = layoutTextRuns(runs, 10, 10, "left", "top", measure);
    expect(frags.map((f) => f.text)).toEqual(["a"]);
  });

  test("CJK 逐字可断", () => {
    const runs = resolveRuns(txtEl({ runs: [{ text: "你好世界", size: 10 }] }));
    const frags = layoutTextRuns(runs, 15, 60, "left", "top", measure);
    const lines = [...new Set(frags.map((f) => f.baseline))].sort((a, b) => a - b);
    expect(lines.length).toBe(2); // 3 字一行（15px 恰容 3×5，不溢出）→ 3+1
    expect(frags.filter((f) => f.baseline === lines[1]).map((f) => f.text)).toEqual(["界"]);
  });

  test("保留 \\n：显式换行", () => {
    const runs = resolveRuns(txtEl({ runs: [{ text: "a\nb", size: 10 }] }));
    const frags = layoutTextRuns(runs, 100, 60, "left", "top", measure);
    expect(frags.map((f) => f.text)).toEqual(["a", "b"]);
    expect(frags[1]!.baseline).toBeCloseTo(frags[0]!.baseline + 13.5, 5);
  });

  test("混排字号共享基线（行盒 above 取各 run 最大贡献）", () => {
    const runs = resolveRuns(txtEl({ runs: [{ text: "A", size: 20 }, { text: "b", size: 10 }] }));
    const frags = layoutTextRuns(runs, 100, 60, "left", "top", measure);
    expect(frags[0]!.baseline).toBeCloseTo(19.5, 5); // 大字 above 19.5 > 小字 9.75
    expect(frags[1]!.baseline).toBeCloseTo(19.5, 5); // 同行共享基线
    expect(frags[1]!.x).toBeCloseTo(10, 5); // 大字宽 = 10
  });

  test("center 对齐按行居中", () => {
    const runs = resolveRuns(txtEl({ runs: [{ text: "ab", size: 10 }] }));
    const frags = layoutTextRuns(runs, 40, 60, "center", "top", measure);
    expect(frags[0]!.x).toBeCloseTo(15, 5); // (40-10)/2
  });

  test("vAlign middle/bottom 平移整段", () => {
    const runs = resolveRuns(txtEl({ runs: [{ text: "ab", size: 10 }] }));
    const mid = layoutTextRuns(runs, 40, 60, "left", "middle", measure);
    const bot = layoutTextRuns(runs, 40, 60, "left", "bottom", measure);
    const lineH = 10 * 1.35;
    const above = (lineH + 8 - 2) / 2;
    expect(mid[0]!.baseline).toBeCloseTo((60 - lineH) / 2 + above, 5);
    expect(bot[0]!.baseline).toBeCloseTo(60 - lineH + above, 5);
  });
});

describe("buildElScene", () => {
  test("diamond：path 取 bbox 四中点，几何与 DOM polygon 一致", () => {
    const el: ShapeEl = { kind: "shape", id: "d1", x: 0, y: 0, w: 100, h: 60, shape: "diamond", fill: "#166534" };
    const node = buildElScene(el, baseCtx);
    const path = node.children![0]!;
    expect(path.tag).toBe("path");
    expect(path.props).toMatchObject({ x: 0, y: 0, fill: "#166534" });
    expect(String(path.props.path)).toBe("M50.0,0 L100.0,30.0 L50.0,60.0 L0,30.0 Z");
  });

  test("strokeStyle：虚线/点线落 dashPattern（实线不写字段）", () => {
    const dashed: ShapeEl = { kind: "shape", id: "d1", x: 0, y: 0, w: 100, h: 60, shape: "rect", stroke: "#1d1d1f", strokeWidth: 2, strokeStyle: "dashed" };
    expect(buildElScene(dashed, baseCtx).children![0]!.props).toMatchObject({ dashPattern: [8, 6] });
    const dotted: ShapeEl = { ...dashed, strokeStyle: "dotted", strokeWidth: 3 };
    expect(buildElScene(dotted, baseCtx).children![0]!.props).toMatchObject({ dashPattern: [0.30000000000000004, 6.6000000000000005] });
    const solid: ShapeEl = { ...dashed, strokeStyle: "solid" };
    expect(buildElScene(solid, baseCtx).children![0]!.props.dashPattern).toBeUndefined();
    const line: ShapeEl = { kind: "shape", id: "l1", x: 0, y: 0, w: 100, h: 0, shape: "line", stroke: "#1d1d1f", strokeWidth: 2, strokeStyle: "dashed" };
    expect(buildElScene(line, baseCtx).children![0]!.props).toMatchObject({ dashPattern: [8, 6] });
  });

  test("rect：组携带中心 x/y + 恒等变换（editor 轨收敛契约）；子节点盒从 0 起", () => {
    const el: ShapeEl = { kind: "shape", id: "s1", x: 5, y: 6, w: 30, h: 20, shape: "rect", fill: "#166534", radius: 4 };
    const node = buildElScene(el, baseCtx);
    expect(node.tag).toBe("group");
    // around:center 的 leafer 语义：x,y = 盒中心（5+15, 6+10）
    expect(node.props.x).toBe(20);
    expect(node.props.y).toBe(16);
    // 恒等变换全量给出：编辑器乘写的 scaleX/rotation 提交后才能被 patch 清掉
    expect(node.props).toMatchObject({ around: "center", rotation: 0, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0, editable: true });
    expect(node.props.dragBounds).toBeUndefined();
    expect(buildElScene(el, baseCtx, true).props.dragBounds).toBe("parent"); // deck 页内限幅
    const rect = node.children![0]!;
    expect(rect.tag).toBe("rect");
    expect(rect.props).toMatchObject({ x: 0, y: 0, width: 30, height: 20, fill: "#166534", stroke: "#166534", strokeAlign: "inside", cornerRadius: 4 });
  });

  test("旋转元素：组带 rotation + around center", () => {
    const el = txtEl({ rotation: 30, runs: [{ text: "x" }] });
    const node = buildElScene(el, baseCtx);
    expect(node.props.rotation).toBe(30);
    expect(node.props.around).toBe("center");
  });

  test("arrow：线 + 敞口 V 头（Excalidraw 式描边，非实心三角）", () => {
    const el: ShapeEl = { kind: "shape", id: "a1", x: 0, y: 0, w: 100, h: 0, shape: "arrow", stroke: "#1d1d1f", strokeWidth: 2 };
    const node = buildElScene(el, baseCtx);
    const [line, head] = node.children!;
    expect(line!.tag).toBe("line");
    expect(head!.tag).toBe("path");
    // 水平线：u=(1,0) n=(0,1)，k=0.7×2=1.4；尖 (101.4,0)，两翼 (87.4,±7)——不闭合、靠描边成 V
    expect(head!.props.path).toBe("M87.4,7.0 L101.4,0.0 L87.4,-7.0");
    expect(head!.props.fill).toBe("transparent");
    expect(head!.props.stroke).toBe("#1d1d1f");
    expect(head!.props.strokeWidth).toBe(2);
  });

  test("double-arrow：两端各一个敞口 V 头，起点头方向相反（-u）", () => {
    const el: ShapeEl = { kind: "shape", id: "a2", x: 0, y: 0, w: 100, h: 0, shape: "double-arrow", stroke: "#1d1d1f", strokeWidth: 2 };
    const node = buildElScene(el, baseCtx);
    const [, endHead, startHead] = node.children!;
    // 终点头同 arrow；起点头：u 取反（dx=-1 → n=(0,-1)）→ 尖 (−1.4,0)，翼 (12.6,∓7)
    expect(endHead!.props.path).toBe("M87.4,7.0 L101.4,0.0 L87.4,-7.0");
    expect(startHead!.props.path).toBe("M12.6,-7.0 L-1.4,0.0 L12.6,7.0");
  });

  test("draw：点集按自然盒→元素盒缩放；描边宽随 zoom 补偿", () => {
    const el: DrawEl = { kind: "draw", id: "d1", x: 0, y: 0, w: 200, h: 100, points: [[0, 0], [100, 50]] };
    const n1 = buildElScene(el, { ...baseCtx, zoom: 2 });
    const path = n1.children![0]!.props.path as string;
    expect(path).toBe("M0.0,0.0 L200.0,100.0");
    expect(n1.children![0]!.props.strokeWidth).toBe(1); // 2 / zoom2
    const n2 = buildElScene(el, { ...baseCtx, zoom: 1 });
    expect(n2.children![0]!.props.strokeWidth).toBe(2);
  });

  test("image：loading 占位（灰底 + 文案）；ready 用图像填充画（mode 在 fill 里，url 简写会退化成 stretch）", () => {
    const el: ImageEl = { kind: "image", id: "i1", x: 0, y: 0, w: 50, h: 40, src: "a.png", fit: "contain" };
    const loading = buildElScene(el, baseCtx);
    expect(findNode(loading, (n) => n.props.text === "加载中…")).toBeTruthy();
    const ready = buildElScene(el, { ...baseCtx, asset: () => ({ status: "ready", url: "data:img" }) });
    const img = findNode(ready, (n) => n.tag === "image");
    // contain→fit；裁切语义只存在于 fill 画对象：{type:'image', url, mode}
    expect(img!.props).toMatchObject({ fill: { type: "image", url: "data:img", mode: "fit" } });
    expect(img!.props.url).toBeUndefined();
    expect(img!.props.mode).toBeUndefined();
  });

  test("text 片段：每 frag 一个 Text 节点，key 稳定可 diff", () => {
    const el = txtEl({ runs: [{ text: "a\nb", size: 10 }] });
    const node = buildElScene(el, baseCtx);
    expect(node.children!.map((c) => c.key)).toEqual(["t1#f0", "t1#f1"]);
    expect(node.children![0]!.props.text).toBe("a");
    // leafer 基线换算：节点 y = baseline − 0.85fs
    expect(node.children![0]!.props.y).toBeCloseTo(9.75 - 8.5, 5);
  });
});

describe("buildScene", () => {
  const frame: Frame = { id: "f1", type: "slide", x: 8, y: 8, w: 1280, h: 720, background: "#ffffff", elements: [] };
  const doc: CanvasDoc = { version: 2, objects: [txtEl()], frames: [frame] } as unknown as CanvasDoc;

  test("board：objects 组渲染、页框不渲染", () => {
    const scene = buildScene({ doc, surface: "board", positions: [], liveContainerId: null, ctx: baseCtx });
    const objects = scene.children!.find((c) => c.key === "objects");
    expect(objects!.children!.map((c) => c.key)).toEqual(["t1"]);
    expect(scene.children!.find((c) => c.key.startsWith("ab:"))).toBeUndefined();
  });

  test("deck：当前页 = bg+clip 组；focused 用 primary 1.5 描边", () => {
    const scene = buildScene({ doc, surface: "deck", positions: [{ frame, x: 8, y: 8 }], liveContainerId: null, focusedFrameId: "f1", ctx: baseCtx });
    const ab = scene.children!.find((c) => c.key === "ab:f1")!;
    expect(ab.props).toMatchObject({ x: 8, y: 8 });
    const bg = ab.children![0]!;
    expect(bg.props).toMatchObject({ stroke: "#166534", strokeWidth: 1.5, strokeAlign: "outside" });
    expect(ab.children![1]!.tag).toBe("box");
  });

  test("live 覆盖只作用于 liveContainerId 匹配的容器", () => {
    const live = new Map<string, Partial<El>>([["t1", { x: 999 }]]);
    const deckScene = buildScene({ doc, surface: "board", positions: [], live, liveContainerId: "f1", ctx: baseCtx });
    const objects = deckScene.children!.find((c) => c.key === "objects")!;
    expect(objects.children![0]!.props.x).toBe(60); // root 不吃 f1 的 live（盒中心 = 10 + 100/2）
    const boardScene = buildScene({ doc, surface: "board", positions: [], live, liveContainerId: "root", ctx: baseCtx });
    expect(boardScene.children!.find((c) => c.key === "objects")!.children![0]!.props.x).toBe(1049);
  });
});

describe("editOuter 定制工具路由标记（editor 轨）", () => {
  const shapeEl = (over: Partial<ShapeEl>): ShapeEl =>
    ({ kind: "shape", id: "x1", x: 0, y: 0, w: 100, h: 50, shape: "rect", stroke: "#000", ...over }) as ShapeEl;

  test("两点线/箭头/双箭头 → sc-line；折线（pts≥3）→ sc-poly", () => {
    for (const s of ["line", "arrow", "double-arrow"] as const) {
      expect(buildElScene(shapeEl({ shape: s }), baseCtx).props.editOuter).toBe("sc-line");
    }
    const poly = shapeEl({ shape: "line", pts: [[0, 0], [50, 10], [100, 50]] });
    expect(buildElScene(poly, baseCtx).props.editOuter).toBe("sc-poly");
  });

  test("面形状与非 shape 元素不带 editOuter（走默认把手）", () => {
    expect(buildElScene(shapeEl({ shape: "ellipse" }), baseCtx).props.editOuter).toBeUndefined();
    expect(buildElScene(shapeEl({ shape: "line", curve: 0.5 }), baseCtx).props.editOuter).toBe("sc-line"); // 弧线仍走端点工具
    const t: TextEl = { kind: "text", id: "t9", x: 0, y: 0, w: 10, h: 10, runs: [{ text: "a" }] };
    expect(buildElScene(t, baseCtx).props.editOuter).toBeUndefined();
  });
});
