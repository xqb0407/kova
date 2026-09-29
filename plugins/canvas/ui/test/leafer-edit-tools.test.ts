/**
 * leafer/editTools 纯几何函数：定制把手（线端点 / 折线顶点）手势数学的单测。
 *
 * 这些函数是 DOM 轨同名交互（onUp draw / node 模式 / alt 删点）的移植，
 * 验收标准 = 与 DOM 轨逐分支同口径：取整/最小尺寸/dir 重编码/Shift 15° 吸附/
 * Alt around 对称塌缩，全在这里锁死；leafer 侧只负责把 DragEvent 变成 dx/dy。
 */
import { describe, expect, test } from "bun:test";
import type { ShapeEl } from "../src/doc";
// 只 import 纯数学模块：editTools.ts 本体加载 leafer-ui，在 bun test 下会缺 DOM 全局直接崩
import { collapsePatch, endpointDrag, vertexDrag } from "../src/leafer/editToolsMath";

const line = (over: Partial<ShapeEl> = {}): ShapeEl => ({
  kind: "shape",
  id: "l1",
  shape: "line",
  x: 100,
  y: 100,
  w: 200,
  h: 100,
  stroke: "#000",
  ...over,
});

describe("endpointDrag（两点线/箭头端点把手）", () => {
  test("dir0 拖终点：盒扩张、dir 不变则补丁不带 dir 键", () => {
    const { patch, start, end } = endpointDrag(line(), "end", 50, 30);
    expect(patch).toEqual({ x: 100, y: 100, w: 250, h: 130 });
    expect(start).toEqual({ x: 100, y: 100 });
    expect(end).toEqual({ x: 350, y: 230 });
  });

  test("拖过起点：bbox 重取对角、dir 重编码（0→3），端点回报与渲染严格一致", () => {
    const { patch, start, end } = endpointDrag(line({ w: 100, h: 100 }), "end", -150, -50);
    // 终点跑到 (50,150)：左上角 x=50,y=100，50×50 盒；向量 (100,100)→(50,150) 左下 = dir3
    expect(patch).toEqual({ x: 50, y: 100, w: 50, h: 50, dir: 3 });
    expect(start).toEqual({ x: 100, y: 100 });
    expect(end).toEqual({ x: 50, y: 150 });
  });

  test("Shift 轴锁：|dx|>|dy| 保横弃纵（作用于 TOTAL，不逐帧漂移）", () => {
    const { patch } = endpointDrag(line(), "end", 10, 100, { axisLock: true });
    expect(patch).toEqual({ x: 100, y: 100, w: 200, h: 200 });
  });

  test("Shift 轴锁等值走 else 分支：|dx|==|dy| 保纵弃横", () => {
    const { patch } = endpointDrag(line(), "end", 40, 40, { axisLock: true });
    expect(patch).toEqual({ x: 100, y: 100, w: 200, h: 140 });
  });

  test("Alt around：另一端对称内移，盒中心不动（穿过中心拖）", () => {
    const { patch } = endpointDrag(line(), "start", 10, 10, { around: true });
    expect(patch).toEqual({ x: 110, y: 110, w: 180, h: 80 });
    expect((patch.x! + patch.w! / 2)).toBe(200);
    expect((patch.y! + patch.h! / 2)).toBe(150);
  });

  test("退化防护：端点重合 w/h 最小 1（与画线落笔同款）", () => {
    const { patch, start, end } = endpointDrag(line({ w: 100, h: 1 }), "end", -100, 0);
    expect(patch.w).toBe(1);
    expect(patch.h).toBe(1);
    // dx=0 → dirFromVec 落 dir0；端点按取整盒重导
    expect(start).toEqual({ x: 100, y: 100 });
    expect(end).toEqual({ x: 101, y: 101 });
  });

  test("亚像素位移取整：端点回报基于取整后的盒（hit 与提交几何一致）", () => {
    const { patch, end } = endpointDrag(line(), "end", 10.4, 9.6);
    expect(patch.w).toBe(210);
    expect(patch.h).toBe(110);
    expect(end).toEqual({ x: 310, y: 210 });
  });

  test("dir1（右上→左下）拖起点：局部系换算仍走同一对角", () => {
    // dir1: start=(0,h) end=(w,0) → 世界 start=(100,200) end=(300,100)
    const { start, end } = endpointDrag(line({ dir: 1 }), "start", -20, 10);
    expect(start).toEqual({ x: 80, y: 210 });
    expect(end).toEqual({ x: 300, y: 100 });
  });
});

