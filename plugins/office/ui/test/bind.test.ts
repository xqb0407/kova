/**
 * 连线绑定测试：syncBoundArrows 的锚点重算、幂等、跟随移动、悬空/自绑清除、
 * 单端绑定，以及 parseDoc/serializeDoc 对 startBind/endBind 的透传白名单。
 */
import { describe, expect, test } from "bun:test";
import { DOC_VERSION, blankFrame, parseDoc, serializeDoc, type CanvasDoc, type Frame, type ShapeEl } from "../src/doc";
import { lineEnds, syncBoundArrows } from "../src/bind";

const rect = (id: string, x: number, y: number, w: number, h: number): ShapeEl => ({
  kind: "shape",
  id,
  shape: "rect",
  x,
  y,
  w,
  h,
});
const arrow = (over: Partial<ShapeEl>): ShapeEl => ({
  kind: "shape",
  id: "arr",
  shape: "arrow",
  x: 0,
  y: 0,
  w: 1,
  h: 1,
  ...over,
});
const boardDoc = (objects: ShapeEl[]): CanvasDoc => ({
  version: DOC_VERSION,
  meta: { name: "t", pagePreset: "16:9", kind: "board" },
  objects,
  frames: [],
});

describe("syncBoundArrows", () => {
  test("两端绑定：端点重算到被绑元素朝向对端中心的边缘锚点", () => {
    // A 中心 (50,50)，B 中心 (350,250)：射线从 A 中心出右边缘 (100, 83.33)，从 B 中心出左边缘 (300, 216.67)
    const doc = boardDoc([rect("a", 0, 0, 100, 100), rect("b", 300, 200, 100, 100), arrow({ startBind: "a", endBind: "b" })]);
    const out = syncBoundArrows(doc);
    const arr = out.objects[2] as ShapeEl;
    expect({ x: arr.x, y: arr.y, w: arr.w, h: arr.h, dir: arr.dir ?? 0 }).toEqual({ x: 100, y: 83, w: 200, h: 133, dir: 0 });
    expect([arr.startBind, arr.endBind]).toEqual(["a", "b"]);
  });

  test("幂等：再同步一次返回原引用（无变化不产新对象）", () => {
    const doc = boardDoc([rect("a", 0, 0, 100, 100), rect("b", 300, 200, 100, 100), arrow({ startBind: "a", endBind: "b" })]);
    const once = syncBoundArrows(doc);
    expect(syncBoundArrows(once)).toBe(once);
  });

  test("被绑元素移动后连线自动跟随", () => {
    const doc = boardDoc([rect("a", 0, 0, 100, 100), rect("b", 300, 200, 100, 100), arrow({ startBind: "a", endBind: "b" })]);
    const moved: CanvasDoc = { ...doc, objects: [doc.objects[0], rect("b", 500, 0, 100, 100), doc.objects[2]] };
    const out = syncBoundArrows(moved);
    const arr = out.objects[2] as ShapeEl;
    // 中心对 (50,50)↔(550,50)：水平连线
    expect([arr.x, arr.y, arr.w, arr.h]).toEqual([100, 50, 400, 1]);
  });

  test("无绑定的文档原样返回", () => {
    const doc = boardDoc([rect("a", 0, 0, 100, 100), arrow({ x: 10, y: 10, w: 90, h: 90 })]);
    expect(syncBoundArrows(doc)).toBe(doc);
  });

  test("悬空绑定：目标已删除时解除绑定、保留线段现状", () => {
    const arr = arrow({ x: 10, y: 10, w: 90, h: 90, startBind: "gone", endBind: "a" });
    const doc = boardDoc([rect("a", 200, 200, 100, 100), arr]);
    const out = syncBoundArrows(doc);
    const s = out.objects[1] as ShapeEl;
    expect(s.startBind).toBeUndefined();
    expect(s.endBind).toBe("a");
    // 起点保持原端点 (10,10)（dir0 → x,y），终点吸附到 A 朝 (10,10) 的右上…左边缘锚点
    const [p0] = lineEnds(s);
    expect(p0).toEqual({ x: 10, y: 10 });
  });

  test("自绑/两端同元素：终点绑定被清除，仅起点吸附", () => {
    const doc = boardDoc([rect("a", 0, 0, 100, 100), arrow({ startBind: "a", endBind: "a" })]);
    const out = syncBoundArrows(doc);
    const arr = out.objects[1] as ShapeEl;
    expect(arr.startBind).toBe("a");
    expect(arr.endBind).toBeUndefined();
  });

  test("单端绑定：自由端保持现状，绑定端重算锚点", () => {
    // 线现状 (100,83)→(300,216)（对角 dir0），仅起点绑 A：向自由端 (300,216) 求锚
    const doc = boardDoc([rect("a", 0, 0, 100, 100), arrow({ x: 100, y: 83, w: 200, h: 133, startBind: "a" })]);
    const out = syncBoundArrows(doc);
    const arr = out.objects[1] as ShapeEl;
    const [p0, p1] = lineEnds(arr);
    expect(p0).toEqual({ x: 100, y: 83 }); // 锚点在 A 右边缘
    expect(p1).toEqual({ x: 300, y: 216 }); // 自由端未动
  });

  test("frame 容器内绑定同步，objects 不受影响", () => {
    const f: Frame = { ...blankFrame(), elements: [rect("a", 0, 0, 100, 100), rect("b", 300, 200, 100, 100), arrow({ startBind: "a", endBind: "b" })] };
    const doc: CanvasDoc = {
      version: DOC_VERSION,
      meta: { name: "t", pagePreset: "16:9", kind: "deck" },
      objects: [arrow({ id: "free", x: 0, y: 0, w: 50, h: 50, startBind: "a" })], // 跨容器悬空 id：objects 里 a 不存在 → 也会被清
      frames: [f],
    };
    const out = syncBoundArrows(doc);
    const arr = out.frames[0].elements[2] as ShapeEl;
    expect({ x: arr.x, y: arr.y, w: arr.w, h: arr.h }).toEqual({ x: 100, y: 83, w: 200, h: 133 });
    expect((out.objects[0] as ShapeEl).startBind).toBeUndefined();
  });
});

