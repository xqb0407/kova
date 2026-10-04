import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classify, parseNumstat, unquotePath } from "../src/protocol/handlers/git";

/** 在临时仓库里跑真 git，验证我们解析的正是真实输出形状（不是脑补的格式） */
function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kova-git-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  git(["add", "."]);
  git(["commit", "-qm", "init"]);
  return dir;
}

describe("git 面板解析", () => {
  test("porcelain 状态归类", () => {
    expect(classify("M", " ")).toBe("M");
    expect(classify(" ", "M")).toBe("M");
    expect(classify("A", " ")).toBe("A");
    expect(classify("?", "?")).toBe("?");
    expect(classify("D", " ")).toBe("D");
    expect(classify("R", " ")).toBe("R");
  });

  test("带引号路径还原（空格/中文）", () => {
    expect(unquotePath('"a b.txt"')).toBe("a b.txt");
    expect(unquotePath('"\\u4e2d"'.replace("\\u4e2d", "中"))).toBe("中");
    expect(unquotePath("plain.txt")).toBe("plain.txt");
  });

  test("numstat 解析（含二进制 - -）", () => {
    const map = parseNumstat("12\t3\tsrc/a.ts\n-\t-\timg.png\n");
    expect(map.get("src/a.ts")).toEqual({ added: 12, removed: 3 });
    expect(map.get("img.png")).toEqual({ added: 0, removed: 0 });
  });

  test("真实仓库：status + numstat + 未跟踪文件", () => {
    const dir = makeRepo();
    try {
      const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
      writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
      writeFileSync(path.join(dir, "new file.txt"), "x\n");
      const status = git(["status", "--porcelain=v1", "-uall"]);
      const lines = status.split("\n").filter(Boolean);
      const parsed = lines.map((line) => {
        const x = line[0]!;
        const y = line[1]!;
        let rest = line.slice(3);
        if (x === "R" || x === "C") {
          const arrow = rest.lastIndexOf(" -> ");
          if (arrow !== -1) rest = rest.slice(arrow + 4);
        }
        return { path: unquotePath(rest), status: classify(x, y), untracked: x === "?" && y === "?" };
      });
      expect(parsed.find((f) => f.path === "a.txt")?.status).toBe("M");
      expect(parsed.find((f) => f.path === "new file.txt")?.untracked).toBe(true);
      const stats = parseNumstat(git(["diff", "--numstat", "HEAD"]));
      expect(stats.get("a.txt")).toEqual({ added: 1, removed: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("真实仓库：git diff HEAD 输出可被 hunk 头定位", () => {
    const dir = makeRepo();
    try {
      const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
      writeFileSync(path.join(dir, "a.txt"), "one\ntwo changed\n");
      const diff = git(["diff", "HEAD", "--no-color", "--unified=3", "--", "a.txt"]);
      expect(diff).toContain("@@ -1,2 +1,2 @@");
      expect(diff).toContain("-two");
      expect(diff).toContain("+two changed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