describe("vertexDrag（折线顶点把手）", () => {
  const poly = (over: Partial<ShapeEl> = {}): ShapeEl =>
    line({ shape: "line", x: 0, y: 0, w: 100, h: 100, pts: [[0, 0], [100, 0], [100, 100]], ...over });

  test("拖中间点：bbox 扩、pts 一位小数重导（rebasePoly 语义）", () => {
    const p = vertexDrag(poly(), [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ], 1, 10, 20);
    expect(p).toMatchObject({ x: 0, y: 0, w: 110, h: 100 });
    expect(p.pts).toEqual([
      [0, 0],
      [110, 20],
      [100, 100],
    ]);
    expect(p.dir).toBeUndefined();
    expect(p.curve).toBeUndefined();
  });

  test("负方向拖拽：原点整体平移，pts 相对新 bbox 左上", () => {
    const p = vertexDrag(poly(), [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ], 0, -5, -5);
    expect(p).toMatchObject({ x: -5, y: -5, w: 105, h: 105 });
    expect(p.pts).toEqual([
      [0, 0],
      [105, 5],
      [105, 105],
    ]);
  });

  test("Shift 15° 吸附：以前邻点为锚、保持长度（atan2≈2.86° → 0°）", () => {
    const p = vertexDrag(poly(), [{ x: 0, y: 0 }, { x: 10, y: 0 }], 1, 100, 5, true);
    // 长度 hypot(110,5) 不变、角度归 0 → y 分量恰为 0
    expect(p.pts![1]![1]).toBe(0);
    expect(p.pts![1]![0]).toBeCloseTo(110.1, 0);
  });

  test("Shift 吸附锚点回退：idx=0 无前邻 → 用后邻；135° 恰为整倍 → 位移原样", () => {
    const p = vertexDrag(poly(), [{ x: 0, y: 0 }, { x: 100, y: 0 }], 0, 3, 97, true);
    // 锚 = 后邻 (100,0)；向量 (−97,97) 角 135° = 15°×9 → 吸附不动。新 bbox 原点被拖点顶到 (3,0)
    expect(p).toMatchObject({ x: 3, y: 0, w: 97, h: 97 });
    expect(p.pts).toEqual([
      [0, 97],
      [97, 0],
    ]);
  });

  test("Shift 极短向量（len≤0.5）不吸附：原样保留", () => {
    const p = vertexDrag(poly(), [{ x: 0, y: 0 }, { x: 10, y: 0 }], 1, -9.8, 0.4, true);
    expect(p.pts![1]).toEqual([0.2, 0.4]);
  });
});

describe("collapsePatch（Alt 删中点：3 点 → 两点对角塌缩）", () => {
  test("正对角：dir 0 时不写 dir 键、pts/curve 显式清除（与 DOM 轨同形）", () => {
    const { patch, start, end } = collapsePatch(poly3(), [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ]);
    expect(patch.x).toBe(50);
    expect(patch.y).toBe(60);
    expect(patch.w).toBe(100);
    expect(patch.h).toBe(100);
    expect("dir" in patch && patch.dir).toBeUndefined();
    expect("pts" in patch).toBe(true);
    expect(patch.pts).toBeUndefined();
    expect(patch.curve).toBeUndefined();
    expect(start).toEqual({ x: 50, y: 60 });
    expect(end).toEqual({ x: 150, y: 160 });
  });

  test("反对角：dir 重编码为 1", () => {
    const { patch } = collapsePatch(poly3(), [
      { x: 0, y: 100 },
      { x: 100, y: 0 },
    ]);
    expect(patch.dir).toBe(1);
  });

  test("取整：非整数保留点 → 四角照旧 min/max + round", () => {
    const { patch } = collapsePatch(poly3(), [
      { x: 0.4, y: 0 },
      { x: 100.5, y: 50.5 },
    ]);
    expect(patch).toMatchObject({ x: 50, y: 60, w: 100, h: 51 });
  });
});

function poly3(): ShapeEl {
  return {
    kind: "shape",
    id: "p1",
    shape: "line",
    x: 50,
    y: 60,
    w: 100,
    h: 100,
    stroke: "#000",
    pts: [
      [0, 0],
      [50, 10],
      [100, 100],
    ],
  } as ShapeEl;
}
