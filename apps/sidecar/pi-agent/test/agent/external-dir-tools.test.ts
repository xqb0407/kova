/**
 * 项目虚拟目录检索工具：跨附加根搜索（只读）。
 * 目录的增删在项目设置里完成，模型侧没有 add 工具。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSearchExternalFilesTool } from "../../src/tools/external-dir-tools";
import type { ExternalDir } from "pi-protocol";

const root = mkdtempSync(join(tmpdir(), "external-dir-tools-"));
const ext = join(root, "shared");
mkdirSync(join(ext, "src"), { recursive: true });
writeFileSync(join(ext, "src", "a.ts"), "a");

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

const dirs: ExternalDir[] = [{ path: ext, label: "shared" }];

describe("search_external_files", () => {
  test("无附加目录时报错（去项目设置里添加）", async () => {
    const tool = buildSearchExternalFilesTool({ getExternalDirs: () => [] });
    await expect(
      tool.execute!("tc", { pattern: "*.ts" }, undefined as never),
    ).rejects.toThrow(/no additional folders/i);
  });

  test("命中时按目录分组列出绝对路径", async () => {
    const tool = buildSearchExternalFilesTool({ getExternalDirs: () => dirs });
    const result = (await tool.execute!(
      "tc",
      { pattern: "*.ts" },
      undefined as never,
    )) as { content: Array<{ type: string; text?: string }> };
    const text = textOf(result);
    expect(text).toContain("Found 1 file(s)");
    expect(text).toContain(join(ext, "src", "a.ts"));
  });

  test("未命中时返回可读说明而不是空串", async () => {
    const tool = buildSearchExternalFilesTool({ getExternalDirs: () => dirs });
    const result = (await tool.execute!(
      "tc",
      { pattern: "*.nope" },
      undefined as never,
    )) as { content: Array<{ type: string; text?: string }> };
    expect(textOf(result)).toContain("No files matching");
  });
});

process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
});
