/**
 * 几何引擎测试：世界盒（嵌套/旋转）、group 派生盒与再基准化、对齐/分布、
 * 吸附求值、框选/点选命中（穿透语义）。
 */
import { describe, expect, test } from "bun:test";
import {
  aabbRotated,
  applyAlign,
  countNodes,
  deriveGroupBox,
  hitPoint,
  hitRect,
  normalizeGroups,
  resolveSnap,
  selectionWorldBox,
  snapCandidates,
  collectSnapBoxes,
  linesFromBoxes,
  spacingLabels,
  unionBox,
  worldBoxOf,
  worldCornersOf,
  type Box,
} from "../src/geometry";
import { blankDoc, findNode, newFrame, solid, type DesignDoc, type DesignNode, type FrameNode, type GroupNode, type Page, type ShapeNode } from "../src/doc";

const rect = (id: string, x: number, y: number, w: number, h: number, over: Partial<ShapeNode> = {}): ShapeNode => ({
  id,
  type: "rect",
  name: id,
  x,
  y,
  w,
  h,
  fills: [solid("#ffffff")],
  strokes: [],
  ...over,
});
const group = (id: string, x: number, y: number, w: number, h: number, children: DesignNode[]): GroupNode => ({
  id,
  type: "group",
  name: id,
  x,
  y,
  w,
  h,
  children,
});
const docWith = (...nodes: DesignNode[]): { doc: DesignDoc; page: Page } => {
  const doc = blankDoc("t");
  doc.pages[0]!.nodes = nodes;
  return { doc, page: doc.pages[0]! };
};
const near = (b: Box, exp: Partial<Box>, eps = 0.01) => {
  for (const [k, v] of Object.entries(exp)) expect(Math.abs(b[k as keyof Box] - (v as number))).toBeLessThan(eps);
};

describe("aabbRotated / worldBoxOf", () => {
  test("零度直通；90° 宽高互换、中心不变", () => {
    const b = { x: 0, y: 0, w: 100, h: 40 };
    expect(aabbRotated(b, 0)).toBe(b);
    near(aabbRotated(b, 90), { x: 30, y: -30, w: 40, h: 100 });
  });

  test("45° 正方形 → 边长 ×√2", () => {
    near(aabbRotated({ x: 0, y: 0, w: 100, h: 100 }, 45), { w: 141.4214, h: 141.4214, x: -20.7107, y: -20.7107 });
  });

  test("页面级 = 局部坐标；frame 子累加父原点；父链旋转参与子世界盒（与嵌套 group 矩阵一致）", () => {
    const frame = newFrame({ w: 375, h: 812, x: 100, y: 50 });
    frame.children.push(rect("r", 10, 20, 30, 30));
    const { doc } = docWith(frame);
    near(worldBoxOf(doc, "r")!, { x: 110, y: 70, w: 30, h: 30 });
    expect(worldCornersOf(doc, "r")![0]).toEqual({ x: 110, y: 70 });
    expect(worldCornersOf(doc, "nope")).toBeNull();

    // frame(0,0,100,40) 旋转 90°：子 (10,10,20,20) 的世界盒 → x∈[40,60], y∈[-20,0]
    const rot = newFrame({ w: 100, h: 40, x: 0, y: 0 });
    rot.rotation = 90;
    rot.children.push(rect("c", 10, 10, 20, 20));
    const t = docWith(rot);
    near(worldBoxOf(t.doc, "c")!, { x: 40, y: -20, w: 20, h: 20 });
    near(worldBoxOf(t.doc, rot.id)!, aabbRotated({ x: 0, y: 0, w: 100, h: 40 }, 90));
  });

  test("嵌套 group 在 frame 内：偏移沿父链累加", () => {
    const frame = newFrame({ w: 400, h: 400, x: 1000, y: 2000 });
    const g = group("g", 8, 8, 10, 10, [rect("c", 2, 3, 20, 30)]);
    frame.children.push(g);
    const { doc } = docWith(frame);
    near(worldBoxOf(doc, "c")!, { x: 1010, y: 2011, w: 20, h: 30 });
  });

  test("选择集并盒 / unionBox 空集", () => {
    const { doc } = docWith(rect("a", 0, 0, 10, 10), rect("b", 50, 60, 20, 30), rect("gone", 0, 0, 1, 1));
    near(selectionWorldBox(doc, ["a", "b"])!, { x: 0, y: 0, w: 70, h: 90 });
    expect(selectionWorldBox(doc, [])).toBeNull();
    expect(selectionWorldBox(doc, ["gone"])).not.toBeNull();
    expect(unionBox([])).toBeNull();
  });
});

