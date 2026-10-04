import { describe, expect, test } from "bun:test";
import type { DesignNode, FrameNode, GroupNode, LineNode } from "../src/doc";
import { ledgerFor, normDeg, scaleChildren, diffPatch, type EditorNodeTransform } from "../src/leafer/ledger";

const rect = (over: Partial<DesignNode> & { id: string; w: number; h: number }): DesignNode =>
  ({
    type: "rect",
    name: "r",
    x: 0,
    y: 0,
    fills: [],
    strokes: [],
    ...over,
  }) as DesignNode;

const tr = (over: Partial<EditorNodeTransform>): EditorNodeTransform => ({
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  ...over,
});

/* ---------------- normDeg ---------------- */

describe("normDeg", () => {
  test("负角/超圈归一", () => {
    expect(normDeg(-90)).toBe(270);
    expect(normDeg(450)).toBe(90);
    expect(normDeg(719.9998)).toBe(0); // 浮点尾巴折 0
  });
});

/* ---------------- 恒等式与基础落账 ---------------- */

describe("ledgerFor", () => {
  test("场景恒等式往返：由 doc 构造 tr → 落账得原值（null）", () => {
    // doc.x=100,y=50,w=200,h=80，页面级（parentHalf=0）：tr = 中心
    const n = rect({ id: "a", x: 100, y: 50, w: 200, h: 80 });
    expect(ledgerFor(n, tr({ x: 200, y: 90 }))).toBeNull();
  });

  test("frame/group 子节点恒等式：tr = 父盒左上角基准局部 + 半宽高", () => {
    // 子 doc.x=20,y=10（相对父盒左上角 = leafer 内层原点），锚点 = 20+25 / 10+20
    const n = rect({ id: "c", x: 20, y: 10, w: 50, h: 40 });
    const t = tr({ x: 20 + 25, y: 10 + 20 });
    expect(ledgerFor(n, t)).toBeNull();
  });

  test("纯移动：只产生 x/y 补丁", () => {
    const n = rect({ id: "a", x: 100, y: 50, w: 200, h: 80 });
    const p = ledgerFor(n, tr({ x: 210, y: 90 }));
    expect(p).not.toBeNull();
    expect(p!.patch).toEqual({ x: 110 }); // y 未变（50+40=90 恒等）→ 不进补丁
  });

  test("缩放：abs 吸收负 scale，中心守恒", () => {
    const n = rect({ id: "a", x: 100, y: 100, w: 100, h: 50 });
    // 中心 (150,125) 不动，横向放大 2 倍并镜像
    const p = ledgerFor(n, tr({ x: 150, y: 125, scaleX: -2, scaleY: 1 }))!;
    expect(p.patch.x).toBe(50); // 150 − 200/2
    expect(p.patch.w).toBe(200);
    expect(p.patch.y).toBeUndefined();
    expect(p.patch.h).toBeUndefined();
  });

  test("rotation 缺省 0 不写入；从 0 旋到 30 才写", () => {
    const n = rect({ id: "a", x: 100, y: 100, w: 100, h: 50 });
    expect(ledgerFor(n, tr({ x: 150, y: 125 }))).toBeNull();
    const p = ledgerFor(n, tr({ x: 150, y: 125, rotation: 30 }))!;
    expect(p.patch.rotation).toBe(30);
  });

  test("已有 rotation:0 脏值被删除分支清掉", () => {
    const n = { ...rect({ id: "a", x: 100, y: 100, w: 100, h: 50 }), rotation: 0 } as DesignNode;
    const p = ledgerFor(n, tr({ x: 150, y: 125 }));
    expect(p).not.toBeNull();
    expect("rotation" in p!.patch).toBe(true);
    expect(p!.patch.rotation).toBeUndefined();
  });

  test("frame 只改盒子：补丁不含 children", () => {
    const f: FrameNode = {
      type: "frame",
      id: "f",
      name: "F",
      x: 0,
      y: 0,
      w: 375,
      h: 812,
      fills: [],
      children: [rect({ id: "k", x: 10, y: 10, w: 20, h: 20 })],
    };
    const p = ledgerFor(f, tr({ x: 187.5, y: 406, scaleX: 2, scaleY: 1 }))!;
    expect(p.patch.w).toBe(750);
    expect("children" in p.patch).toBe(false);
  });
});

