import { describe, expect, it } from "bun:test";
import {
  checkRichMarkdown,
  joinEditorMarkdown,
  resolveRichImageSrc,
  splitEditorMarkdown,
} from "./rich-markdown";

describe("splitEditorMarkdown", () => {
  it("没有 frontmatter 时整段都是正文", () => {
    const parts = splitEditorMarkdown("# 标题\n\n正文");
    expect(parts.hasFrontmatter).toBe(false);
    expect(parts.raw).toBe("");
    expect(parts.body).toBe("# 标题\n\n正文");
  });

  it("保留 frontmatter 原文（含换行）", () => {
    const text = "---\ntitle: 会议\ncreated: 2026-01-01\n---\n# 正文\n";
    const parts = splitEditorMarkdown(text);
    expect(parts.hasFrontmatter).toBe(true);
    expect(parts.raw).toBe("---\ntitle: 会议\ncreated: 2026-01-01\n---\n");
    expect(parts.body).toBe("# 正文\n");
    expect(joinEditorMarkdown(parts.raw, parts.body)).toBe(text);
  });

  it("CRLF 与 BOM 不改写元数据块", () => {
    const text = "\uFEFF---\r\ntitle: A\r\n---\r\nbody\r\n";
    const parts = splitEditorMarkdown(text);
    expect(parts.raw).toBe("\uFEFF---\r\ntitle: A\r\n---\r\n");
    expect(parts.body).toBe("body\r\n");
    expect(joinEditorMarkdown(parts.raw, parts.body)).toBe(text);
  });

  it("开头 --- 只是水平线时不误判", () => {
    const text = "---\n不是键值\n---\n正文";
    const parts = splitEditorMarkdown(text);
    expect(parts.hasFrontmatter).toBe(false);
    expect(parts.raw).toBe("");
    expect(parts.body).toBe(text);
  });

  it("闭合后直接 EOF 的 frontmatter 仍能拼回", () => {
    const text = "---\ntitle: A\n---";
    const parts = splitEditorMarkdown(text);
    expect(parts.raw).toBe(text);
    expect(joinEditorMarkdown(parts.raw, "正文")).toBe(
      "---\ntitle: A\n---\n正文",
    );
  });
});

describe("checkRichMarkdown", () => {
  it("放行常见 Markdown 结构", () => {
    const text = [
      "---",
      "title: 周报",
      "---",
      "# 本周",
      "",
      "- 一",
      "- [ ] 待办",
      "",
      "> 引用",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "```html",
      "<div>代码里的 HTML 不算裸 HTML</div>",
      "```",
      "",
      "[链接](https://example.com/a<b>)",
    ].join("\n");
    expect(checkRichMarkdown(text)).toEqual({ ok: true });
  });

  it("无法解析的 frontmatter 退回源码（防止 --- 被当水平线）", () => {
    expect(checkRichMarkdown("---\n不是键值\n---\n正文")).toEqual({
      ok: false,
      reason: "frontmatter",
    });
    // 正常 frontmatter 仍放行（正文里没有未解析块）
    expect(
      checkRichMarkdown("---\ntitle: A\n---\n正文"),
    ).toEqual({ ok: true });
  });

  it("裸 HTML 退回源码", () => {
    expect(checkRichMarkdown("正文\n\n<details>内容</details>")).toEqual({
      ok: false,
      reason: "html",
    });
    expect(checkRichMarkdown("<!-- 注释 -->")).toEqual({
      ok: false,
      reason: "html",
    });
    expect(checkRichMarkdown("第一行<br>第二行")).toEqual({ ok: true });
  });

  it("脚注与引用式链接退回源码", () => {
    expect(checkRichMarkdown("正文[^1]\n\n[^1]: 注释")).toEqual({
      ok: false,
      reason: "footnote",
    });
    expect(checkRichMarkdown("[文字][ref]\n\n[ref]: https://x.test")).toEqual({
      ok: false,
      reason: "reference-link",
    });
  });

  it("被截断或超大内容退回源码", () => {
    expect(checkRichMarkdown("# A", { truncated: true })).toEqual({
      ok: false,
      reason: "truncated",
    });
    expect(checkRichMarkdown("a".repeat(200_001))).toEqual({
      ok: false,
      reason: "size",
    });
  });
});

describe("resolveRichImageSrc", () => {
  const cwd = "/tmp/library";

  it("远程/数据 URL 原样返回", () => {
    expect(resolveRichImageSrc(cwd, "a.md", "https://x.test/a.png")).toBe(
      "https://x.test/a.png",
    );
    expect(resolveRichImageSrc(cwd, "a.md", "data:image/png;base64,AAA")).toBe(
      "data:image/png;base64,AAA",
    );
  });

  it("根目录笔记的相对图片按笔记目录解析", () => {
    expect(resolveRichImageSrc(cwd, "a.md", "assets/a.png")).toBe(
      "assets/a.png",
    );
  });

  it("嵌套笔记支持 ../ 且归一化", () => {
    expect(
      resolveRichImageSrc(cwd, "项目/kova/note.md", "../img/./a.png"),
    ).toBe("项目/img/a.png");
    expect(resolveRichImageSrc(cwd, "项目/note.md", "/assets/a.png")).toBe(
      "assets/a.png",
    );
  });

  it("保留查询串/锚点", () => {
    expect(resolveRichImageSrc(cwd, "a.md", "assets/a.png?v=1#x")).toBe(
      "assets/a.png?v=1#x",
    );
  });

  it("百分号编码的路径先还原再解析", () => {
    expect(resolveRichImageSrc(cwd, "a.md", "assets/my%20image.png")).toBe(
      "assets/my image.png",
    );
  });
});
