/**
 * 容错解析与图标节点单测：
 * ① AI 坏写法的字段/类型别名（不再静默丢内容）
 * ② 内置 lucide 图标：解析别名、SVG 渲染（含未知名占位）
 * ③ 修复层与解析的端到端（坏 JSON 开出完整档）
 */
import { describe, expect, test } from "bun:test";
import { normalizeBlendMode, parseDesignDoc, serializeDoc, type DesignDoc, type DesignNode } from "../src/doc";
import { fixJsonText } from "../src/jsonfix";
import { normalizeIconName, resolveIconName, searchIcons, iconDrawSpec, transformPathD } from "../src/icons";
import { buildSvg, type SvgOptions } from "../src/svg";
import { nodeToCode, nodeToCss } from "../src/css";

const parse = (json: unknown): { doc: DesignDoc; node: DesignNode | null; res: ReturnType<typeof parseDesignDoc> } => {
  const res = parseDesignDoc(JSON.stringify({ pages: [{ id: "p1", name: "页", nodes: [json] }] }));
  expect(res.fatal).toBe(false);
  return { doc: res.doc, node: res.doc.pages[0]!.nodes[0] ?? null, res };
};

const measure = () => ({ width: 10, ascent: 8, descent: 2 });
const svgOpts: SvgOptions = { measure, images: new Map() };
const docOf = (n: DesignNode): DesignDoc => ({ version: 1, meta: { name: "t", kind: "uidesign" }, activePage: "p1", pages: [{ id: "p1", name: "页", nodes: [n] }] });

describe("字段与类型别名容错", () => {
  test("类型别名与大小写：Rectangle/circle/Icon/img/artboard", () => {
    expect(parse({ id: "a", type: "Rectangle", x: 0, y: 0, w: 10, h: 10 }).node?.type).toBe("rect");
    expect(parse({ id: "b", type: "circle", x: 0, y: 0, w: 10, h: 10 }).node?.type).toBe("ellipse");
    expect(parse({ id: "c", type: "Icon", x: 0, y: 0, w: 24, h: 24, icon: "house" }).node?.type).toBe("icon");
    expect(parse({ id: "d", type: "img", x: 0, y: 0, w: 10, h: 10, src: "a.png" }).node?.type).toBe("image");
    expect(parse({ id: "e", type: "artboard", x: 0, y: 0, w: 10, h: 10 }).node?.type).toBe("frame");
  });

  test("未知类型：丢弃但给出警告（不再静默）", () => {
    const { res } = parse({ id: "x", type: "component-v2", x: 0, y: 0, w: 10, h: 10 });
    expect(res.doc.pages[0]!.nodes).toHaveLength(0);
    expect(res.warnings.join()).toContain("component-v2");
  });

  test("cornerRadius/borderRadius → radius；fill 字符串 → fills；stroke 简写 → strokes", () => {
    const { node } = parse({ id: "a", type: "rect", x: 0, y: 0, w: 10, h: 10, cornerRadius: 8, fill: "#0d99ff", stroke: "#111111", strokeWidth: 3 });
    if (node?.type !== "rect") throw new Error("not rect");
    expect(node.radius).toBe(8);
    expect(node.fills[0]?.type === "solid" && node.fills[0].color).toBe("#0d99ff");
    expect(node.strokes[0]?.width).toBe(3);
    expect(node.strokes[0]?.color).toBe("#111111");
  });

  test("text 顶层简写：fontSize/color/weight 不再丢（AI 不写 runs 数组）", () => {
    const { node } = parse({ id: "t", type: "text", x: 0, y: 0, w: 100, h: 30, text: "标题", fontSize: 24, color: "#111111", fontWeight: 700 });
    if (node?.type !== "text") throw new Error("not text");
    expect(node.runs[0]?.text).toBe("标题");
    expect(node.runs[0]?.size).toBe(24);
    expect(node.runs[0]?.color).toBe("#111111");
    expect(node.runs[0]?.weight).toBe(700);
  });

  test("宽松值：visible/locked 字符串、opacity 百分比、px 后缀、rgb() 色名", () => {
    const { node } = parse({ id: "a", type: "rect", x: 0, y: 0, w: "100px", h: 10, visible: "false", opacity: "50%", fill: "rgb(13, 153, 255)" });
    expect(node?.visible).toBe(false);
    expect(node?.opacity).toBe(0.5);
    expect(node?.w).toBe(100);
    if (node?.type === "rect") expect(node.fills[0]?.type === "solid" && node.fills[0].color).toBe("#0d99ff");
  });
});

