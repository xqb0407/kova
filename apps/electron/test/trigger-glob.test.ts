import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  globToRegExp,
  isIgnored,
  isWithin,
  matchesAny,
  summarizeChangedFiles,
  toPosixRelative,
  watchRootFor,
} from "../main/trigger-glob";

const WS = "/tmp/ws";

describe("文件触发器 glob（L1b）", () => {
  test("**/ 跨段且可吞零段", () => {
    const re = globToRegExp("src/**/*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/x/y.ts")).toBe(true);
    expect(re.test("lib/a.ts")).toBe(false);
    expect(globToRegExp("**/*.md").test("README.md")).toBe(true);
    expect(globToRegExp("**/*.md").test("docs/a/b.md")).toBe(true);
  });

  test("* 段内不跨 /；? 单字符", () => {
    expect(globToRegExp("*.md").test("a.md")).toBe(true);
    expect(globToRegExp("*.md").test("docs/a.md")).toBe(false);
    expect(globToRegExp("file?.ts").test("file1.ts")).toBe(true);
    expect(globToRegExp("file?.ts").test("file12.ts")).toBe(false);
  });

  test("正则元字符按字面匹配", () => {
    expect(globToRegExp("a.b").test("a.b")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
    expect(globToRegExp("(x)+[y].ts").test("(x)+[y].ts")).toBe(true);
  });

  test("watchRootFor：取 glob 的静态前缀目录", () => {
    expect(watchRootFor(WS, "src/**/*.ts")).toBe(resolve(WS, "src"));
    expect(watchRootFor(WS, "*.md")).toBe(resolve(WS));
    expect(watchRootFor(WS, "docs/a.md")).toBe(resolve(WS, "docs"));
    expect(watchRootFor(WS, "packages/x/src/**")).toBe(resolve(WS, "packages/x/src"));
  });

  test("忽略规则：依赖/版本库/agent 产物目录", () => {
    expect(isIgnored("src/index.ts")).toBe(false);
    expect(isIgnored("node_modules/x/index.js")).toBe(true);
    expect(isIgnored(".git/HEAD")).toBe(true);
    expect(isIgnored(".kova/checkpoints/x")).toBe(true);
    expect(isIgnored("apps/desktop/out/a.js")).toBe(true);
    expect(isIgnored("my-build/file.ts")).toBe(false);
  });

  test("变更摘要：相对路径 + 截断计数", () => {
    const files = Array.from({ length: 7 }, (_, i) => join(WS, "src", `f${i}.ts`));
    expect(summarizeChangedFiles(WS, files.slice(0, 2))).toBe(
      "2 file(s) changed: src/f0.ts, src/f1.ts",
    );
    const many = summarizeChangedFiles(WS, files);
    expect(many).toContain("7 file(s) changed:");
    expect(many).toContain("…2 more");
    expect(toPosixRelative(WS, join(WS, "a", "b.ts"))).toBe("a/b.ts");
  });

  test("watch 根必须在 workspace 内（绝对路径/.. 逃逸被拦）", () => {
    expect(isWithin(WS, resolve(WS, "src"))).toBe(true);
    expect(isWithin(WS, WS)).toBe(true);
    expect(isWithin(WS, "/etc")).toBe(false);
    expect(isWithin(WS, resolve(WS, ".."))).toBe(false);
    expect(watchRootFor(WS, "../outside/**")).toBe(resolve(WS, "..", "outside"));
    expect(isWithin(WS, watchRootFor(WS, "../outside/**"))).toBe(false);
    expect(isWithin(WS, watchRootFor(WS, "/etc/**"))).toBe(false);
  });

  test("matchesAny 多模式任一命中", () => {
    const patterns = ["src/**/*.ts", "docs/**/*.md"].map(globToRegExp);
    expect(matchesAny(patterns, "docs/guide/a.md")).toBe(true);
    expect(matchesAny(patterns, "src/a.ts")).toBe(true);
    expect(matchesAny(patterns, "lib/a.ts")).toBe(false);
  });
});