describe("被绑元素旋转（锚点走在旋转后的真实边上）", () => {
  test("90° 竖条：水平射线锚在旋转后的右缘（x=70），而不是原盒右缘（x=100）", () => {
    // a 存储盒 (0,0,100,40) 中心 (50,20)；旋转 90° 后世界占 (30,-30)~(70,70)，右缘 x=70
    const a: ShapeEl = { ...rect("a", 0, 0, 100, 40), rotation: 90 };
    const arr = arrow({ x: 70, y: 21, w: 250, h: 19, startBind: "a" }); // 自由端 (320,40)
    const out = syncBoundArrows(boardDoc([a, arr]));
    const s = out.objects[1] as ShapeEl;
    const [p0] = lineEnds(s);
    expect(p0.x).toBeCloseTo(70, 0); // 贴旋转右缘；未修时锚在 x=100
  });

  test("45° 方块：水平射线锚在菱形最右顶点 (120.7, 50)", () => {
    const a: ShapeEl = { ...rect("a", 0, 0, 100, 100), rotation: 45 };
    const b = rect("b", 300, 0, 100, 100);
    const out = syncBoundArrows(boardDoc([a, b, arrow({ startBind: "a", endBind: "b" })]));
    const s = out.objects[2] as ShapeEl;
    const [p0, p1] = lineEnds(s);
    expect(p0.x).toBeCloseTo(50 + 50 * Math.SQRT2, 0); // 120.7：局部 (100,0) 角旋到世界最右
    expect(p0.y).toBeCloseTo(50, 0);
    expect(p1.x).toBe(300);
    expect(Math.abs(p1.y - 50)).toBeLessThanOrEqual(1); // b 未旋转：常规左缘锚点（水平线 h 兜底 1px）
  });

  test("旋转锚点幂等：带旋转文档二次同步返回原引用", () => {
    const a: ShapeEl = { ...rect("a", 0, 0, 100, 40), rotation: 30 };
    const doc = boardDoc([a, rect("b", 300, 0, 100, 100), arrow({ startBind: "a", endBind: "b" })]);
    const once = syncBoundArrows(doc);
    expect(syncBoundArrows(once)).toBe(once);
  });

  test("绑定线自身带 rotation：同步按世界位置取自由端，并把线自身 rotation 归一化清除", () => {
    const a = rect("a", 0, 0, 100, 100);
    // 线盒 (200,100,100,100) dir0 局部对角 (200,100)→(300,200)，自身旋转 90°：
    // 世界像 = 绕中心 (250,150) 顺转 → (300,100)→(200,200)。起点绑 a，终点自由。
    // 正确结果：自由终点停在世界像 (200,200)（旧代码会停在局部 (300,200)，视觉上跳位）；
    // 绑定端重锚到 a 朝 (200,200) 的对角射线交点（右下角 (100,100)）。
    const arr: ShapeEl = { ...arrow({ x: 200, y: 100, w: 100, h: 100, startBind: "a" }), rotation: 90 };
    const out = syncBoundArrows(boardDoc([a, arr]));
    const s = out.objects[1] as ShapeEl;
    expect(s.rotation).toBeUndefined(); // bbox+dir 已整体重写，自身旋转无意义
    const [p0, p1] = lineEnds(s);
    expect([p0.x, p0.y]).toEqual([100, 100]); // 绑定端贴 a 右下缘
    expect([p1.x, p1.y]).toEqual([200, 200]); // 自由端 = 原世界像（未因清 rotation 跳回局部对角）
  });
});

describe("parseDoc 绑定透传", () => {
  test("线类保留 startBind/endBind，serializeDoc 往返不丢", () => {
    const doc = boardDoc([rect("a", 0, 0, 100, 100), arrow({ startBind: "a", endBind: "nope" })]);
    const parsed = parseDoc(JSON.parse(serializeDoc(doc)));
    expect(parsed).not.toBeNull();
    const arr = parsed!.objects.find((e) => e.kind === "shape" && e.shape === "arrow") as ShapeEl;
    expect([arr.startBind, arr.endBind]).toEqual(["a", "nope"]);
    // 往返后再同步：endBind 悬空被清，几何已收敛（锚进 a 边缘 + 自由端）
    const resynced = syncBoundArrows(parsed!);
    const arr2 = resynced.objects.find((e) => e.kind === "shape" && e.shape === "arrow") as ShapeEl;
    expect(arr2.startBind).toBe("a");
    expect(arr2.endBind).toBeUndefined();
  });

  test("非线类形状的绑定字段被丢弃", () => {
    const parsed = parseDoc({
      version: DOC_VERSION,
      meta: { name: "t", pagePreset: "16:9" },
      objects: [{ kind: "shape", id: "r1", shape: "rect", x: 0, y: 0, w: 10, h: 10, startBind: "r2" }],
      frames: [],
    });
    const r = parsed!.objects[0] as ShapeEl;
    expect(r.startBind).toBeUndefined();
  });
});
