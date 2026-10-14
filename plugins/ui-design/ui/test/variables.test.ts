/**
 * 共享颜色变量单测（纯函数）：var: 引用语法贯通 colorOr、三端解析 resolveVarColor
 * （直色/命中/链式/防环/坏引用）、全档引用盘点、引用重映射、parse/serialize 往返、
 * merge 并档时变量 id 重发 + 名字去重 + 引用同步改写、首页缩略图解析。
 */
import { describe, expect, test } from "bun:test";
import {
  MISSING_VAR_COLOR,
  collectVarRefs,
  colorOr,
  docStats,
  isVarRef,
  parseDesignDoc,
  remapVarColors,
  resolveVarColor,
  serializeDoc,
  varRefId,
  type DesignDoc,
  type DesignNode,
} from "../src/doc";
import { mergeImportedDoc } from "../src/merge";

const rect = (id: string, over: Partial<DesignNode> = {}): DesignNode =>
  ({ id, type: "rect", name: id, x: 0, y: 0, w: 10, h: 10, fills: [], strokes: [], ...over }) as DesignNode;

const doc = (nodes: DesignNode[], variables?: DesignDoc["variables"], components?: DesignDoc["components"]): DesignDoc => ({
  version: 1,
  meta: { name: "变量测试", kind: "uidesign" },
  activePage: "p1",
  pages: [{ id: "p1", name: "Page 1", nodes }],
  ...(variables ? { variables } : {}),
  ...(components ? { components } : {}),
});

const V = (id: string, value: string, name = id): NonNullable<DesignDoc["variables"]>[number] => ({ id, name, value });

/* ---------------- 引用语法 ---------------- */

describe("var: 引用语法", () => {
  test("colorOr 放行 var: 引用（其余颜色照旧归一）", () => {
    expect(colorOr("var:abc-1", "#111111")).toBe("var:abc-1");
    expect(colorOr(" var:abc-1 ", "#111111")).toBe("var:abc-1");
    expect(colorOr("var:", "#111111")).toBe("#111111"); // 空引用不算引用
    expect(colorOr("RED", "#111111")).toBe("#ff0000");
  });
  test("isVarRef / varRefId", () => {
    expect(isVarRef("var:v1")).toBe(true);
    expect(isVarRef("var:")).toBe(false);
    expect(isVarRef("#ff0000")).toBe(false);
    expect(varRefId("var:primary-2")).toBe("primary-2");
  });
});

/* ---------------- 解析 ---------------- */

describe("resolveVarColor", () => {
  const d = doc([], [V("v1", "#0d99ff", "主色"), V("v2", "var:v1"), V("dead", "var:gone")]);
  test("非引用原样返回；空值走 fallback", () => {
    expect(resolveVarColor(d, "#ff0000")).toBe("#ff0000");
    expect(resolveVarColor(d, undefined, "#111111")).toBe("#111111");
  });
  test("命中：var:id → 变量值", () => {
    expect(resolveVarColor(d, "var:v1")).toBe("#0d99ff");
  });
  test("链式引用（v2→v1）", () => {
    expect(resolveVarColor(d, "var:v2")).toBe("#0d99ff");
  });
  test("坏引用 → 警示粉；链式坏引用同样", () => {
    expect(resolveVarColor(d, "var:gone")).toBe(MISSING_VAR_COLOR);
    expect(resolveVarColor(d, "var:dead")).toBe(MISSING_VAR_COLOR);
    expect(resolveVarColor(undefined, "var:v1")).toBe(MISSING_VAR_COLOR);
  });
  test("循环引用不炸（深度封顶 → 警示粉）", () => {
    const c = doc([], [V("a", "var:b"), V("b", "var:a")]);
    expect(resolveVarColor(c, "var:a")).toBe(MISSING_VAR_COLOR);
  });
});

/* ---------------- 盘点 / 重映射 ---------------- */

describe("collectVarRefs / remapVarColors", () => {
  test("盘点覆盖填充/渐变色标/描边/文字/图标/效果/组件主档", () => {
    const d = doc(
      [
        rect("r1", { fills: [{ type: "solid", color: "var:a" }], strokes: [{ color: "var:b", width: 1 }] }),
        rect("r2", { fills: [{ type: "linear", stops: [{ at: 0, color: "var:a" }, { at: 1, color: "#ffffff" }] }] }),
        { id: "t1", type: "text", name: "t", x: 0, y: 0, w: 10, h: 10, runs: [{ text: "x", color: "var:a" }] } as unknown as DesignNode,
        { id: "ic1", type: "icon", name: "i", x: 0, y: 0, w: 10, h: 10, icon: "house", color: "var:c" } as unknown as DesignNode,
        {
          id: "s1", type: "rect", name: "s", x: 0, y: 0, w: 10, h: 10, fills: [],
          effects: [{ type: "drop-shadow", color: "var:c", x: 0, y: 2, blur: 4 }],
          strokes: [],
        } as unknown as DesignNode,
      ],
      undefined,
      [{ id: "c1", name: "主档", nodes: [rect("m1", { fills: [{ type: "solid", color: "var:a" }] })] }],
    );
    const u = collectVarRefs(d);
    expect(u.get("a")).toBe(4); // r1 填充 + r2 色标 + t1 文字 + 主档填充
    expect(u.get("b")).toBe(1);
    expect(u.get("c")).toBe(2);
    expect(u.has("z")).toBe(false);
  });
  test("重映射：映射内改写（含色标/覆盖值），映射外保留", () => {
    const map = new Map([["a", "x"], ["b", "y"]]);
    const nodes = [
      rect("r1", {
        fills: [{ type: "linear", stops: [{ at: 0, color: "var:a" }, { at: 1, color: "#ffffff" }] }],
        strokes: [{ color: "var:b", width: 1 }, { color: "var:keep", width: 1 }],
      }),
      {
        id: "i1", type: "instance", name: "i", x: 0, y: 0, w: 10, h: 10, componentId: "c1",
        overrides: { m1: { fills: [{ type: "solid", color: "var:a" }], color: "var:b" } },
      } as unknown as DesignNode,
    ];
    remapVarColors(nodes, map);
    const r = nodes[0] as DesignNode & { fills: { stops: { color: string } }[]; strokes: { color: string }[] };
    expect(r.fills[0]!.stops[0]!.color).toBe("var:x");
    expect(r.fills[0]!.stops[1]!.color).toBe("#ffffff");
    expect(r.strokes[0]!.color).toBe("var:y");
    expect(r.strokes[1]!.color).toBe("var:keep"); // 查不到原样保留
    const inst = nodes[1] as DesignNode & { overrides: Record<string, { fills: { color: string }[]; color: string }> };
    expect(inst.overrides.m1!.fills[0]!.color).toBe("var:x");
    expect(inst.overrides.m1!.color).toBe("var:y");
  });
});

