import { describe, expect, it } from "bun:test";
import {
  buildCodeCommentText,
  normalizeDiffLineSelection,
} from "./code-comment";

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

  describe("buildCodeCommentText", () => {
    const ref = { path: "src/foo.ts", startLine: 11, endLine: 16 };

    it("芯片 + 空格 + 评论正文", () => {
      expect(buildCodeCommentText(ref, "这段为什么要这样写？")).toBe(
        ":code[src/foo.ts:11-16]{name=code:src/foo.ts:11-16} 这段为什么要这样写？",
      );
    });

    it("评论首尾空白裁掉；空评论只保留芯片", () => {
      expect(buildCodeCommentText(ref, "  换个写法  ")).toBe(
        ":code[src/foo.ts:11-16]{name=code:src/foo.ts:11-16} 换个写法",
      );
      expect(buildCodeCommentText(ref, "   ")).toBe(
        ":code[src/foo.ts:11-16]{name=code:src/foo.ts:11-16}",
      );
    });

    it("删除侧引用：芯片 id 带 :old，评论正文照常追加", () => {
      expect(
        buildCodeCommentText(
          { path: "src/foo.ts", startLine: 11, endLine: 12, deleted: true },
          "这行删得对吗",
        ),
      ).toBe(
        ":code[src/foo.ts:11-12]{name=code:src/foo.ts:11-12:old} 这行删得对吗",
      );
    });
  });
});
