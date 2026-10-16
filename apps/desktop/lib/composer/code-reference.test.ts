import { describe, expect, it } from "bun:test";
import {
  buildCodeDirective,
  expandCodeDirectives,
  formatCodeReference,
  formatCodeReferencePath,
  parseCodeDirectiveId,
  toWorkspaceRelative,
} from "./code-reference";

describe("代码引用（「引用到对话」）", () => {
  describe("formatCodeReference", () => {
    it("相对路径 + 行范围 → @path (lines N-M)", () => {
      expect(
        formatCodeReference({ path: "src/foo.ts", startLine: 11, endLine: 16 }),
      ).toBe("@src/foo.ts (lines 11-16)");
    });

    it("单行 → (line N)", () => {
      expect(
        formatCodeReference({ path: "src/foo.ts", startLine: 12, endLine: 12 }),
      ).toBe("@src/foo.ts (line 12)");
    });

    it("带空格/绝对路径 → 反引号包裹（提及正则不吃带空格的裸路径）", () => {
      expect(
        formatCodeReference({
          path: "my dir/a b.ts",
          startLine: 3,
          endLine: 4,
        }),
      ).toBe("`my dir/a b.ts` (lines 3-4)");
      expect(formatCodeReferencePath("/abs/x.ts")).toBe("`/abs/x.ts`");
    });
  });

  describe("buildCodeDirective ↔ 展开", () => {
    const ref = { path: "migrations/0001_init.sql", startLine: 11, endLine: 16 };

    it("芯片序列化格式与库的 formatter 同源", () => {
      expect(buildCodeDirective(ref)).toBe(
        ":code[migrations/0001_init.sql:11-16]{name=code:migrations/0001_init.sql:11-16}",
      );
    });

    it("回环：芯片文本展开回引用串", () => {
      expect(expandCodeDirectives(buildCodeDirective(ref))).toBe(
        formatCodeReference(ref),
      );
    });

    it("混合文本：芯片展开、其它指令与正文原样保留", () => {
      const text = `看看这个 ${buildCodeDirective(ref)} 怎么改 :skill[网页搜索]{name=skill:web} 顺带看看`;
      expect(expandCodeDirectives(text)).toBe(
        "看看这个 @migrations/0001_init.sql (lines 11-16) 怎么改 :skill[网页搜索]{name=skill:web} 顺带看看",
      );
    });

    it("手打的 :code[path:12]（无 name 属性）也能展开", () => {
      expect(expandCodeDirectives(":code[src/foo.ts:12]")).toBe(
        "@src/foo.ts (line 12)",
      );
    });

    it("解析不了 / 无芯片 → 一字不动", () => {
      expect(expandCodeDirectives("普通消息")).toBe("普通消息");
      expect(expandCodeDirectives(":code[乱七八糟]")).toBe(":code[乱七八糟]");
    });
  });

  describe("parseCodeDirectiveId", () => {
    it("带不带 code: 前缀都能解析；单行/范围两种", () => {
      expect(parseCodeDirectiveId("code:src/a.ts:11-16")).toEqual({
        path: "src/a.ts",
        startLine: 11,
        endLine: 16,
      });
      expect(parseCodeDirectiveId("src/a.ts:7")).toEqual({
        path: "src/a.ts",
        startLine: 7,
        endLine: 7,
      });
    });

    it("路径含冒号（Windows 盘符）从右侧切", () => {
      expect(parseCodeDirectiveId("code:C:/proj/a.ts:3-4")).toEqual({
        path: "C:/proj/a.ts",
        startLine: 3,
        endLine: 4,
      });
    });

    it("无行号/无路径 → null", () => {
      expect(parseCodeDirectiveId("code:src/a.ts")).toBe(null);
      expect(parseCodeDirectiveId(":12")).toBe(null);
    });
  });

  describe("路径折算", () => {
    it("工作目录下的路径折算相对，目录外原样返回", () => {
      expect(toWorkspaceRelative("/w/proj/src/a.ts", "/w/proj")).toBe("src/a.ts");
      expect(toWorkspaceRelative("/other/a.ts", "/w/proj")).toBe("/other/a.ts");
      expect(toWorkspaceRelative("/w/proj/src/a.ts", "/w/proj/")).toBe("src/a.ts");
      expect(toWorkspaceRelative("/w/proj/src/a.ts", null)).toBe("/w/proj/src/a.ts");
    });
  });
});
