import { describe, expect, it } from "bun:test";
import {
  buildNoteMarkdown,
  noteTitleFromText,
  projectFolderFor,
} from "./library-save-note";

describe("noteTitleFromText", () => {
  it("优先取首个 Markdown 标题并剥掉修饰", () => {
    expect(noteTitleFromText("前言\n\n# **Auth** 方案\n正文")).toBe("Auth 方案");
  });

  it("没有标题时取首个非空正文行", () => {
    expect(noteTitleFromText("\n\n第一行正文\n第二行")).toBe("第一行正文");
  });

  it("空内容回退到默认标题", () => {
    expect(noteTitleFromText(" \n\t\n")).toBe("未命名笔记");
    expect(noteTitleFromText("", "自定义")).toBe("自定义");
  });

  it("代码围栏不作为标题", () => {
    expect(noteTitleFromText("```ts\nconst a = 1\n```")).toBe("const a = 1");
  });
});

describe("projectFolderFor", () => {
  it("按项目目录名分文件夹", () => {
    expect(projectFolderFor("/Users/me/Desktop/kova-electron")).toBe(
      "项目/kova-electron",
    );
    expect(projectFolderFor("C:\\work\\demo\\")).toBe("项目/demo");
  });

  it("没有 cwd 时落收件箱", () => {
    expect(projectFolderFor(null)).toBe("收件箱");
    expect(projectFolderFor("")).toBe("收件箱");
    expect(projectFolderFor("/")).toBe("收件箱");
  });

  it("目录名里的非法字符被替换", () => {
    expect(projectFolderFor("/work/a:b*c")).toBe("项目/a-b-c");
  });
});

describe("buildNoteMarkdown", () => {
  it("写入 frontmatter 与原文（YAML 值转义）", () => {
    const markdown = buildNoteMarkdown(
      {
        title: 'He said "hi"',
        tags: ["#API Design", "api-design"],
        sourceSessionId: "s-1",
        sourceCwd: "/work/demo",
        createdAt: new Date(2026, 10, 5),
      },
      "# 正文\n\n保留 **Markdown**。\n",
    );
    expect(markdown.startsWith("---\n")).toBe(true);
    expect(markdown).toContain('title: "He said \\"hi\\""');
    expect(markdown).toContain('tags: ["api-design"]');
    expect(markdown).toContain('source_session: "s-1"');
    expect(markdown).toContain('source_cwd: "/work/demo"');
    expect(markdown).toContain("created: 2026-11-05");
    expect(markdown).toContain("\n---\n\n# 正文");
    expect(markdown).toContain("保留 **Markdown**。");
  });

  it("没有来源字段时不写空行", () => {
    const markdown = buildNoteMarkdown({ title: "T" }, "body");
    expect(markdown).not.toContain("source_session");
    expect(markdown).not.toContain("source_cwd");
    expect(markdown).not.toContain("tags:");
  });
});
