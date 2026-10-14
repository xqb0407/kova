/**
 * 形状内嵌文字（LayerText）全链路测试。
 *
 * 这是「双击矩形直接打字」（Figma 的 layer text）的底座：形状自带一段文字，
 * 随形状移动/删除/成组，不占独立图层。四项契约必须同时成立，缺一个就会出现
 * 「画布看得见、导出没有」这类割裂：
 *   ① 文档层：解析容错 + 序列化幂等 + 空文字 = 摘标签（不留空壳）
 *   ② 读取口径：canHoldText / nodeTextRuns / nodeTextStyle 对 text 与形状统一
 *   ③ 渲染同源：画布 scene 与 SVG 导出都把文字画在形状自身盒内、缺省双居中
 *   ④ 体检覆盖：内嵌文字的对比度要纳入 text-contrast（底色就是形状自己的填充）
 */
import { describe, expect, test } from "bun:test";
import {
  canHoldText,
  layerText,
  nodeTextRuns,
  nodeTextStyle,
  parseDesignDoc,
  parseLayerText,
  serializeDoc,
  withTextRuns,
  withTextStyle,
  type DesignDoc,
  type DesignNode,
  type Page,
  type ShapeNode,
} from "../src/doc";
import { buildPageScene, type MeasureFn } from "../src/leafer/scene";
import { buildSvg } from "../src/svg";
import { lintDoc } from "../src/lint";

/** 确定性测量：CJK 1em、拉丁 0.5em —— 只为验证盒内落位，不追字体精度 */
const measure: MeasureFn = (text, fontCss) => {
  const size = parseFloat(fontCss.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? "16") || 16;
  let w = 0;
  for (const ch of text) w += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.5;
  return { width: w, ascent: size * 0.8, descent: size * 0.2 };
};

const btn = (over: Partial<ShapeNode> = {}): ShapeNode =>
  ({ id: "btn", type: "rect", name: "按钮", x: 24, y: 40, w: 200, h: 48, fills: [{ type: "solid", color: "#111111" }], strokes: [], ...over }) as ShapeNode;

const makeDoc = (nodes: DesignNode[]): DesignDoc => {
  const board = { id: "b1", type: "frame", name: "画板", x: 0, y: 0, w: 390, h: 844, fills: [], strokes: [], children: nodes } as DesignNode;
  const page: Page = { id: "p1", name: "P", nodes: [board] };
  return { version: 1, meta: { name: "t", kind: "uidesign" }, activePage: "p1", pages: [page] };
};

/* ---------------- ① 文档层 ---------------- */

describe("LayerText 解析与序列化", () => {
  test("裸串简写 → runs，align/vAlign 不落字段（缺省即居中）", () => {
    const lt = parseLayerText("按钮")!;
    expect(lt.runs).toEqual([{ text: "按钮" }]);
    expect(lt.align).toBeUndefined();
    expect(lt.vAlign).toBeUndefined();
  });

  test("对象式：text / runs / label 三种写法都认", () => {
    expect(parseLayerText({ text: "A" })!.runs[0]!.text).toBe("A");
    expect(parseLayerText({ label: "B" })!.runs[0]!.text).toBe("B");
    expect(parseLayerText({ runs: [{ text: "C", size: 20 }] })!.runs[0]!.size).toBe(20);
    // run 数组直接给也算
    expect(parseLayerText([{ text: "D" }])!.runs[0]!.text).toBe("D");
  });

  test("只有偏离缺省才落 align/vAlign —— 保证序列化幂等", () => {
    const c = parseLayerText({ text: "x", align: "center", vAlign: "middle" })!;
    expect(c.align).toBeUndefined();
    expect(c.vAlign).toBeUndefined();
    const l = parseLayerText({ text: "x", align: "left", vAlign: "top" })!;
    expect(l.align).toBe("left");
    expect(l.vAlign).toBe("top");
  });

  test("空值一律 null：不产生空壳 text 对象", () => {
    expect(parseLayerText(undefined)).toBeNull();
    expect(parseLayerText(null)).toBeNull();
    expect(parseLayerText("")).toBeNull();
    expect(parseLayerText({})).toBeNull();
    expect(parseLayerText({ text: "" })).toBeNull();
    expect(parseLayerText([{ text: "" }])).toBeNull();
  });

  test("整档往返：解析 → 序列化 → 再解析，文字不丢也不漂", () => {
    const doc = makeDoc([btn({ text: { runs: [{ text: "提交", size: 16, color: "#ffffff" }], align: "left" } })]);
    const round = parseDesignDoc(serializeDoc(doc)).doc;
    const shape = (round.pages[0]!.nodes[0] as DesignNode & { children: DesignNode[] }).children[0] as ShapeNode;
    const lt = layerText(shape)!;
    expect(lt.runs[0]).toEqual({ text: "提交", size: 16, color: "#ffffff" });
    expect(lt.align).toBe("left");
  });
});

