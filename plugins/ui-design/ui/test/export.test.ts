/**
 * SVG 导出序列化测试：画板裁切/渐变 defs/圆角/文字/描边虚线/旋转与嵌套偏移。
 * （measure 注入假实现，不依赖 DOM。）
 */
import { describe, expect, test } from "bun:test";
import { nodesToSvg } from "../src/export";
import type { MeasureFn } from "../src/leafer/scene";
import {
  blankDoc,
  newFrame,
  solid,
  uid,
  type DesignDoc,
  type DesignNode,
  type ShapeNode,
  type TextNode,
} from "../src/doc";

const measure: MeasureFn = (text, fontCss) => {
  const size = parseFloat(fontCss.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? "16") || 16;
  return { width: text.length * size * 0.5, ascent: size * 0.8, descent: size * 0.2 };
};

const rect = (over: Partial<ShapeNode>): ShapeNode => ({
  id: uid("r"),
  type: "rect",
  name: "r",
  x: 0,
  y: 0,
  w: 100,
  h: 40,
  fills: [solid("#ff0000")],
  strokes: [],
  ...over,
});

function docWith(...nodes: DesignNode[]): DesignDoc {
  const d = blankDoc("导出测试");
  d.pages[0]!.nodes.push(...nodes);
  return d;
}

describe("nodesToSvg", () => {
  test("画板：裁切 clipPath + 底色 + 子节点", async () => {
    const frame = newFrame({ w: 300, h: 600, x: 40, y: 40 });
    frame.fills = [solid("#ffffff")];
    frame.children.push(rect({ x: 10, y: 10, w: 50, h: 20 }));
    const r = await nodesToSvg(docWith(frame), [frame.id], measure);
    expect(r).not.toBeNull();
    const { svg } = r!;
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain("clipPath");
    expect(svg).toContain('width="300" height="600"');
    expect(svg).toContain('fill="#ff0000"');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('viewBox="40.00 40.00 300.00 600.00"');
  });

  test("渐变/圆角/描边虚线/文字/旋转", async () => {
    const grad = rect({
      id: "g1",
      w: 200,
      h: 60,
      radius: 24,
      fills: [{ type: "linear", angle: 90, stops: [{ at: 0, color: "#111111" }, { at: 1, color: "#eeeeee" }] }],
      strokes: [{ color: "#0d99ff", width: 2, style: "dashed" }],
      rotation: 30,
    });
    const text: TextNode = {
      id: "t1",
      type: "text",
      name: "t",
      x: 0,
      y: 200,
      w: 120,
      h: 24,
      runs: [{ text: "你好", size: 16, weight: 700, color: "#1e1e1e" }],
    };
    const r = await nodesToSvg(docWith(grad, text), ["g1", "t1"], measure);
    const { svg } = r!;
    expect(svg).toContain("<linearGradient");
    expect(svg).toContain('gradientTransform="rotate(90 .5 .5)"');
    expect(svg).toContain('stop-color="#eeeeee"');
    expect(svg).toContain('rx="24"');
    expect(svg).toContain("stroke-dasharray=");
    expect(svg).toContain('transform="translate(0 0) rotate(30 100 30)"');
    // CJK 按字断词，逐字成 <text>（与 leafer 渲染一致）
    expect(svg).toContain(">你<");
    expect(svg).toContain(">好<");
    expect(svg).toContain('font-weight="700"');
  });

  test("嵌套选中：世界盒偏移；隐藏节点跳过；空选择返回 null", async () => {
    const frame = newFrame({ w: 300, h: 600, x: 1000, y: 0 });
    const child = rect({ id: "kid", x: 10, y: 10, w: 50, h: 20 });
    frame.children.push(child);
    const hidden = rect({ id: "hid", x: 500, y: 500, visible: false });
    const doc = docWith(frame, hidden);
    const r = await nodesToSvg(doc, ["kid", "hid"], measure);
    expect(r).not.toBeNull();
    const { svg, box } = r!;
    // 子节点世界位置 = 1010,10：外层包裹补父链偏移 (1000,0)，内层 translate(10 10)
    expect(box.x).toBe(1010);
    expect(svg).toContain('transform="translate(1000 0)"');
    expect(svg).toContain('transform="translate(10 10)"');
    expect(svg).not.toContain("hid");
    expect(await nodesToSvg(doc, [], measure)).toBeNull();
  });
});
