import { describe, expect, it } from "bun:test";
import { deriveNoteTitle, normalizeNoteTags } from "./library-note-meta";

describe("normalizeNoteTags", () => {
  it("去 #（含其后空格）、空格转 -、小写、去重", () => {
    expect(
      normalizeNoteTags(["# 123", "123", "-123", "##  Project Docs", "ideas"]),
    ).toEqual(["123", "project-docs", "ideas"]);
  });

  it("折叠/去首尾连字符：`# 123` 不再变成 `-123`", () => {
    expect(normalizeNoteTags(["# 123"])).toEqual(["123"]);
    expect(normalizeNoteTags(["--x--"])).toEqual(["x"]);
    expect(normalizeNoteTags(["a  b"])).toEqual(["a-b"]);
  });

  it("空/纯符号丢弃，限数 20", () => {
    expect(normalizeNoteTags(["", "  ", "###"])).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => `tag-${i}`);
    expect(normalizeNoteTags(many)).toHaveLength(20);
  });
});

describe("deriveNoteTitle", () => {
  it("优先 Markdown 标题，其次首行正文，最后文件名", () => {
    expect(deriveNoteTitle("# Auth approach\n\nbody", "a.md")).toBe(
      "Auth approach",
    );
    expect(deriveNoteTitle("第一行正文\n第二行", "a.md")).toBe("第一行正文");
    expect(deriveNoteTitle("\n\n", "my-note.md")).toBe("my-note");
  });
});
