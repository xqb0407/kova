/**
 * 导入侧纯函数单测：svg-import 解析/变换烘焙数值 + merge 的 id/引用重映射。
 * （撤销路径的行为验证靠浏览器探针：state.ts 是 React hook，bun 里不跑组件。）
 */
import { describe, expect, test } from "bun:test";
import { importSvg, matPoint, parseSvgXml, parseTransform, tokenizePath, type SvgEl } from "../src/svg-import";
import { mergeImportedDoc } from "../src/merge";
import type { DesignDoc, DesignNode, InstanceNode } from "../src/doc";

/* ---------------- 夹具 ---------------- */

const rect = (id: string, over: Partial<DesignNode> = {}): DesignNode =>
  ({ id, type: "rect", name: id, x: 0, y: 0, w: 10, h: 10, fills: [], strokes: [], ...over }) as DesignNode;

const doc = (pages: { id: string; name: string; nodes: DesignNode[] }[], components?: DesignDoc["components"]): DesignDoc => ({
  version: 1,
  meta: { name: "夹具", kind: "uidesign" },
  activePage: pages[0]?.id ?? "none",
  pages,
  ...(components ? { components } : {}),
});

/* ---------------- SVG 解析 ---------------- */

describe("parseSvgXml", () => {
  test("注释/声明/实体/命名空间前缀", () => {
    const el = parseSvgXml(
      '<?xml version="1.0"?><!-- hi --><!DOCTYPE svg PUBLIC "x" "y">' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
        '<g xlink:href="#a&amp;x"><text>A &lt;B&gt; &#65;</text></g></svg>',
    );
    expect(el.tag).toBe("svg");
    expect(el.attrs["xmlns"]).toBe("http://www.w3.org/2000/svg");
    const g = el.children.find((c): c is SvgEl => typeof c !== "string" && c.tag === "g");
    expect(g).toBeDefined();
    expect(g!.attrs["href"]).toBe("#a&x"); // 前缀剥掉 + 实体解码
    const t = g!.children.find((c): c is SvgEl => typeof c !== "string" && c.tag === "text");
    expect(t!.children.join("")).toBe("A <B> A");
  });
  test("缺 svg 根 → throw", () => {
    expect(() => parseSvgXml("<div></div>")).toThrow();
  });
});