describe("内置 lucide 图标", () => {
  test("名字解析：精确 / 别名 / 驼峰与容错", () => {
    expect(resolveIconName("house")).toBe("house");
    expect(resolveIconName("home")).toBe("house"); // 别名折算
    expect(resolveIconName("ArrowLeft")).toBe("arrow-left");
    expect(resolveIconName("lucide:search")).toBe("search");
    expect(resolveIconName("chevronright")).toBe("chevron-right");
    expect(resolveIconName("not-an-icon-xyz")).toBe(null);
    expect(normalizeIconName(" ShoppingCart ")).toBe("shopping-cart");
  });

  test("搜索：前缀优先、别名命中、limit", () => {
    const hit = searchIcons("arrow-left", 10);
    expect(hit[0]).toBe("arrow-left");
    const home = searchIcons("home", 10);
    expect(home).toContain("house");
    expect(searchIcons("", 5)).toHaveLength(5);
    expect(searchIcons("cart", 3).length).toBeLessThanOrEqual(3);
  });

  test("icon 节点解析：别名归一、name 兼容、未知名保留 + 警告", () => {
    const a = parse({ id: "i1", type: "icon", x: 0, y: 0, w: 24, h: 24, icon: "home" });
    if (a.node?.type !== "icon") throw new Error("not icon");
    expect(a.node.icon).toBe("house");
    expect(a.node.name).toBe("house");
    expect(a.node.color ?? "#111111").toBe("#111111");
    expect(a.node.strokeWidth ?? 2).toBe(2);

    const b = parse({ id: "i2", type: "icon", x: 0, y: 0, w: 24, h: 24, name: "home", color: "red", strokeWidth: 3 });
    if (b.node?.type !== "icon") throw new Error("not icon");
    expect(b.node.icon).toBe("house");
    expect(b.node.color).toBe("#ff0000");
    expect(b.node.strokeWidth).toBe(3);

    const c = parse({ id: "i3", type: "icon", x: 0, y: 0, w: 24, h: 24, icon: "fake-icon-q" });
    if (c.node?.type !== "icon") throw new Error("not icon");
    expect(c.node.icon).toBe("fake-icon-q");
    expect(c.res.warnings.join()).toContain("未知图标名");
  });

  test("icon 的 SVG 渲染：24 栅格缩放进盒、描边语义、未知名画占位", () => {
    const icon: DesignNode = { id: "ic", type: "icon", name: "home", x: 10, y: 20, w: 48, h: 48, icon: "house", color: "#0d99ff", strokeWidth: 2 };
    const svg = buildSvg(docOf(icon), ["ic"], svgOpts)!.svg;
    expect(svg).toContain('stroke="#0d99ff"');
    expect(svg).toContain('stroke-width="4.00"'); // 2 × (48/24) = 4
    expect(svg).not.toContain("M15 21v-8"); // 原始 24 栅格坐标已被变换
    expect(svg).toContain("M30 42"); // 15×2=30（盒内），21×2=42（盒内）
    // 未知名 → 占位
    const bad: DesignNode = { id: "bd", type: "icon", name: "?", x: 0, y: 0, w: 24, h: 24, icon: "nope-nope" };
    const badSvg = buildSvg(docOf(bad), ["bd"], svgOpts)!.svg;
    expect(badSvg).toContain("?");
    expect(badSvg).toContain("stroke-dasharray");
  });

  test("transformPathD：等比缩放 + 平移后端点落在预期位置；恒等变换原样返回", () => {
    const d = "M2 3L4 5A2 2 0 0 1 6 7Z";
    expect(transformPathD(d, 1, 0, 0)).toBe(d);
    const moved = transformPathD(d, 2, 10, 20);
    expect(moved).toContain("M14 26");
    expect(moved).toContain("A4 4 0 0 1 22 34");
    // 相对命令只缩放不平移
    expect(transformPathD("M2 3l2 2", 2, 10, 20)).toBe("M14 26l4 4");
  });

  test("iconDrawSpec：短边贴合居中；非正方形盒留白居中", () => {
    const spec = iconDrawSpec("house", 48, 24, 2);
    expect(spec).not.toBeNull();
    expect(spec!.sw).toBe(2); // 短边 24 决定缩放 s=1 → 2×1
  });
});

