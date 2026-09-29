/**
 * editorLedger：@leafer-in/editor 节点终值 → doc 几何补丁的换算契约。
 *
 * 核心不变量（防"松手回弹"）：END 时用户看到的几何 == 提交后 scene 重渲染的几何。
 * 两侧都用已证实的矩阵约定表达（scene.ts 恒等契约 + @leafer/math around:center 探针）：
 *   节点 world(v) = (tr.x, tr.y) + R(tr.rotation)·diag(s)·(v − o)
 *   提交后 world(v') = center(el') + R(el'.rotation)·(v' − o')   （scale 恒 1）
 * 于是局部映射必须是无旋转项的 v' = o' + diag(s)·(v − o)
 * （与 DOM 轨 rebasePoly「rotation 原样保留、pts 存未旋转系」同口径）。
 */
import { describe, expect, test } from "bun:test";
import { editorLocalMap, editorPatchIfChanged, editorTransformToElPatch, type EditorNodeTransform } from "../src/leafer/editorLedger";
import { LINE_SHAPE_KINDS, type El, type LinePt, type ShapeEl } from "../src/doc";
import { curveArrow, isPolyline, lineEnds } from "../src/viewspec";

type Box = { x: number; y: number; w: number; h: number; rotation?: number };

const rot = (deg: number, x: number, y: number) => {
  const th = (deg * Math.PI) / 180;
  return { x: Math.cos(th) * x - Math.sin(th) * y, y: Math.sin(th) * x + Math.cos(th) * y };
};

/** 节点在 END 时刻的世界位置（用户所见） */
const nodeWorld = (el: Box, tr: EditorNodeTransform, v: { x: number; y: number }) => {
  const p = rot(tr.rotation, tr.scaleX * (v.x - el.w / 2), tr.scaleY * (v.y - el.h / 2));
  return { x: tr.x + p.x, y: tr.y + p.y };
};

/** 提交后的 doc 元素经 scene 恒等契约渲染出的世界位置 */
const docWorld = (el: Box, v: { x: number; y: number }) => {
  const p = rot(el.rotation ?? 0, v.x - el.w / 2, v.y - el.h / 2);
  return { x: el.x + el.w / 2 + p.x, y: el.y + el.h / 2 + p.y };
};

/** 补丁应用后的元素（含 undefined 删键，语义同 store 的 {...el, ...patch}） */
const applyPatch = (el: El, patch: Partial<El>): El & Box => ({ ...el, ...patch }) as El & Box;

/** 元素的世界可采样点集：盒元素取四角；线类取端点 + 弧控制点；折线逐顶点 */
function sampleLocals(el: El): { x: number; y: number }[] {
  if (el.kind === "shape" && LINE_SHAPE_KINDS.includes((el as ShapeEl).shape)) {
    const s = el as ShapeEl;
    if (isPolyline(s)) return (s.pts as LinePt[]).map(([x, y]) => ({ x, y }));
    const e = lineEnds(s.w, s.h, s.dir);
    const c = curveArrow(s);
    return [
      { x: e.x1, y: e.y1 },
      { x: e.x2, y: e.y2 },
      { x: c.cx, y: c.cy },
    ];
  }
  return [
    { x: 0, y: 0 },
    { x: el.w, y: 0 },
    { x: el.w, y: el.h },
    { x: 0, y: el.h },
  ];
}

/** 全表世界不变量：对每种手势，采样点提交前后世界位置逐一相等 */
function expectWorldInvariant(el: El, tr: EditorNodeTransform) {
  const next = applyPatch(el, editorTransformToElPatch(el, tr));
  for (const v of sampleLocals(el)) {
    const q = editorLocalMap(el, tr, v.x, v.y);
    const a = nodeWorld(el, tr, v);
    const b = docWorld(next, q);
    expect(Math.abs(a.x - b.x)).toBeLessThan(1e-6);
    expect(Math.abs(a.y - b.y)).toBeLessThan(1e-6);
  }
}

const rect = (o: Partial<ShapeEl> = {}): ShapeEl => ({ kind: "shape", id: "r1", x: 100, y: 100, w: 50, h: 40, shape: "rect", ...o });
const line = (o: Partial<ShapeEl> = {}): ShapeEl => ({ kind: "shape", id: "l1", x: 100, y: 100, w: 100, h: 60, shape: "arrow", stroke: "#000", ...o });

