import { describe, expect, it } from "bun:test";
import { readNoteIcon, setNoteIcon } from "./note-icon";

describe("note icon frontmatter", () => {
  it("读取已有图标（含引号）", () => {
    expect(readNoteIcon("---\nicon: 🚀\ntitle: A\n---\n正文")).toBe("🚀");
    expect(readNoteIcon("---\nicon: \"🚀\"\n---\n正文")).toBe("🚀");
    expect(readNoteIcon("---\ntitle: A\n---\n正文")).toBeNull();
    expect(readNoteIcon("正文")).toBeNull();
  });

  it("没有 frontmatter 时补一个最小块", () => {
    expect(setNoteIcon("正文", "📝")).toBe("---\nicon: 📝\n---\n\n正文");
  });

  it("已有其它元数据时只插入/替换 icon 行", () => {
    const text = "---\ntitle: A\ntags: [x]\n---\n\n正文";
    const withIcon = setNoteIcon(text, "🔥");
    expect(withIcon).toContain("title: A");
    expect(withIcon).toContain("tags: [x]");
    expect(readNoteIcon(withIcon)).toBe("🔥");

    const replaced = setNoteIcon(withIcon, "🚀");
    expect(readNoteIcon(replaced)).toBe("🚀");
    expect((replaced.match(/^icon:/gm) ?? []).length).toBe(1);
  });

  it("移除图标但保留其它字段", () => {
    const text = "---\ntitle: A\nicon: 🚀\n---\n\n正文";
    const next = setNoteIcon(text, null);
    expect(next).not.toContain("icon:");
    expect(next).toContain("title: A");
    expect(next.endsWith("\n\n正文")).toBe(true);
  });

  it("移除最后一个字段时连空 frontmatter 一起删掉", () => {
    expect(setNoteIcon("---\nicon: 🚀\n---\n\n正文", null)).toBe("正文");
  });

  it("保留 CRLF frontmatter 的换行风格", () => {
    const text = "---\r\ntitle: A\r\n---\r\n\r\n正文";
    const next = setNoteIcon(text, "📌");
    expect(next).toContain("title: A\r\nicon: 📌");
    expect(readNoteIcon(next)).toBe("📌");
  });
});