describe("deriveGroupBox / normalizeGroups", () => {
  test("组盒贴合子并集，原点位移、子坐标反向补偿（世界位置不变）", () => {
    const c1 = rect("c1", 30, 40, 10, 10);
    const c2 = rect("c2", 70, 10, 10, 10);
    const g = group("g", 500, 600, 1, 1, [c1, c2]);
    deriveGroupBox(g);
    near(g, { x: 530, y: 610, w: 50, h: 40 });
    near(c1, { x: 0, y: 30, w: 10, h: 10 });
    near(c2, { x: 40, y: 0, w: 10, h: 10 });
  });

  test("含旋转子：用旋转后 AABB 参与并集", () => {
    const g = group("g", 0, 0, 1, 1, [rect("r", 0, 0, 100, 40, { rotation: 90 })]);
    deriveGroupBox(g);
    near(g, { x: 30, y: -30, w: 40, h: 100 }, 0.1);
  });

  test("空组保留原盒；normalizeGroups 端到端（agent 乱写的组几何被矫正，子的世界位置不变）", () => {
    const empty = group("empty", 3, 4, 5, 6, []);
    deriveGroupBox(empty);
    near(empty, { x: 3, y: 4, w: 5, h: 6 });

    const { doc } = docWith(group("g", -999, 42, 7, 7, [rect("a", 10, 10, 20, 20), rect("b", 40, 15, 10, 30)]));
    const before = worldBoxOf(doc, "a")!;
    normalizeGroups(doc);
    const g = doc.pages[0]!.nodes[0] as GroupNode;
    near(g, { x: -989, y: 52, w: 40, h: 35 });
    near(worldBoxOf(doc, "a")!, before);
  });
});

describe("applyAlign", () => {
  test("三形状左/水平中/底对齐", () => {
    const { doc } = docWith(rect("a", 100, 0, 20, 10), rect("b", 0, 50, 40, 10), rect("c", 60, 100, 10, 10));
    expect(applyAlign(doc, ["a", "b", "c"], "left", null)).toEqual(["a", "c"]);
    near(findNode(doc, "b")!.node, { x: 0 });
    near(findNode(doc, "a")!.node, { x: 0 });
    near(findNode(doc, "c")!.node, { x: 0 });

    const t2 = docWith(rect("a", 100, 0, 20, 10), rect("b", 0, 50, 40, 10), rect("c", 60, 100, 10, 10));
    applyAlign(t2.doc, ["a", "b", "c"], "hcenter", null);
    // 并盒 [0..120]，中心 60：a 中心 110→移 -50, b 中心 20→移 +40, c 中心 65→移 -5
    near(findNode(t2.doc, "a")!.node, { x: 50 });
    near(findNode(t2.doc, "b")!.node, { x: 40 });
    near(findNode(t2.doc, "c")!.node, { x: 55 });

    const t3 = docWith(rect("a", 100, 0, 20, 10), rect("b", 0, 50, 40, 10), rect("c", 60, 100, 10, 10));
    applyAlign(t3.doc, ["a", "b", "c"], "bottom", null);
    near(findNode(t3.doc, "a")!.node, { y: 100 });
    near(findNode(t3.doc, "c")!.node, { y: 100 });
  });

  test("单件按参照盒（画板）对齐；hdist 三点等距、首尾钉住", () => {
    const frame = newFrame({ w: 375, h: 812, x: 1000, y: 0 });
    frame.children.push(rect("t", 10, 20, 100, 40)); // 子坐标是 frame 局部：世界 x=1010
    const { doc } = docWith(frame);
    applyAlign(doc, ["t"], "hcenter", worldBoxOf(doc, frame.id));
    near(findNode(doc, "t")!.node, { x: (375 - 100) / 2 });

    const d = docWith(rect("x", 0, 0, 10, 10), rect("y", 35, 0, 20, 10), rect("z", 100, 0, 10, 10));
    applyAlign(d.doc, ["x", "y", "z"], "hdist", null);
    // 跨度 110，总宽 40，两个间隙各 35：x@0，y@45，z@100
    near(findNode(d.doc, "y")!.node, { x: 45 });
    near(findNode(d.doc, "z")!.node, { x: 100 });
    const two = docWith(rect("p", 0, 0, 5, 5), rect("q", 50, 0, 5, 5));
    expect(applyAlign(two.doc, ["p", "q"], "hdist", null)).toEqual([]);
  });

  test("组的子节点不参与独立对齐", () => {
    const { doc } = docWith(group("g", 0, 0, 40, 40, [rect("c", 10, 10, 20, 20)]));
    expect(applyAlign(doc, ["c"], "left", null)).toEqual([]);
    near(findNode(doc, "c")!.node, { x: 10 });
  });

  test("旋转父容器：世界位移逆变换回局部再落笔（左对齐真的对齐世界左缘、y 纹丝不动）", () => {
    const frame = newFrame({ x: 0, y: 0, w: 200, h: 100 });
    frame.rotation = 90;
    frame.children.push(rect("c1", 10, 10, 20, 20), rect("c2", 50, 30, 20, 20));
    const { doc } = docWith(frame);
    const before = worldBoxOf(doc, "c1")!;
    applyAlign(doc, ["c1", "c2"], "left", null);
    const b1 = worldBoxOf(doc, "c1")!;
    const b2 = worldBoxOf(doc, "c2")!;
    near(b1, { x: b2.x }); // 世界左缘对齐
    near(b1, { y: before.y }); // 左对齐不许动世界 y
    near(findNode(doc, "c1")!.node, { x: 10, y: 30 }); // 位移落在局部 y 上（旧代码会错改局部 x）
  });

  test("锁定/隐藏层：不进参照盒、也不被挪动", () => {
    const { doc } = docWith(
      rect("a", 100, 0, 20, 10),
      rect("b", 0, 50, 40, 10, { locked: true }),
      rect("c", 60, 100, 10, 10),
      rect("d", 200, 0, 10, 10, { visible: false }),
    );
    applyAlign(doc, ["a", "b", "c", "d"], "left", null);
    near(findNode(doc, "a")!.node, { x: 60 }); // 参照盒 = 可移动 {a,c} 并盒，左缘 60（不含 b 的 0 / d 的 200）
    near(findNode(doc, "c")!.node, { x: 60 });
    near(findNode(doc, "b")!.node, { x: 0 });
    near(findNode(doc, "d")!.node, { x: 200 });
  });
});

