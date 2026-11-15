import { describe, expect, it } from "bun:test";
import { INBOX_SUMMARY_LIMIT, safePreview } from "../../src/inbox/summary";

describe("inbox safePreview", () => {
  it("压空白并截断到上限", () => {
    const text = safePreview("a\n\n  b   c");
    expect(text).toBe("a b c");
    expect(safePreview("长".repeat(500)).length).toBe(INBOX_SUMMARY_LIMIT);
  });

  it("打码 sk- / Bearer / KEY= 形状", () => {
    const text = safePreview("sk-abcdefghijklmnop Bearer abc.def KEY=secret123");
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).not.toContain("abc.def");
    expect(text).not.toContain("secret123");
    expect(text).toContain("sk-***");
    expect(text).toContain("Bearer ***");
    expect(text).toContain("KEY=***");
  });

  it("对象优先取常见可读字段", () => {
    expect(safePreview({ command: "npm run build", other: "x" })).toBe("npm run build");
    expect(safePreview({ file_path: "/tmp/a.ts" })).toBe("/tmp/a.ts");
  });

  it("打码 GitHub/AWS/JWT 形状", () => {
    const text = safePreview(
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789 AKIAIOSFODNN7EXAMPLE " +
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456",
    );
    expect(text).not.toContain("ghp_abcdef");
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).not.toContain("eyJhbGci");
    expect(text).toContain("gh*_***");
    expect(text).toContain("AKIA***");
    expect(text).toContain("[jwt]");
  });

  it("长 base64 块替换为占位符", () => {
    const text = safePreview(`before ${"A".repeat(120)} after`);
    expect(text).toContain("[base64]");
    expect(text).not.toContain("A".repeat(120));
  });
});
