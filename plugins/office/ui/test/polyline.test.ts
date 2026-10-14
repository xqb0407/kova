/**
 * 多点折线（线类 ShapeEl.pts）契约测试：
 * parseLinePts/parseDoc 透传与丢弃；viewspec polyLocal/rebasePoly/scalePolyPts/bakePolyRotation；
 * geometry pointSegDist/polyHit；bind 带 pts 绑定线同步（端点重锚、内部折点保留、幂等、rotation 烘焙）。
 */
import { describe, expect, test } from "bun:test";
import {
  DOC_VERSION,
  LINE_MAX_POINTS,
  parseDoc,
  parseLinePts,
  serializeDoc,
  type CanvasDoc,
  type LinePt,
  type ShapeEl,
} from "../src/doc";
import { isPolyline, polyLocal, polyWorld, rebasePoly, scalePolyPts, bakePolyRotation } from "../src/viewspec";
import { pointSegDist, polyHit } from "../src/geometry";
import { syncBoundArrows } from "../src/bind";

/* ---------------- 数据契约（parseLinePts / parseDoc） ---------------- */

describe("parseLinePts", () => {
  test("≥3 个有效点保留，坐标归一到一位小数", () => {
    const pts = parseLinePts([[0, 0], [50.04, 50], [100, 100.06]]);
    expect(pts).toEqual([[0, 0], [50, 50], [100, 100.1]] as LinePt[]);
  });
  test("不足 3 个有效点（含非法项过滤后）返回 undefined", () => {
    expect(parseLinePts([[0, 0], [100, 100]])).toBeUndefined();
    expect(parseLinePts([[0, 0], ["x", 1], [100, 100]])).toBeUndefined();
    expect(parseLinePts(null)).toBeUndefined();
    expect(parseLinePts("pts")).toBeUndefined();
  });
  test("非法点跳过、合法点保留：过滤后仍 ≥3 即成立", () => {
    const pts = parseLinePts([[0, 0], [NaN, 5], [50, 50], 7, [100, 100]]);
    expect(pts).toEqual([[0, 0], [50, 50], [100, 100]] as LinePt[]);
  });
  test("点数上限 LINE_MAX_POINTS 截断", () => {
    const many: number[][] = Array.from({ length: 250 }, (_, i) => [i, i % 7]);
    expect(parseLinePts(many)?.length).toBe(LINE_MAX_POINTS);
  });
});

const lineShape = (over: Partial<ShapeEl>): ShapeEl => ({
  kind: "shape",
  id: "l",
  shape: "arrow",
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  ...over,
});
const boardDoc = (objects: ShapeEl[]): CanvasDoc => ({
  version: DOC_VERSION,
  meta: { name: "t", pagePreset: "16:9", kind: "board" },
  objects,
  frames: [],
});
const parsedLine = (raw: unknown): ShapeEl => {
  const parsed = parseDoc({
    version: DOC_VERSION,
    meta: { name: "t", pagePreset: "16:9", kind: "board" },
    objects: [{ kind: "shape", id: "l", shape: "arrow", x: 0, y: 0, w: 100, h: 100, ...(raw as object) }],
    frames: [],
  });
  return parsed!.objects[0] as ShapeEl;
};

describe("parseDoc pts 透传", () => {
  test("线类合法 pts 保留，serializeDoc 往返不丢", () => {
    const s = parsedLine({ pts: [[0, 0], [40, 55.5], [100, 100]] });
    expect(s.pts).toEqual([[0, 0], [40, 55.5], [100, 100]]);
    const doc = parseDoc(JSON.parse(serializeDoc(boardDoc([s]))));
    expect((doc!.objects[0] as ShapeEl).pts).toEqual([[0, 0], [40, 55.5], [100, 100]]);
  });
  test("非法/过短 pts 丢弃，回落 bbox+dir 语义", () => {
    expect(parsedLine({ pts: [[0, 0], [100, 100]] }).pts).toBeUndefined();
    expect(parsedLine({ pts: "x" }).pts).toBeUndefined();
  });
  test("非线类形状的 pts 被丢弃", () => {
    const parsed = parseDoc({
      version: DOC_VERSION,
      meta: { name: "t", pagePreset: "16:9" },
      objects: [{ kind: "shape", id: "r", shape: "rect", x: 0, y: 0, w: 10, h: 10, pts: [[0, 0], [5, 5], [10, 10]] }],
      frames: [],
    });
    expect((parsed!.objects[0] as ShapeEl).pts).toBeUndefined();
  });
  test("pts 成立时 curve 被忽略（不落字段）；pts 不成立时 curve 保留", () => {
    expect(parsedLine({ pts: [[0, 0], [40, 55], [100, 100]], curve: 0.5 }).curve).toBeUndefined();
    expect(parsedLine({ pts: [[0, 0], [100, 100]], curve: 0.5 }).curve).toBe(0.5);
  });
});