describe("snap", () => {
  test("候选线：页级节点的边/中线，排除被拖集合与隐藏/锁定", () => {
    const { doc, page } = docWith(
      rect("a", 100, 200, 50, 50),
      rect("m", 0, 0, 10, 10),
      rect("h", 500, 0, 10, 10, { visible: false }),
      rect("l", 600, 0, 10, 10, { locked: true }),
    );
    const c = snapCandidates(doc, page, new Set(["m"]));
    expect(c.v.map((l) => l.at)).toContain(100);
    expect(c.v.map((l) => l.at)).toContain(125); // a 中线
    expect(c.v.map((l) => l.at)).not.toContain(500);
    expect(c.h.map((l) => l.at)).not.toContain(600);
  });

  test("右缘吸 A 左缘：dx 修正 + 对齐线段纵向覆盖两者", () => {
    const { doc, page } = docWith(rect("a", 100, 200, 50, 50));
    const c = snapCandidates(doc, page, new Set());
    const moving: Box = { x: 64, y: 210, w: 36, h: 20 }; // 右缘 100 差 0？→ 左缘 64 距 100 差 36>6 不吸；右缘 64+36=100 精确
    const r = resolveSnap(moving, c, 6);
    expect(r.dx).toBe(0); // 右缘 100 已重合（d=0 也走 best）
    expect(r.vLines.length).toBe(1);
    expect(r.vLines[0]!.at).toBe(100);
    expect(r.vLines[0]!.a).toBe(200); // min(200, 210)=200? A 覆盖 200..250、mover 210..230 → 200..250? min=200
    expect(r.vLines[0]!.b).toBe(250);
  });

  test("阈值内取最近边：优先更小偏差；超阈值不吸", () => {
    const { doc, page } = docWith(rect("a", 100, 0, 50, 50));
    const c = snapCandidates(doc, page, new Set());
    // mover 左缘 103 → 距 a 左缘 100 差 -3；上缘距 0 远
    const r = resolveSnap({ x: 103, y: 300, w: 10, h: 10 }, c, 6);
    expect(r.dx).toBe(-3);
    expect(r.dy).toBe(0);
    const far = resolveSnap({ x: 110, y: 300, w: 10, h: 10 }, c, 6);
    // 110 左缘对 a 中线 125 差 15>6；右缘 120 对 125 差 5≤6 → 吸中线
    expect(far.dx).toBe(5);
    expect(resolveSnap({ x: 500, y: 500, w: 10, h: 10 }, c, 6)).toEqual({ dx: 0, dy: 0, vLines: [], hLines: [] });
  });
});