/* ---------------- line dir 重映射 ---------------- */

describe("ledgerFor line", () => {
  const line = (dir: LineNode["dir"]): LineNode =>
    ({
      type: "line",
      id: "l",
      name: "L",
      x: 100,
      y: 100,
      w: 100,
      h: 50,
      strokes: [],
      ...(dir === undefined ? {} : { dir }),
    }) as LineNode;

  test("水平镜像：dir 0 ↘ → 3 ↙", () => {
    const p = ledgerFor(line(0), tr({ x: 150, y: 125, scaleX: -1 }))!;
    expect(p.patch.dir).toBe(3);
  });

  test("dir 0 为缺省值：折返 0 时写 undefined 删除", () => {
    const p = ledgerFor(line(1), tr({ x: 150, y: 125, scaleY: -1 }))!;
    expect(p.patch.dir).toBeUndefined(); // 1↗ 纵向镜像 → 0（缺省）
    expect("dir" in p.patch).toBe(true);
  });

  test("纯移动不改 dir", () => {
    const p = ledgerFor(line(2), tr({ x: 160, y: 125 }))!;
    expect("dir" in p.patch).toBe(false);
  });
});

/* ---------------- group 缩放传播 ---------------- */

describe("scaleChildren", () => {
  const g = (id: string, x: number, y: number, w: number, h: number, children: DesignNode[]): GroupNode =>
    ({ type: "group", id, name: id, x, y, w, h, children }) as GroupNode;

  test("子盒绕组中心放大：位置与尺寸同倍", () => {
    const kids = scaleChildren([rect({ id: "c", x: 10, y: 10, w: 20, h: 20 })], 2, 2, 100, 100);
    expect(kids[0]).toMatchObject({ x: -30, y: -30, w: 40, h: 40 });
  });

  test("镜像传播：子盒关于组中心翻转", () => {
    const kids = scaleChildren([rect({ id: "c", x: 10, y: 10, w: 20, h: 20 })], -1, 1, 100, 100);
    expect(kids[0]).toMatchObject({ x: 70, y: 10, w: 20, h: 20 });
  });

  test("嵌套 group 递归 + 线 dir 奇偶翻转", () => {
    const inner = g("in", 0, 0, 50, 50, [
      { type: "line", id: "l", name: "l", x: 5, y: 5, w: 10, h: 10, dir: 0, strokes: [] } as LineNode,
    ]);
    const kids = scaleChildren([inner], 2, -2, 100, 100);
    // 外层：x∈[0,50] 绕 50 ×2 → [−50,100]；y∈[0,50] 绕 50 ×−2 → [50,100]
    expect(kids[0]).toMatchObject({ x: -50, y: 50, w: 100, h: 100 });
    const li = (kids[0] as GroupNode).children[0] as LineNode;
    // 内层（旧局部 50×50）：x∈[5,15] 绕 25 ×2 → [−15,20]；y∈[5,15] 绕 25 ×−2 → [45,20]
    expect(li).toMatchObject({ x: -15, y: 45, w: 20, h: 20 });
    expect(li.dir).toBe(1); // 0↘ flipY → 1↗
  });

  test("组内文字字号按 |sx| 缩放", () => {
    const t = {
      type: "text",
      id: "t",
      name: "T",
      x: 0,
      y: 0,
      w: 60,
      h: 20,
      runs: [{ text: "hi", size: 14 }],
    } as DesignNode;
    const kids = scaleChildren([t], 1.5, 3, 100, 100);
    expect((kids[0] as { runs: { size: number }[] }).runs[0]!.size).toBe(21);
    expect(kids[0]!.h).toBe(60);
  });

  test("组内 frame 只缩盒子不传播", () => {
    const f = {
      type: "frame",
      id: "f",
      name: "F",
      x: 0,
      y: 0,
      w: 50,
      h: 50,
      fills: [],
      children: [rect({ id: "c", x: 10, y: 10, w: 10, h: 10 })],
    } as DesignNode;
    const kids = scaleChildren([f], 2, 2, 100, 100);
    const nf = kids[0] as FrameNode;
    expect(nf).toMatchObject({ x: -50, y: -50, w: 100, h: 100 });
    expect(nf.children[0]).toMatchObject({ x: 10, y: 10, w: 10, h: 10 });
  });
});

