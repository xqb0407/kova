import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalStorage, resetStorageForTest } from "../../src/storage/hostdb";
import {
  BUILTIN_SUBAGENT_SPECS,
  builtinSubagents,
  deleteSubagentDefinition,
  emitSubagentYaml,
  loadSubagentDefinitions,
  parseSubagentDraftYaml,
  parseSubagentYaml,
  resetSubagentsForTest,
  saveSubagentDefinition,
  setSubagentEnabled,
  subagentFileName,
  subagentStateKey,
  type SubagentDraft,
} from "../../src/subagent/subagent-definitions";

const tmp = mkdtempSync(join(tmpdir(), "pi-agent-subagents-"));

/** sidecar 基础工具目录（与 tools.ts buildTools 保持一致） */
const BASE_TOOLS = new Set(["bash", "read", "write", "edit", "glob", "grep"]);

const draft = (over: Partial<SubagentDraft> & { name: string }): SubagentDraft => ({
  description: `${over.name} does a thing.`,
  tools: ["read", "grep"],
  prompt: "Do the thing carefully.",
  ...over,
});

beforeAll(() => {
  // 开关/信任落 kv：走本地 SQLite（与个性化测试同款初始化）
  initLocalStorage(join(tmp, "state.db"));
});

afterAll(() => {
  // bun test 单进程共享模块注册表：清内存态与连接，避免污染后续文件
  resetSubagentsForTest();
  resetStorageForTest();
});

describe("builtinSubagents", () => {
  test("内置四份定义齐全且有效", () => {
    const definitions = builtinSubagents();
    expect(definitions.map((d) => d.name)).toEqual([
      "Explorer",
      "Code-reviewer",
      "Test-runner",
      "Fixer",
    ]);
    expect(BUILTIN_SUBAGENT_SPECS.length).toBe(definitions.length);
  });

  test("每份定义的工具都存在于基础工具目录，且 maxTurns 为正", () => {
    for (const d of builtinSubagents()) {
      expect(d.description.trim()).not.toBe("");
      expect(d.prompt.trim()).not.toBe("");
      expect(d.tools.length).toBeGreaterThan(0);
      for (const t of d.tools) expect(BASE_TOOLS.has(t)).toBe(true);
      expect(d.maxTurns).toBeGreaterThan(0);
      expect(d.scope).toBe("builtin");
      expect(d.stateKey).toBe(`builtin:${d.name.toLowerCase()}`);
    }
  });

  test("explorer 不直接写文件，fixer 可变更文件", () => {
    const byName = Object.fromEntries(builtinSubagents().map((d) => [d.name, d]));
    expect(byName.Explorer.tools.some((t: string) => ["write", "edit"].includes(t))).toBe(false);
    expect(byName.Fixer.tools).toContain("edit");
    expect(byName.Fixer.tools).toContain("write");
  });

  test("内置 raw 可被同一解析器读回（序列化/解析闭环）", () => {
    for (const spec of BUILTIN_SUBAGENT_SPECS) {
      const raw = emitSubagentYaml(spec);
      const parsed = parseSubagentYaml(raw, { scope: "builtin" });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.definition.name).toBe(spec.name);
      expect(parsed.definition.description).toBe(spec.description);
      expect(parsed.definition.tools).toEqual(spec.tools);
      expect(parsed.definition.prompt).toBe(spec.prompt.trim());
    }
  });
});

