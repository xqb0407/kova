/**
 * 图片填充 + 蒙版单测（P0-A）：
 * ① fill type "image"：解析别名 / SVG 几何裁剪渲染 / CSS 导出 / collectImageSrcs
 * ② mask：Figma 语义（裁剪同容器上方兄弟、自身不绘制、隐藏跳过、多蒙版交集）
 */
import { describe, expect, test } from "bun:test";
import { parseDesignDoc, serializeDoc, type DesignDoc, type DesignNode } from "../src/doc";
import { buildSvg, collectImageSrcs, type SvgOptions } from "../src/svg";
import { nodeToCss } from "../src/css";

const measure = () => ({ width: 10, ascent: 8, descent: 2 });
const svgOpts: SvgOptions = { measure, images: new Map([["pic.png", "data:image/png;base64,QQ=="]]) };

const docOf = (nodes: DesignNode[]): DesignDoc => ({
  version: 1,
  meta: { name: "t", kind: "uidesign" },
  activePage: "p1",
  pages: [{ id: "p1", name: "页", nodes }],
});

describe("图片填充", () => {
  test("解析：type image + src 别名 + scaleMode 归一（cover/crop→fill、contain→fit）", () => {
    const res = parseDesignDoc(
      JSON.stringify({
        pages: [
          {
            id: "p1",
            nodes: [
              { id: "a", type: "rect", x: 0, y: 0, w: 100, h: 50, fills: [{ type: "image", image: "pic.png", fit: "cover" }] },
              { id: "b", type: "rect", x: 0, y: 0, w: 100, h: 50, fills: [{ type: "image", src: "pic.png", scaleMode: "contain" }] },
              { id: "c", type: "rect", x: 0, y: 0, w: 100, h: 50, fills: [{ type: "image" }] },
            ],
          },
        ],
      }),
    );
    expect(res.fatal).toBe(false);
    const [a, b, c] = res.doc.pages[0]!.nodes;
    if (a?.type !== "rect" || b?.type !== "rect" || c?.type !== "rect") throw new Error("types");
    expect(a.fills[0]?.type === "image" && a.fills[0].src).toBe("pic.png");
    expect(a.fills[0]?.type === "image" && a.fills[0].scaleMode).toBe("fill");
    expect(b.fills[0]?.type === "image" && b.fills[0].scaleMode).toBe("fit");
    expect(c?.fills).toHaveLength(0); // 无 src 的图片填充丢弃
  });

  test("SVG：几何裁剪 + <image>，scaleMode 决定 preserveAspectRatio；资产缺失跳过该层", () => {
    const node: DesignNode = {
      id: "r",
      type: "rect",
      name: "卡",
      x: 0,
      y: 0,
      w: 100,
      h: 50,
      radius: 12,
      fills: [{ type: "image", src: "pic.png", scaleMode: "fill" }],
    };
    const svg = buildSvg(docOf([node]), ["r"], svgOpts)!.svg;
    expect(svg).toContain('<image href="data:image/png;base64,QQ=="');
    expect(svg).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(svg).toContain('clip-path="url(#if1)"');
    expect(svg).toContain('<clipPath id="if1"><rect width="100" height="50" rx="12"/></clipPath>');

    const fitSvg = buildSvg(docOf([{ ...node, fills: [{ type: "image", src: "pic.png", scaleMode: "fit" }] }]), ["r"], svgOpts)!.svg;
    expect(fitSvg).toContain('preserveAspectRatio="xMidYMid meet"');

    // 椭圆几何裁剪
    const ell: DesignNode = { id: "e", type: "ellipse", name: "头像", x: 0, y: 0, w: 40, h: 40, fills: [{ type: "image", src: "pic.png" }] };
    const ellSvg = buildSvg(docOf([ell]), ["e"], svgOpts)!.svg;
    expect(ellSvg).toContain('<clipPath id="if1"><ellipse cx="20" cy="20" rx="20" ry="20"/></clipPath>');

    // 资产表没有 → 层被跳过（无 image 元素）
    const missing = buildSvg(docOf([node]), ["r"], { measure, images: new Map() })!.svg;
    expect(missing).not.toContain("<image");
  });

  test("collectImageSrcs 收集图片填充的 src", () => {
    const node: DesignNode = {
      id: "g",
      type: "group",
      name: "g",
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      children: [
        { id: "r", type: "rect", name: "r", x: 0, y: 0, w: 10, h: 10, fills: [{ type: "image", src: "bg.png" }, { type: "solid", color: "#fff" }] },
      ],
    };
    const srcs = collectImageSrcs([node]);
    expect(srcs.has("bg.png")).toBe(true);
  });

  test("CSS 导出：url + cover/contain 尺寸口径", () => {
    const node: DesignNode = { id: "r", type: "rect", name: "卡", x: 0, y: 0, w: 100, h: 50, fills: [{ type: "image", src: "pic.png" }] };
    const css = nodeToCss(node);
    expect(css).toContain('url("pic.png")');
    expect(css).toContain("cover");
  });

  test("序列化往返幂等", () => {
    const node: DesignNode = { id: "r", type: "rect", name: "卡", x: 0, y: 0, w: 100, h: 50, fills: [{ type: "image", src: "pic.png", scaleMode: "fit", opacity: 0.8 }] };
    // 先经 parse 规范化（strokes 等缺省字段补齐），再断言单次往返稳定
    const doc = parseDesignDoc(JSON.stringify({ pages: [{ id: "p1", nodes: [node] }] })).doc;
    const once = serializeDoc(doc);
    expect(serializeDoc(parseDesignDoc(once).doc)).toBe(once);
  });
});