describe("ledgerFor group", () => {
  test("group 缩放补丁携带传播后的 children；纯移动不携带", () => {
    const grp: GroupNode = {
      type: "group",
      id: "grp",
      name: "G",
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      children: [rect({ id: "c", x: 50, y: 50, w: 20, h: 20 })],
    };
    const moved = ledgerFor(grp, tr({ x: 60, y: 60 }))!;
    expect("children" in moved.patch).toBe(false);
    const scaled = ledgerFor(grp, tr({ x: 50, y: 50, scaleX: 2 }))!;
    const kids = scaled.patch.children as DesignNode[];
    expect(kids[0]).toMatchObject({ x: 50, y: 50, w: 40, h: 20 });
  });
});

/* ---------------- diffPatch ---------------- */

describe("diffPatch", () => {
  test("数值容差、数组逐项、undefined 删除分支", () => {
    const cur = { a: 1.0, b: [1, 2], c: 3 };
    const full = { a: 1.0000000001, b: [1, 3], c: undefined, d: 9 };
    expect(diffPatch(cur, full)).toEqual({ b: [1, 3], c: undefined, d: 9 });
  });

  test("cur 数值先 r1 归一到写入精度再比", () => {
    expect(diffPatch({ a: 1.04 }, { a: 1 })).toEqual({}); // 1.04→1.0 = 1
    expect(diffPatch({ a: 1.04 }, { a: 1.05 })).toEqual({ a: 1.05 }); // 1.0→1.05 仍差
  });
});

describe("flip 镜像契约", () => {
  test("翻转节点的纯移动：不产生宽高/子树噪声", () => {
    const rect: DesignNode = { id: "r", type: "rect", name: "R", x: 100, y: 100, w: 50, h: 40, flipX: true };
    const patch = ledgerFor(rect, { x: 130, y: 120, scaleX: -1, scaleY: 1, rotation: 0 }); // y=中心 100+40/2
    expect(patch).toEqual({ id: "r", patch: { x: 105 } });
  });

  test("手势翻转到镜像：提交 flipX=true", () => {
    const rect: DesignNode = { id: "r", type: "rect", name: "R", x: 100, y: 100, w: 50, h: 40 };
    // 绕中心 (125,120) 水平镜像：tr.x = 125 - 25 = 100（位置不变），scaleX = -1
    const patch = ledgerFor(rect, { x: 100, y: 100, scaleX: -1, scaleY: 1, rotation: 0 });
    expect(patch?.patch.flipX).toBe(true);
    expect(patch?.patch.w).toBeUndefined(); // 尺寸不变
  });

  test("已翻转节点再翻转回正：flipX 清除（走 undefined 删除分支）", () => {
    const rect: DesignNode = { id: "r", type: "rect", name: "R", x: 100, y: 100, w: 50, h: 40, flipX: true };
    const patch = ledgerFor(rect, { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 0 });
    expect(patch?.patch.flipX).toBeUndefined();
    expect("flipX" in (patch?.patch ?? {})).toBe(true);
  });

  test("翻转节点的 group：纯移动不重排子树（手势相对缩放 = 1）", () => {
    const grp: DesignNode = {
      id: "g", type: "group", name: "G", x: 100, y: 100, w: 100, h: 100, flipX: true,
      children: [{ id: "c", type: "rect", name: "C", x: 10, y: 10, w: 30, h: 30 }],
    };
    const patch = ledgerFor(grp, { x: 160, y: 150, scaleX: -1, scaleY: 1, rotation: 0 }); // y=中心 100+100/2
    expect(patch).toEqual({ id: "g", patch: { x: 110 } });
  });

  test("翻转节点的文本缩放手势：字号按相对缩放（不双算镜像）", () => {
    const text: DesignNode = { id: "t", type: "text", name: "T", x: 100, y: 100, w: 100, h: 30, flipX: true, runs: [{ text: "字", size: 20, color: "#111111" }] };
    // 手势再放大 2 倍：tr.scaleX = -2（含 flip 符号），相对 = 2
    const patch = ledgerFor(text, { x: 200, y: 100, scaleX: -2, scaleY: 1, rotation: 0 });
    const runs = (patch?.patch.runs as { size: number }[]) ?? [];
    expect(runs[0]?.size).toBe(40);
    expect(patch?.patch.w).toBe(200); // |100 * -2|
  });
});
