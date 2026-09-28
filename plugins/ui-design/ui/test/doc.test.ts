/**
 * DesignDoc v1 模型测试：容错解析（坏 JSON/坏节点/钳制/上限）、id 唯一性兜底、
 * 序列化往返幂等、渐变/描边/效果/圆角解析细节、docStats 摘要。
 */
import { describe, expect, test } from "bun:test";
import {
  blankDoc,
  DEVICE_PRESETS,
  DOC_VERSION,
  docStats,
  findNode,
  newFrame,
  newNode,
  parseDesignDoc,
  serializeDoc,
  starterDoc,
  walkDoc,
  type DesignDoc,
  type FrameNode,
} from "../src/doc";

const parse = (json: string) => parseDesignDoc(json).doc;
const wrap = (nodes: unknown[]): DesignDoc =>
  parse(JSON.stringify({ version: 1, meta: { name: "t" }, pages: [{ id: "p1", name: "P", nodes }] }));

describe("parseDesignDoc 容错", () => {
  test("坏 JSON / 非对象 → 空档不抛错", () => {
    const bad = parseDesignDoc("{not json");
    expect(bad.doc.pages.length).toBe(1);
    expect(bad.warnings.length).toBe(1);
    expect(parseDesignDoc("[1,2]").doc.pages[0]!.nodes).toEqual([]);
  });

  test("未知类型节点丢弃，坏子节点丢弃，好兄弟保留", () => {
    const doc = wrap([
      { id: "a", type: "rect", x: 0, y: 0, w: 10, h: 10 },
      { id: "b", type: "pen-path", x: 0, y: 0, w: 10, h: 10 },
      "string",
      { id: "c", type: "frame", children: [null, { type: "ellipse", x: 1, y: 1, w: 2, h: 2 }] },
    ]);
    const ids = [...walkDoc(doc)].map((e) => e.node.id);
    expect(ids).toContain("a");
    expect(ids).not.toContain("b");
    expect(ids).toContain("c");
    const frame = doc.pages[0]!.nodes.find((n) => n.id === "c") as FrameNode;
    expect(frame.children.length).toBe(1);
  });

  test("数值钳制：w/h≥1、opacity 0..1、坐标 ±100000、颜色非法走默认", () => {
    const doc = wrap([
      { id: "a", type: "rect", x: "1e9", y: -999999, w: 0, h: -5, opacity: 3, fills: [{ type: "solid", color: "red" }] },
    ]);
    const n = doc.pages[0]!.nodes[0]!;
    expect(n.x).toBe(100000);
    expect(n.y).toBe(-100000);
    expect(n.w).toBe(1);
    expect(n.h).toBe(1);
    expect(n.opacity).toBeUndefined(); // 钳到 1 = 缺省，不落字段
    if (n.type === "rect") expect(n.fills[0]!.color).toBe("#d9d9d9");
  });

  test("字符串数字弱类型转换", () => {
    const doc = wrap([{ id: "a", type: "rect", x: "12.5", y: 0, w: "100", h: "50" }]);
    const n = doc.pages[0]!.nodes[0]!;
    expect(n.x).toBe(12.5);
    expect(n.w).toBe(100);
  });

  test("activePage 缺失/指向坏页 → 回落第一页；meta.name 清洗", () => {
    const doc = parse(JSON.stringify({ pages: [{ id: "pA", nodes: [] }, { id: "pB", nodes: [] }], activePage: "zzz", meta: { name: 123 } }));
    expect(doc.activePage).toBe("pA");
    expect(doc.meta.name).toBe("UI 设计");
    expect(doc.meta.kind).toBe("uidesign");
    expect(doc.version).toBe(DOC_VERSION);
  });

  test("id 重复自动补唯一 id；空 id 也补", () => {
    const doc = wrap([
      { id: "dup", type: "rect", w: 9, h: 9 },
      { id: "dup", type: "rect", w: 9, h: 9 },
      { type: "rect", w: 9, h: 9 },
    ]);
    const ids = doc.pages[0]!.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe("dup");
    expect(ids[1]).not.toBe("dup");
  });

  test("上限：fills 4 / strokes 4 / effects 4 / children 500 / pages 20", () => {
    const fat = wrap([
      {
        id: "f",
        type: "frame",
        w: 100,
        h: 100,
        fills: Array.from({ length: 9 }, () => ({ type: "solid", color: "#fff" })),
        strokes: Array.from({ length: 9 }, () => ({ color: "#000", width: 1 })),
        effects: Array.from({ length: 9 }, () => ({ type: "drop-shadow", color: "#000", x: 0, y: 1, blur: 2 })),
        children: Array.from({ length: 600 }, (_, i) => ({ id: `c${i}`, type: "rect", w: 1, h: 1 })),
      },
    ]);
    const frame = fat.pages[0]!.nodes[0] as FrameNode;
    expect(frame.fills.length).toBe(4);
    expect(frame.strokes!.length).toBe(4);
    expect(frame.effects!.length).toBe(4);
    expect(frame.children.length).toBe(500);
    const manyPages = parse(JSON.stringify({ pages: Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, nodes: [] })) }));
    expect(manyPages.pages.length).toBe(20);
  });

  test("text：runs 坏项过滤、全坏回退默认 run、string 的 text 字段兜底", () => {
    const doc = wrap([
      { id: "t1", type: "text", w: 50, h: 20, runs: [{ noText: 1 }, { text: "好", size: 9999 }] },
      { id: "t2", type: "text", w: 50, h: 20, text: "裸文本" },
      { id: "t3", type: "text", w: 50, h: 20, runs: [] },
    ]);
    const [t1, t2, t3] = doc.pages[0]!.nodes;
    if (t1?.type !== "text") throw new Error("t1");
    if (t2?.type !== "text") throw new Error("t2");
    if (t3?.type !== "text") throw new Error("t3");
    expect(t1.runs.length).toBe(1);
    expect(t1.runs[0]!.size).toBe(400);
    expect(t2.runs[0]!.text).toBe("裸文本");
    expect(t3.runs[0]!.text).toBe("文本");
  });

  test("linear fill：stops 升序归一、angle 归 0..360、缺 stops 用默认双色", () => {
    const doc = wrap([
      { id: "r", type: "rect", w: 9, h: 9, fills: [{ type: "linear", angle: -90, stops: [{ at: 1, color: "#0000ff" }, { at: 0, color: "#ff0000" }] }] },
      { id: "r2", type: "rect", w: 9, h: 9, fills: [{ type: "linear" }] },
    ]);
    const a = doc.pages[0]!.nodes[0]!;
    if (a.type !== "rect") throw new Error("a");
    const fa = a.fills[0]!;
    expect(fa.stops!.map((s) => s.color)).toEqual(["#ff0000", "#0000ff"]);
    expect(fa.angle).toBe(270);
    const b = doc.pages[0]!.nodes[1]!;
    if (b.type !== "rect") throw new Error("b");
    expect(b.fills[0]!.stops!.length).toBe(2);
  });

  test("radial center 钳 0..1；未知 fill type 整条丢弃", () => {
    const doc = wrap([
      { id: "r", type: "rect", w: 9, h: 9, fills: [{ type: "radial", center: { x: 2, y: -1 } }, { type: "diamond-pattern" }] },
    ]);
    const n = doc.pages[0]!.nodes[0]!;
    if (n.type !== "rect") throw new Error("n");
    expect(n.fills.length).toBe(1);
    expect(n.fills[0]!.center).toEqual({ x: 1, y: 0 });
  });

  test("radius：0/坏值省略、四角数组保留、越界钳 4096", () => {
    const doc = wrap([
      { id: "a", type: "rect", w: 9, h: 9, radius: 0 },
      { id: "b", type: "rect", w: 9, h: 9, radius: [8, 0, 99999, "4"] },
    ]);
    expect(doc.pages[0]!.nodes[0]!.radius).toBeUndefined();
    expect(doc.pages[0]!.nodes[1]!.radius).toEqual([8, 0, 4096, 4]);
  });

  test("line 无 strokes 补默认；dir 非法值归 0", () => {
    const doc = wrap([
      { id: "l", type: "line", w: 100, h: 0 },
      { id: "ar", type: "arrow", w: 100, h: 10, dir: 7 },
    ]);
    const l = doc.pages[0]!.nodes[0]!;
    if (l.type !== "line") throw new Error("l");
    expect(l.strokes).toEqual([{ color: "#111111", width: 2 }]);
    const ar = doc.pages[0]!.nodes[1]!;
    if (ar.type !== "arrow") throw new Error("ar");
    expect(ar.dir).toBeUndefined();
  });

  test("frame preset 白名单；clip=false 保留、缺省省略", () => {
    const doc = wrap([
      { id: "f", type: "frame", w: 10, h: 10, preset: "ios-375", clip: false },
      { id: "g", type: "frame", w: 10, h: 10, preset: "nokia" },
    ]);
    const f = doc.pages[0]!.nodes[0]!;
    if (f.type !== "frame") throw new Error("f");
    expect(f.preset).toBe("ios-375");
    expect(f.clip).toBe(false);
    const g = doc.pages[0]!.nodes[1]!;
    if (g.type !== "frame") throw new Error("g");
    expect(g.preset).toBeUndefined();
    expect(g.clip).toBeUndefined();
  });
});

