/**
 * 画布几何纯函数单测（bun test）：
 * 框选相交 / 并盒 / 对齐 / 分布 / 组缩放 / 旋转吸附 / resize / z 序 / 粘贴偏移 / 布局列数稳定。
 */
import { describe, expect, test } from "bun:test";
import {
  alignBoxes,
  boxOf,
  boxesIntersect,
  distributeBoxes,
  expandGroup,
  gridLayout,
  norm,
  normalizeDeg,
  offsetPasted,
  regroupCopies,
  reorderForZ,
  resizeBox,
  scaleGroup,
  snapDeg,
  unionBox,
} from "../src/geometry";
import type { El } from "../src/doc";

describe("boxesIntersect / norm", () => {
  test("重叠判定（边贴边不算）", () => {
    expect(boxesIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(boxesIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
    expect(boxesIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10.5, y: 0, w: 5, h: 5 })).toBe(false);
  });
  test("反向框归一", () => {
    expect(norm({ x: 10, y: 10, w: -20, h: -5 })).toEqual({ x: -10, y: 5, w: 20, h: 5 });
  });
});

describe("unionBox", () => {
  test("多盒并集", () => {
    const u = unionBox([
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 30, y: -5, w: 20, h: 20 },
    ]);
    expect(u).toEqual({ x: 0, y: -5, w: 50, h: 20 });
  });
  test("空集 null", () => {
    expect(unionBox([])).toBeNull();
  });
});

describe("alignBoxes", () => {
  const a = { id: "a", box: { x: 10, y: 10, w: 20, h: 20 } };
  const b = { id: "b", box: { x: 60, y: 50, w: 40, h: 10 } };
  test("单选对齐画板", () => {
    const r = alignBoxes([a], "left", { x: 0, y: 0, w: 100, h: 80 });
    expect(r.get("a")).toEqual({ x: 0, y: 10 });
    const c = alignBoxes([a], "vcenter", { x: 0, y: 0, w: 100, h: 80 });
    expect(c.get("a")).toEqual({ x: 10, y: 30 });
  });
  test("多选对齐组框", () => {
    const r = alignBoxes([a, b], "right", { x: 0, y: 0, w: 1000, h: 1000 });
    const u = unionBox([a.box, b.box])!;
    expect(r.get("a")).toEqual({ x: u.x + u.w - 20, y: 10 });
    expect(r.get("b")).toEqual({ x: u.x + u.w - 40, y: 50 });
  });
  test("空输入不炸", () => {
    expect(alignBoxes([], "left", { x: 0, y: 0, w: 100, h: 100 }).size).toBe(0);
  });
});

describe("distributeBoxes", () => {
  test("水平等间隙：首尾不动，中间等分", () => {
    const items = [
      { id: "a", box: { x: 0, y: 0, w: 10, h: 10 } },
      { id: "b", box: { x: 35, y: 20, w: 10, h: 10 } },
      { id: "c", box: { x: 90, y: 5, w: 10, h: 10 } },
    ];
    const r = distributeBoxes(items, "h");
    // span=100, sumW=30, gap=35 → b 应在 x=45
    expect(r.get("a")).toEqual({ x: 0, y: 0 });
    expect(r.get("b")).toEqual({ x: 45, y: 20 });
    expect(r.get("c")).toEqual({ x: 90, y: 5 });
  });
  test("少于 3 个无效", () => {
    expect(
      distributeBoxes(
        [
          { id: "a", box: { x: 0, y: 0, w: 10, h: 10 } },
          { id: "b", box: { x: 40, y: 0, w: 10, h: 10 } },
        ],
        "h",
      ).size,
    ).toBe(0);
  });
});

describe("scaleGroup / resizeBox", () => {
  test("组缩放等比映射", () => {
    const orig = { x: 0, y: 0, w: 100, h: 100 };
    const next = { x: 0, y: 0, w: 200, h: 50 };
    const r = scaleGroup(orig, next, [
      { id: "a", box: { x: 0, y: 0, w: 10, h: 10 } },
      { id: "b", box: { x: 50, y: 50, w: 20, h: 20 } },
    ]);
    expect(r.get("a")).toEqual({ x: 0, y: 0, w: 20, h: 5 });
    expect(r.get("b")).toEqual({ x: 100, y: 25, w: 40, h: 10 });
  });
  test("se 手柄拖动放大", () => {
    const r = resizeBox({ x: 10, y: 10, w: 20, h: 20 }, 4, 30, 40, false, false);
    expect(r).toEqual({ x: 10, y: 10, w: 50, h: 60 });
  });
  test("nw 手柄反向越过保持正宽高", () => {
    const r = resizeBox({ x: 10, y: 10, w: 20, h: 20 }, 0, 50, 50, false, false);
    expect(r.w).toBeGreaterThanOrEqual(4);
    expect(r.h).toBeGreaterThanOrEqual(4);
  });
  test("Shift 角手柄保比例", () => {
    const r = resizeBox({ x: 0, y: 0, w: 100, h: 50 }, 4, 10, 40, true, false);
    expect(r.w / r.h).toBeCloseTo(2, 5);
  });
  test("Shift 缩放锚定对边：se 手柄时左上角不动（回归：位置漂移）", () => {
    // 高度主导 k=1.8，旧实现用被拖动的 x2/y2 反推 → x=-70 漂移
    const r = resizeBox({ x: 0, y: 0, w: 100, h: 50 }, 4, 10, 40, true, false);
    expect(r).toEqual({ x: 0, y: 0, w: 180, h: 90 });
  });
  test("Shift 缩放锚定对边：nw 手柄时右下边不动", () => {
    const r = resizeBox({ x: 10, y: 10, w: 100, h: 50 }, 0, -30, -10, true, false);
    expect(r.x + r.w).toBe(110);
    expect(r.y + r.h).toBe(60);
  });
});

