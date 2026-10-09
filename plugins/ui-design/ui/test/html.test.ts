/**
 * HTML 原型导出测试：分页过滤、屏与热点进载荷、跨屏死链降级、运行时内联、转义。
 *
 * 导出产物不再是"每屏一段 HTML 由静态脚本切显示"，而是
 * 「JSON 载荷 + 内联的 prototypeRuntime 源码」——预览与导出跑同一份运行时，
 * 因此这里的断言集中在载荷内容与内联完整性上。
 * measure 注入假实现，不依赖 DOM。
 */
import { describe, expect, test } from "bun:test";
import { parseDesignDoc } from "../src/doc";
import { docToPrototypeHtml } from "../src/html";
import { prototypeRuntime } from "../src/prototype-runtime";
import type { RuntimePayload } from "../src/prototype-runtime";
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

/** 从导出产物里取出载荷 JSON（与浏览器里运行时读的是同一段） */
function payloadOf(html: string): RuntimePayload {
  const m = /<script type="application\/json" id="payload">([\s\S]*?)<\/script>/.exec(html);
  expect(m).not.toBeNull();
  // JSON 里的 `\u003c` 由 JSON.parse 自己还原（写进 HTML 时转义是为了防 </script> 提前收尾）
  return JSON.parse(m![1]!) as RuntimePayload;
}

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

  test("每块顶层画板 = 一节：屏 id/名称/尺寸齐全，SVG 铺满容器", async () => {
    const html = (await docToPrototypeHtml(doc, { measure }))!;
    const p = payloadOf(html);
    expect(p.screens.map((s) => s.id)).toEqual(["f1", "f2"]);
    expect(p.screens[0]).toMatchObject({ id: "f1", name: "f1", w: 300, h: 600 });
    expect(p.start).toBe("f1");
    expect(p.screens[0]!.svg).toContain('width="100%" height="100%"'); // 硬尺寸已替换
    expect(p.screens[0]!.svg).not.toMatch(/<svg[^>]* width="300"/);
    expect(html).toContain("<title>T&lt;&gt;&amp; · 原型</title>");
  });

  test("运行时源码内联：与面板预览用的是同一个函数", async () => {
    const html = (await docToPrototypeHtml(doc, { measure }))!;
    expect(html).toContain("uir");
    expect(html).toContain(prototypeRuntime.toString());
    expect(html).toContain("uir-hot"); // 运行时样式在
  });

  test("热点进载荷：盒坐标与解析后的动作；死链单独记录不执行", async () => {
    const html = (await docToPrototypeHtml(doc, { measure }))!;
    const p = payloadOf(html);
    const hs = p.hotspots["f1"]!;
    const btn = hs.find((h) => h.nodeId === "btn")!;
    expect(btn.box).toEqual({ x: 20, y: 500, w: 260, h: 56 });
    expect(btn.actions).toHaveLength(1);
    expect(btn.actions[0]).toMatchObject({
      trigger: "tap",
      action: "navigate",
      target: "f2",
      targetName: "f2",
      transition: "pushLeft", // 缺省转场已填好
      duration: 300,
    });
    const dead = hs.find((h) => h.nodeId === "dead")!;
    expect(dead.actions).toEqual([]);
    expect(dead.dead).toEqual([{ trigger: "tap", action: "navigate", to: "nope" }]);
    // f2 的返回热点保留
    expect(p.hotspots["f2"]![0]!.actions[0]!.target).toBe("f1");
  });

  test("pageId 只导当前页：跨页跳转降级为死链（点了不会静默无反应）", async () => {
    const html = (await docToPrototypeHtml(doc, { measure, pageId: "pB" }))!;
    const p = payloadOf(html);
    expect(p.screens.map((s) => s.id)).toEqual(["f2"]);
    const back = p.hotspots["f2"]![0]!;
    expect(back.actions).toEqual([]);
    expect(back.dead[0]).toMatchObject({ action: "navigate", to: "f1" });
  });

  test("危险名称不会逃出 JSON 载荷（`</script>` 已被转义）", async () => {
    const evil = wrap([
      { id: "p", name: "P", nodes: [frame("f1", [rect("b", { name: '"><script>alert(1)</script>', onTap: { to: "f1" } })], { name: "<b>&" })] },
    ]);
    const html = (await docToPrototypeHtml(evil, { measure }))!;
    expect(html).not.toContain('"><script>');
    expect(html).not.toContain("</script>alert");
    const p = payloadOf(html);
    expect(p.screens[0]!.name).toBe("<b>&");
    expect(p.hotspots["f1"]![0]!.name).toBe('"><script>alert(1)</script>');
  });
});
