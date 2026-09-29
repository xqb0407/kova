/**
 * 布尔运算单测：union/subtract/intersect/exclude 的面积与环结构、旋转折算、
 * 曲线路径拒绝、vector 产物往返与三端渲染。
 */
import { describe, expect, test } from "bun:test";
import { parseDesignDoc, serializeDoc, type DesignDoc, type DesignNode } from "../src/doc";
import { booleanPath, isBoolShape, normalizeBoolOp, pathDRings } from "../src/boolean";
import { buildSvg, type SvgOptions } from "../src/svg";
import { buildPageScene } from "../src/leafer/scene";

const rect = (id: string, x: number, y: number, w: number, h: number): DesignNode => ({
  id, type: "rect", name: id, x, y, w, h, fills: [{ type: "solid", color: "#d9d9d9" }], strokes: [],
});

/** 鞋带公式算多边形组总面积（绝对值，外环+反向内环自然抵消） */
function polyArea(d: string): number {
  let total = 0;
  for (const ring of pathDRings(d)) {
    let s = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i]!;
      const [x2, y2] = ring[(i + 1) % ring.length]!;
      s += x1 * y2 - x2 * y1;
    }
    total += Math.abs(s) / 2;
  }
  return total;
}

describe("布尔引擎", () => {
  test("union：重叠正方形合并，面积 = 2A - 交集，包围盒 150×150", () => {
    const { d, bbox } = booleanPath("union", [rect("a", 0, 0, 100, 100), rect("b", 50, 50, 100, 100)]);
    expect(Math.round(polyArea(d))).toBe(10000 + 10000 - 2500);
    expect(bbox).toEqual({ x: 0, y: 0, w: 150, h: 150 });
  });

  test("subtract：底形减去覆盖形（面积扣减）", () => {
    const { d } = booleanPath("subtract", [rect("a", 0, 0, 100, 100), rect("b", 25, 25, 100, 100)]);
    expect(Math.round(polyArea(d))).toBe(10000 - 75 * 75);
  });

  test("intersect：交集面积", () => {
    const { d } = booleanPath("intersect", [rect("a", 0, 0, 100, 100), rect("b", 50, 50, 100, 100)]);
    expect(Math.round(polyArea(d))).toBe(2500);
  });

  test("exclude：异或拆成两块", () => {
    const { d } = booleanPath("exclude", [rect("a", 0, 0, 100, 100), rect("b", 50, 50, 100, 100)]);
    expect(Math.round(polyArea(d))).toBe(15000); // |A|+|B|-2|A∩B|
    expect(pathDRings(d).length).toBe(2);
  });

  test("完全无交集的 union 不合并但合法；完全覆盖的 subtract 结果为空", () => {
    const sep = booleanPath("union", [rect("a", 0, 0, 10, 10), rect("b", 100, 100, 10, 10)]);
    expect(polyArea(sep.d)).toBe(200);
    const empty = booleanPath("subtract", [rect("a", 0, 0, 10, 10), rect("b", 0, 0, 100, 100)]);
    expect(empty.d).toBe("");
  });

  test("旋转折算：45° 正方形与轴对齐正方形的并集包围盒", () => {
    const dia: DesignNode = { id: "d", type: "rect", name: "d", x: 50, y: 50, w: 100, h: 100, rotation: 45, fills: [], strokes: [] };
    const { d, bbox } = booleanPath("union", [dia, rect("a", 50, 50, 100, 100)]);
    expect(d).toContain("M");
    expect(bbox.x).toBeLessThan(50); // 旋转角伸出轴对齐盒外
    expect(bbox.w).toBeGreaterThan(100);
  });

  test("椭圆多边形化（64 段）参与布尔", () => {
    const ell: DesignNode = { id: "e", type: "ellipse", name: "e", x: 0, y: 0, w: 100, h: 100, fills: [], strokes: [] };
    const { d } = booleanPath("union", [ell, rect("a", 40, 40, 60, 60)]);
    expect(polyArea(d)).toBeGreaterThan(7850); // 圆面积 ~7854 + 露出的矩形角
  });

  test("曲线 vector 路径拒绝并报可读错误；全直线 vector 可运算", () => {
    const curve: DesignNode = { id: "c", type: "vector", name: "c", x: 0, y: 0, w: 10, h: 10, path: "M0 0C10 10 20 0 30 10Z", fills: [], strokes: [] };
    expect(() => booleanPath("union", [curve, rect("a", 0, 0, 10, 10)])).toThrow(/曲线/);
    const poly: DesignNode = { id: "v", type: "vector", name: "v", x: 20, y: 20, w: 50, h: 50, path: "M20 20L70 20L70 70Z", fills: [], strokes: [] };
    const { d } = booleanPath("union", [poly, rect("a", 0, 0, 50, 50)]);
    expect(d).toContain("M");
  });

  test("别名归一与形状判定", () => {
    expect(normalizeBoolOp("merge")).toBe("union");
    expect(normalizeBoolOp("MINUS")).toBe("subtract");
    expect(normalizeBoolOp("xor")).toBe("exclude");
    expect(normalizeBoolOp("nope")).toBeNull();
    expect(isBoolShape(rect("a", 0, 0, 1, 1))).toBe(true);
    expect(isBoolShape({ id: "t", type: "text", name: "t", x: 0, y: 0, w: 1, h: 1, runs: [] } as unknown as DesignNode)).toBe(false);
  });
});

