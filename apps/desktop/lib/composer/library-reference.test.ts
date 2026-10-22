import { describe, expect, it } from "bun:test";
import {
  buildLibraryContext,
  buildLibraryDirective,
  buildLibraryDirectiveId,
  formatLibraryReference,
  joinFsPath,
  parseLibraryDirectiveId,
  rememberLibraryNoteBody,
  rememberLibraryNoteTags,
  removeLibraryDirectives,
  sanitizeDirectiveLabel,
  setMissingLibraryRefIds,
} from "./library-reference";

describe("资料库引用（「引用到对话」）", () => {
  describe("buildLibraryDirectiveId ↔ parseLibraryDirectiveId", () => {
    it("回环：rel / absPath / 无行号", () => {
      const ref = {
        rel: "notes/周报.md",
        name: "周报",
        absPath: "/Users/me/library/notes/周报.md",
      };
      const id = buildLibraryDirectiveId(ref);
      expect(id.startsWith("library:")).toBe(true);
      expect(parseLibraryDirectiveId(id)).toEqual({
        rel: ref.rel,
        absPath: ref.absPath,
      });
    });

    it("行号：单行与区间", () => {
      const single = buildLibraryDirectiveId({
        rel: "a.md",
        name: "a",
        absPath: "/l/a.md",
        startLine: 12,
        endLine: 12,
      });
      expect(single.endsWith("#L12")).toBe(true);
      expect(parseLibraryDirectiveId(single)).toEqual({
        rel: "a.md",
        absPath: "/l/a.md",
        startLine: 12,
        endLine: 12,
      });

      const range = buildLibraryDirectiveId({
        rel: "a.md",
        name: "a",
        absPath: "/l/a.md",
        startLine: 12,
        endLine: 20,
      });
      expect(range.endsWith("#L12-20")).toBe(true);
      expect(parseLibraryDirectiveId(range)).toEqual({
        rel: "a.md",
        absPath: "/l/a.md",
        startLine: 12,
        endLine: 20,
      });
    });

    it("路径含 `]` `}` `#` `%` `:` 与中文都安全", () => {
      const ref = {
        rel: "notes/周 报[1]#2}.md",
        name: "周 报[1]",
        absPath: "C:\\Users\\me\\lib 100%\\周 报[1]#2}.md",
      };
      const id = buildLibraryDirectiveId(ref);
      expect(id).not.toContain("]");
      expect(parseLibraryDirectiveId(id)).toEqual({
        rel: ref.rel,
        absPath: ref.absPath,
      });
    });

    it("非法输入 → null", () => {
      expect(parseLibraryDirectiveId("")).toBe(null);
      expect(parseLibraryDirectiveId("library:only-one")).toBe(null);
      expect(parseLibraryDirectiveId("code:src/a.ts:12")).toBe(null);
      expect(parseLibraryDirectiveId("library:rel%2Fa.md:%2Fl%2Fa.md#Labc")).toBe(null);
      expect(parseLibraryDirectiveId("library:rel%2Fa.md:%2Fl%2Fa.md#L20-12")).toBe(null);
    });
  });

  describe("buildLibraryDirective ↔ 发送上下文", () => {
    const ref = {
      rel: "notes/周报.md",
      name: "周报",
      absPath: "/Users/me/library/notes/周报.md",
      startLine: 12,
      endLine: 20,
    };

    it("芯片序列化与库的 formatter 同源（label 带行号）", () => {
      const chip = buildLibraryDirective(ref);
      expect(chip.startsWith(":library[周报:12-20]{name=library:")).toBe(true);
    });

    it("芯片原样保留，路径行进隐藏上下文（用户气泡看到芯片）", () => {
      const chip = buildLibraryDirective(ref);
      const lines = buildLibraryContext(chip);
      expect(lines).toBe(
        formatLibraryReference({
          rel: ref.rel,
          absPath: ref.absPath,
          startLine: 12,
          endLine: 20,
        }),
      );
      // 文本本身未被改写：芯片留在正文里
      expect(chip).toContain(":library[周报:12-20]");
    });

    it("混合文本：只收集资料库芯片，代码/技能指令不掺和", () => {
      const chip = buildLibraryDirective(ref);
      const text = `看下 ${chip} 和 :code[src/a.ts:3]{name=code:src/a.ts:3} 以及 :skill[网页搜索]{name=skill:web}`;
      const lines = buildLibraryContext(text);
      expect(lines).toContain("[资料库笔记] notes/周报.md");
      expect(lines).toContain("(lines 12-20)");
      expect(lines).not.toContain("src/a.ts");
      expect(lines).not.toContain("网页搜索");
    });

    it("无芯片/解析不了 → null", () => {
      expect(buildLibraryContext("普通消息")).toBe(null);
      expect(buildLibraryContext(":library[乱七八糟]")).toBe(null);
    });
  });

  describe("笔记正文内联", () => {
    it("缓存命中 → 不入 refs 行，回调交出正文块（含标题与来源路径）", () => {
      const ref = {
        rel: "notes/inline.md",
        name: "Inline",
        absPath: "/l/notes/inline.md",
      };
      const chip = buildLibraryDirective(ref);
      rememberLibraryNoteBody(
        ref.absPath,
        "Inline Note",
        "# Inline Note\n\n正文内容。",
      );
      const blocks: string[] = [];
      const lines = buildLibraryContext(chip, (block) => blocks.push(block));
      expect(lines).toBe(null);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toContain('Referenced note "Inline Note"');
      expect(blocks[0]).toContain("`/l/notes/inline.md`");
      expect(blocks[0]).toContain("正文内容。");
    });

    it("无缓存 → 不回调（退回路径行）", () => {
      const ref = {
        rel: "notes/no-cache.md",
        name: "No cache",
        absPath: "/l/notes/no-cache.md",
      };
      const chip = buildLibraryDirective(ref);
      const blocks: string[] = [];
      const lines = buildLibraryContext(chip, (block) => blocks.push(block));
      expect(blocks).toHaveLength(0);
      expect(lines).toContain("[资料库笔记] notes/no-cache.md");
    });

    it("选区引用只内联选中的行（不再把整篇灌进去）", () => {
      const ref = {
        rel: "notes/lines.md",
        name: "lines",
        absPath: "/l/notes/lines.md",
        startLine: 2,
        endLine: 3,
      };
      const chip = buildLibraryDirective(ref);
      rememberLibraryNoteBody(
        ref.absPath,
        "Lines",
        "第一行\n第二行\n第三行\n第四行",
      );
      const blocks: string[] = [];
      const lines = buildLibraryContext(chip, (block) => blocks.push(block));
      expect(lines).toBe(null);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toContain("lines 2-3");
      expect(blocks[0]).toContain("第二行");
      expect(blocks[0]).toContain("第三行");
      expect(blocks[0]).not.toContain("第一行");
      expect(blocks[0]).not.toContain("第四行");
    });

    it("单篇超过 8KB → 退回路径引用，不内联", () => {
      const ref = {
        rel: "notes/big.md",
        name: "big",
        absPath: "/l/notes/big.md",
      };
      const chip = buildLibraryDirective(ref);
      rememberLibraryNoteBody(
        ref.absPath,
        "Big",
        "x".repeat(9 * 1024),
      );
      const blocks: string[] = [];
      const lines = buildLibraryContext(chip, (block) => blocks.push(block));
      expect(blocks).toHaveLength(0);
      expect(lines).toContain("[资料库笔记] notes/big.md");
    });

    it("单条消息内联总预算 24KB：超出的笔记退回路径引用", () => {
      const body = "y".repeat(7 * 1024);
      const chips: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const ref = {
          rel: `notes/budget-${i}.md`,
          name: `budget-${i}`,
          absPath: `/l/notes/budget-${i}.md`,
        };
        rememberLibraryNoteBody(ref.absPath, ref.name, body);
        chips.push(buildLibraryDirective(ref));
      }
      const blocks: string[] = [];
      const lines = buildLibraryContext(chips.join(" "), (block) =>
        blocks.push(block),
      );
      // 7KB × 3 = 21KB 在预算内；第 4 篇超出 24KB → 路径引用
      expect(blocks).toHaveLength(3);
      expect(lines).toContain("[资料库笔记] notes/budget-3.md");
    });

    it("标签随引用交给模型：内联块 Tags 行 / 路径行后缀", () => {
      const inlineRef = {
        rel: "notes/tagged-inline.md",
        name: "tagged-inline",
        absPath: "/l/notes/tagged-inline.md",
      };
      rememberLibraryNoteBody(inlineRef.absPath, "Tagged", "正文");
      rememberLibraryNoteTags(inlineRef.absPath, ["api", "设计"]);
      const blocks: string[] = [];
      const lines = buildLibraryContext(
        buildLibraryDirective(inlineRef),
        (block) => blocks.push(block),
      );
      expect(lines).toBe(null);
      expect(blocks[0]).toContain("Tags: #api #设计");

      const pathRef = {
        rel: "notes/tagged-path.md",
        name: "tagged-path",
        absPath: "/l/notes/tagged-path.md",
      };
      rememberLibraryNoteTags(pathRef.absPath, ["x"]);
      const pathLines = buildLibraryContext(
        buildLibraryDirective(pathRef),
        () => {},
      );
      expect(pathLines).toContain("[Tags: #x]");
    });

    it("缺失优先于内联：已删除的文件即使有旧缓存也不内联", () => {
      const ref = {
        rel: "notes/gone-inline.md",
        name: "Gone",
        absPath: "/l/notes/gone-inline.md",
      };
      const id = buildLibraryDirectiveId(ref);
      const chip = buildLibraryDirective(ref);
      rememberLibraryNoteBody(ref.absPath, "Gone", "旧正文");
      setMissingLibraryRefIds(new Set([id]));
      const blocks: string[] = [];
      const lines = buildLibraryContext(chip, (block) => blocks.push(block));
      expect(lines).toContain("[资料库文件已删除]");
      expect(blocks).toHaveLength(0);
      setMissingLibraryRefIds(new Set());
    });
  });

  describe("缺失安全网", () => {
    it("命中缺失集合 → 输出已删除标记而不是死路径", () => {
      const ref = {
        rel: "notes/gone.md",
        name: "gone",
        absPath: "/l/notes/gone.md",
      };
      const chip = buildLibraryDirective(ref);
      setMissingLibraryRefIds(new Set([buildLibraryDirectiveId(ref)]));
      const lines = buildLibraryContext(chip);
      expect(lines).toContain("[资料库文件已删除] notes/gone.md");
      expect(lines).not.toContain("`/l/notes/gone.md`");
      setMissingLibraryRefIds(new Set());
      expect(buildLibraryContext(chip)).toBe(
        "[资料库笔记] notes/gone.md → `/l/notes/gone.md`",
      );
    });
  });

  describe("removeLibraryDirectives", () => {
    const make = (rel: string, abs: string) =>
      buildLibraryDirective({ rel, name: rel, absPath: abs });

    it("只删命中的芯片，保留正文与其它指令", () => {
      const a = make("a.md", "/l/a.md");
      const b = make("b.md", "/l/b.md");
      const text = `总结 ${a} 和 ${b} 谢谢 :skill[网页搜索]{name=skill:web}`;
      const cleaned = removeLibraryDirectives(text, new Set([buildLibraryDirectiveId({ rel: "a.md", name: "a.md", absPath: "/l/a.md" })]));
      expect(cleaned).not.toContain("a.md");
      expect(cleaned).toContain(b);
      expect(cleaned).toContain(":skill[网页搜索]{name=skill:web}");
      expect(cleaned.startsWith("总结")).toBe(true);
    });

    it("整条消息只有芯片 → 清空", () => {
      const chip = make("a.md", "/l/a.md");
      expect(removeLibraryDirectives(chip, new Set([buildLibraryDirectiveId({ rel: "a.md", name: "a.md", absPath: "/l/a.md" })]))).toBe("");
    });

    it("无命中 → 一字不动", () => {
      const text = "普通消息";
      expect(removeLibraryDirectives(text, new Set(["library:x:y"]))).toBe(text);
    });
  });

  describe("sanitizeDirectiveLabel", () => {
    it("替换会截断 formatter 的字符", () => {
      expect(sanitizeDirectiveLabel("报[1].md")).toBe("报(1).md");
      expect(sanitizeDirectiveLabel("a\nb")).toBe("a b");
      expect(sanitizeDirectiveLabel("  ")).toBe("file");
    });
  });

  describe("joinFsPath", () => {
    it("POSIX / Windows / 混合分隔符", () => {
      expect(joinFsPath("/Users/me/library", "notes/a.md")).toBe(
        "/Users/me/library/notes/a.md",
      );
      expect(joinFsPath("/Users/me/library/", "/notes/a.md")).toBe(
        "/Users/me/library/notes/a.md",
      );
      expect(joinFsPath("C:\\Users\\me\\library", "notes\\a.md")).toBe(
        "C:\\Users\\me\\library\\notes\\a.md",
      );
      expect(joinFsPath("C:\\Users\\me\\library", "notes/a.md")).toBe(
        "C:\\Users\\me\\library\\notes\\a.md",
      );
    });
  });
});