describe("editorTransformToElPatch — 盒几何", () => {
  test("纯移动：中心平移 50/40 → x=55, y=46（w/h/rotation 不动）", () => {
    const el = rect({ x: 5, y: 6, w: 30, h: 20 }); // 中心 (20,16)
    const patch = editorTransformToElPatch(el, { x: 70, y: 56, scaleX: 1, scaleY: 1, rotation: 0 });
    expect(patch.x).toBe(55);
    expect(patch.y).toBe(46);
    expect(patch.w).toBe(30);
    expect(patch.h).toBe(20);
    expect(patch.rotation).toBe(0);
  });

  test("右缘拖宽 2×：中心随盒走，x 不动", () => {
    const el = rect(); // (100,100,50,40) 中心 (125,120)
    const patch = editorTransformToElPatch(el, { x: 150, y: 120, scaleX: 2, scaleY: 1, rotation: 0 });
    expect(patch).toMatchObject({ x: 100, y: 100, w: 100, h: 40 });
  });

  test("rotation 归一化 350 → −10", () => {
    const el = rect();
    const patch = editorTransformToElPatch(el, { x: 125, y: 120, scaleX: 1, scaleY: 1, rotation: 350 });
    expect(patch.rotation).toBe(-10);
  });

  test("纯旋转世界不变（pts/角点不在局部系里二次旋转）", () => {
    expectWorldInvariant(line({ pts: undefined }), { x: 150, y: 130, scaleX: 1, scaleY: 1, rotation: 45 });
    expectWorldInvariant(rect({ rotation: 30 }), { x: 125, y: 120, scaleX: 1, scaleY: 1, rotation: -120 });
  });
});

describe("editorTransformToElPatch — 线语义", () => {
  test("FLIP_X 两点线：dir 0→3、curve 翻号、世界不变", () => {
    const el = line({ x: 100, y: 100, w: 100, h: 60, shape: "arrow", dir: 0, curve: 0.5 });
    const tr: EditorNodeTransform = { x: 150, y: 130, scaleX: -1, scaleY: 1, rotation: 0 };
    const patch = editorTransformToElPatch(el, tr);
    expect(patch.dir).toBe(3);
    expect(patch.curve).toBe(-0.5);
    expectWorldInvariant(el, tr);
  });

  test("FLIP_Y 两点线：dir 0→1、curve 翻号、世界不变", () => {
    const el = line({ x: 100, y: 100, w: 100, h: 60, shape: "arrow", dir: 0, curve: 0.5 });
    const tr: EditorNodeTransform = { x: 150, y: 130, scaleX: 1, scaleY: -1, rotation: 0 };
    const patch = editorTransformToElPatch(el, tr);
    expect(patch.dir).toBe(1);
    expect(patch.curve).toBe(-0.5);
    expectWorldInvariant(el, tr);
  });

  test("diag(−1,−1)（点镜像，未折叠）：dir 0→2、curve 不变、世界不变", () => {
    const el = line({ x: 100, y: 100, w: 100, h: 60, shape: "arrow", dir: 0, curve: 0.5 });
    const tr: EditorNodeTransform = { x: 150, y: 130, scaleX: -1, scaleY: -1, rotation: 0 };
    const patch = editorTransformToElPatch(el, tr);
    expect(patch.dir).toBe(2);
    expect(patch.curve).toBeUndefined(); // det>0：弧向不变，不写 curve 键
    expectWorldInvariant(el, tr);
  });

  test("折叠镜像（getLayout 把 flip-x 折进 rotation+180）：世界不变量仍成立", () => {
    const el = line({ rotation: 30, curve: 0.4 });
    // 节点终值被分解为 sx=1、sy=−1、θ=30+180→−150：等价于原矩阵 R(30)·diag(−1,1)
    const tr: EditorNodeTransform = { x: 150, y: 130, scaleX: 1, scaleY: -1, rotation: -150 };
    expect(editorTransformToElPatch(el, tr).rotation).toBe(-150);
    expectWorldInvariant(el, tr);
    // 对照组：未折叠表示给出同一视觉（世界采样点重合）
    const folded = applyPatch(el, editorTransformToElPatch(el, tr));
    const raw = applyPatch(el, editorTransformToElPatch(el, { x: 150, y: 130, scaleX: -1, scaleY: 1, rotation: 30 }));
    for (const v of sampleLocals(el)) {
      const a = docWorld(folded, editorLocalMap(el, tr, v.x, v.y));
      const b = docWorld(raw, editorLocalMap(el, { x: 150, y: 130, scaleX: -1, scaleY: 1, rotation: 30 }, v.x, v.y));
      expect(Math.abs(a.x - b.x)).toBeLessThan(1e-6);
      expect(Math.abs(a.y - b.y)).toBeLessThan(1e-6);
    }
  });

  test("旋转 + 缩放复合手势：世界不变", () => {
    expectWorldInvariant(line({ curve: -0.3 }), { x: 160, y: 140, scaleX: 1.5, scaleY: 0.5, rotation: 70 });
    expectWorldInvariant(line({ dir: 2 }), { x: 140, y: 120, scaleX: -2, scaleY: 1.5, rotation: 200 });
  });

  test("折线：逐顶点映射 + r1；bbox 恒等式 |s|·w/h", () => {
    const el = line({ x: 0, y: 0, w: 100, h: 100, pts: [[10, 20], [50, 30], [90, 10]] });
    const patch = editorTransformToElPatch(el, { x: 100, y: 50, scaleX: 2, scaleY: 0.5, rotation: 0 });
    expect(patch).toMatchObject({ x: 0, y: 25, w: 200, h: 50 });
    expect(patch.pts).toEqual([
      [20, 10],
      [100, 15],
      [180, 5],
    ]);
    expectWorldInvariant(el, { x: 100, y: 50, scaleX: 2, scaleY: 0.5, rotation: 0 });
  });

  test("折线镜像：顶点局部映射自动翻转，世界不变", () => {
    expectWorldInvariant(line({ pts: [[10, 20], [50, 30], [90, 10]] }), { x: 50, y: 50, scaleX: -1, scaleY: 1, rotation: 0 });
  });
});

