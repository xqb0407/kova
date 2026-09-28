/**
 * HTML 原型导出测试：屏切分（顶层画板/分页过滤）、SVG 铺容器、热点链接与死链剔除、
 * 名称转义。measure 注入假实现，不依赖 DOM。
 */
import { describe, expect, test } from "bun:test";
import { parseDesignDoc } from "../src/doc";
import { docToPrototypeHtml } from "../src/html";
import type { MeasureFn } from "../src/leafer/scene";

const measure: MeasureFn = (text, fontCss) => {
  const size = parseFloat(fontCss.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? "16") || 16;
  return { width: text.length * size * 0.5, ascent: size * 0.8, descent: size * 0.2 };
};

const rect = (id: string, over: Record<string, unknown> = {}) => ({ id, type: "rect", x: 0, y: 0, w: 100, h: 40, ...over });
const frame = (id: string, children: unknown[] = [], over: Record<string, unknown> = {}) => ({
  id,
  type: "frame",
  x: 0,
  y: 0,
  w: 300,
  h: 600,
  name: id,
  children,
  ...over,
});
const build = (json: unknown) => parseDesignDoc(JSON.stringify(json)).doc;
const wrap = (pages: unknown[], activePage = "pA") =>
  build({ version: 1, meta: { name: "T<>&" }, activePage, pages });

const doc = wrap([
  { id: "pA", name: "A", nodes: [frame("f1", [rect("btn", { x: 20, y: 500, w: 260, h: 56, name: "按钮", onTap: { to: "f2" } }), rect("dead", { onTap: { to: "nope" } })])] },
  { id: "pB", name: "B", nodes: [frame("f2", [rect("back", { onTap: { to: "f1" }, name: "返回" })])] },
]);

describe("docToPrototypeHtml", () => {
  test("无顶层画板 → null", async () => {
    const empty = wrap([{ id: "p", name: "P", nodes: [rect("r")] }]);
    expect(await docToPrototypeHtml(empty, { measure })).toBeNull();
    // 画板嵌在组里不算屏
    const nested = wrap([{ id: "p", name: "P", nodes: [{ id: "g", type: "group", children: [frame("fx")] }] }]);
    expect(await docToPrototypeHtml(nested, { measure })).toBeNull();
  });

  test("每个顶层画板一节：id/尺寸/铺满 SVG；HTML 骨架与转义", async () => {
    const html = (await docToPrototypeHtml(doc, { measure }))!;
    expect(html).toContain('<section class="sc" id="s-f1" data-name="f1" style="width:300px;height:600px"');
    expect(html).toContain('id="s-f2"');
    expect(html).toContain('width="100%" height="100%"'); // 硬尺寸已替换
    expect(html).not.toMatch(/<svg[^>]* width="300"/);
    expect(html).toContain("<title>T&lt;&gt;&amp; · 原型</title>");
    expect(html).toContain("hashchange"); // 路由脚本在
    expect(html).toContain('href="#s-f2"');
  });

  test("热点 → <a>：盒坐标/标题映射；死链被剔除", async () => {
    const html = (await docToPrototypeHtml(doc, { measure }))!;
    const a = /<a class="hot" href="#s-f2" title="按钮 → f2" style="([^"]*)"\/?>/.exec(html);
    expect(a).not.toBeNull();
    expect(a![1]).toContain("left:20px");
    expect(a![1]).toContain("top:500px");
    expect(a![1]).toContain("width:260px");
    expect(html).not.toContain("#s-nope"); // 死链目标不出链接
    expect(html).toContain('href="#s-f1"'); // f2 的返回热点保留
  });

  test("pageId 只导当前页，跨页链接一并剔除", async () => {
    const html = (await docToPrototypeHtml(doc, { measure, pageId: "pB" }))!;
    expect(html).toContain('id="s-f2"');
    expect(html).not.toContain('id="s-f1"');
    expect(html).not.toContain('href="#s-f1"'); // 跳去 A 页的热点被过滤
  });

  test("危险名称全链路转义", async () => {
    const evil = wrap([
      { id: "p", name: "P", nodes: [frame("f1", [rect("b", { name: '"><script>' , onTap: { to: "f1" } })], { name: "<b>&" })] },
    ]);
    const html = (await docToPrototypeHtml(evil, { measure }))!;
    expect(html).toContain('data-name="&lt;b&gt;&amp;"');
    expect(html).toContain('title="&quot;&gt;&lt;script&gt; → &lt;b&gt;&amp;"');
    expect(html).not.toContain('"><script>'); // 原始串不允许出现在属性位
  });
});
