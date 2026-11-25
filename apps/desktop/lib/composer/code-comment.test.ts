import { describe, expect, it } from "bun:test";
import {
  buildCodeCommentChip,
  expandCodeCommentDirectives,
  normalizeDiffLineSelection,
} from "./code-comment";
import {
  createCodeCommentEntry,
  getCodeComment,
  putCodeComment,
  removeCodeComment,
} from "./code-comment-store";

describe("代码行评论", () => {
  describe("normalizeDiffLineSelection", () => {
    it("additions 侧：保留行范围、不标删除", () => {
      expect(
        normalizeDiffLineSelection({ start: 5, end: 5, side: "additions" }),
      ).toEqual({ startLine: 5, endLine: 5 });
      expect(
        normalizeDiffLineSelection({ start: 9, end: 4, side: "additions" }),
      ).toEqual({ startLine: 4, endLine: 9 });
    });

    it("无 side（File 模式）按 additions 处理", () => {
      expect(normalizeDiffLineSelection({ start: 3, end: 7 })).toEqual({
        startLine: 3,
        endLine: 7,
      });
    });

    it("deletions 侧：标 deleted，行号按旧文件", () => {
      expect(
        normalizeDiffLineSelection({ start: 8, end: 10, side: "deletions" }),
      ).toEqual({ startLine: 8, endLine: 10, deleted: true });
    });

    it("跨旧/新两侧：退回单侧单行，避免混用行号", () => {
      expect(
        normalizeDiffLineSelection({
          start: 12,
          end: 8,
          side: "additions",
          endSide: "deletions",
        }),
      ).toEqual({ startLine: 12, endLine: 12 });
      expect(
        normalizeDiffLineSelection({
          start: 8,
          end: 12,
          side: "deletions",
          endSide: "additions",
        }),
      ).toEqual({ startLine: 12, endLine: 12 });
    });
  });

  describe("评论芯片 ↔ 发送展开", () => {
    it("芯片只携带 id + 预览；发送展开成引用 + 完整正文", () => {
      const entry = createCodeCommentEntry(
        { path: "src/foo.ts", startLine: 11, endLine: 12 },
        "换个写法\n因为 [x] 会慢",
      );
      putCodeComment(entry);
      try {
        const chip = buildCodeCommentChip(entry);
        expect(chip).toContain(":comment[src/foo.ts:11-12 · 换个写法 因为 x 会慢]");
        expect(chip).toContain(`{name=comment:${entry.id}}`);
        expect(expandCodeCommentDirectives(chip, getCodeComment)).toBe(
          "@src/foo.ts (lines 11-12)\n换个写法\n因为 [x] 会慢",
        );
      } finally {
        removeCodeComment(entry.id);
      }
    });

    it("删除侧：展开带 deleted 行号语义", () => {
      const entry = createCodeCommentEntry(
        { path: "src/foo.ts", startLine: 7, endLine: 7, deleted: true },
        "这行删除的理由？",
      );
      putCodeComment(entry);
      try {
        expect(
          expandCodeCommentDirectives(buildCodeCommentChip(entry), getCodeComment),
        ).toBe("@src/foo.ts (deleted line 7)\n这行删除的理由？");
      } finally {
        removeCodeComment(entry.id);
      }
    });

    it("store 丢失时 label 前缀仍能还原引用（不把内部 token 发给模型）", () => {
      expect(
        expandCodeCommentDirectives(
          ":comment[src/foo.ts:7-8 · 旧预览]{name=comment:missing}",
          () => undefined,
        ),
      ).toBe("@src/foo.ts (lines 7-8)");
    });
  });
});