/* ---------------- viewspec 折线助手 ---------------- */

describe("isPolyline / polyLocal / polyWorld", () => {
  test("pts≥3 才成立折线；两点线按对角物化", () => {
    expect(isPolyline(lineShape({ pts: [[0, 0], [50, 50], [100, 100]] }))).toBe(true);
    expect(isPolyline(lineShape({ pts: [[0, 0], [100, 100]] }))).toBe(false);
    expect(isPolyline(lineShape({}))).toBe(false);
    const two = polyLocal(lineShape({ w: 100, h: 50, dir: 1 }));
    expect(two).toEqual([{ x: 0, y: 50 }, { x: 100, y: 0 }]);
  });
  test("polyWorld = bbox 左上平移（不含 rotation）", () => {
    const w = polyWorld(lineShape({ x: 10, y: 20, pts: [[0, 0], [5, 5], [10, 10]] }));
    expect(w).toEqual([{ x: 10, y: 20 }, { x: 15, y: 25 }, { x: 20, y: 30 }]);
  });
});

describe("rebasePoly", () => {
  test("bbox=点并集取整，pts 相对新原点且一位小数，dir/curve 置 undef", () => {
    const reb = rebasePoly({ x: 0, y: 0 }, [{ x: 10.04, y: -5.2 }, { x: 50, y: 20 }, { x: 20, y: 0 }]);
    expect({ x: reb.x, y: reb.y, w: reb.w, h: reb.h }).toEqual({ x: 10, y: -5, w: 40, h: 25 });
    expect(reb.pts).toEqual([[0, -0.2], [40, 25], [10, 5]]);
    expect(reb.dir).toBeUndefined();
    expect(reb.curve).toBeUndefined();
  });
  test("退化水平线（零高 bbox）宽高兜底 ≥1", () => {
    const reb = rebasePoly({ x: 100, y: 100 }, [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }]);
    expect({ x: reb.x, y: reb.y, w: reb.w, h: reb.h }).toEqual({ x: 100, y: 100, w: 100, h: 1 });
  });
});

describe("scalePolyPts", () => {
  test("按新旧盒比例缩点；零宽高回退 1:1", () => {
    expect(scalePolyPts([[0, 0], [10, 10]], 10, 20, 20, 20)).toEqual([[0, 0], [20, 10]]);
    expect(scalePolyPts([[0, 0], [10, 5]], 0, 0, 50, 50)).toEqual([[0, 0], [10, 5]]);
  });
});

describe("bakePolyRotation", () => {
  test("旋转 90° 烘焙进折点：rotation 清零、对角换向、中点不动", () => {
    const el = lineShape({ w: 100, h: 100, rotation: 90, pts: [[0, 0], [50, 50], [100, 100]] });
    const baked = bakePolyRotation(el);
    expect(baked.rotation).toBe(0);
    expect(baked.pts).toBeDefined();
    expect(baked.pts).toContainEqual([100, 0]);
    expect(baked.pts).toContainEqual([0, 100]);
    expect(baked.pts).toContainEqual([50, 50]);
  });
  test("未旋转或非折线原样返回", () => {
    const flat = lineShape({ pts: [[0, 0], [50, 50], [100, 100]] });
    expect(bakePolyRotation(flat)).toBe(flat);
    const twoRot = lineShape({ rotation: 45 });
    expect(bakePolyRotation(twoRot)).toBe(twoRot);
  });
});

/* ---------------- geometry 段命中 ---------------- */

describe("pointSegDist / polyHit", () => {
  test("点到线段：垂距与端点钳制", () => {
    expect(pointSegDist(5, 3, 0, 0, 10, 0)).toBeCloseTo(3, 6);
    expect(pointSegDist(-4, 0, 0, 0, 10, 0)).toBeCloseTo(4, 6); // 超出端点：按端点距离
    expect(pointSegDist(3, 4, 0, 0, 6, 8)).toBeCloseTo(0, 6); // 线上
  });
  test("polyHit：任一段容差内即命中；点列不足 2 项恒 false", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ];
    expect(polyHit(pts, 50, 4, 5)).toBe(true);
    expect(polyHit(pts, 104, 50, 5)).toBe(true);
    expect(polyHit(pts, 50, 40, 5)).toBe(false);
    expect(polyHit([{ x: 0, y: 0 }], 0, 0, 5)).toBe(false);
  });
});