describe("修复层 × 解析端到端", () => {
  test("坏 JSON（注释+尾逗号+裸键+围栏）开档不 fatal，fixes/warnings 有报导", () => {
    const bad = "```json\n{\n // 稿\n version: 1,\n pages: [{ id: 'p1', name: '页', nodes: [\n   { id: 'f1', type: 'frame', name: '首页', x: 0, y: 0, w: 375, h: 812, },\n ]}],\n}\n```";
    expect(() => JSON.parse(bad)).toThrow();
    const res = parseDesignDoc(bad);
    expect(res.fatal).toBe(false);
    expect(res.fixes?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(res.warnings.join()).toContain("已自动修复");
    expect(res.doc.pages[0]!.nodes[0]!.type).toBe("frame");
    // 修好的档序列化是严格 JSON 且幂等
    const once = serializeDoc(res.doc);
    expect(serializeDoc(parseDesignDoc(once).doc)).toBe(once);
  });

  test("截断的档也能救回完整前缀", () => {
    const res = parseDesignDoc('{"version":1,"pages":[{"id":"p1","name":"页","nodes":[{"id":"f1","type":"frame","name":"首页","x":0,"y":0,"w":375,"h":812},{"id":"f2","type":"frame","na');
    expect(res.fatal).toBe(false);
    expect(res.doc.pages[0]!.nodes).toHaveLength(1);
    expect(res.doc.pages[0]!.nodes[0]!.id).toBe("f1");
  });

  test("fixJsonText 幂等：修复结果再修不变", () => {
    const bad = "{a:1,}";
    const once = fixJsonText(bad);
    const twice = fixJsonText(once.text);
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once.text);
  });
});

describe("混合模式与翻转", () => {
  test("解析：别名归一 + normal 缺省不落字段 + flip 别名", () => {
    expect(normalizeBlendMode(" Multiply ")).toBe("multiply");
    expect(normalizeBlendMode("PASS_THROUGH")).toBeUndefined();
    expect(normalizeBlendMode("normal")).toBeUndefined();
    expect(normalizeBlendMode("nope")).toBeUndefined();
    const r = parseDesignDoc(JSON.stringify({
      pages: [{ id: "p1", nodes: [
        { id: "a", type: "rect", x: 0, y: 0, w: 10, h: 10, blendMode: "MULTIPLY", flipH: true },
        { id: "b", type: "rect", x: 0, y: 0, w: 10, h: 10, blendMode: "normal" },
      ] }],
    }));
    const [a, b] = r.doc.pages[0]!.nodes;
    expect(a?.blendMode).toBe("multiply");
    expect(a?.flipX).toBe(true);
    expect(b?.blendMode).toBeUndefined();
  });

  test("SVG：mix-blend-mode 双写（属性+style）、翻转变换绕盒中心", () => {
    const node: DesignNode = { id: "x", type: "rect", name: "X", x: 10, y: 20, w: 100, h: 50, blendMode: "multiply", flipX: true, fills: [{ type: "solid", color: "#ff0000" }] };
    const svg = buildSvg(docOf(node), ["x"], svgOpts)!.svg;
    expect(svg).toContain('mix-blend-mode="multiply"');
    expect(svg).toContain('style="mix-blend-mode:multiply"');
    expect(svg).toContain("translate(100 0) scale(-1 1)"); // 镜像平移 w=100（与 translate(10 20) 组合等价 110)
  });

  test("CSS：mix-blend-mode 与 scaleX(-1) 声明", () => {
    const node: DesignNode = { id: "x", type: "rect", name: "X", x: 0, y: 0, w: 10, h: 10, blendMode: "difference", flipY: true };
    const css = nodeToCss(node);
    expect(css).toContain("mix-blend-mode: difference;");
    expect(css).toContain("transform: scaleY(-1);");
  });
});

describe("Dev Mode 代码生成", () => {
  test("SwiftUI / Compose：几何、颜色、圆角、混合、翻转", () => {
    const node: DesignNode = { id: "x", type: "rect", name: "按钮", x: 0, y: 0, w: 120, h: 48, radius: 24, blendMode: "multiply", flipX: true, fills: [{ type: "solid", color: "#0d99ff" }] };
    const sw = nodeToCode(node, "swiftui");
    expect(sw).toContain("RoundedRectangle(cornerRadius: 24)");
    expect(sw).toContain(".frame(width: 120, height: 48)");
    expect(sw).toContain("Color(red: 0.051, green: 0.600, blue: 1.000)");
    expect(sw).toContain(".blendMode(.multiply)");
    expect(sw).toContain(".scaleEffect(x: -1, y: 1)");
    const kt = nodeToCode(node, "compose");
    expect(kt).toContain(".size(120.dp, 48.dp)");
    expect(kt).toContain("RoundedCornerShape(24.dp)");
    expect(kt).toContain(".blendMode(BlendMode.Multiply)");
  });
  test("text 节点：Text + 字体", () => {
    const node: DesignNode = { id: "t", type: "text", name: "标题", x: 0, y: 0, w: 100, h: 30, runs: [{ text: "你好", size: 20, weight: 600, color: "#111111" }] };
    expect(nodeToCode(node, "swiftui")).toContain('Text("你好")');
    expect(nodeToCode(node, "swiftui")).toContain(".font(.system(size: 20, weight: .semibold))");
    expect(nodeToCode(node, "compose")).toContain("fontSize = 20.sp");
  });
});