describe("parseTransform", () => {
  const w = (): void => {};
  test("链式组合顺序 = 左乘外（SVG 语义：transform='A B' 得 M=A·B）", () => {
    const m = parseTransform("translate(10 0) scale(2)", w);
    // 局部点 (1,1) → scale 先：(2,2) → translate：(12,2)
    expect(matPoint(m, 1, 1)).toEqual([12, 2]);
    expect(m[0]).toBeCloseTo(2, 6);
  });
  test("rotate 带心", () => {
    const m = parseTransform("rotate(90 5 5)", w);
    const [x, y] = matPoint(m, 10, 10); // 绕 (5,5) 转 90°：(10,10)→(0,10)
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(10, 6);
  });
  test("未知函数按恒等跳过并警告", () => {
    const warns2: string[] = [];
    const m = parseTransform("foo(1) translate(3 4)", (s) => warns2.push(s));
    expect(m[4]).toBeCloseTo(3, 6);
    expect(warns2.some((x) => x.includes("foo"))).toBe(true);
  });
  test("matrix 原样", () => {
    const m = parseTransform("matrix(1 2 3 4 5 6)", w);
    expect(m).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("tokenizePath", () => {
  test("多参数续段与 Z", () => {
    const cmds = tokenizePath("M1 2 3 4 L5,6z");
    expect(cmds[0]).toEqual({ c: "M", a: [1, 2, 3, 4] });
    expect(cmds.map((x) => x.c)).toEqual(["M", "L", "Z"]);
  });
});

/* ---------------- importSvg 几何烘焙 ---------------- */

const svg = (body: string, attrs = 'width="100" height="100"') => `<svg ${attrs}>${body}</svg>`;

describe("importSvg", () => {
  test("轴对齐 rect 保原生类型 + 尺寸/坐标/填充", () => {
    const r = importSvg(svg('<rect x="10" y="20" width="30" height="40" fill="#ff0000" rx="5"/>'));
    expect(r.nodes).toHaveLength(1);
    const n = r.nodes[0]! as unknown as Record<string, unknown>;
    expect(n.type).toBe("rect");
    expect([n.x, n.y, n.w, n.h]).toEqual([10, 20, 30, 40]);
    expect((n.fills as { color: string }[])[0]!.color).toBe("#ff0000");
    expect(n.radius).toBe(5);
  });

  test("带旋转的 rect 烘焙为 vector（角点变换）", () => {
    const r = importSvg(svg('<rect x="0" y="0" width="10" height="0" transform="rotate(45)"/>'));
    // h=0 无效 → 无节点也不炸；再来一个真的：
    const r2 = importSvg(svg('<rect x="0" y="0" width="10" height="10" transform="rotate(45)"/>'));
    expect(r.nodes).toHaveLength(0);
    expect(r2.nodes[0]!.type).toBe("vector");
    const v = r2.nodes[0] as unknown as { x: number; y: number; w: number; h: number };
    expect(v.x).toBeCloseTo(-7.07, 2); // 旋转 45° 后四角包围盒
    expect(v.y).toBeCloseTo(0, 4);
    expect(v.w).toBeCloseTo(14.14, 2);
    expect(v.h).toBeCloseTo(14.14, 2);
    expect(r2.warnings.some((x) => x.includes("旋转"))).toBe(true);
  });

  test("viewBox 缩放烘焙：200 单位映射到 100px", () => {
    const r = importSvg('<svg width="100" height="50" viewBox="0 0 200 100"><rect x="0" y="0" width="200" height="100" fill="black"/></svg>');
    const n = r.nodes[0] as unknown as { x: number; y: number; w: number; h: number };
    expect([n.x, n.y, n.w, n.h]).toEqual([0, 0, 100, 50]);
    expect(r.w).toBe(100);
    expect(r.h).toBe(50);
  });

  test("相对路径转绝对 + transform 烘焙 + path 局部化", () => {
    const r = importSvg(svg('<path d="M10 10h20v20z" transform="translate(5 5)" fill="rgb(0,128,0)"/>'));
    const v = r.nodes[0] as unknown as { x: number; y: number; w: number; h: number; path: string };
    expect(v.type).toBe("vector");
    expect([v.x, v.y]).toEqual([15, 15]);
    expect([v.w, v.h]).toEqual([20, 20]);
    expect(v.path.startsWith("M0 0")).toBe(true); // 盒局部：整体平移掉 (15,15)
    expect(v.path).toContain("Z");
    expect((r.nodes[0] as unknown as { fills: { color: string }[] }).fills[0]!.color).toBe("#008000");
  });

  test("opacity×fill-opacity 合成进 alpha", () => {
    const r = importSvg(svg('<rect x="0" y="0" width="8" height="8" fill="#ff0000" fill-opacity="0.5" opacity="0.5"/>'));
    const f = (r.nodes[0] as unknown as { fills: { color: string }[] }).fills[0]!;
    expect(f.color).toBe("#ff000040"); // 0.25*255=63.75→64=0x40
  });

  test("circle→ellipse（轴对齐）；line 带斜率定 dir", () => {
    const r = importSvg(svg('<circle cx="20" cy="30" r="10"/><line x1="0" y1="10" x2="10" y2="0" stroke="#111"/>'));
    expect(r.nodes[0]!.type).toBe("ellipse");
    const e = r.nodes[0] as unknown as { x: number; y: number; w: number; h: number };
    expect([e.x, e.y, e.w, e.h]).toEqual([10, 20, 20, 20]);
    const l = r.nodes[1] as unknown as { type: string; dir: number; x: number; y: number; w: number; h: number };
    expect(l.type).toBe("line");
    expect(l.dir).toBe(1); // 右上
    expect([l.x, l.y, l.w, l.h]).toEqual([0, 0, 10, 10]);
  });

  test("g 继承链：fill/stroke/transform 逐层合成", () => {
    const r = importSvg(
      svg('<g fill="#abc" stroke="red" stroke-width="2" transform="translate(4 4)"><rect x="0" y="0" width="5" height="5"/></g>'),
    );
    const n = r.nodes[0] as unknown as { x: number; y: number; fills: { color: string }[]; strokes: { color: string; width: number }[] };
    expect([n.x, n.y]).toEqual([4, 4]);
    expect(n.fills[0]!.color).toBe("#aabbcc");
    expect(n.strokes[0]!.color).toBe("#ff0000");
    expect(n.strokes[0]!.width).toBe(2);
  });

  test("style= 属性优先于展示属性；dasharray→dashed", () => {
    const r = importSvg(svg('<rect x="0" y="0" width="5" height="5" fill="red" style="fill:#00ff00" stroke="#123" stroke-dasharray="4 2"/>'));
    const n = r.nodes[0] as unknown as { fills: { color: string }[]; strokes: { style?: string }[] };
    expect(n.fills[0]!.color).toBe("#00ff00");
    expect(n.strokes[0]!.style).toBe("dashed");
  });

  test("text：基线近似 + 锚点 + 解码内容", () => {
    const r = importSvg(svg('<text x="50" y="20" font-size="10" text-anchor="middle">你好 &amp; Hi</text>'));
    const t = r.nodes[0] as unknown as { type: string; x: number; y: number; runs: { text: string; size: number }[] };
    expect(t.type).toBe("text");
    expect(t.runs[0]!.text).toBe("你好 & Hi");
    expect(t.runs[0]!.size).toBe(10);
    expect(t.y).toBeCloseTo(12, 4); // y - 0.8*size
    expect(t.x).toBeLessThan(50); // middle 锚点整体左移半宽
  });

  test("渐变 url() → 无填充 + 警告；image/use 跳过警告", () => {
    const r = importSvg(svg('<rect x="0" y="0" width="5" height="5" fill="url(#g)"/><image href="a.png"/><use href="#x"/><rect x="6" y="6" width="5" height="5" fill="black"/>'));
    const n0 = r.nodes[0] as unknown as { fills: unknown[] };
    expect(n0.fills).toEqual([]);
    expect(r.warnings.some((x) => x.includes("渐变"))).toBe(true);
    expect(r.warnings.some((x) => x.includes("image"))).toBe(true);
    expect(r.warnings.some((x) => x.includes("use"))).toBe(true);
  });

  test("display=none 与 visibility=hidden 不产出", () => {
    const r = importSvg(svg('<rect display="none" x="0" y="0" width="5" height="5"/><rect visibility="hidden" x="0" y="0" width="5" height="5"/>'));
    expect(r.nodes).toHaveLength(0);
  });

  test("缺尺寸回落 320 + 警告；polyline 折线成 vector", () => {
    const r = importSvg("<svg><polyline points='0,0 10,5 5,10' fill='none' stroke='#333'/></svg>");
    expect(r.w).toBe(320);
    expect(r.warnings.some((x) => x.includes("320"))).toBe(true);
    const v = r.nodes[0] as unknown as { type: string; w: number; h: number; path: string };
    expect(v.type).toBe("vector");
    expect([v.w, v.h]).toEqual([10, 10]);
    expect(v.path).toContain("L");
    expect(v.path).not.toContain("Z"); // polyline 不闭合
  });
});

/* ---------------- mergeImportedDoc ---------------- */

describe("mergeImportedDoc", () => {
  test("页全量并入：id 重发、activePage 不变、目标页序保持", () => {
    const target = doc([{ id: "tp1", name: "甲页", nodes: [rect("a")] }]);
    const incoming = doc([
      { id: "ip1", name: "乙页", nodes: [rect("b")] },
      { id: "ip2", name: "丙页", nodes: [rect("c")] },
    ]);
    const m = mergeImportedDoc(target, incoming);
    expect(m.doc.pages.map((p) => p.name)).toEqual(["甲页", "乙页", "丙页"]);
    expect(m.doc.activePage).toBe("tp1");
    expect(m.doc.pages[0]!.nodes[0]!.id).toBe("a"); // 目标侧不动
    expect(m.pages.every((p) => p.id !== "ip1" && p.id !== "ip2")).toBe(true);
    expect(m.nodes).toBe(2);
    // 序列化往返幂等（导入产物必须过 parseDesignDoc 不报修）
    const nodes = m.doc.pages[1]!.nodes;
    expect(nodes[0]!.type).toBe("rect");
    expect(nodes[0]!.id.length).toBeGreaterThan(1);
  });

  test("页子集按 id 或名称挑；没命中给警告；全空 throw", () => {
    const target = doc([{ id: "tp", name: "甲", nodes: [] }]);
    const incoming = doc([
      { id: "ia", name: "乙", nodes: [rect("r1")] },
      { id: "ib", name: "丙", nodes: [rect("r2")] },
    ]);
    const m = mergeImportedDoc(target, incoming, { pageNames: ["乙", "ib"] });
    expect(m.pages.map((p) => p.name)).toEqual(["乙", "丙"]);
    expect(() => mergeImportedDoc(target, incoming, { pageNames: ["不存在"] })).toThrow(/没有可导入/);
    expect(() => mergeImportedDoc(target, doc([]))).toThrow(/没有可导入/);
  });

  test("组件与实例：componentId 与 overrides key 全量重映射，主档嵌套实例也修", () => {
    // 来源档：组件 C（含节点 m1、m2 + 嵌套实例引用组件 D）→ 页面实例 I 带 overrides{m1,ghost}
    const compD = { id: "cd", name: "D", nodes: [rect("d1")] };
    const instOfD: DesignNode = { id: "i0", type: "instance", name: "D用", x: 1, y: 1, w: 10, h: 10, componentId: "cd" } as unknown as DesignNode;
    const compC = { id: "cc", name: "C", nodes: [rect("m1"), rect("m2"), instOfD] };
    const pageInst: DesignNode = {
      id: "ii",
      type: "instance",
      name: "C用",
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      componentId: "cc",
      overrides: { m1: { x: 99 }, ghost: { y: 1 } },
    } as unknown as DesignNode;
    const target = doc([{ id: "tp", name: "页", nodes: [] }]);
    const incoming = doc([{ id: "ip", name: "源页", nodes: [pageInst] }], [compC, compD]);
    const m = mergeImportedDoc(target, incoming);
    expect(m.components).toBe(2);
    const comps = m.doc.components!;
    const newC = comps.find((c) => c.name === "C")!;
    const newD = comps.find((c) => c.name === "D")!;
    expect(newC.id).not.toBe("cc");
    // 主档里的嵌套实例指向新 D
    const nested = newC.nodes.find((n) => n.type === "instance") as InstanceNode;
    expect(nested.componentId).toBe(newD.id);
    // 页面上的实例指向新 C
    const inst = m.doc.pages[1]!.nodes[0] as InstanceNode;
    expect(inst.componentId).toBe(newC.id);
    // overrides key：m1 → 新 C 里的 m1 副本 id；查不到的 ghost 原样保留（死覆盖）
    const keys = Object.keys(inst.overrides!);
    expect(keys).toHaveLength(2);
    const mapped = keys.find((k) => k !== "ghost")!;
    expect(newC.nodes.some((n) => n.id === mapped)).toBe(true);
    expect(newC.nodes.some((n) => n.id === "m1")).toBe(false); // 主档 id 也重发了
    expect(inst.overrides!["ghost"]).toEqual({ y: 1 });
    expect(inst.overrides![mapped]!.x).toBe(99); // 覆盖值原样带过来
    expect(m.warnings).toEqual([]); // 组件都在来源档内：无缺失警告
  });

  test("引用了不在来源档的组件 → 计数警告（落为组件缺失占位）", () => {
    const orphan: DesignNode = { id: "oi", type: "instance", name: "孤", x: 0, y: 0, w: 10, h: 10, componentId: "zz" } as unknown as DesignNode;
    const target = doc([{ id: "tp", name: "页", nodes: [] }]);
    const incoming = doc([{ id: "ip", name: "源", nodes: [orphan] }]);
    const m = mergeImportedDoc(target, incoming);
    expect(m.warnings.some((x) => x.includes("组件缺失"))).toBe(true);
    const inst = m.doc.pages[1]!.nodes[0] as InstanceNode;
    expect(inst.componentId).toBe("zz"); // 保留原引用（渲染侧走占位）
  });

  test("双方 components 皆空 → 产物不带 components 字段（序列化幂等）", () => {
    const target = doc([{ id: "tp", name: "页", nodes: [] }]);
    const incoming = doc([{ id: "ip", name: "源", nodes: [rect("x")] }]);
    const m = mergeImportedDoc(target, incoming);
    expect(m.doc.components).toBeUndefined();
  });
});
