import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInside, isWithinAnyRoots, realResolve, resolveToolPath } from "../src";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return realResolve(dir);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("isInside", () => {
  test("子路径、自身、父路径与 .. 的判定", () => {
    const root = tempDir("pi-paths-");
    expect(isInside(root, join(root, "a", "b"))).toBe(true);
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, join(root, "..", "sibling"))).toBe(false);
    expect(isInside(root, "/etc/passwd")).toBe(false);
  });
});

describe("realResolve", () => {
  test("新建文件的路径按存在的祖先解析", () => {
    const root = tempDir("pi-paths-new-");
    const nested = join(root, "does", "not", "exist", "file.ts");
    expect(realResolve(nested)).toBe(nested);
  });

  if (process.platform !== "win32") {
    test("符号链接解析到真实目标", () => {
      const root = tempDir("pi-paths-link-");
      const outside = tempDir("pi-paths-link-out-");
      writeFileSync(join(outside, "file.ts"), "x");
      mkdirSync(join(root, "dir"));
      symlinkSync(outside, join(root, "dir", "escape"));
      expect(realResolve(join(root, "dir", "escape", "file.ts"))).toBe(
        join(outside, "file.ts"),
      );
    });
  }
});

describe("resolveToolPath / isWithinAnyRoots", () => {
  test("相对路径按 cwd 解析，空格不被吃掉", () => {
    const cwd = tempDir("pi-paths-cwd-");
    expect(resolveToolPath(cwd, "src/a.ts")).toBe(join(cwd, "src", "a.ts"));
    expect(resolveToolPath(cwd, " src/a.ts ")).toBe(join(cwd, " src", "a.ts "));
  });

  test("多个根任一命中", () => {
    const rootA = tempDir("pi-paths-a-");
    const rootB = tempDir("pi-paths-b-");
    expect(isWithinAnyRoots(join(rootB, "x"), [rootA, rootB])).toBe(true);
    expect(isWithinAnyRoots(join(rootA, "..", "x"), [rootA, rootB])).toBe(false);
  });
});