/* ---------------- 档往返 ---------------- */

describe("parse/serialize 变量表", () => {
  test("variables 与 var: 引用往返保持；引用齐全无警告", () => {
    const src = doc([rect("r1", { fills: [{ type: "solid", color: "var:v1" }] })], [V("v1", "#0d99ff", "主色")]);
    const res = parseDesignDoc(serializeDoc(src));
    expect(res.fatal).toBe(false);
    expect(res.warnings).toEqual([]);
    expect(res.doc!.variables).toEqual([{ id: "v1", name: "主色", value: "#0d99ff" }]);
    expect((res.doc!.pages[0]!.nodes[0] as DesignNode & { fills: { color: string }[] }).fills[0]!.color).toBe("var:v1");
  });
  test("坏引用给警告；空表/坏行丢弃", () => {
    const res = parseDesignDoc(
      JSON.stringify(doc([rect("r1", { fills: [{ type: "solid", color: "var:zz" }] })], [V("ok", "#ffffff"), { id: "", name: "无名", value: "x" } as unknown as NonNullable<DesignDoc["variables"]>[number]])),
    );
    expect(res.doc!.variables!.length).toBe(1);
    expect(res.warnings.some((w) => w.includes("var:zz"))).toBe(true);
  });
  test("首页缩略图底色解析变量", () => {
    const d = doc([rect("f", { type: "frame", name: "f", x: 0, y: 0, w: 10, h: 10, fills: [{ type: "solid", color: "var:v1" }], children: [] } as unknown as DesignNode)], [V("v1", "#123456")]);
    expect(docStats(d).previews[0]!.bg).toBe("#123456");
  });
});

/* ---------------- merge 并档 ---------------- */

describe("merge 变量并入", () => {
  test("变量 id 重发 + 名字去重 + 页面/主档/覆盖引用同步改写", () => {
    const target = doc([rect("t1")], [V("vt", "#111111", "主色")]);
    const incoming = doc(
      [
        rect("p1r", { fills: [{ type: "solid", color: "var:va" }] }),
        {
          id: "i1", type: "instance", name: "i", x: 0, y: 0, w: 10, h: 10, componentId: "c1",
          overrides: { m1: { strokes: [{ color: "var:va", width: 1 }] } },
        } as unknown as DesignNode,
      ],
      [V("va", "#222222", "主色"), V("vb", "#333333", "次色")], // 名字与 target 撞名
      [{ id: "c1", name: "主档", nodes: [rect("m1", { strokes: [{ color: "var:va", width: 1 }] })] }],
    );
    const m = mergeImportedDoc(target, incoming);
    expect(m.variables).toBe(2);
    expect(m.doc.variables!.length).toBe(3); // vt + 2 个新变量
    const newA = m.doc.variables!.find((v) => v.value === "#222222")!;
    expect(newA.id).not.toBe("va");
    expect(newA.name).toBe("主色 2"); // 撞名自动序号
    // 页面填充引用 → 新 id
    const pageNode = m.doc.pages[1]!.nodes[0] as DesignNode & { fills: { color: string }[] };
    expect(pageNode.fills[0]!.color).toBe(`var:${newA.id}`);
    // 组件主档描边 → 新 id；实例覆盖描边 → 新 id
    const comp = m.doc.components![0]!;
    const masterStroke = (comp.nodes[0] as DesignNode & { strokes: { color: string }[] }).strokes[0]!.color;
    expect(masterStroke).toBe(`var:${newA.id}`);
    const inst = m.doc.pages[1]!.nodes[1] as DesignNode & { overrides: Record<string, { strokes: { color: string }[] }> };
    const ovKey = Object.keys(inst.overrides)[0]!;
    expect(inst.overrides[ovKey]!.strokes[0]!.color).toBe(`var:${newA.id}`);
    // 目标档自己的变量与引用不受影响
    expect(m.doc.variables!.find((v) => v.id === "vt")!.name).toBe("主色");
  });
  test("来源档没变量：目标变量表原样保留、结果计数为 0", () => {
    const target = doc([rect("t1")], [V("vt", "#111111")]);
    const m = mergeImportedDoc(target, doc([rect("s1")]));
    expect(m.variables).toBe(0);
    expect(m.doc.variables!.length).toBe(1);
  });
});
