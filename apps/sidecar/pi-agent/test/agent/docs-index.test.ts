import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knowledgePromptBlock, projectDocsMap } from "../../src/agent/docs-index";

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-docs-index-"));
  mkdirSync(join(dir, "docs"), { recursive: true });
  return dir;
}

describe("projectDocsMap", () => {
  it("列出根级约定文档与 docs/ 下的标题/摘要", () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, "README.md"), "# Project\n\nWhat this repo is.\n");
      writeFileSync(
        join(ws, "docs", "architecture.md"),
        "# **Architecture**\n\nCore modules and data flow.\n",
      );
      writeFileSync(join(ws, "docs", "notes.txt"), "not markdown");
      const map = projectDocsMap(ws);
      expect(map).toContain("## Project docs");
      expect(map).toContain("README.md — Project — What this repo is.");
      expect(map).toContain(
        "docs/architecture.md — Architecture — Core modules and data flow.",
      );
      expect(map).not.toContain("notes.txt");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("文档删除后目录地图立刻更新（mtime 签名，不吃 TTL 缓存）", () => {
    const ws = makeWorkspace();
    try {
      const file = join(ws, "docs", "gone.md");
      writeFileSync(file, "# Gone\n\nsoon removed.\n");
      expect(projectDocsMap(ws)).toContain("docs/gone.md");
      rmSync(file);
      expect(projectDocsMap(ws)).not.toContain("docs/gone.md");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("远程会话 / 空 cwd / 无 docs 时不产地图", () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, "docs", "a.md"), "# A\n\nbody\n");
      expect(projectDocsMap(ws, true)).toBe("");
      expect(projectDocsMap("")).toBe("");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("docs 目录是软链时不扫描（外部整棵目录不进提示词）", () => {
    const ws = mkdtempSync(join(tmpdir(), "pi-docs-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-docs-outside-dir-"));
    try {
      writeFileSync(join(outside, "secret.md"), "# SECRET\n\nbody\n");
      try {
        symlinkSync(outside, join(ws, "docs"));
      } catch {
        return; // Windows 无符号链接权限：跳过（不是实现问题）
      }
      expect(projectDocsMap(ws)).toBe("");
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("根级文档是软链时不读取（外部内容不进系统提示词）", () => {
    const ws = makeWorkspace();
    const outside = mkdtempSync(join(tmpdir(), "pi-docs-outside-"));
    try {
      const secret = join(outside, "secret.md");
      writeFileSync(secret, "# SECRET\n\nmust not be injected.\n");
      try {
        symlinkSync(secret, join(ws, "README.md"));
      } catch {
        return; // Windows 无符号链接权限：跳过（不是实现问题）
      }
      const map = projectDocsMap(ws);
      expect(map).not.toContain("SECRET");
      expect(map).not.toContain("must not be injected");
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("条目与字符预算有上限", () => {
    const ws = makeWorkspace();
    try {
      for (let i = 0; i < 60; i += 1) {
        writeFileSync(
          join(ws, "docs", `doc-${i}.md`),
          `# ${"长标题".repeat(10)} ${i}\n\n${"摘要内容".repeat(20)}\n`,
        );
      }
      const map = projectDocsMap(ws);
      const lines = map.split("\n").filter((line) => line.startsWith("- "));
      expect(lines.length).toBeLessThanOrEqual(40);
      expect(map.length).toBeLessThanOrEqual(2020);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("knowledgePromptBlock", () => {
  it("始终带使用规则；有文档时追加地图", () => {
    const block = knowledgePromptBlock("");
    expect(block).toContain("## Knowledge sources");
    expect(block).toContain("kb_search");
    expect(block).toContain("cite line");
    expect(block).not.toContain("## Project docs");
  });

  it("有 docs 时规则与地图同时存在", () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, "docs", "a.md"), "# A\n\nbody\n");
      const block = knowledgePromptBlock(ws);
      expect(block).toContain("## Knowledge sources");
      expect(block).toContain("## Project docs");
      expect(block).toContain("docs/a.md — A — body");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("附加根：多根文档带标签合并", () => {
    const ws = makeWorkspace();
    const ext = makeWorkspace();
    try {
      writeFileSync(join(ws, "docs", "main.md"), "# Main\n\nmain body\n");
      writeFileSync(join(ext, "docs", "backend.md"), "# Backend\n\nbackend body\n");
      const block = knowledgePromptBlock(ws, false, [
        { path: ext, label: "backend" },
      ]);
      expect(block).toContain("- [main] docs/main.md — Main — main body");
      expect(block).toContain(
        "- [backend] docs/backend.md — Backend — backend body",
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(ext, { recursive: true, force: true });
    }
  });
});
