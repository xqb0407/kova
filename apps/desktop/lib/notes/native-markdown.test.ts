import { describe, expect, it } from "bun:test";
import { createPlateEditor } from "platejs/react";
import { PLATE_PLUGINS } from "@/components/files/plate-editor/plugins";
import {
  markdownFromNativeValue,
  nativeNoteFromMarkdown,
} from "./native-markdown";
import { parseNativeNote, serializeNativeNote } from "./native-note";

describe("native note from markdown", () => {
  it("把 Markdown 转成可解析的 native envelope", () => {
    const note = nativeNoteFromMarkdown({
      title: "迁移测试",
      tags: ["ops"],
      markdown: `---
title: 旧标题
---

# 迁移测试

- 第一项
- 第二项

| A | B |
| --- | --- |
| 1 | 2 |
`,
    });
    expect(note.title).toBe("迁移测试");
    expect(note.tags).toEqual(["ops"]);
    expect(note.frontmatter).toContain("title: 旧标题");
    expect(note.markdown).toContain("# 迁移测试");
    expect(note.markdown.startsWith("---")).toBe(false);
    expect(note.blocks.length).toBeGreaterThan(0);
    expect(note.blocks.some((block) => "type" in block && block.type === "table")).toBe(true);

    const parsed = parseNativeNote(serializeNativeNote(note));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.note.blocks).toEqual(note.blocks);
  });
});

describe("native → markdown 降级", () => {
  it("callout/toggle/分栏按内容展开，不丢正文", () => {
    const editor = createPlateEditor({ plugins: PLATE_PLUGINS });
    const markdown = markdownFromNativeValue(editor, [
      {
        type: "callout",
        icon: "💡",
        children: [{ type: "p", children: [{ text: "提示内容" }] }],
      },
      {
        type: "toggle",
        title: "折叠标题",
        open: true,
        children: [{ type: "p", children: [{ text: "折叠正文" }] }],
      },
      {
        type: "column_group",
        children: [
          { type: "column", children: [{ type: "p", children: [{ text: "左栏" }] }] },
          { type: "column", children: [{ type: "p", children: [{ text: "右栏" }] }] },
        ],
      },
    ]);
    expect(markdown).toContain("> 提示内容");
    expect(markdown).toContain("**折叠标题**");
    expect(markdown).toContain("折叠正文");
    expect(markdown).toContain("左栏");
    expect(markdown).toContain("右栏");
    expect(markdown).not.toContain("column_group");
  });
});

describe("导入 frontmatter 标签", () => {
  it("无显式 tags 时从 YAML flow/block 提取", () => {
    const flow = nativeNoteFromMarkdown({
      title: "A",
      markdown: '---\ntags: ["ops", "api"]\n---\n\n正文\n',
    });
    expect(flow.tags).toEqual(["ops", "api"]);

    const block = nativeNoteFromMarkdown({
      title: "B",
      markdown: "---\ntags:\n  - ops\n  - api\n---\n\n正文\n",
    });
    expect(block.tags).toEqual(["ops", "api"]);
  });
});