describe("parseSubagentYaml", () => {
  const VALID = `name: my-agent
description: Does a thing.
tools: [read, grep]
maxTurns: 12
model: anthropic/claude-sonnet-4
prompt: |
  Do the thing carefully.
  Second line kept.
`;

  test("解析完整定义", () => {
    const parsed = parseSubagentYaml(VALID, { scope: "system" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.definition.name).toBe("my-agent");
    expect(parsed.definition.tools).toEqual(["read", "grep"]);
    expect(parsed.definition.maxTurns).toBe(12);
    expect(parsed.definition.model).toBe("anthropic/claude-sonnet-4");
    expect(parsed.definition.prompt).toBe("Do the thing carefully.\nSecond line kept.");
    expect(parsed.definition.scope).toBe("system");
    expect(parsed.definition.stateKey).toBe("system:my-agent");
  });

  test("缺 name 时回退 fallbackName", () => {
    const parsed = parseSubagentYaml(VALID.replace("name: my-agent\n", ""), {
      scope: "system",
      fallbackName: "file-name",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.definition.name).toBe("file-name");
  });

  test("既无 name 也无 fallbackName 报错", () => {
    const parsed = parseSubagentYaml(VALID.replace("name: my-agent\n", ""), { scope: "system" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(";")).toContain("name");
  });

  test("缺 description / tools / prompt 分别报错", () => {
    expect(parseSubagentYaml(VALID.replace(/description: .*\n/, ""), { scope: "system" }).ok).toBe(false);
    expect(parseSubagentYaml(VALID.replace("tools: [read, grep]\n", ""), { scope: "system" }).ok).toBe(false);
    expect(parseSubagentYaml(VALID.replace(/prompt: \|\n(.|\n)*$/, ""), { scope: "system" }).ok).toBe(false);
  });

  test("tools 支持逗号分隔字符串形态", () => {
    const parsed = parseSubagentYaml(VALID.replace("tools: [read, grep]", 'tools: "read, grep"'), {
      scope: "system",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.definition.tools).toEqual(["read", "grep"]);
  });

  test("非法 maxTurns / model 缺 provider / 未知工具 / 未知键都进 warnings 不致命", () => {
    const parsed = parseSubagentYaml(
      VALID.replace("maxTurns: 12", "maxTurns: abc")
        .replace("model: anthropic/claude-sonnet-4", "model: claude-sonnet-4")
        .replace("tools: [read, grep]", "tools: [read, teleport]")
        .replace("name: my-agent", "name: my-agent\npermission: ask"),
      { scope: "system" },
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.definition.maxTurns).toBeUndefined();
      expect(parsed.definition.model).toBeUndefined();
    }
    const joined = parsed.warnings.join("\n");
    expect(joined).toContain("maxTurns");
    expect(joined).toContain("model");
    expect(joined).toContain("teleport");
    expect(joined).toContain("permission");
  });

  test("YAML 语法错误进 errors", () => {
    const parsed = parseSubagentYaml("name: [unclosed", { scope: "system" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(";")).toContain("YAML parse error");
  });

  test("空文档 / 顶层非 mapping 报错", () => {
    expect(parseSubagentYaml("", { scope: "system" }).ok).toBe(false);
    expect(parseSubagentYaml("- a\n- b", { scope: "system" }).ok).toBe(false);
  });

  test("工作区层的 stateKey 带上所属 cwd", () => {
    const dir = join(tmp, "ws-key", ".kova", "subagents");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "a.yml");
    writeFileSync(file, VALID);
    const parsed = parseSubagentYaml(VALID, { scope: "workspace", filePath: file });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.definition.stateKey).toBe(`workspace:${join(tmp, "ws-key")}::my-agent`);
    }
  });
});

describe("emitSubagentYaml / parseSubagentDraftYaml", () => {
  test("round-trip 保持字段", () => {
    const d = draft({
      name: "round-trip",
      description: "Multi-line: has a colon, quotes \"here\".",
      tools: ["read", "bash"],
      maxTurns: 30,
      model: "openai/gpt-4o",
      prompt: "line one\n\nline three\n  indented",
    });
    const parsed = parseSubagentDraftYaml(emitSubagentYaml(d), "system");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.draft.description).toBe(d.description);
      expect(parsed.draft.tools).toEqual(d.tools);
      expect(parsed.draft.maxTurns).toBe(30);
      expect(parsed.draft.model).toBe("openai/gpt-4o");
      expect(parsed.draft.prompt.trim()).toBe(d.prompt.trim());
    }
  });

  test("坏 YAML 返回解析错误", () => {
    const parsed = parseSubagentDraftYaml("name: [broken", "system");
    expect(parsed.ok).toBe(false);
  });
});

