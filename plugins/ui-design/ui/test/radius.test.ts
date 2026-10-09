/**
 * 圆角手柄的纯计算测试：radius 字段两种形态的读取、手柄落点（弧心 + 最小内移）、
 * 指针 → 半径（取双轴较小值 / 夹在短边一半）、写回规则（统一 ↔ 拆角、0 摘字段）。
 */
import { describe, expect, test } from "bun:test";
import { parseDesignDoc, type DesignNode } from "../src/doc";
import {
  RADIUS_TYPES,
  cornerAt,
  handleAt,
  hasRadiusField,
  isUniformRadius,
  maxRadius,
  radiiOf,
  radiusFromPointer,
  withCornerRadius,
} from "../src/radius";

const box = { x: 100, y: 50, w: 200, h: 100 };
const node = (over: Record<string, unknown> = {}): DesignNode =>
  ({ id: "r1", type: "rect", name: "r1", x: 0, y: 0, w: 200, h: 100, fills: [], strokes: [], ...over }) as DesignNode;

describe("radiiOf / isUniformRadius", () => {
  test("数字 = 四角统一；数组 = 逐角（缺位补 0）；未设 = 全 0", () => {
    expect(radiiOf(node({ radius: 8 }))).toEqual([8, 8, 8, 8]);
    expect(radiiOf(node({ radius: [1, 2, 3, 4] }))).toEqual([1, 2, 3, 4]);
    expect(radiiOf(node({ radius: [1, 2] as unknown as number[] }))).toEqual([1, 2, 0, 0]);
    expect(radiiOf(node())).toEqual([0, 0, 0, 0]);
    expect(isUniformRadius(node({ radius: 8 }))).toBe(true);
    expect(isUniformRadius(node({ radius: [8, 8, 8, 8] }))).toBe(false);
    expect(isUniformRadius(node())).toBe(true);
  });

  test("只有 rect/frame/image 有圆角字段（与 Inspector 同口径）", () => {
    for (const t of RADIUS_TYPES) expect(hasRadiusField(node({ type: t }))).toBe(true);
    for (const t of ["text", "group", "ellipse", "line", "icon", "vector", "instance", "star"]) {
      expect(hasRadiusField(node({ type: t }))).toBe(false);
    }
  });
});

describe("cornerAt / maxRadius", () => {
  test("四角坐标与朝内方向：0=tl 1=tr 2=br 3=bl", () => {
    expect(cornerAt(box, 0)).toEqual({ x: 100, y: 50, dx: 1, dy: 1 });
    expect(cornerAt(box, 1)).toEqual({ x: 300, y: 50, dx: -1, dy: 1 });
    expect(cornerAt(box, 2)).toEqual({ x: 300, y: 150, dx: -1, dy: -1 });
    expect(cornerAt(box, 3)).toEqual({ x: 100, y: 150, dx: 1, dy: -1 });
  });

  test("半径上限 = 短边一半", () => {
    expect(maxRadius(box)).toBe(50);
    expect(maxRadius({ w: 10, h: 200 })).toBe(5);
  });
});

describe("handleAt", () => {
  test("手柄落在圆角弧心：角点沿对角线内移 r", () => {
    expect(handleAt(box, 0, 12, 0)).toEqual({ x: 112, y: 62 });
    expect(handleAt(box, 2, 12, 0)).toEqual({ x: 288, y: 138 });
  });

  test("半径小于最小内移量时贴到最小内移处（否则被缩放手柄压住抓不到）", () => {
    expect(handleAt(box, 0, 0, 11)).toEqual({ x: 111, y: 61 });
    expect(handleAt(box, 0, 2, 11)).toEqual({ x: 111, y: 61 });
    expect(handleAt(box, 0, 20, 11)).toEqual({ x: 120, y: 70 });
  });
});