/* ---------------- bind：带 pts 的绑定线同步 ---------------- */

const rect = (id: string, x: number, y: number, w: number, h: number): ShapeEl => ({
  kind: "shape",
  id,
  shape: "rect",
  x,
  y,
  w,
  h,
});

describe("syncBoundArrows（折线）", () => {
  const polyArrow = (over: Partial<ShapeEl>): ShapeEl =>
    lineShape({ startBind: "a", endBind: "b", ...over });

  test("两端锚定只换首末点，内部折点原样保留、bbox 重算为并集", () => {
    // a 中心 (50,50)、b 中心 (350,250)：锚点同两点线 (100,83.33) / (300,216.67)
    const doc = boardDoc([
      rect("a", 0, 0, 100, 100),
      rect("b", 300, 200, 100, 100),
      polyArrow({ pts: [[100, 80], [200, 50], [300, 220]] }),
    ]);
    const out = syncBoundArrows(doc);
    const s = out.objects[2] as ShapeEl;
    const w = polyWorld(s);
    expect(w[0].x).toBeCloseTo(100, 0);
    expect(w[0].y).toBeCloseTo(83, 0);
    expect(w[w.length - 1].x).toBeCloseTo(300, 0);
    expect(w[w.length - 1].y).toBeCloseTo(217, 0);
    expect(w[1]).toEqual({ x: 200, y: 50 }); // 中间折点原样
    expect(s.pts!.length).toBe(3);
    expect([s.startBind, s.endBind]).toEqual(["a", "b"]);
  });

  test("被绑元素移动后：端点重锚、内部折点不动", () => {
    const doc = boardDoc([
      rect("a", 0, 0, 100, 100),
      rect("b", 300, 200, 100, 100),
      polyArrow({ pts: [[100, 83], [200, 50], [300, 217]] }),
    ]);
    const once = syncBoundArrows(doc);
    const b2 = rect("b", 500, 0, 100, 100);
    const moved: CanvasDoc = { ...once, objects: [once.objects[0], b2, once.objects[2]] };
    const out = syncBoundArrows(moved);
    const w = polyWorld(out.objects[2] as ShapeEl);
    expect(w[0]).toEqual({ x: 100, y: 50 }); // a 右缘水平锚
    expect(w[w.length - 1]).toEqual({ x: 500, y: 50 }); // b 左缘水平锚
    expect(w[1]).toEqual({ x: 200, y: 50 }); // 中间点保留（共线后仍在线上）
  });

  test("折线同步幂等：二次同步返回原引用", () => {
    const doc = boardDoc([
      rect("a", 0, 0, 100, 100),
      rect("b", 300, 200, 100, 100),
      polyArrow({ pts: [[100, 80], [200, 50], [300, 220]] }),
    ]);
    const once = syncBoundArrows(doc);
    expect(syncBoundArrows(once)).toBe(once);
  });

  test("折线自身带 rotation：同步把旋转烘焙进点列并清除 rotation 字段", () => {
    // 线盒 (200,100,100,100) pts 局部对角，自身旋转 90°：世界首点 (300,100)、末点 (200,200)
    const arr = lineShape({
      x: 200,
      y: 100,
      w: 100,
      h: 100,
      rotation: 90,
      pts: [[0, 0], [50, 50], [100, 100]],
      startBind: "a",
    });
    const out = syncBoundArrows(boardDoc([rect("a", 0, 0, 100, 100), arr]));
    const s = out.objects[1] as ShapeEl;
    expect(s.rotation).toBeUndefined();
    const w = polyWorld(s);
    expect(w[0]).toEqual({ x: 100, y: 100 }); // a 右下缘对角锚点
    expect(w[1]).toEqual({ x: 250, y: 150 }); // 中点 = 原世界像
    expect(w[2]).toEqual({ x: 200, y: 200 }); // 自由端 = 原世界像（未因清 rotation 跳位）
  });

  test("无绑定折线：同步原样返回文档引用", () => {
    const doc = boardDoc([lineShape({ pts: [[0, 0], [50, 50], [100, 100]] })]);
    expect(syncBoundArrows(doc)).toBe(doc);
  });
});