describe("subagentFileName / subagentStateKey", () => {
  test("非法字符与空白替换为连字符，中文名保留原文", () => {
    expect(subagentFileName(" My Agent ")).toBe("My-Agent.yml");
    expect(subagentFileName("a/b:c*d?")).toBe("a-b-c-d.yml");
    expect(subagentFileName("代码审查")).toBe("代码审查.yml");
    expect(subagentFileName("///")).toBe("agent.yml");
  });

  test("开关键按层区分，工作区键按 cwd 隔离", () => {
    expect(subagentStateKey("builtin", "Explorer")).toBe("builtin:explorer");
    expect(subagentStateKey("system", " A ")).toBe("system:a");
    expect(subagentStateKey("workspace", "a", "/ws/x")).toBe("workspace:/ws/x::a");
    expect(subagentStateKey("workspace", "a", "/ws/y")).toBe("workspace:/ws/y::a");
  });
});

describe("loadSubagentDefinitions（三层发现 / 开关）", () => {
  test("系统层遮蔽内置同名以外的定义合并挂载", async () => {
    const sys = join(tmp, "layers-system");
    mkdirSync(sys, { recursive: true });
    writeFileSync(join(sys, "lint.yml"), emitSubagentYaml(draft({ name: "linter", description: "Runs lint." })));
    const loaded = await loadSubagentDefinitions({ systemDir: sys });
    const names = loaded.definitions.map((d) => d.name);
    expect(names).toContain("linter");
    expect(names).toContain("Explorer");
    // 内置 + 系统都进清单，内置 editable=false
    const explorer = loaded.entries.find((e) => e.name === "Explorer")!;
    expect(explorer.editable).toBe(false);
    expect(explorer.enabled).toBe(true);
    const linter = loaded.entries.find((e) => e.name === "linter")!;
    expect(linter.scope).toBe("system");
    expect(linter.editable).toBe(true);
    expect(linter.raw).toContain("name: linter");
  });

  test("关闭的定义不挂载但仍在清单中（enabled=false）", async () => {
    const sys = join(tmp, "off-system");
    mkdirSync(sys, { recursive: true });
    writeFileSync(join(sys, "a.yml"), emitSubagentYaml(draft({ name: "toggle-me" })));
    await setSubagentEnabled("system", "toggle-me", false);
    const loaded = await loadSubagentDefinitions({ systemDir: sys });
    expect(loaded.definitions.some((d) => d.name === "toggle-me")).toBe(false);
    const entry = loaded.entries.find((e) => e.name === "toggle-me")!;
    expect(entry.enabled).toBe(false);
    // 内置也能关
    await setSubagentEnabled("builtin", "explorer", false);
    const loaded2 = await loadSubagentDefinitions({ systemDir: sys });
    expect(loaded2.definitions.some((d) => d.name === "Explorer")).toBe(false);
    await setSubagentEnabled("builtin", "explorer", true);
    await setSubagentEnabled("system", "toggle-me", true);
  });

  test("工作区定义直接挂载并可遮蔽系统层同名", async () => {
    const sys = join(tmp, "trust-system");
    const ws = join(tmp, "trust-ws");
    mkdirSync(sys, { recursive: true });
    mkdirSync(join(ws, ".kova", "subagents"), { recursive: true });
    writeFileSync(join(sys, "shared.yml"), emitSubagentYaml(draft({ name: "shared", description: "system copy" })));
    writeFileSync(
      join(ws, ".kova", "subagents", "shared.yml"),
      emitSubagentYaml(draft({ name: "shared", description: "workspace copy" })),
    );

    const loaded = await loadSubagentDefinitions({ systemDir: sys, cwd: ws });
    expect(loaded.definitions.find((d) => d.name === "shared")?.description).toBe("workspace copy");
    // 清单里两层同名条目都在，工作区那条 enabled 跟随开关
    const wsEntry = loaded.entries.find((e) => e.name === "shared" && e.scope === "workspace")!;
    expect(wsEntry.enabled).toBe(true);
  });

  test("坏文件降级为诊断，不赔上同层其它定义", async () => {
    const sys = join(tmp, "bad-file");
    mkdirSync(sys, { recursive: true });
    writeFileSync(join(sys, "broken.yml"), "name: [unclosed");
    writeFileSync(join(sys, "ok.yml"), emitSubagentYaml(draft({ name: "fine" })));
    const loaded = await loadSubagentDefinitions({ systemDir: sys });
    expect(loaded.definitions.some((d) => d.name === "fine")).toBe(true);
    expect(loaded.diagnostics.some((d) => d.includes("broken.yml"))).toBe(true);
  });

  test("文件改动即时生效（签名缓存跟随 mtime+size）", async () => {
    const sys = join(tmp, "sig");
    mkdirSync(sys, { recursive: true });
    const file = join(sys, "a.yml");
    writeFileSync(file, emitSubagentYaml(draft({ name: "siggy", description: "v1" })));
    const first = await loadSubagentDefinitions({ systemDir: sys });
    expect(first.definitions.find((d) => d.name === "siggy")?.description).toBe("v1");
    writeFileSync(file, emitSubagentYaml(draft({ name: "siggy", description: "v2-longer" })));
    const second = await loadSubagentDefinitions({ systemDir: sys });
    expect(second.definitions.find((d) => d.name === "siggy")?.description).toBe("v2-longer");
  });
});