describe("radiusFromPointer", () => {
  // 左上角朝内方向 = (+1, +1)
  const c = { x: 100, y: 50, dx: 1 as const, dy: 1 as const };

  test("沿对角线拖：位移直接就是半径（手柄跟手）", () => {
    expect(radiusFromPointer(c, { x: 100, y: 50 }, 50)).toBe(0);
    expect(radiusFromPointer(c, { x: 120, y: 70 }, 50)).toBe(20);
    expect(radiusFromPointer(c, { x: 116, y: 66 }, 50)).toBe(16);
  });

  test("只拖一条轴：半速响应（不会是 0，也不会卡死）", () => {
    expect(radiusFromPointer(c, { x: 140, y: 50 }, 50)).toBe(20);
    expect(radiusFromPointer(c, { x: 100, y: 90 }, 50)).toBe(20);
  });

  test("往外拖到角点之外 → 归 0", () => {
    expect(radiusFromPointer(c, { x: 60, y: 10 }, 50)).toBe(0);
    expect(radiusFromPointer(c, { x: 90, y: 40 }, 50)).toBe(0);
  });

  test("夹在 0..max（短边一半），保留一位小数", () => {
    expect(radiusFromPointer(c, { x: 900, y: 900 }, 50)).toBe(50);
    expect(radiusFromPointer(c, { x: 100, y: 57.66 }, 50)).toBe(3.8);
  });

  test("其它三个角的方向取反也能算对", () => {
    const br = { x: 300, y: 150, dx: -1 as const, dy: -1 as const };
    expect(radiusFromPointer(br, { x: 280, y: 130 }, 50)).toBe(20);
    expect(radiusFromPointer(br, { x: 320, y: 170 }, 50)).toBe(0); // 往外
    const tr = { x: 300, y: 50, dx: -1 as const, dy: 1 as const };
    expect(radiusFromPointer(tr, { x: 290, y: 60 }, 50)).toBe(10);
  });
});

describe("withCornerRadius 写回规则", () => {
  test("统一值：拖任一角 = 四角一起变（并且保持数字形态）", () => {
    const out = withCornerRadius(node(), 1, 16);
    expect(out.radius).toBe(16);
  });

  test("已是四角数组：只改拖的那一角", () => {
    const out = withCornerRadius(node({ radius: [4, 4, 4, 4] }), 2, 20);
    expect(out.radius).toEqual([4, 4, 20, 4]);
  });

  test("split:true（Alt 拖）：统一值就地拆成四角，只改当前角", () => {
    const out = withCornerRadius(node({ radius: 6 }), 3, 18, { split: true });
    expect(out.radius).toEqual([6, 6, 6, 18]);
  });

  test("拖回 0：摘掉 radius 字段，不留 0", () => {
    expect(withCornerRadius(node({ radius: 12 }), 0, 0).radius).toBeUndefined();
  });

  test("四角被拖成同一个值时收敛回数字形态（文档不膨胀）", () => {
    const out = withCornerRadius(node({ radius: [8, 8, 8, 4] }), 3, 8);
    expect(out.radius).toBe(8);
  });

  test("只改 radius，其余字段原样带过去", () => {
    const src = node({ radius: 3, opacity: 0.5, name: "按钮" });
    const out = withCornerRadius(src, 0, 9);
    expect(out.name).toBe("按钮");
    expect(out.opacity).toBe(0.5);
    expect(src.radius).toBe(3); // immutable：原节点不动
  });

  test("往返：解析存下来的数组形态仍然被认作逐角", () => {
    const doc = parseDesignDoc(
      JSON.stringify({
        version: 1,
        meta: { name: "t" },
        pages: [{ id: "p", name: "P", nodes: [node({ radius: [1, 2, 3, 4] })] }],
      }),
    ).doc;
    const parsed = doc.pages[0]!.nodes[0]!;
    expect(radiiOf(parsed)).toEqual([1, 2, 3, 4]);
    expect(withCornerRadius(parsed, 0, 9).radius).toEqual([9, 2, 3, 4]);
  });
});

describe("handleAt 的碰撞防护", () => {
  test("胶囊形（radius = 短边一半）：同侧上下两个手柄不会落到同一点", () => {
    const pill = { x: 0, y: 0, w: 200, h: 56 };
    const t = handleAt(pill, 1, 28, 11); // 右上
    const b = handleAt(pill, 2, 28, 11); // 右下
    expect(b.y - t.y).toBeGreaterThanOrEqual(22); // 至少隔开 2×minInset
  });

  test("大画板（圆角远小于半高）时手柄仍落在弧心，不受夹取影响", () => {
    const card = { x: 0, y: 0, w: 320, h: 240 };
    expect(handleAt(card, 0, 16, 8)).toEqual({ x: 16, y: 16 });
  });
});
