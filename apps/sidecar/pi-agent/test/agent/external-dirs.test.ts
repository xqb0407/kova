/**
 * 会话外部目录（agent/external-dirs）：准入校验、提示词块与跨目录搜索。
 * 校验是纯函数（除 realpath 外零 I/O 语义），这里把「能被绕过」的方向也钉住。
 */
import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  externalDirsOverlap,
  externalDirsPromptBlock,
  externalSkillNames,
  findFilesInExternalDir,
  MAX_EXTERNAL_DIRS,
  resolveExternalPath,
  searchExternalDirs,
  validateExternalDir,
} from "../../src/agent/external-dirs";

const root = mkdtempSync(join(tmpdir(), "external-dirs-"));
const cwd = join(root, "workspace");
const ext = join(root, "shared-lib");
const extNested = join(ext, "src");
const other = join(root, "other");
mkdirSync(cwd, { recursive: true });
mkdirSync(extNested, { recursive: true });
mkdirSync(other, { recursive: true });
writeFileSync(join(ext, "AGENTS.md"), "external rules");
writeFileSync(join(ext, "src", "a.ts"), "export const a = 1;");
writeFileSync(join(ext, "src", "b.test.ts"), "test");
writeFileSync(join(other, "c.ts"), "c");
mkdirSync(join(ext, "node_modules", "pkg"), { recursive: true });
writeFileSync(join(ext, "node_modules", "pkg", "hidden.ts"), "x");
mkdirSync(join(ext, ".hidden"), { recursive: true });
writeFileSync(join(ext, ".hidden", "hidden.ts"), "x");
symlinkSync(join(other, "c.ts"), join(ext, "link.ts"));
mkdirSync(join(ext, ".agents", "skills", "ext-skill"), { recursive: true });
writeFileSync(
  join(ext, ".agents", "skills", "ext-skill", "SKILL.md"),
  "---\nname: ext-skill\ndescription: d\n---\nbody",
);

describe("validateExternalDir", () => {
  test("合法目录：realpath + label", () => {
    const r = validateExternalDir(ext, { cwd, existing: [] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.absolutePath).toBe(resolveExternalPath(ext, cwd));
      expect(r.label).toBe("shared-lib");
    }
  });

  test("相对路径按 cwd 解析", () => {
    const r = validateExternalDir("../other", { cwd, existing: [] });
    expect(r.ok).toBe(true);
  });

  test("不存在 / 空路径 / 指向文件", () => {
    expect(validateExternalDir(join(root, "nope"), { cwd, existing: [] }).ok).toBe(false);
    expect(validateExternalDir("   ", { cwd, existing: [] }).ok).toBe(false);
    expect(validateExternalDir(join(ext, "AGENTS.md"), { cwd, existing: [] }).ok).toBe(false);
  });

  test("与工作区重叠（内部 / 父目录）都拒绝", () => {
    expect(validateExternalDir(join(cwd), { cwd, existing: [] }).ok).toBe(false);
    expect(validateExternalDir(root, { cwd, existing: [] }).ok).toBe(false);
  });

  test("与已加目录重叠拒绝；同一路径也按重叠处理（调用方先短路幂等）", () => {
    const existing = [{ path: ext, label: "shared-lib" }];
    expect(
      validateExternalDir(join(ext, "src"), { cwd, existing }).ok,
    ).toBe(false);
    expect(validateExternalDir(ext, { cwd, existing }).ok).toBe(false);
  });

  test("数量上限", () => {
    const existing = Array.from({ length: MAX_EXTERNAL_DIRS }, (_, i) => ({
      path: join(root, `d${i}`),
      label: `d${i}`,
    }));
    const r = validateExternalDir(other, { cwd, existing });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(String(MAX_EXTERNAL_DIRS));
  });

  test("externalDirsOverlap：前缀相似的兄弟目录不算重叠", () => {
    expect(externalDirsOverlap("/a/project", "/a/project-x")).toBe(false);
    expect(externalDirsOverlap("/a/project", "/a/project/src")).toBe(true);
  });
});

describe("externalDirsPromptBlock", () => {
  test("无目录 = 空串（默认提示词字节不变）", () => {
    expect(externalDirsPromptBlock([])).toBe("");
  });

  test("带项目主目录时点明配置根", () => {
    const block = externalDirsPromptBlock(
      [{ path: ext, label: "shared-lib" }],
      "/work/main",
    );
    expect(block).toContain("The project's main folder is `/work/main`");
    expect(block).toContain(".kova configuration");
  });

  test("优先 AGENTS.md，并带目录标题与正文", () => {
    const block = externalDirsPromptBlock([{ path: ext, label: "shared-lib" }]);
    expect(block).toContain("## Project Folders (additional code repositories)");
    expect(block).toContain("### shared-lib");
    expect(block).toContain("external rules");
    expect(block).not.toContain("CLAUDE.md (from");
  });

  test("CLAUDE.md 回退与 .claude/CLAUDE.md 回退", () => {
    const dir = join(root, "claude-only");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "CLAUDE.md"), "claude rules");
    const block = externalDirsPromptBlock([{ path: dir, label: "claude-only" }]);
    expect(block).toContain("claude rules");
    expect(block).toContain("CLAUDE.md (from claude-only)");
  });

  test("超长指令保头截断", () => {
    const dir = join(root, "big");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "x".repeat(20_000));
    const block = externalDirsPromptBlock([{ path: dir, label: "big" }]);
    expect(block).toContain("[truncated");
    expect(block.length).toBeLessThan(17_500);
  });

  test("缺失目录保留占位说明", () => {
    const missing = join(root, "gone");
    const block = externalDirsPromptBlock([{ path: missing, label: "gone" }]);
    expect(block).toContain("### gone");
    expect(block).toContain("[unavailable: directory does not exist]");
  });
});

describe("findFilesInExternalDir / searchExternalDirs", () => {
  test("basename glob 只匹配文件名，跳过 node_modules / 隐藏目录 / 符号链接", async () => {
    const files = await findFilesInExternalDir(ext, "*.ts", 50);
    const names = files.map((f) => f.slice(ext.length + 1)).sort();
    expect(names).toEqual(["src/a.ts", "src/b.test.ts"]);
  });

  test("带分隔符的 glob 匹配相对路径", async () => {
    const files = await findFilesInExternalDir(ext, "src/**/*.test.ts", 50);
    expect(files).toEqual([join(ext, "src", "b.test.ts")]);
  });

  test("上限与 truncated（跨目录共享预算）", async () => {
    const result = await searchExternalDirs(
      [
        { path: ext, label: "ext" },
        { path: other, label: "other" },
      ],
      "*.ts",
      2,
    );
    expect(result.totalFound).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.searchedDirectories).toBe(1);
  });

  test("缺失目录跳过，不抛错", async () => {
    const result = await searchExternalDirs(
      [
        { path: join(root, "gone"), label: "gone" },
        { path: other, label: "other" },
      ],
      "*.ts",
      10,
    );
    expect(result.totalFound).toBe(1);
    expect(result.directories[0]?.label).toBe("other");
  });

  test("空 pattern 抛错", async () => {
    await expect(findFilesInExternalDir(ext, "   ", 10)).rejects.toThrow(/must not be blank/);
  });
});

describe("externalSkillNames", () => {
  test("发现 .agents/skills 下的 SKILL.md", () => {
    expect(externalSkillNames(ext)).toContain("ext-skill");
  });
});

process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
});