describe("hitRect / hitPoint", () => {
  test("框选：相交即选顶层、锁定/隐藏跳过、组与画板整体收", () => {
    const g = group("g", 0, 0, 100, 100, [rect("inner", 80, 80, 10, 10)]);
    const { doc, page } = docWith(g, rect("far", 500, 500, 10, 10), rect("lock", 10, 10, 10, 10, { locked: true }));
    expect(hitRect(doc, page, { x: 85, y: 85, w: 20, h: 20 })).toEqual(["g"]);
    expect(hitRect(doc, page, { x: -50, y: -50, w: 700, h: 700 })).toEqual(["g", "far"]);
  });

  test("点选：最深优先；画板空白落板面；锁定穿透到下层；后画在上；组空白回组根", () => {
    const frame = newFrame({ name: "F", w: 300, h: 300, x: 0, y: 0 });
    frame.children.push(rect("child", 10, 10, 20, 20));
    const below = rect("below", 0, 0, 50, 50);
    const onTop = rect("onTop", 0, 0, 50, 50, { locked: true });
    const { doc, page } = docWith(below, onTop, frame);
    expect(hitPoint(doc, page, { x: 15, y: 15 })).toBe("child"); // frame 内命中最深子
    expect(hitPoint(doc, page, { x: 5, y: 5 })).toBe(frame.id); // frame 空白 → frame 本身（后画盖住 below/onTop）

    const t2 = docWith(below, onTop);
    expect(hitPoint(t2.doc, t2.page, { x: 5, y: 5 })).toBe("below"); // 锁定整枝穿透

    const g = group("g", 0, 0, 100, 100, [rect("inner", 80, 80, 10, 10)]);
    const t3 = docWith(g);
    expect(hitPoint(t3.doc, t3.page, { x: 85, y: 85 })).toBe("inner");
    expect(hitPoint(t3.doc, t3.page, { x: 10, y: 10 })).toBe("g"); // 组空白 → 组根
    expect(hitPoint(t3.doc, t3.page, { x: 200, y: 200 })).toBeNull();
    g.visible = false;
    expect(hitPoint(t3.doc, t3.page, { x: 85, y: 85 })).toBeNull();
  });
});

describe("countNodes", () => {
  test("跨页全树计数", () => {
    const { doc } = docWith(newFrame({ w: 10, h: 10 }), group("g", 0, 0, 10, 10, [rect("a", 0, 0, 1, 1), group("g2", 0, 0, 2, 2, [rect("b", 0, 0, 1, 1)])]));
    const page2: Page = { id: "p2", name: "2", nodes: [rect("x", 0, 0, 1, 1)] };
    doc.pages.push(page2);
    expect(countNodes(doc)).toBe(6);
  });
});

describe("collectSnapBoxes / linesFromBoxes / spacingLabels", () => {
  test("移动集自身与子孙排除；祖先画板保留为参照", () => {
    const frame = newFrame({ w: 300, h: 300, x: 0, y: 0 });
    const child = rect("c1", 10, 10, 20, 20);
    frame.children.push(child);
    const other = rect("o1", 400, 0, 50, 50);
    const { doc, page } = docWith(frame, other);
    const boxes = collectSnapBoxes(doc, page, new Set([child.id]));
    // 画板（祖先）+ other 在列；移动子节点不在
    expect(boxes.some((b) => b.x === 400)).toBe(true);
    expect(boxes.some((b) => b.w === 300)).toBe(true);
    expect(boxes.some((b) => b.w === 20 && b.x === 10)).toBe(false);
    // 移动整个画板：其子孙整体排除，other 保留
    const boxes2 = collectSnapBoxes(doc, page, new Set([frame.id]));
    expect(boxes2.length).toBe(1);
    expect(boxes2[0]!.x).toBe(400);
  });

  test("linesFromBoxes：每盒 3 竖 3 横", () => {
    const c = linesFromBoxes([{ x: 0, y: 0, w: 100, h: 50 }]);
    expect(c.v.map((l) => l.at).sort((a, b) => a - b)).toEqual([0, 50, 100]);
    expect(c.h.map((l) => l.at).sort((a, b) => a - b)).toEqual([0, 25, 50]);
  });

  test("spacingLabels：四向最近间距，投影不相交/超阈值不计", () => {
    const moving: Box = { x: 100, y: 100, w: 40, h: 40 };
    const left: Box = { x: 0, y: 90, w: 80, h: 60 }; // 右缘 80 → 间距 20
    const right: Box = { x: 160, y: 0, w: 20, h: 50 }; // 投影不相交（y 不重叠）
    const far: Box = { x: 100, y: 500, w: 10, h: 10 }; // 太远
    const near: Box = { x: 100, y: 40, w: 10, h: 40 }; // 顶缘 80 → 间距 20
    const labels = spacingLabels(moving, [left, right, far, near], 240);
    expect(labels.length).toBe(2);
    expect(labels.find((l) => l.text === "20" && l.x2 === 100)).toBeDefined(); // 左
    expect(labels.find((l) => l.text === "20" && l.y2 === 100)).toBeDefined(); // 上
    // 阈值裁剪
    expect(spacingLabels(moving, [left], 10).length).toBe(0);
  });
});