describe("旋转吸附", () => {
  test("normalizeDeg 归一到 (-180,180]", () => {
    expect(normalizeDeg(190)).toBe(-170);
    expect(normalizeDeg(-190)).toBe(170);
    expect(normalizeDeg(360)).toBe(0);
  });
  test("Shift 吸附 15°", () => {
    expect(snapDeg(38, true)).toBe(45);
    expect(snapDeg(36, true)).toBe(30);
    expect(snapDeg(36.4, false)).toBe(36);
  });
});

describe("reorderForZ", () => {
  const els = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  test("front/back 保持选中相对顺序", () => {
    expect(reorderForZ(els, new Set(["b", "a"]), "front").map((e) => e.id)).toEqual(["c", "d", "a", "b"]);
    expect(reorderForZ(els, new Set(["d", "c"]), "back").map((e) => e.id)).toEqual(["c", "d", "a", "b"]);
  });
  test("forward/backward 逐级", () => {
    expect(reorderForZ(els, new Set(["a"]), "forward").map((e) => e.id)).toEqual(["b", "a", "c", "d"]);
    expect(reorderForZ(els, new Set(["d"]), "backward").map((e) => e.id)).toEqual(["a", "b", "d", "c"]);
    // 多选连续段一起上移：c 越过整段沉到最底
    expect(reorderForZ(els, new Set(["a", "b"]), "forward").map((e) => e.id)).toEqual(["c", "a", "b", "d"]);
  });
});

describe("offsetPasted", () => {
  test("平移 + 新 id", () => {
    const els = [{ kind: "text", id: "t1", x: 5, y: 5, w: 10, h: 10, runs: [{ text: "x" }], opacity: 1 }] as El[];
    const out = offsetPasted(els, 20, 20, (old) => `${old}-copy`);
    expect(out[0]!.id).toBe("t1-copy");
    expect(out[0]!.x).toBe(25);
    expect(out[0]!.y).toBe(25);
    // 深拷贝：原对象不受影响
    expect(els[0]!.x).toBe(5);
    expect(out[0]).not.toBe(els[0]);
  });
});

describe("gridLayout（缩放不重排）", () => {
  const slides = [
    { id: "s1", w: 960, h: 540 },
    { id: "s2", w: 960, h: 540 },
    { id: "s3", w: 960, h: 540 },
    { id: "s4", w: 960, h: 540 },
  ];
  test("列数只随容器宽变化", () => {
    const wide = gridLayout(slides, 2200, 1000);
    const narrow = gridLayout(slides, 1100, 1000);
    const colOf = (r: typeof wide, id: string) => r.positions.find((p) => p.id === id)!;
    expect(colOf(wide, "s2").x).toBeGreaterThan(colOf(wide, "s1").x);
    expect(colOf(wide, "s2").y).toBe(colOf(wide, "s1").y);
    // 窄容器：s2 换行
    expect(colOf(narrow, "s2").y).toBeGreaterThan(colOf(narrow, "s1").y);
  });
  test("同一容器宽下幂等（不含缩放因子 → 缩放不重排）", () => {
    const a = gridLayout(slides, 1500, 900);
    const b = gridLayout(slides, 1500, 900);
    expect(a).toEqual(b);
  });
  test("空文档安全", () => {
    expect(gridLayout([], 800, 600).positions).toEqual([]);
  });
});

describe("expandGroup / regroupCopies（编辑组）", () => {
  const el = (id: string, groupId?: string): El =>
    ({ kind: "shape", id, shape: "rect", x: 0, y: 0, w: 10, h: 10, ...(groupId ? { groupId } : {}) }) as El;
  const els = [el("a", "g1"), el("b", "g1"), el("c"), el("d", "g2")];

  test("expandGroup：选中成员扩成整组；无组选中原样返回", () => {
    expect(expandGroup(els, ["a"])).toEqual(["a", "b"]);
    expect(expandGroup(els, ["c"])).toEqual(["c"]);
    const both = expandGroup(els, ["a", "c"]);
    expect([...both].sort()).toEqual(["a", "b", "c"]); // 跨两组不串组
  });

  test("expandGroup：id 不存在时原样返回", () => {
    expect(expandGroup(els, ["zz"])).toEqual(["zz"]);
    expect(expandGroup([], [])).toEqual([]);
  });

  test("regroupCopies：同批内组关系保留但换新 id；无组元素引用不变；原数组不被修改", () => {
    const copies = regroupCopies(els);
    const g1 = (copies[0] as { groupId?: string }).groupId;
    expect(g1).toBeTruthy();
    expect(g1).not.toBe("g1");
    expect((copies[1] as { groupId?: string }).groupId).toBe(g1); // 同组同新 id
    const g2 = (copies[3] as { groupId?: string }).groupId;
    expect(g2).not.toBe("g2");
    expect(g2).not.toBe(g1); // 不同组不同 id
    expect(copies[2]).toBe(els[2]); // 无组元素原样（同一引用）
    expect((els[0] as { groupId?: string }).groupId).toBe("g1"); // 入参未被改动
  });

  test("regroupCopies：全无组 → 原数组直接返回", () => {
    const plain = [el("x"), el("y")];
    expect(regroupCopies(plain)).toBe(plain);
  });
});