describe("序列化往返", () => {
  test("parse 输出键序规范：parse→serialize→parse→serialize 字节稳定（幂等）", () => {
    // 工厂函数与解析器的键插入序不同，幂等基线取解析后的规范形态
    const j1 = serializeDoc(parseDesignDoc(serializeDoc(starterDoc("往返", "ios-390"))).doc);
    const j2 = serializeDoc(parseDesignDoc(j1).doc);
    expect(j2).toBe(j1);
    // 解析保真：字段一个不少
    const doc = parseDesignDoc(j1).doc;
    expect(docStats(doc).frames).toBe(3);
  });

  test("富节点往返：fills/strokes/effects/radius/rotation 全字段保持", () => {
    const src = wrap([
      {
        id: "f",
        name: "Home",
        type: "frame",
        x: 10,
        y: 20,
        w: 375,
        h: 812,
        rotation: 45,
        opacity: 0.9,
        clip: false,
        preset: "ios-375",
        fills: [
          { type: "solid", color: "#ffffff" },
          { type: "linear", angle: 90, stops: [{ at: 0, color: "#ff0000" }, { at: 1, color: "#0000ff" }] },
        ],
        strokes: [{ color: "#333333", width: 2, align: "inside", style: "dashed" }],
        effects: [
          { type: "drop-shadow", color: "#00000066", x: 0, y: 4, blur: 12 },
          { type: "layer-blur", blur: 6 },
        ],
        radius: [16, 16, 0, 0],
        children: [
          { id: "t", type: "text", x: 8, y: 8, w: 100, h: 24, runs: [{ text: "标题", size: 20, weight: 600, color: "#111111" }], align: "center", lineHeight: 1.5, letterSpacing: 1 },
          { id: "i", type: "image", x: 0, y: 40, w: 50, h: 50, src: "assets/a.png", fit: "contain" },
          { id: "g", type: "group", x: 0, y: 100, w: 30, h: 30, children: [{ id: "e", type: "ellipse", x: 0, y: 0, w: 30, h: 30, fills: [{ type: "solid", color: "#0f0" }] }] },
        ],
      },
    ]);
    const json = serializeDoc(src);
    const back = parseDesignDoc(json).doc;
    expect(serializeDoc(back)).toBe(json);
    const f = back.pages[0]!.nodes[0] as FrameNode;
    expect(f.rotation).toBe(45);
    expect(f.radius).toEqual([16, 16, 0, 0]);
    expect(f.effects!.length).toBe(2);
    const loc = findNode(back, "i")!;
    expect(loc.parent!.id).toBe("f");
    expect(loc.pageId).toBe(back.pages[0]!.id);
  });
});

