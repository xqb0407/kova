import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalStorage, resetStorageForTest } from "../../src/storage/hostdb";
import {
  BUILTIN_SUBAGENT_SPECS,
  SUBAGENT_AVATAR_MAX_LENGTH,
  builtinSubagents,
  deleteSubagentDefinition,
  emitSubagentYaml,
  loadSubagentDefinitions,
  normalizeSubagentAvatar,
  parseSubagentDraftYaml,
  parseSubagentYaml,
  resetSubagentsForTest,
  saveSubagentDefinition,
  setSubagentAvatarOverride,
  setSubagentEnabled,
  setSubagentModelOverride,
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

describe("模型覆盖（kv，只读层专用）", () => {
  test("内置覆盖后 definitions 与 entries 都带上该模型", async () => {
    const sys = join(tmp, "model-builtin");
    mkdirSync(sys, { recursive: true });
    const before = await loadSubagentDefinitions({ systemDir: sys });
    expect(before.definitions.find((d) => d.name === "Explorer")?.model).toBeUndefined();

    await setSubagentModelOverride("builtin", "Explorer", "deepseek/deepseek-chat");
    const after = await loadSubagentDefinitions({ systemDir: sys });
    expect(after.definitions.find((d) => d.name === "Explorer")?.model).toBe(
      "deepseek/deepseek-chat",
    );
    expect(after.entries.find((e) => e.name === "Explorer")?.model).toBe(
      "deepseek/deepseek-chat",
    );
    await setSubagentModelOverride("builtin", "Explorer", "");
  });

  test("覆盖同步进 raw（设置页 YAML 页签与表单不打架）", async () => {
    const sys = join(tmp, "model-raw");
    mkdirSync(sys, { recursive: true });
    await setSubagentModelOverride("builtin", "Test-runner", "deepseek/deepseek-chat");
    const loaded = await loadSubagentDefinitions({ systemDir: sys });
    const entry = loaded.entries.find((e) => e.name === "Test-runner")!;
    expect(entry.raw).toContain("model: deepseek/deepseek-chat");
    // 覆盖后的 raw 必须仍能被同一解析器读回来
    const reparsed = parseSubagentYaml(entry.raw!, { scope: "builtin" });
    expect(reparsed.ok && reparsed.definition.model).toBe("deepseek/deepseek-chat");
    await setSubagentModelOverride("builtin", "Test-runner", "");
  });

  test("覆盖优先于定义自带的 model；清除后回落自带值", async () => {
    const sys = join(tmp, "model-priority");
    mkdirSync(sys, { recursive: true });
    writeFileSync(
      join(sys, "own.yml"),
      emitSubagentYaml(draft({ name: "own-model", model: "anthropic/claude-sonnet-4" })),
    );
    const original = await loadSubagentDefinitions({ systemDir: sys });
    expect(original.definitions.find((d) => d.name === "own-model")?.model).toBe(
      "anthropic/claude-sonnet-4",
    );

    await setSubagentModelOverride("system", "own-model", "deepseek/deepseek-chat");
    const overridden = await loadSubagentDefinitions({ systemDir: sys });
    expect(overridden.definitions.find((d) => d.name === "own-model")?.model).toBe(
      "deepseek/deepseek-chat",
    );

    // 空串 = 清除覆盖，回落定义自带值而不是清空
    await setSubagentModelOverride("system", "own-model", "");
    const cleared = await loadSubagentDefinitions({ systemDir: sys });
    expect(cleared.definitions.find((d) => d.name === "own-model")?.model).toBe(
      "anthropic/claude-sonnet-4",
    );
  });

  test("无 provider 前缀的模型键被拒", async () => {
    const sys = join(tmp, "model-bad-key");
    mkdirSync(sys, { recursive: true });
    expect(
      setSubagentModelOverride("builtin", "Fixer", "gpt-oss-120b"),
    ).rejects.toThrow(/provider\/modelId/);
    const loaded = await loadSubagentDefinitions({ systemDir: sys });
    expect(loaded.definitions.find((d) => d.name === "Fixer")?.model).toBeUndefined();
  });

  test("工作区层覆盖按 cwd 隔离，同名定义互不串味", async () => {
    const wsA = join(tmp, "model-ws-a");
    const wsB = join(tmp, "model-ws-b");
    mkdirSync(join(wsA, ".kova", "subagents"), { recursive: true });
    mkdirSync(join(wsB, ".kova", "subagents"), { recursive: true });
    const body = emitSubagentYaml(draft({ name: "ws-agent" }));
    writeFileSync(join(wsA, ".kova", "subagents", "ws-agent.yml"), body);
    writeFileSync(join(wsB, ".kova", "subagents", "ws-agent.yml"), body);

    await setSubagentModelOverride("workspace", "ws-agent", "deepseek/deepseek-chat", wsA);
    const a = await loadSubagentDefinitions({ cwd: wsA });
    const b = await loadSubagentDefinitions({ cwd: wsB });
    expect(a.definitions.find((d) => d.name === "ws-agent")?.model).toBe(
      "deepseek/deepseek-chat",
    );
    expect(b.definitions.find((d) => d.name === "ws-agent")?.model).toBeUndefined();
  });

  test("删除定义顺带清掉覆盖键，不在 kv 里留孤儿", async () => {
    const sys = join(tmp, "model-delete");
    mkdirSync(sys, { recursive: true });
    await saveSubagentDefinition("system", draft({ name: "doomed" }), { systemDir: sys });
    await setSubagentModelOverride("system", "doomed", "deepseek/deepseek-chat", undefined);
    await deleteSubagentDefinition("system", "doomed", { systemDir: sys });

    // 覆盖键已清：同名重建后不应继承旧模型
    await saveSubagentDefinition("system", draft({ name: "doomed" }), { systemDir: sys });
    const loaded = await loadSubagentDefinitions({ systemDir: sys });
    expect(loaded.definitions.find((d) => d.name === "doomed")?.model).toBeUndefined();
  });
});

describe("头像（kv，四层统一；不进定义文件）", () => {
  const PNG_1PX =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  test("normalizeSubagentAvatar：空白=清除，内置 id 与图片 data URL 放行", () => {
    expect(normalizeSubagentAvatar(undefined)).toBeUndefined();
    expect(normalizeSubagentAvatar("   ")).toBeUndefined();
    expect(normalizeSubagentAvatar(" builtin:clay-07 ")).toBe("builtin:clay-07");
    expect(normalizeSubagentAvatar(PNG_1PX)).toBe(PNG_1PX);
    expect(normalizeSubagentAvatar("data:image/svg+xml;base64,PHN2Zy8+")).toBe(
      "data:image/svg+xml;base64,PHN2Zy8+",
    );
  });

  test("normalizeSubagentAvatar：拒绝 http 地址、本地路径、非图片 MIME、畸形内置 id", () => {
    for (const bad of [
      "https://example.com/a.png",
      "/Users/me/a.png",
      "data:text/html;base64,PGI+",
      "data:image/png,notbase64",
      "builtin:",
      "builtin:Clay 07",
      "builtin:../x",
    ]) {
      expect(() => normalizeSubagentAvatar(bad)).toThrow();
    }
  });

  test("normalizeSubagentAvatar：超过体积上限的 data URL 被拒", () => {
    const huge = `data:image/png;base64,${"A".repeat(SUBAGENT_AVATAR_MAX_LENGTH)}`;
    expect(() => normalizeSubagentAvatar(huge)).toThrow(/过大/);
  });

  test("内置条目设头像后 entries 带 avatar；清除后消失，且 raw 不受影响", async () => {
    const sys = join(tmp, "avatar-builtin");
    mkdirSync(sys, { recursive: true });
    const before = await loadSubagentDefinitions({ systemDir: sys });
    const rawBefore = before.entries.find((e) => e.name === "Explorer")?.raw;
    expect(before.entries.find((e) => e.name === "Explorer")?.avatar).toBeUndefined();

    await setSubagentAvatarOverride("builtin", "Explorer", "builtin:clay-03");
    const after = await loadSubagentDefinitions({ systemDir: sys });
    const entry = after.entries.find((e) => e.name === "Explorer")!;
    expect(entry.avatar).toBe("builtin:clay-03");
    // 头像不是 YAML 字段：raw 原样，不会像模型覆盖那样被重算
    expect(entry.raw).toBe(rawBefore);
    expect(entry.raw).not.toContain("avatar");

    await setSubagentAvatarOverride("builtin", "Explorer", "");
    const cleared = await loadSubagentDefinitions({ systemDir: sys });
    expect(cleared.entries.find((e) => e.name === "Explorer")?.avatar).toBeUndefined();
  });

  test("上传头像（data URL）原样进 entries", async () => {
    const sys = join(tmp, "avatar-data");
    mkdirSync(sys, { recursive: true });
    await setSubagentAvatarOverride("builtin", "Fixer", PNG_1PX);
    const loaded = await loadSubagentDefinitions({ systemDir: sys });
    expect(loaded.entries.find((e) => e.name === "Fixer")?.avatar).toBe(PNG_1PX);
    await setSubagentAvatarOverride("builtin", "Fixer", "");
  });

  test("非法头像写入被拒，且不改动既有值", async () => {
    const sys = join(tmp, "avatar-bad");
    mkdirSync(sys, { recursive: true });
    await setSubagentAvatarOverride("builtin", "Code-reviewer", "builtin:clay-01");
    expect(
      setSubagentAvatarOverride("builtin", "Code-reviewer", "https://evil.example/x.png"),
    ).rejects.toThrow();
    const loaded = await loadSubagentDefinitions({ systemDir: sys });
    expect(loaded.entries.find((e) => e.name === "Code-reviewer")?.avatar).toBe("builtin:clay-01");
    await setSubagentAvatarOverride("builtin", "Code-reviewer", "");
  });

  test("工作区层头像按 cwd 隔离", async () => {
    const wsA = join(tmp, "avatar-ws-a");
    const wsB = join(tmp, "avatar-ws-b");
    mkdirSync(join(wsA, ".kova", "subagents"), { recursive: true });
    mkdirSync(join(wsB, ".kova", "subagents"), { recursive: true });
    const body = emitSubagentYaml(draft({ name: "ws-avatar" }));
    writeFileSync(join(wsA, ".kova", "subagents", "ws-avatar.yml"), body);
    writeFileSync(join(wsB, ".kova", "subagents", "ws-avatar.yml"), body);

    await setSubagentAvatarOverride("workspace", "ws-avatar", "builtin:clay-09", wsA);
    const a = await loadSubagentDefinitions({ cwd: wsA });
    const b = await loadSubagentDefinitions({ cwd: wsB });
    expect(a.entries.find((e) => e.name === "ws-avatar")?.avatar).toBe("builtin:clay-09");
    expect(b.entries.find((e) => e.name === "ws-avatar")?.avatar).toBeUndefined();
  });

  test("删除定义顺带清掉头像键，同名重建不继承旧头像", async () => {
    const sys = join(tmp, "avatar-delete");
    mkdirSync(sys, { recursive: true });
    await saveSubagentDefinition("system", draft({ name: "doomed-avatar" }), { systemDir: sys });
    await setSubagentAvatarOverride("system", "doomed-avatar", "builtin:clay-05");
    await deleteSubagentDefinition("system", "doomed-avatar", { systemDir: sys });

    await saveSubagentDefinition("system", draft({ name: "doomed-avatar" }), { systemDir: sys });
    const loaded = await loadSubagentDefinitions({ systemDir: sys });
    expect(loaded.entries.find((e) => e.name === "doomed-avatar")?.avatar).toBeUndefined();
  });

  test("保存时随带 avatar：新建即有头像；不传 avatar 的保存不动既有头像", async () => {
    const sys = join(tmp, "avatar-save");
    mkdirSync(sys, { recursive: true });
    await saveSubagentDefinition("system", draft({ name: "with-face" }), {
      systemDir: sys,
      avatar: "builtin:clay-12",
    });
    let loaded = await loadSubagentDefinitions({ systemDir: sys });
    expect(loaded.entries.find((e) => e.name === "with-face")?.avatar).toBe("builtin:clay-12");

    // 只改描述、不带 avatar 字段（老客户端/其它路径）：头像保持
    await saveSubagentDefinition(
      "system",
      draft({ name: "with-face", description: "changed" }),
      { systemDir: sys, replaceName: "with-face" },
    );
    loaded = await loadSubagentDefinitions({ systemDir: sys });
    expect(loaded.entries.find((e) => e.name === "with-face")?.avatar).toBe("builtin:clay-12");

    // 带空串 = 恢复默认
    await saveSubagentDefinition("system", draft({ name: "with-face" }), {
      systemDir: sys,
      replaceName: "with-face",
      avatar: "",
    });
    loaded = await loadSubagentDefinitions({ systemDir: sys });
    expect(loaded.entries.find((e) => e.name === "with-face")?.avatar).toBeUndefined();
  });

  test("保存时 avatar 非法：整个保存被拒，定义文件不落盘", async () => {
    const sys = join(tmp, "avatar-save-bad");
    mkdirSync(sys, { recursive: true });
    expect(
      saveSubagentDefinition("system", draft({ name: "half-born" }), {
        systemDir: sys,
        avatar: "https://evil.example/x.png",
      }),
    ).rejects.toThrow();
    expect(existsSync(join(sys, "half-born.yml"))).toBe(false);
    const loaded = await loadSubagentDefinitions({ systemDir: sys });
    expect(loaded.entries.some((e) => e.name === "half-born")).toBe(false);
  });

  test("改名保存：头像跟到新名字，旧名的键清掉", async () => {
    const sys = join(tmp, "avatar-rename");
    mkdirSync(sys, { recursive: true });
    await saveSubagentDefinition("system", draft({ name: "old-face" }), {
      systemDir: sys,
      avatar: "builtin:clay-02",
    });
    await saveSubagentDefinition("system", draft({ name: "new-face" }), {
      systemDir: sys,
      replaceName: "old-face",
      avatar: "builtin:clay-02",
    });
    let loaded = await loadSubagentDefinitions({ systemDir: sys });
    expect(loaded.entries.some((e) => e.name === "old-face")).toBe(false);
    expect(loaded.entries.find((e) => e.name === "new-face")?.avatar).toBe("builtin:clay-02");

    // 旧名键已清：再建一个同叫 old-face 的不应继承头像
    await saveSubagentDefinition("system", draft({ name: "old-face" }), { systemDir: sys });
    loaded = await loadSubagentDefinitions({ systemDir: sys });
    expect(loaded.entries.find((e) => e.name === "old-face")?.avatar).toBeUndefined();
  });

  test("改名保存但不带 avatar（老客户端）：旧名的头像键同样清掉", async () => {
    const sys = join(tmp, "avatar-rename-noavatar");
    mkdirSync(sys, { recursive: true });
    await saveSubagentDefinition("system", draft({ name: "ancient" }), {
      systemDir: sys,
      avatar: "builtin:clay-06",
    });
    // 老客户端不知道 avatar 字段：只改名
    await saveSubagentDefinition("system", draft({ name: "renamed" }), {
      systemDir: sys,
      replaceName: "ancient",
    });
    await saveSubagentDefinition("system", draft({ name: "ancient" }), { systemDir: sys });
    const loaded = await loadSubagentDefinitions({ systemDir: sys });
    expect(loaded.entries.find((e) => e.name === "ancient")?.avatar).toBeUndefined();
    expect(loaded.entries.find((e) => e.name === "renamed")?.avatar).toBeUndefined();
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

describe("知识源格式守卫", () => {
  test("保存路径拒绝指向二进制文档的知识源（单个文件与 glob 形态都拒）", async () => {
    const sys = join(tmp, "save-kb-binary");
    const paths = ["./docs/手册.pdf", "./kb/manual.docx", "./kb/**/*.XLSX"];
    for (const [i, path] of paths.entries()) {
      await expect(
        saveSubagentDefinition(
          "system",
          draft({ name: `kb-bin-${i}`, knowledge: [{ name: "资料", path }] }),
          { systemDir: sys },
        ),
      ).rejects.toThrow(/二进制文档/);
    }
  });

  test("文本类源（glob 或单文件）可落盘读回", async () => {
    const sys = join(tmp, "save-kb-text");
    await saveSubagentDefinition(
      "system",
      draft({
        name: "kb-ok",
        knowledge: [
          { name: "流程", path: "./docs/**/*.md" },
          { name: "价格表", path: "./pricing.csv" },
        ],
      }),
      { systemDir: sys },
    );
    const loaded = await loadSubagentDefinitions({ systemDir: sys });
    const def = loaded.definitions.find((d) => d.name === "kb-ok")!;
    expect(def.knowledge?.map((k) => k.path)).toEqual(["./docs/**/*.md", "./pricing.csv"]);
  });

  test("既有 YAML 含二进制源：加载只警告不丢条目（静默删除会带走用户数据）", () => {
    const raw = emitSubagentYaml(
      draft({ name: "kb-legacy", knowledge: [{ name: "旧手册", path: "./docs/旧手册.pdf" }] }),
    );
    const parsed = parseSubagentYaml(raw, { scope: "system" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.definition.knowledge?.[0]?.path).toBe("./docs/旧手册.pdf");
    expect(parsed.warnings.join("\n")).toMatch(/binary/);
  });
});