/* ---------------- ② 读取口径 ---------------- */

describe("canHoldText / nodeTextRuns / nodeTextStyle 统一口径", () => {
  test("text 节点与形状都能承载文字；frame/line/icon 不能", () => {
    expect(canHoldText({ type: "text", runs: [] } as unknown as DesignNode)).toBe(true);
    for (const t of ["rect", "ellipse", "triangle", "star", "diamond", "pentagon", "hexagon"]) {
      expect(canHoldText({ type: t } as unknown as DesignNode)).toBe(true);
    }
    for (const t of ["frame", "group", "line", "arrow", "icon", "image", "vector", "instance"]) {
      expect(canHoldText({ type: t } as unknown as DesignNode)).toBe(false);
    }
  });

  test("nodeTextRuns：text 取自身 runs，形状取内嵌 text.runs，其余空数组", () => {
    const t = { type: "text", runs: [{ text: "自" }] } as unknown as DesignNode;
    expect(nodeTextRuns(t)[0]!.text).toBe("自");
    expect(nodeTextRuns(btn({ text: { runs: [{ text: "嵌" }] } }) as DesignNode)[0]!.text).toBe("嵌");
    expect(nodeTextRuns(btn() as DesignNode)).toEqual([]);
    expect(nodeTextRuns({ type: "frame" } as unknown as DesignNode)).toEqual([]);
  });

  test("nodeTextStyle：text 缺省左上，形状缺省双居中 —— 这正是两处默认值不同的原因", () => {
    expect(nodeTextStyle({ type: "text", runs: [] } as unknown as DesignNode)).toMatchObject({ align: "left", vAlign: "top" });
    expect(nodeTextStyle(btn() as DesignNode)).toMatchObject({ align: "center", vAlign: "middle" });
    // 形状显式覆盖时按覆盖走
    expect(nodeTextStyle(btn({ text: { runs: [{ text: "x" }], align: "right" } }) as DesignNode).align).toBe("right");
  });

  test("layerText 只服务形状：text 节点返回 null，避免与自身 runs 打架", () => {
    expect(layerText({ type: "text", runs: [{ text: "x" }] } as unknown as DesignNode)).toBeNull();
    expect(layerText(btn({ text: { runs: [{ text: "x" }] } }) as DesignNode)).not.toBeNull();
  });
});

/* ---------------- ③ 渲染同源 ---------------- */