describe("saveSubagentDefinition / deleteSubagentDefinition", () => {
  test("新建系统定义落盘 YAML 文件并可读回", async () => {
    const sys = join(tmp, "save-new");
    await saveSubagentDefinition(
      "system",
      draft({ name: "fresh", description: "Fresh one.", tools: ["read", "bash"], maxTurns: 20 }),
      { systemDir: sys },
    );
    const file = join(sys, "fresh.yml");
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain("name: fresh");
    expect(raw).toContain("maxTurns: 20");
    const loaded = await loadSubagentDefinitions({ systemDir: sys });
    const entry = loaded.entries.find((e) => e.name === "fresh")!;
    expect(entry.tools).toEqual(["read", "bash"]);
    expect(entry.maxTurns).toBe(20);
  });

  test("与内置重名拒绝；描述/prompt 为空拒绝", async () => {
    const sys = join(tmp, "save-invalid");
    await expect(
      saveSubagentDefinition("system", draft({ name: "explorer" }), { systemDir: sys }),
    ).rejects.toThrow(/内置/);
    await expect(
      saveSubagentDefinition("system", { ...draft({ name: "x" }), description: "" }, { systemDir: sys }),
    ).rejects.toThrow(/描述/);
    await expect(
      saveSubagentDefinition("system", { ...draft({ name: "x" }), prompt: " " }, { systemDir: sys }),
    ).rejects.toThrow(/prompt/);
  });

  test("跨层同名拒绝（系统已有，工作区再建同名）", async () => {
    const sys = join(tmp, "save-clash-system");
    const ws = join(tmp, "save-clash-ws");
    mkdirSync(sys, { recursive: true });
    await saveSubagentDefinition("system", draft({ name: "clash" }), { systemDir: sys });
    await expect(
      saveSubagentDefinition("workspace", draft({ name: "clash" }), { systemDir: sys, cwd: ws }),
    ).rejects.toThrow(/另一层/);
  });

  test("编辑改名清旧文件；工作区保存即挂载", async () => {
    const sys = join(tmp, "save-rename");
    const ws = join(tmp, "save-rename-ws");
    await saveSubagentDefinition("system", draft({ name: "old-name", description: "before" }), { systemDir: sys });
    await saveSubagentDefinition(
      "system",
      draft({ name: "new-name", description: "after" }),
      { systemDir: sys, replaceName: "old-name" },
    );
    expect(existsSync(join(sys, "old-name.yml"))).toBe(false);
    const names = (await loadSubagentDefinitions({ systemDir: sys })).definitions
      .filter((d) => d.scope === "system")
      .map((d) => d.name);
    expect(names).toEqual(["new-name"]);

    await saveSubagentDefinition("workspace", draft({ name: "ws-agent" }), { systemDir: sys, cwd: ws });
    const afterSave = await loadSubagentDefinitions({ systemDir: sys, cwd: ws });
    expect(afterSave.definitions.some((d) => d.name === "ws-agent")).toBe(true);
  });

  test("删除：系统/工作区可删，内置与不存在报错", async () => {
    const sys = join(tmp, "del-system");
    await saveSubagentDefinition("system", draft({ name: "gone" }), { systemDir: sys });
    await deleteSubagentDefinition("system", "gone", { systemDir: sys });
    expect(existsSync(join(sys, "gone.yml"))).toBe(false);
    await expect(deleteSubagentDefinition("system", "gone", { systemDir: sys })).rejects.toThrow(/未找到/);
  });
});
