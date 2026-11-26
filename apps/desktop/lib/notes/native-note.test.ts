import { describe, expect, it } from "bun:test";
import {
  createNativeNote,
  emptyNativeBlocks,
  nativeNoteBaseName,
  parseNativeNote,
  serializeNativeNote,
  withNativeNotePatch,
} from "./native-note";

describe("native note codec", () => {
  it("创建空笔记并往返序列化", () => {
    const note = createNativeNote({
      title: "  周报  ",
      tags: ["ops", " ops ", ""],
      icon: "📝",
    });
    expect(note.title).toBe("周报");
    expect(note.tags).toEqual(["ops"]);
    expect(note.blocks).toEqual(emptyNativeBlocks());
    expect(note.version).toBe(1);

    const parsed = parseNativeNote(serializeNativeNote(note));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.note.id).toBe(note.id);
    expect(parsed.note.title).toBe("周报");
    expect(parsed.note.icon).toBe("📝");
    expect(parsed.note.blocks).toEqual(note.blocks);
  });

  it("拒绝损坏 JSON / 未知格式 / 未来版本", () => {
    expect(parseNativeNote("{").ok).toBe(false);
    expect(
      parseNativeNote(JSON.stringify({ format: "other", version: 1 })).ok,
    ).toBe(false);

    const note = createNativeNote({ title: "A" });
    const future = { ...note, version: 99 };
    const parsed = parseNativeNote(JSON.stringify(future));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("unsupported-version");
  });

  it("保留 Markdown 兼容缓存和 frontmatter", () => {
    const note = createNativeNote({
      title: "A",
      blocks: [{ type: "p", children: [{ text: "正文" }] }],
      markdown: "正文\n",
      frontmatter: "---\ntags: [x]\n---\n",
    });
    const parsed = parseNativeNote(serializeNativeNote(note));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.note.markdown).toBe("正文\n");
    expect(parsed.note.frontmatter).toBe("---\ntags: [x]\n---\n");
  });

  it("补丁更新 updatedAt 且归一化标签", () => {
    const note = createNativeNote({ title: "A", tags: ["a"] });
    const patched = withNativeNotePatch(note, {
      title: "B",
      tags: [" b ", "b", ""],
    });
    expect(patched.title).toBe("B");
    expect(patched.tags).toEqual(["b"]);
    expect(patched.createdAt).toBe(note.createdAt);
    expect(patched.updatedAt >= note.updatedAt).toBe(true);
  });

  it("文件名安全化", () => {
    expect(nativeNoteBaseName("a/b:c*d?.md")).toBe("a-b-c-d-.md");
    expect(nativeNoteBaseName("   ")).toBe("未命名");
    expect(nativeNoteBaseName("...hidden")).toBe("hidden");
  });
});
