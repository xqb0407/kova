import { describe, expect, test } from "bun:test";
import { filterPatchSections } from "../main/git-patch";

/**
 * 检查点 patch 的按路径裁剪：逐文件回滚复用结算刻存档的整轮 patch，
 * 只取目标文件的段再 `apply -R`。解析必须扛住 rename 与含空格路径，
 * 且不能把相似后缀（dir/b.ts vs b.ts）误命中。
 */

const PATCH = [
  "diff --git a/a.ts b/a.ts",
  "index 1111111..2222222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1 +1 @@",
  "-old a",
  "+new a",
  "diff --git a/dir/b.ts b/dir/b.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/dir/b.ts",
  "@@ -0,0 +1 @@",
  "+hello",
  "diff --git a/old name c.ts b/new name c.ts",
  "similarity index 90%",
  "rename from old name c.ts",
  "rename to new name c.ts",
].join("\n");

describe("filterPatchSections", () => {
  test("按路径取段：只含目标文件，不带其它文件的 hunk", () => {
    const out = filterPatchSections(PATCH, ["dir/b.ts"])!.toString("utf8");
    expect(out).toContain("diff --git a/dir/b.ts b/dir/b.ts");
    expect(out).toContain("+hello");
    expect(out).not.toContain("a/a.ts");
    expect(out).not.toContain("new name c.ts");
  });

  test("rename 段：新旧路径都能命中", () => {
    expect(
      filterPatchSections(PATCH, ["new name c.ts"])!.toString("utf8"),
    ).toContain("rename to new name c.ts");
    expect(
      filterPatchSections(PATCH, ["old name c.ts"])!.toString("utf8"),
    ).toContain("rename from old name c.ts");
  });

  test("相似后缀不误命中（b.ts ≠ dir/b.ts）", () => {
    expect(filterPatchSections(PATCH, ["b.ts"])).toBeNull();
  });

  test("无命中/空路径返回 null（调用方按「该文件当时无改动」处理）", () => {
    expect(filterPatchSections(PATCH, ["nope.ts"])).toBeNull();
    expect(filterPatchSections(PATCH, [])).toBeNull();
  });

  test("多路径合并为一份 patch（整轮撤销前的批量逐文件回滚）", () => {
    const out = filterPatchSections(PATCH, ["a.ts", "dir/b.ts"])!.toString("utf8");
    expect(out).toContain("b/a.ts");
    expect(out).toContain("b/dir/b.ts");
    expect(out).not.toContain("new name c.ts");
  });
});