describe("画布渲染形状内嵌文字", () => {
  const sceneOf = (nodes: DesignNode[]) => {
    const doc = makeDoc(nodes);
    const scene = buildPageScene(doc.pages[0]!, { measure, asset: () => ({ status: "missing" }), doc } as never);
    const board = scene.find((c) => c.key === "b1")!;
    return board.children!.find((c) => c.key === "btn")!;
  };

  test("有内嵌文字：形状组下多出 #lt 片段，排在填充/描边之后（文字在上）", () => {
    const g = sceneOf([btn({ text: { runs: [{ text: "提交", size: 16 }] } })]);
    const kids = g.children!;
    const fills = kids.filter((c) => c.key.startsWith("btn#") && !c.key.startsWith("btn#lt"));
    const lt = kids.filter((c) => c.key.startsWith("btn#lt"));
    expect(lt.length).toBeGreaterThan(0);
    // z 序：文字片段必须全部排在视觉件之后
    const lastFill = Math.max(...fills.map((c) => kids.indexOf(c)));
    const firstLt = Math.min(...lt.map((c) => kids.indexOf(c)));
    expect(firstLt).toBeGreaterThan(lastFill);
  });

  test("缺省居中：短文案的片段 x > 0（不是贴左）", () => {
    const g = sceneOf([btn({ text: { runs: [{ text: "提交", size: 16 }] } })]);
    const lt = g.children!.filter((c) => c.key.startsWith("btn#lt"));
    expect((lt[0]!.props.x as number)).toBeGreaterThan(0);
  });

  test("显式 align:left 时片段从 x=0 起", () => {
    const g = sceneOf([btn({ text: { runs: [{ text: "提交", size: 16 }], align: "left" } })]);
    const lt = g.children!.filter((c) => c.key.startsWith("btn#lt"));
    expect(lt[0]!.props.x).toBe(0);
  });

  test("没有内嵌文字就不产生 #lt（不白占 key）", () => {
    const g = sceneOf([btn()]);
    expect(g.children!.filter((c) => c.key.startsWith("btn#lt"))).toHaveLength(0);
  });

  test("就地编辑时（hideTextId）内嵌文字不渲染，但填充照旧", () => {
    const doc = makeDoc([btn({ text: { runs: [{ text: "提交" }] } })]);
    const scene = buildPageScene(doc.pages[0]!, { measure, asset: () => ({ status: "missing" }), doc, hideTextId: "btn" } as never);
    const g = scene.find((c) => c.key === "b1")!.children!.find((c) => c.key === "btn")!;
    expect(g.children!.filter((c) => c.key.startsWith("btn#lt"))).toHaveLength(0);
    expect(g.children!.length).toBeGreaterThan(0);
  });
});

describe("SVG 导出形状内嵌文字", () => {
  const svgOf = (node: DesignNode) => {
    const doc = makeDoc([node]);
    return buildSvg(doc, ["btn"], { measure, images: new Map() })!.svg;
  };

  test("rect 内嵌文字出现在导出里，且带 <text>", () => {
    const svg = svgOf(btn({ text: { runs: [{ text: "提交", size: 16, color: "#ffffff" }] } }));
    expect(svg).toContain("<text");
    expect(svg).toContain(">提<");
    expect(svg).toContain("#ffffff");
  });

  test("多边形（star）同样能带内嵌文字", () => {
    const svg = svgOf(btn({ type: "star", text: { runs: [{ text: "星", size: 14 }] } }) as DesignNode);
    expect(svg).toContain(">星<");
  });

  test("无内嵌文字时导出不出现多余 text", () => {
    expect(svgOf(btn())).not.toContain("<text");
  });

  test("画布与导出的文字落位一致：都居中，x 相同量级", () => {
    const node = btn({ text: { runs: [{ text: "提交", size: 16 }] } });
    const doc = makeDoc([node]);
    const scene = buildPageScene(doc.pages[0]!, { measure, asset: () => ({ status: "missing" }), doc } as never);
    const g = scene.find((c) => c.key === "b1")!.children!.find((c) => c.key === "btn")!;
    const canvasX = g.children!.find((c) => c.key.startsWith("btn#lt"))!.props.x as number;

    const svg = buildSvg(doc, ["btn"], { measure, images: new Map() })!.svg;
    const m = svg.match(/<text x="([\d.]+)"/);
    expect(m).not.toBeNull();
    const svgX = parseFloat(m![1]!);
    // 同源同 measure，两者必须逐值相等（不是「接近」）
    expect(svgX).toBeCloseTo(canvasX, 5);
  });
});

