/**
 * 节点 → CSS 生成测试：透明色换算、渐变角映射（档 0=自上而下 → CSS 180+θ）、
 * 填充层序反置、描边三对齐映射、圆角/椭圆、效果 box-shadow/filter、文本首 run 口径、
 * 选择器消毒与代码块成形。
 */
import { describe, expect, test } from "bun:test";
import { newNode, type DesignNode, type FrameNode, type ShapeNode, type TextNode } from "../src/doc";
import { cssSelectorOf, nodeCssDecls, nodeToCss, withAlpha } from "../src/css";

const box = { x: 12, y: 20, w: 300, h: 60 };
const rectAt = (over: Partial<ShapeNode> = {}): ShapeNode => ({
  ...(newNode("rect", box) as ShapeNode),
  ...over,
});
const has = (n: DesignNode, frag: string) => nodeCssDecls(n).some((l) => l.includes(frag));

describe("withAlpha", () => {
  test("3 位扩张 / 6 位换算 / 8 位与非法原样 / op≥1 原样", () => {
    expect(withAlpha("#f00", 0.5)).toBe("rgba(255, 0, 0, 0.5)");
    expect(withAlpha("#0d99ff", 0.25)).toBe("rgba(13, 153, 255, 0.25)");
    expect(withAlpha("#0d99ff80", 0.5)).toBe("rgba(13, 153, 255, 0.5)");
    expect(withAlpha("tomato", 0.5)).toBe("tomato");
    expect(withAlpha("#f00", 1)).toBe("#f00");
  });
});

describe("填充 → background", () => {
  test("纯色带 opacity 转 rgba；多填充数组反序（CSS 先声明画在最上）", () => {
    // 档语义：fills 后画者在上（green 盖 red）；CSS 先声明者在上 → 反序输出 green 在前
    const n = rectAt({
      fills: [
        { type: "solid", color: "#ff0000", opacity: 0.5 },
        { type: "solid", color: "#00ff00" },
      ],
    });
    const bg = nodeCssDecls(n).find((l) => l.startsWith("background:"))!;
    expect(bg).toBe("background: #00ff00, rgba(255, 0, 0, 0.5);");
  });

  test("线性渐变角：0→180deg（自上而下）、90→270deg、-45→135deg", () => {
    const deg = (angle: number) =>
      nodeCssDecls(rectAt({ fills: [{ type: "linear", angle, stops: [{ at: 0, color: "#000" }, { at: 1, color: "#fff" }] }] }))
        .find((l) => l.startsWith("background:"))!;
    expect(deg(0)).toContain("linear-gradient(180deg");
    expect(deg(90)).toContain("linear-gradient(270deg");
    expect(deg(-45)).toContain("linear-gradient(135deg");
    expect(deg(0)).toContain("#000 0%, #fff 100%");
  });

  test("径向渐变圆心百分比；隐藏填充被剔除", () => {
    const n = rectAt({
      fills: [
        { type: "solid", color: "#111", visible: false },
        { type: "radial", center: { x: 0.3, y: 0.7 }, stops: [{ at: 0, color: "#000" }] },
      ],
    });
    const decls = nodeCssDecls(n);
    expect(decls).toContain(`background: radial-gradient(circle at 30% 70%, #000 0%);`);
  });
});

describe("描边/圆角/效果", () => {
  test("center→border（含虚线样式）；inside→inset 环；outside→外扩环", () => {
    const center = rectAt({ strokes: [{ color: "#f00", width: 2, align: "center", style: "dashed" }] });
    expect(nodeCssDecls(center)).toContain("border: 2px dashed #f00;");
    const inside = rectAt({ strokes: [{ color: "#00f", width: 3, align: "inside" }] });
    expect(has(inside, "box-shadow: inset 0 0 0 3px #00f")).toBe(true);
    const outside = rectAt({ strokes: [{ color: "#0f0", width: 1, align: "outside" }] });
    expect(has(outside, "box-shadow: 0 0 0 1px #0f0")).toBe(true);
    const hidden = rectAt({ strokes: [{ color: "#0f0", width: 1, visible: false }, { color: "#00f", width: 2 }] });
    expect(has(hidden, "border: 2px solid #00f")).toBe(true); // 取第一条可见
  });

  test("椭圆 50%；统一圆角与四角数组；0 不出声明", () => {
    const ell = newNode("ellipse", box) as ShapeNode;
    expect(nodeCssDecls(ell)).toContain("border-radius: 50%;");
    expect(nodeCssDecls(rectAt({ radius: 8 }))).toContain("border-radius: 8px;");
    expect(nodeCssDecls(rectAt({ radius: [8, 0, 4, 0] }))).toContain("border-radius: 8px 0px 4px 0px;");
    expect(nodeCssDecls(rectAt({ radius: 0 })).some((l) => l.startsWith("border-radius"))).toBe(false);
  });

  test("外/内投影合并进 box-shadow；层模糊走 backdrop-filter（毛玻璃，含 -webkit 前缀）；隐藏效果剔除", () => {
    const n = rectAt({
      effects: [
        { type: "drop-shadow", color: "#00000033", x: 0, y: 4, blur: 12 },
        { type: "inner-shadow", visible: false, color: "#000", x: 1, y: 1, blur: 2 },
        { type: "layer-blur", blur: 3 },
      ],
    });
    const decls = nodeCssDecls(n);
    expect(decls).toContain("box-shadow: 0px 4px 12px #00000033;");
    expect(decls).toContain("backdrop-filter: blur(3px);");
    expect(decls).toContain("-webkit-backdrop-filter: blur(3px);");
    // 绝不糊自身：不得出现 filter:blur（会把半透卡连同文字糊掉）
    expect(decls.some((l) => l.startsWith("filter:"))).toBe(false);
  });
});

