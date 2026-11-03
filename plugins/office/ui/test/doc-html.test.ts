/**
 * 文档 → HTML 导出测试：标题层级、行内样式（粗/斜/下划线/字号/颜色/字体）、
 * 段落偏移与 run 裁剪、HTML 转义、空文档兜底、24 位色值转换。
 * 解析规则与 skills/doc 的机械约定同源（\r 分段、结尾 \r\n）。
 */
import { describe, expect, test } from "bun:test";
import { docToHtml, rgbIntToHex } from "../src/doc/html";

const snapshot = {
  title: "季度方案",
  body: {
    dataStream: "季度方案\r\r一、背景\r今年聚焦增长。\r\n",
    paragraphs: [
      { startIndex: 0, paragraphStyle: { namedStyleType: 2 } },
      { startIndex: 5 },
      { startIndex: 6, paragraphStyle: { namedStyleType: 4 } },
      { startIndex: 11 },
    ],
    textRuns: [
      { st: 6, ed: 10, ts: { bl: 1 } }, // 一、背景 加粗
      { st: 12, ed: 14, ts: { cl: { rgb: 0xff0000 } } }, // 上半年 红色（偏移在段内验证用）
      { st: 16, ed: 18, ts: { fs: 20, it: 1, ul: 1, ff: "Georgia" } }, // 增长 字号/斜/下划线/字体
    ],
  },
};

describe("docToHtml", () => {
  test("标题层级映射：namedStyleType 2→h1、4→h2", () => {
    const html = docToHtml(snapshot);
    expect(html).toContain('<h1 class="title">季度方案</h1>');
    expect(html).toContain('<h2 class="heading-1">');
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>季度方案</title>");
  });

  test("行内样式：加粗/颜色/字号/斜体/下划线/字体按 run 偏移切分", () => {
    const html = docToHtml(snapshot);
    expect(html).toContain('<span style="font-weight:700">一、背景</span>');
    expect(html).toContain("color:#ff0000");
    expect(html).toContain("font-size:20px");
    expect(html).toContain("font-style:italic");
    expect(html).toContain("text-decoration:underline");
    expect(html).toContain("font-family:Georgia");
    // 未覆盖样式的片段保持裸文本
    expect(html).toContain("焦增");
  });

  test("空段落保留为空行；空文档有兜底", () => {
    const html = docToHtml(snapshot);
    expect(html).toContain("<p><br></p>");
    const empty = docToHtml({ title: "空", body: { dataStream: "\r\n", paragraphs: [{ startIndex: 0 }] } });
    expect(empty).toContain("<p><br></p>");
    expect(docToHtml({})).toContain("<title>未命名文档</title>");
  });

  test("HTML 转义：正文里的标签/引号不会注入", () => {
    const html = docToHtml({
      title: "<b>危险</b>",
      body: { dataStream: 'alert("<script>")&x\r\n', paragraphs: [{ startIndex: 0 }], textRuns: [] },
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;");
    expect(html).toContain("&amp;");
    expect(html).toContain("<title>&lt;b&gt;危险&lt;/b&gt;</title>");
  });

  test("rgbIntToHex：24 位整数 → #rrggbb", () => {
    expect(rgbIntToHex(0xff0000)).toBe("#ff0000");
    expect(rgbIntToHex(0x00ff00)).toBe("#00ff00");
    expect(rgbIntToHex(0x123456)).toBe("#123456");
  });

  test("跨段落边界的 run 被按段裁剪", () => {
    // 两段：AB / CD，run 覆盖 B..C（跨 \r），各段只拿到自己范围内的样式
    const html = docToHtml({
      title: "t",
      body: {
        dataStream: "AB\rCD\r\n",
        paragraphs: [{ startIndex: 0 }, { startIndex: 3 }],
        textRuns: [{ st: 1, ed: 4, ts: { bl: 1 } }],
      },
    });
    expect(html).toContain('<span style="font-weight:700">B</span>');
    expect(html).toContain('<span style="font-weight:700">C</span>');
    expect(html).not.toContain('<span style="font-weight:700">BC');
  });
});
