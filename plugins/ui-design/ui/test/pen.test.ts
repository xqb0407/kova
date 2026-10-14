/**
 * 钢笔几何核单测：path D 串生成（直/曲/闭合）、de Casteljau 切分数值、删锚合并、
 * 柄拖拽（平滑镜像/折角独立）、平滑切换、线段/锚点命中、保守包围盒。
 */
import { describe, expect, test } from "bun:test";
import {
  delAnchor,
  hitAnchor,
  hitSeg,
  moveAnchor,
  moveHandle,
  penBBox,
  penPathD,
  segPoint,
  splitSeg,
  toggleSmooth,
  translatePath,
  type Anchor,
  type PenPath,
} from "../src/pen";

const A = (x: number, y: number, hin?: [number, number], hout?: [number, number]): Anchor => ({ p: [x, y], ...(hin ? { hin } : {}), ...(hout ? { hout } : {}) });

describe("penPathD", () => {
  test("直线 / 折线 / 闭合 Z", () => {
    const open: PenPath = { pts: [A(0, 0), A(10, 0), A(10, 10)], closed: false };
    expect(penPathD(open)).toBe("M 0 0 L 10 0 L 10 10");
    const closed: PenPath = { pts: [A(0, 0), A(10, 0), A(10, 10)], closed: true };
    expect(penPathD(closed)).toBe("M 0 0 L 10 0 L 10 10 Z");
  });
  test("带柄段 → C（柄为锚点相对偏移）", () => {
    const path: PenPath = { pts: [A(0, 0, undefined, [10, -10]), A(30, 0, [-10, 10])], closed: false };
    expect(penPathD(path)).toBe("M 0 0 C 10 -10 20 10 30 0");
  });
  test("混合：直角锚邻段走 L、曲线锚邻段走 C", () => {
    const path: PenPath = { pts: [A(0, 0), A(20, 0, undefined, [5, 0]), A(40, 0)], closed: false };
    expect(penPathD(path)).toBe("M 0 0 L 20 0 C 25 0 40 0 40 0");
  });
  test("segPoint：t=0/1 端点，t=0.5 中点", () => {
    expect(segPoint([0, 0], [0, 10], [10, 10], [10, 0], 0)).toEqual([0, 0]);
    expect(segPoint([0, 0], [0, 10], [10, 10], [10, 0], 1)).toEqual([10, 0]);
    const m = segPoint([0, 0], [0, 10], [10, 10], [10, 0], 0.5);
    expect(m[0]).toBeCloseTo(5, 6);
    expect(m[1]).toBeCloseTo(7.5, 6); // 对称三次曲线中点 = 0.75 高
  });
});

describe("penBBox", () => {
  test("锚点+柄极值的保守盒", () => {
    const path: PenPath = { pts: [A(10, 10, undefined, [20, -5]), A(60, 40, [-10, 5])], closed: false };
    const b = penBBox(path)!;
    expect(b.x).toBe(10);
    expect(b.y).toBe(5); // 出柄 y=10-5
    expect(b.w).toBe(50); // 60 - 10
    expect(b.h).toBe(40); // hin 绝对 y=45 − 柄顶 5
  });
  test("空路径 null；退化 1×1 下限", () => {
    expect(penBBox({ pts: [], closed: false })).toBeNull();
    const b = penBBox({ pts: [A(5, 5)], closed: false })!;
    expect(b.w).toBeGreaterThanOrEqual(0.5);
  });
});

describe("splitSeg（de Casteljau）", () => {
  test("直线段 t=0.5：新锚在中点、无柄", () => {
    const pts = [A(0, 0), A(10, 0)];
    const out = splitSeg(pts, 0, 0.5, false);
    expect(out.length).toBe(3);
    expect(out[1]!.p).toEqual([5, 0]);
    expect(out[1]!.hin).toBeUndefined();
    expect(out[1]!.hout).toBeUndefined();
  });
  test("曲线段 t=0.5：新锚在切点、两侧柄分裂、原柄裁剪", () => {
    const pts = [A(0, 0, undefined, [0, 10]), A(0, 20, [0, -10])];
    const out = splitSeg(pts, 0, 0.5, false);
    expect(out.length).toBe(3);
    const mid = out[1]!;
    expect(mid.p[1]).toBeCloseTo(10, 1); // 竖直三次曲线中点
    expect(mid.hin).toBeDefined();
    expect(mid.hout).toBeDefined();
    // 原锚出柄被裁剪为子曲线柄（长度减半量级）
    const first = out[0]!;
    expect(first.hout![1]).toBeGreaterThan(0);
    expect(first.hout![1]).toBeLessThan(10);
  });
  test("开路径末段越界不切；t 被夹在 (0,1) 内仍插锚", () => {
    const pts = [A(0, 0), A(10, 0)];
    expect(splitSeg(pts, 1, 0.5, false)).toEqual(pts);
    const out = splitSeg(pts, 0, 0, false);
    expect(out.length).toBe(3);
    // 三次参数化在端点附近速度趋零：切点应落在两端之间（非严格等于端点即视为有效）
    expect(out[1]!.p[0]).toBeGreaterThanOrEqual(0);
    expect(out[1]!.p[0]).toBeLessThanOrEqual(10);
  });
});