describe("画板/文本/其他", () => {
  test("frame：clip 缺省 hidden、clip:false visible；无底色 transparent", () => {
    const f = newNode("frame", box) as FrameNode;
    f.fills = [];
    let decls = nodeCssDecls(f);
    expect(decls).toContain("overflow: hidden;");
    expect(decls).toContain("background: transparent;");
    f.clip = false;
    expect(nodeCssDecls(f)).toContain("overflow: visible;");
  });

  test("文本取首 run 样式 + 对齐/行高；多 run 附注释", () => {
    const t = newNode("text", box) as TextNode;
    t.runs = [
      { text: "标题", size: 24, weight: 600, color: "#111111", italic: true },
      { text: "副", size: 12 },
    ];
    t.align = "center";
    t.lineHeight = 1.2;
    const decls = nodeCssDecls(t);
    expect(decls).toContain("font-size: 24px;");
    expect(decls).toContain("font-weight: 600;");
    expect(decls).toContain("font-style: italic;");
    expect(decls).toContain("color: #111111;");
    expect(decls).toContain("text-align: center;");
    expect(decls).toContain("line-height: 1.2;");
    expect(decls.some((l) => l.includes("2 段样式"))).toBe(true);
    expect(decls.some((l) => l.includes("font-size: 12px"))).toBe(false);
  });

  test("图片 background-image/fit；线形/多边形附导出提示注释", () => {
    const img = newNode("image", { x: 0, y: 0, w: 100, h: 100 }) as DesignNode & { src: string };
    img.src = "a/x.png";
    expect(has(img, `url("a/x.png")`)).toBe(true);
    expect(has(img, "background-size: cover")).toBe(true);
    expect(has(newNode("star", box), "SVG 导出")).toBe(true);
    expect(has(newNode("arrow", box), "SVG 导出")).toBe(true);
  });

  test("选择器消毒 + 代码块整体成形", () => {
    const n = rectAt();
    n.name = "按钮 Primary!";
    expect(cssSelectorOf(n)).toBe(".primary"); // 中文名剥掉，英文词根留任选择器
    n.name = "  ";
    expect(cssSelectorOf(n)).toBe(".rect");
    n.name = "Card";
    n.x = 0;
    n.y = 0;
    const css = nodeToCss(n);
    expect(css.startsWith(".card {\n")).toBe(true);
    expect(css.endsWith("\n}")).toBe(true);
    expect(css).toContain("\n  position: absolute;\n");
  });

  test("选择器：uuid 脸名退类型且绝不露出；中文名以注释保留", () => {
    const n = rectAt();
    n.name = n.id; // 图层名就是 uuid
    const css = nodeToCss(n);
    expect(cssSelectorOf(n)).toBe(".rect");
    expect(css).not.toContain(n.id);
    n.name = "i3k2x9f4j1"; // 没叫 id 但形态是 base36 时间戳
    expect(cssSelectorOf(n)).toBe(".rect");
    n.name = "card2024"; // 正常命名带数字不误伤
    expect(cssSelectorOf(n)).toBe(".card2024");
    n.name = "详情"; // 纯中文 → 类型选择器 + 原名注释
    const zh = nodeToCss(n);
    expect(zh.startsWith("/* 详情 */\n.rect {")).toBe(true);
  });
});
