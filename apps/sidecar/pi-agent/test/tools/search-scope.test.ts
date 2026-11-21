/**
 * grep/glob 的检索范围提示：工作区内不加任何字节；工作区外（含 `..`）照常
 * 执行，只在结果头部加一行范围提醒——不拒绝、不阻断，保留“有时必须看工作区
 * 外”的用法。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExternalDir } from "pi-protocol";
import { buildTools } from "../../src/tools/tools";

const root = mkdtempSync(join(tmpdir(), "search-scope-"));
const ws = join(root, "ws");
const outside = join(root, "outside");
const projectDir = join(root, "project-dir");
mkdirSync(join(ws, "src"), { recursive: true });
mkdirSync(outside, { recursive: true });
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(ws, "src", "inside.ts"), "const needle = 1;\n");
writeFileSync(join(outside, "outside.ts"), "const needle = 2;\n");
writeFileSync(join(projectDir, "project.ts"), "const needle = 3;\n");

const OUTSIDE_PREFIX = "[outside workspace:";

type Tool = ReturnType<typeof buildTools>[number];

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

function detailsOf(result: unknown): { outsideWorkspace?: boolean } | undefined {
  return (result as { details?: { outsideWorkspace?: boolean } }).details;
}

function build(externalDirs: ExternalDir[] = []): Tool[] {
  return buildTools(
    ws,
    "t-search-scope",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => externalDirs,
  );
}

function toolNamed(tools: Tool[], name: string): Tool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool: ${name}`);
  return tool;
}

async function run(tool: Tool, params: Record<string, unknown>): Promise<unknown> {
  return tool.execute!("tc", params, undefined as never);
}

describe("grep/glob 检索范围提示（非阻断）", () => {
  test("工作区内检索：无 outside workspace 标注", async () => {
    const grep = toolNamed(build(), "grep");
    const result = await run(grep, { pattern: "needle", path: "src" });
    const text = textOf(result);
    expect(text).toContain("inside.ts");
    expect(text).not.toContain(OUTSIDE_PREFIX);
    expect(detailsOf(result)?.outsideWorkspace).toBeUndefined();
  });

  test("不传 path：默认从工作区根开始，无标注", async () => {
    const grep = toolNamed(build(), "grep");
    const text = textOf(await run(grep, { pattern: "needle" }));
    expect(text).toContain("inside.ts");
    expect(text).not.toContain(OUTSIDE_PREFIX);
  });

  test("工作区外的具体文件：照常返回结果，并带一行标注", async () => {
    const grep = toolNamed(build(), "grep");
    const file = join(outside, "outside.ts");
    const result = await run(grep, { pattern: "needle", path: file });
    const text = textOf(result);
    expect(text).toContain("outside.ts");
    expect(text.startsWith(OUTSIDE_PREFIX)).toBe(true);
    expect(detailsOf(result)?.outsideWorkspace).toBe(true);
  });

  test("工作区外的具体目录：照常返回结果，并带一行标注", async () => {
    const grep = toolNamed(build(), "grep");
    const result = await run(grep, { pattern: "needle", path: outside });
    const text = textOf(result);
    expect(text).toContain("outside.ts");
    expect(text.startsWith(OUTSIDE_PREFIX)).toBe(true);
    expect(detailsOf(result)?.outsideWorkspace).toBe(true);
  });

  test("path: \"..\" 不拒绝：仍执行，并标注越界", async () => {
    const grep = toolNamed(build(), "grep");
    const text = textOf(await run(grep, { pattern: "needle", path: ".." }));
    expect(text.startsWith(OUTSIDE_PREFIX)).toBe(true);
    expect(text).toContain("outside.ts");
  });

  test("已配置的项目文件夹：视作工作区内，无标注", async () => {
    const grep = toolNamed(
      build([{ path: projectDir, label: "project-dir" }]),
      "grep",
    );
    const text = textOf(await run(grep, { pattern: "needle", path: projectDir }));
    expect(text).toContain("project.ts");
    expect(text).not.toContain(OUTSIDE_PREFIX);
  });

  test("glob 使用同一规则", async () => {
    const glob = toolNamed(build(), "glob");
    const inside = textOf(await run(glob, { pattern: "**/*.ts", path: "src" }));
    expect(inside).not.toContain(OUTSIDE_PREFIX);

    const outsideText = textOf(await run(glob, { pattern: "**/*.ts", path: outside }));
    expect(outsideText.startsWith(OUTSIDE_PREFIX)).toBe(true);
    expect(outsideText).toContain("outside.ts");
  });
});

process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
});