/* ---------------- ④ 体检覆盖 ---------------- */

describe("lint 纳入形状内嵌文字", () => {
  test("深字压深底命中 text-contrast，且标为 layer", () => {
    const doc = makeDoc([btn({ fills: [{ type: "solid", color: "#1c1e24" }], text: { runs: [{ text: "提交", size: 14, color: "#1c1f26" }] } })]);
    const iss = lintDoc(doc).issues.find((i) => i.code === "text-contrast");
    expect(iss).toBeDefined();
    expect(iss!.detail!.layer).toBe(true);
    expect(iss!.message).toContain("形状内嵌文字");
  });

  test("浅字压深底不报（正例）", () => {
    const doc = makeDoc([btn({ fills: [{ type: "solid", color: "#1c1e24" }], text: { runs: [{ text: "提交", size: 14, color: "#ffffff" }] } })]);
    expect(lintDoc(doc).issues.find((i) => i.code === "text-contrast")).toBeUndefined();
  });

  test("形状没写字就不会误报", () => {
    const doc = makeDoc([btn({ fills: [{ type: "solid", color: "#1c1e24" }] })]);
    expect(lintDoc(doc).issues.find((i) => i.code === "text-contrast")).toBeUndefined();
  });
});

/* ---------------- ⑤ 统一写入口 ---------------- */

describe("withTextRuns / withTextStyle 统一写入口", () => {
  test("写 text 节点：runs 与排版落到节点自身平铺字段", () => {
    const t = { id: "t", type: "text", name: "t", x: 0, y: 0, w: 100, h: 20, runs: [{ text: "旧" }] } as unknown as DesignNode;
    const out = withTextRuns(t, [{ text: "新" }], { align: "right", lineHeight: 2 });
    expect(nodeTextRuns(out)[0]!.text).toBe("新");
    expect((out as unknown as { align: string }).align).toBe("right");
    expect((out as unknown as { lineHeight: number }).lineHeight).toBe(2);
  });

  test("写形状：排版落进内嵌 LayerText，不污染形状自身字段", () => {
    const out = withTextStyle(btn({ text: { runs: [{ text: "提交" }] } }) as DesignNode, { vAlign: "bottom", letterSpacing: 1 });
    const lt = layerText(out)!;
    expect(lt.vAlign).toBe("bottom");
    expect(lt.letterSpacing).toBe(1);
    // 形状顶层不该出现 align/vAlign/lineHeight 这些文字专属字段
    expect((out as unknown as Record<string, unknown>).align).toBeUndefined();
    expect((out as unknown as Record<string, unknown>).vAlign).toBeUndefined();
  });

  test("withTextStyle 不改文案（只动排版）", () => {
    const out = withTextStyle(btn({ text: { runs: [{ text: "提交", size: 16 }] } }) as DesignNode, { align: "left" });
    expect(layerText(out)!.runs[0]).toEqual({ text: "提交", size: 16 });
  });

  test("写空串 = 摘掉形状标签（不留空壳 text）", () => {
    const out = withTextRuns(btn({ text: { runs: [{ text: "提交" }] } }) as DesignNode, [{ text: "" }]);
    expect(layerText(out)).toBeNull();
  });

  test("不可变：原节点不被改写", () => {
    const original = btn({ text: { runs: [{ text: "提交" }] } }) as DesignNode;
    withTextRuns(original, [{ text: "改过" }]);
    expect(layerText(original)!.runs[0]!.text).toBe("提交");
  });

  test("不能承载文字的节点原样返回（frame/icon 不被硬塞字段）", () => {
    const f = { id: "f", type: "frame", name: "f", x: 0, y: 0, w: 10, h: 10, children: [] } as unknown as DesignNode;
    expect(withTextRuns(f, [{ text: "x" }])).toBe(f);
  });
});