describe("绑定解绑口径（与 DOM 轨 unbindPatch 一致）", () => {
  test("纯移动保留 startBind/endBind", () => {
    const el = line({ startBind: "a", endBind: "b" });
    const patch = editorTransformToElPatch(el, { x: 175, y: 150, scaleX: 1, scaleY: 1, rotation: 0 });
    expect("startBind" in patch).toBe(false);
    expect("endBind" in patch).toBe(false);
  });

  test("缩放/旋转 → 双键置 undefined（editorPatchIfChanged 仅在原值存在时写入）", () => {
    const el = line({ startBind: "a", endBind: "b" });
    const p = editorPatchIfChanged(el, { x: 150, y: 130, scaleX: 2, scaleY: 1, rotation: 0 });
    expect(p?.startBind).toBeUndefined();
    expect("startBind" in (p ?? {})).toBe(true);
    const bare = editorPatchIfChanged(line({ x: 100, y: 100, startBind: undefined }), { x: 150, y: 130, scaleX: 2, scaleY: 1, rotation: 0 });
    expect("startBind" in bare!).toBe(false);
  });

  test("180° 折叠不算纯移动（解绑）", () => {
    const el = line({ startBind: "a", rotation: 0 });
    const patch = editorTransformToElPatch(el, { x: 150, y: 130, scaleX: -1, scaleY: -1, rotation: 0 });
    expect("startBind" in patch).toBe(true);
  });
});

describe("editorPatchIfChanged — 空补丁守卫", () => {
  test("恒等手势 → null（原地单击不产生 undo 步）", () => {
    expect(editorPatchIfChanged(rect(), { x: 125, y: 120, scaleX: 1, scaleY: 1, rotation: 0 })).toBeNull();
    expect(editorPatchIfChanged(line({ rotation: 20 }), { x: 150, y: 130, scaleX: 1, scaleY: 1, rotation: 20 })).toBeNull();
  });

  test("r1 写入精度归一：0.44 的存储噪声不算变化", () => {
    const el = rect({ x: 200.44, y: 100, w: 30, h: 20 }); // 中心 (215.44, 110)
    expect(editorPatchIfChanged(el, { x: 215.44, y: 110, scaleX: 1, scaleY: 1, rotation: 0 })).toBeNull();
  });

  test("rotation 缺省视为 0：折叠到 −0 也不算变化", () => {
    expect(editorPatchIfChanged(rect(), { x: 125, y: 120, scaleX: 1, scaleY: 1, rotation: -0 })).toBeNull();
  });
});

describe("editorLocalMap 直测", () => {
  test("无旋转纯缩放：v' = o' + diag(s)·(v − o)；不随 tr.rotation 二次旋转", () => {
    const el = rect({ x: 0, y: 0, w: 100, h: 50 });
    expect(editorLocalMap(el, { x: 0, y: 0, scaleX: 2, scaleY: 1, rotation: 0 }, 100, 50)).toEqual({ x: 200, y: 50 });
    expect(editorLocalMap(el, { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 90 }, 0, 0)).toEqual({ x: 0, y: 0 });
  });
});