describe("蒙版", () => {
  const img: DesignNode = { id: "img", type: "rect", name: "图", x: 0, y: 0, w: 100, h: 100, fills: [{ type: "solid", color: "#ff0000" }] };
  const mask: DesignNode = { id: "m", type: "ellipse", name: "蒙", x: 10, y: 10, w: 60, h: 60, mask: true, fills: [{ type: "solid", color: "#ffffff" }] };
  const after: DesignNode = { id: "b", type: "rect", name: "后", x: 0, y: 0, w: 100, h: 100, fills: [{ type: "solid", color: "#0000ff" }] };

  test("解析：mask 布尔与字符串", () => {
    const r = parseDesignDoc(JSON.stringify({ pages: [{ id: "p1", nodes: [{ id: "m", type: "rect", x: 0, y: 0, w: 10, h: 10, mask: "true" }] }] }));
    expect(r.doc.pages[0]!.nodes[0]?.mask).toBe(true);
    const r2 = parseDesignDoc(JSON.stringify({ pages: [{ id: "p1", nodes: [{ id: "m", type: "rect", x: 0, y: 0, w: 10, h: 10, mask: false }] }] }));
    expect(r2.doc.pages[0]!.nodes[0]?.mask).toBeUndefined();
  });

  test("SVG：蒙版之后的兄弟被裁剪；之前的兄弟不受影响；蒙版自身不绘制", () => {
    const svg = buildSvg(docOf([img, mask, after]), ["img", "m", "b"], svgOpts)!.svg;
    expect(svg).toContain("<clipPath id=\"m1\"><ellipse transform=\"translate(10 10)\" cx=\"30\" cy=\"30\" rx=\"30\" ry=\"30\"/></clipPath>");
    // b 在裁剪组内
    const clipIdx = svg.indexOf('<g clip-path="url(#m1)">');
    const bIdx = svg.indexOf("#0000ff");
    const closeIdx = svg.indexOf("</g></g>", clipIdx);
    expect(clipIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(clipIdx);
    expect(bIdx).toBeLessThan(closeIdx);
    // img（蒙版之前的兄弟）不在裁剪组内
    expect(svg.indexOf("#ff0000")).toBeLessThan(clipIdx);
    // 蒙版自身不被绘制（其白色填充不作为普通图形出现两次：只在 clipPath 定义里）
    expect(svg.indexOf("#ffffff")).toBe(-1); // clipPath 几何无 paint
  });

  test("隐藏的蒙版跳过；多蒙版嵌套成交集", () => {
    const hiddenMask: DesignNode = { ...mask, visible: false };
    const svg1 = buildSvg(docOf([img, hiddenMask, after]), ["img", "m", "b"], svgOpts)!.svg;
    expect(svg1).not.toContain("clip-path=\"url(#m");

    const mask2: DesignNode = { id: "m2", type: "rect", name: "蒙2", x: 0, y: 0, w: 50, h: 50, mask: true };
    const svg2 = buildSvg(docOf([img, mask, mask2, after]), ["img", "m", "m2", "b"], svgOpts)!.svg;
    expect(svg2).toContain("clip-path=\"url(#m1)\"");
    expect(svg2).toContain("clip-path=\"url(#m2)\"");
    // 嵌套：m2 的裁剪组开在 m1 之内
    expect(svg2.indexOf('<g clip-path="url(#m2)">')).toBeGreaterThan(svg2.indexOf('<g clip-path="url(#m1)">'));
  });

  test("序列化往返幂等（mask: true 保留）", () => {
    const doc = parseDesignDoc(
      JSON.stringify({
        pages: [
          {
            id: "p1",
            nodes: [
              img,
              { ...mask, visible: undefined },
              after,
            ],
          },
        ],
      }),
    ).doc;
    const once = serializeDoc(doc);
    expect(serializeDoc(parseDesignDoc(once).doc)).toBe(once);
    expect(once).toContain('"mask": true');
  });
});
