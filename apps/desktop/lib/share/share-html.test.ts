import { describe, expect, test } from "bun:test";
import type { ShareDoc } from "./share-doc";
import { buildShareHtml } from "./share-html";
import { docToMarkdown } from "./share-markdown";

const doc: ShareDoc = {
  title: "排查 <script> 问题",
  createdAt: new Date(2026, 9, 22, 14, 30).getTime(),
  messages: [
    {
      id: "u1",
      role: "user",
      quote: "上一轮的结论",
      blocks: [{ kind: "text", markdown: "帮我看下这段：payload" }],
    },
    {
      id: "a1",
      role: "assistant",
      incomplete: true,
      blocks: [
        { kind: "reasoning", markdown: "先读代码" },
        { kind: "text", markdown: "```ts\nconst a = 1;\n```\n\n结论如下" },
        { kind: "tool", name: "bash", failed: true },
        {
          kind: "image",
          src: "data:image/png;base64,AAA",
          alt: "截图",
        },
      ],
    },
  ],
};

/** 测试环境没有 DOM（DOMPurify 不可用），注入可观测的桩 */
const sanitize = (html: string): string => html.replaceAll("payload", "SANITIZED");

describe("buildShareHtml", () => {
  test("输出完整自包含文档：标题转义、消息与页脚", () => {
    const html = buildShareHtml(doc, {}, sanitize);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("排查 &lt;script&gt; 问题");
    expect(html).not.toContain("<script>");
    expect(html).toContain("由 扣瓦 生成");
    expect(html).toContain("2 条消息");
    expect(html).toContain("回复未完成");
  });

  test("注入应用主题令牌，缺省回落浅色默认值", () => {
    const html = buildShareHtml(
      doc,
      { tokens: { "--background": "#111111", "--muted": "#222222" }, colorScheme: "dark" },
      sanitize,
    );
    expect(html).toContain("color-scheme:dark");
    expect(html).toContain("--background:#111111");
    expect(html).toContain("--muted:#222222");
    // 未提供的令牌保留默认值
    expect(html).toContain("--primary:oklch(0.205 0 0)");
  });

  test("代码块渲染成 App 同款卡片（muted 外卡 + 语言标签 + 代码体）", () => {
    const html = buildShareHtml(doc, {}, sanitize);
    expect(html).toContain('class="code-card"');
    expect(html).toContain('class="code-lang">ts<');
    expect(html).toContain("<pre><code>const a = 1;");
  });

  test("用户气泡内含引用块；Markdown 片段经过注入的 sanitizer", () => {
    const html = buildShareHtml(doc, {}, sanitize);
    expect(html).toContain('class="quote"');
    expect(html).toContain("上一轮的结论");
    expect(html).toContain("SANITIZED");
    expect(html).not.toContain("payload");
  });

  test("思考过程弱化块与失败工具标记", () => {
    const html = buildShareHtml(doc, {}, sanitize);
    expect(html).toContain('class="reasoning"');
    expect(html).toContain("思考过程");
    expect(html).toContain("tool-failed");
    expect(html).toContain("失败");
  });
});

describe("docToMarkdown", () => {
  test("标题、角色、引用、工具与图片占位", () => {
    const markdown = docToMarkdown(doc);
    expect(markdown).toContain("# 排查 <script> 问题");
    expect(markdown).toContain("## 你");
    expect(markdown).toContain("## 助手");
    expect(markdown).toContain("> 上一轮的结论");
    expect(markdown).toContain("**思考过程**");
    expect(markdown).toContain("- 工具：bash（失败）");
    expect(markdown).toContain("_[图片：截图]_");
    expect(markdown).toContain("（回复未完成）");
    // data URL 不塞进剪贴板文本
    expect(markdown).not.toContain("data:image");
  });
});