describe("delAnchor / moveAnchor", () => {
  test("开路径删中间锚：其余保留", () => {
    const pts = [A(0, 0), A(5, 5), A(10, 0)];
    const out = delAnchor(pts, 1, false);
    expect(out.map((a) => a.p)).toEqual([[0, 0], [10, 0]]);
  });
  test("低于下限不删（开 2 / 闭 3）", () => {
    expect(delAnchor([A(0, 0), A(1, 1)], 0, false).length).toBe(2);
    const tri = [A(0, 0), A(10, 0), A(5, 10)];
    expect(delAnchor(tri, 0, true).length).toBe(3);
  });
  test("moveAnchor 平移锚点、柄相对偏移不变", () => {
    const pts = [A(0, 0, undefined, [10, 0])];
    const out = moveAnchor(pts, 0, [5, 5]);
    expect(out[0]!.p).toEqual([5, 5]);
    expect(out[0]!.hout).toEqual([10, 0]);
  });
});

describe("moveHandle / toggleSmooth", () => {
  test("折角模式：只动本侧柄", () => {
    const pts = [A(0, 0, [-10, 0], [10, 0])];
    const out = moveHandle(pts, 0, "hout", [30, 20], false);
    expect(out[0]!.hout).toEqual([30, 20]);
    expect(out[0]!.hin).toEqual([-10, 0]);
  });
  test("平滑模式：对侧柄等长反向联动", () => {
    const pts = [A(0, 0, [-10, 0], [10, 0])];
    const out = moveHandle(pts, 0, "hout", [20, 0], true);
    expect(out[0]!.hout).toEqual([20, 0]);
    expect(out[0]!.hin).toEqual([-20, 0]);
  });
  test("toggleSmooth on：hin = -hout 等长；off 原样", () => {
    const pts = [A(0, 0, undefined, [10, 4])];
    const sm = toggleSmooth(pts, 0, true);
    expect(sm[0]!.hin![0]).toBe(-10);
    expect(sm[0]!.hin![1]).toBe(-4);
    expect(toggleSmooth(pts, 0, false)[0]!.hin).toBeUndefined();
  });
});

describe("命中", () => {
  const path: PenPath = { pts: [A(0, 0), A(100, 0), A(100, 100)], closed: false };
  test("hitSeg：线段上命中段 0，t 中点；远处 miss", () => {
    const h = hitSeg(path, [50, 0], 4)!;
    expect(h.seg).toBe(0);
    expect(h.t).toBeCloseTo(0.5, 1);
    expect(hitSeg(path, [50, 30], 4)).toBeNull();
  });
  test("hitAnchor：近锚命中下标；空白 null", () => {
    expect(hitAnchor(path.pts, [101, 1], 4)).toBe(1);
    expect(hitAnchor(path.pts, [50, 50], 4)).toBeNull();
  });
});

describe("translatePath / 闭合", () => {
  test("整路径平移", () => {
    const out = translatePath({ pts: [A(1, 2), A(3, 4)], closed: false }, [10, -1]);
    expect(out.pts[0]!.p).toEqual([11, 1]);
    expect(out.closed).toBe(false);
  });
});

describe("penToNode", () => {
  test("世界锚点 → 盒 + 盒局部 path（平移不变性）", async () => {
    const { penToNode } = await import("../src/pen");
    const a = penToNode([{ p: [100, 200] }, { p: [160, 200] }, { p: [160, 260] }], true);
    expect(a.x).toBe(100);
    expect(a.y).toBe(200);
    expect(a.w).toBe(60);
    expect(a.h).toBe(60);
    expect(a.path).toBe("M 0 0 L 60 0 L 60 60 Z");
  });
});