describe("vector 节点", () => {
  test("解析/序列化往返；缺 path 跳过并警告", () => {
    const res = parseDesignDoc(JSON.stringify({
      pages: [{
        id: "p1",
        nodes: [
          { id: "v", type: "vector", name: "矢量", x: 5, y: 5, w: 100, h: 100, path: "M0 0L100 0L50 100Z", fill: "#0d99ff" },
          { id: "bad", type: "vector", name: "坏", x: 0, y: 0, w: 10, h: 10 },
        ],
      }],
    }));
    expect(res.fatal).toBe(false);
    expect(res.doc.pages[0]!.nodes).toHaveLength(1);
    expect(res.warnings.join()).toContain("path");
    const v = res.doc.pages[0]!.nodes[0]!;
    if (v.type !== "vector") throw new Error("not vector");
    expect(v.path).toBe("M0 0L100 0L50 100Z");
    expect(v.fills[0]?.type === "solid" && v.fills[0].color).toBe("#0d99ff"); // fill 简写
    const doc: DesignDoc = { version: 1, meta: { name: "t", kind: "uidesign" }, activePage: "p1", pages: [{ id: "p1", name: "页", nodes: [v] }] };
    expect(serializeDoc(parseDesignDoc(serializeDoc(doc)).doc)).toBe(serializeDoc(doc));
  });

  test("SVG 渲染：path 几何 + 填充描边；leafer 场景 path d 传入", () => {
    const v: DesignNode = { id: "v", type: "vector", name: "V", x: 10, y: 20, w: 100, h: 100, path: "M0 0L100 0L50 100Z", fills: [{ type: "solid", color: "#0d99ff" }], strokes: [{ color: "#111111", width: 2 }] };
    const svg = buildSvg(docOf(v), ["v"], { measure: () => ({ width: 10, ascent: 8, descent: 2 }), images: new Map() })!.svg;
    expect(svg).toContain('<path d="M0 0L100 0L50 100Z" fill="#0d99ff"');
    expect(svg).toContain("stroke");
    const scene = buildPageScene(parseDesignDoc(JSON.stringify({ pages: [{ id: "p1", nodes: [v] }] })).doc.pages[0]!, { measure: () => ({ width: 10, ascent: 8, descent: 2 }), asset: () => ({ status: "missing" }) as const });
    const paint = (scene[0]!.children ?? [])[0]!;
    expect((paint.props as { path?: string }).path).toBe("M0 0L100 0L50 100Z");
  });
});

function docOf(n: DesignNode): DesignDoc {
  return { version: 1, meta: { name: "t", kind: "uidesign" }, activePage: "p1", pages: [{ id: "p1", name: "页", nodes: [n] }] };
}
