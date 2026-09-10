import { describe, expect, test } from "bun:test";
import {
  BUILTIN_SUBAGENT_DOCUMENTS,
  builtinSubagents,
  mergeSubagentDefinitions,
  parseSubagentDefinition,
  subagentDefinitionDir,
  type SubagentDefinition,
} from "./subagent-definitions";

/** sidecar 基础工具目录（与 tools.ts buildTools 保持一致） */
const BASE_TOOLS = new Set(["bash", "read", "write", "edit", "glob", "grep"]);

describe("builtinSubagents", () => {
  test("内置四份定义全部有效", () => {
    const { definitions, diagnostics } = builtinSubagents();
    expect(diagnostics).toEqual([]);
    expect(definitions.map((d) => d.name)).toEqual([
      "explorer",
      "code-reviewer",
      "test-runner",
      "fixer",
    ]);
  });

  test("每份定义的工具都存在于基础工具目录，且 maxTurns 为正", () => {
    const { definitions } = builtinSubagents();
    for (const d of definitions) {
      expect(d.description.trim()).not.toBe("");
      expect(d.prompt.trim()).not.toBe("");
      expect(d.tools.length).toBeGreaterThan(0);
      for (const t of d.tools) expect(BASE_TOOLS.has(t)).toBe(true);
      expect(d.maxTurns).toBeGreaterThan(0);
    }
  });

  test("explorer 不直接写文件，fixer 可变更文件", () => {
    const { definitions } = builtinSubagents();
    const explorer = definitions.find((d) => d.name === "explorer")!;
    const fixer = definitions.find((d) => d.name === "fixer")!;
    expect(explorer.tools.some((t) => ["write", "edit"].includes(t))).toBe(false);
    expect(fixer.tools).toContain("edit");
    expect(fixer.tools).toContain("write");
  });

  test("BUILTIN_SUBAGENT_DOCUMENTS 与 builtinSubagents 数量一致", () => {
    expect(BUILTIN_SUBAGENT_DOCUMENTS.length).toBe(builtinSubagents().definitions.length);
  });
});

describe("parseSubagentDefinition", () => {
  const VALID = `---
name: my-agent
description: Does a thing.
tools: [read, grep]
maxTurns: 12
model: anthropic/claude-sonnet-4
---

Do the thing carefully.`;

  test("解析完整文档", () => {
    const parsed = parseSubagentDefinition(VALID);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.definition).toEqual({
      name: "my-agent",
      description: "Does a thing.",
      tools: ["read", "grep"],
      maxTurns: 12,
      model: "anthropic/claude-sonnet-4",
      prompt: "Do the thing carefully.",
      source: "user",
    });
  });

  test("缺 name 时回退 fallbackName", () => {
    const parsed = parseSubagentDefinition(
      VALID.replace("name: my-agent\n", ""),
      { fallbackName: "file-name" },
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.definition.name).toBe("file-name");
  });

  test("缺 description 报错", () => {
    const parsed = parseSubagentDefinition(VALID.replace("description: Does a thing.\n", ""));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors[0]).toContain("description");
  });

  test("缺 tools 报错", () => {
    const parsed = parseSubagentDefinition(VALID.replace("tools: [read, grep]\n", ""));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors[0]).toContain("tools");
  });

  test("非法 maxTurns 进 warnings 且不进定义", () => {
    const parsed = parseSubagentDefinition(VALID.replace("maxTurns: 12", "maxTurns: abc"));
    expect(parsed.ok).toBe(true);
    expect(parsed.warnings.some((w) => w.includes("maxTurns"))).toBe(true);
    if (parsed.ok) expect(parsed.definition.maxTurns).toBeUndefined();
  });

  test("model 缺 provider 部分进 warnings", () => {
    const parsed = parseSubagentDefinition(VALID.replace(
      "model: anthropic/claude-sonnet-4",
      "model: claude-sonnet-4",
    ));
    expect(parsed.ok).toBe(true);
    expect(parsed.warnings.some((w) => w.includes("model"))).toBe(true);
    if (parsed.ok) expect(parsed.definition.model).toBeUndefined();
  });

  test("未知 frontmatter 键进 warnings", () => {
    const parsed = parseSubagentDefinition(
      VALID.replace("maxTurns: 12", "maxTurns: 12\npermission: ask"),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.warnings.some((w) => w.includes("permission"))).toBe(true);
  });

  test("没有 frontmatter 报错", () => {
    expect(parseSubagentDefinition("just text").ok).toBe(false);
  });
});

describe("mergeSubagentDefinitions", () => {
  const def = (name: string, source: SubagentDefinition["source"] = "builtin"): SubagentDefinition => ({
    name,
    description: `${name} desc`,
    tools: ["read"],
    prompt: "p",
    source,
  });

  test("后到者遮蔽同名（用户遮蔽内置）", () => {
    const merged = mergeSubagentDefinitions([
      [def("explorer"), def("custom")],
      [def("explorer", "user")],
    ]);
    // Map 保持首次插入顺序：explorer 位置不变，值被用户定义覆盖
    expect(merged.definitions.map((d) => d.name)).toEqual(["explorer", "custom"]);
    expect(merged.definitions.find((d) => d.name === "explorer")?.source).toBe("user");
    expect(merged.dropped).toEqual([]);
  });

  test("超过目录上限时丢弃多余的", () => {
    const many = Array.from({ length: 40 }, (_, i) => def(`agent-${i}`));
    const merged = mergeSubagentDefinitions([many]);
    expect(merged.definitions.length).toBe(32);
    expect(merged.dropped.length).toBe(8);
  });
});

test("用户定义目录是全局 ~/.agents/subagents", () => {
  expect(subagentDefinitionDir().replace(/\\/g, "/")).toMatch(/\.agents\/subagents$/);
});