describe("构造与摘要", () => {
  test("blankDoc 单空页；starterDoc 三画板横排、预设尺寸", () => {
    const doc = starterDoc("演示", "desktop-1440");
    const p = DEVICE_PRESETS["desktop-1440"]!;
    expect(doc.pages[0]!.nodes.length).toBe(3);
    const [f0, f1, f2] = doc.pages[0]!.nodes;
    expect(f0!.w).toBe(p.w);
    expect(f1!.x).toBeGreaterThan(p.w);
    expect(f2!.x).toBeGreaterThan(f1!.x);
    expect(newFrame({ w: 375, h: 812 }).fills[0]!.color).toBe("#ffffff");
    expect(blankDoc().meta.name).toBe("UI 设计");
  });

  test("newNode 各类型默认结构正确", () => {
    const box = { x: 0, y: 0, w: 100, h: 40 };
    expect(newNode("text", box).type).toBe("text");
    const rect = newNode("rect", box);
    if (rect.type !== "rect") throw new Error("rect");
    expect(rect.fills.length).toBe(1);
    const line = newNode("line", box);
    if (line.type !== "line") throw new Error("line");
    expect(line.strokes.length).toBe(1);
    expect(newNode("group", box).name).toBe("组");
  });

  test("docStats：跨页节点计数、当前页画板 preview", () => {
    const doc = starterDoc("统计", "ios-375");
    (doc.pages[0]!.nodes[0] as FrameNode).children.push(newNode("rect", { x: 0, y: 0, w: 10, h: 10 }));
    const s = docStats(doc);
    expect(s.frames).toBe(3);
    expect(s.nodes).toBe(4); // 3 frame + 1 rect
    expect(s.previews[0]!.w).toBe(375);
    expect(s.previews[0]!.bg).toBe("#ffffff");
  });
});
