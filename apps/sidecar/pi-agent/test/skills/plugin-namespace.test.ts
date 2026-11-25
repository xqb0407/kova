/**
 * 插件技能命名空间（Codex `plugin:skill`）：
 * - 跨插件同名技能共存，不再互相遮蔽；
 * - 系统提示词展示 qualifiedName；
 * - use_skill 支持 qualified 精确匹配、裸名唯一兜底、歧义报错、普通技能优先。
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { initLocalStorage, resetStorageForTest } from "../../src/storage/hostdb";
import {
  ensureSkillsLoaded,
  resetSkillsForTest,
  skillsPromptBlock,
  skillsSnapshot,
  workspaceSkillsDir,
} from "../../src/skills/skills";
import { buildSkillUseTool } from "../../src/skills/skill-use-tool";
import { resetPluginsForTest } from "../../src/plugins/store";

const tmp = mkdtempSync(join(tmpdir(), "pi-agent-skill-ns-"));
const prevPluginsDir = process.env.PI_PLUGINS_DIR;
const prevSkillsDir = process.env.PI_SKILLS_DIR;
const prevCompatDir = process.env.PI_COMPAT_SKILLS_DIR;
const ws = join(tmp, "repo");

const skillDoc = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

function seedPlugin(
  name: string,
  skill: string,
  body: string,
  description = `${name} ${skill} skill`,
): void {
  const dir = join(tmp, "plugins", "cache", "local", name);
  mkdirSync(join(dir, ".codex-plugin"), { recursive: true });
  mkdirSync(join(dir, "skills", skill), { recursive: true });
  writeFileSync(
    join(dir, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name, version: "1.0.0", skills: "./skills/" }),
  );
  writeFileSync(join(dir, "skills", skill, "SKILL.md"), skillDoc(skill, description, body));
}

async function call(tool: AgentTool, params: Record<string, unknown>) {
  const result = (await tool.execute("tc-ns", params as never)) as {
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  };
  return {
    text: result.content.map((item) => item.text ?? "").join("\n"),
    details: result.details as Record<string, unknown> | undefined,
  };
}

beforeAll(async () => {
  initLocalStorage(join(tmp, "state.db"));
  process.env.PI_PLUGINS_DIR = join(tmp, "plugins");
  process.env.PI_SKILLS_DIR = join(tmp, "system-skills");
  process.env.PI_COMPAT_SKILLS_DIR = join(tmp, "compat-skills");
  mkdirSync(process.env.PI_SKILLS_DIR, { recursive: true });
  mkdirSync(process.env.PI_COMPAT_SKILLS_DIR, { recursive: true });
  mkdirSync(workspaceSkillsDir(ws), { recursive: true });

  // 两个插件都有 review/shared；工作区也有 review（测试普通技能优先）
  seedPlugin("alpha", "review", "ALPHA REVIEW BODY");
  seedPlugin("alpha", "shared", "ALPHA SHARED BODY");
  seedPlugin("beta", "review", "BETA REVIEW BODY");
  seedPlugin("beta", "shared", "BETA SHARED BODY");
  seedPlugin(
    "alpha",
    "longdesc",
    "ALPHA LONG BODY",
    `${"描述".repeat(160)}TAIL-MARKER`,
  );
  // Codex 技能元数据：禁止隐式调用 + 声明 MCP 工具依赖
  seedPlugin("policy", "manual", "POLICY MANUAL BODY");
  const manualAgents = join(tmp, "plugins", "cache", "local", "policy", "skills", "manual", "agents");
  mkdirSync(manualAgents, { recursive: true });
  writeFileSync(
    join(manualAgents, "openai.yaml"),
    [
      "interface:",
      '  display_name: "Manual only"',
      "dependencies:",
      "  tools:",
      '    - type: "mcp"',
      '      value: "github"',
      '      description: "GitHub MCP server"',
      "policy:",
      "  allow_implicit_invocation: false",
    ].join("\n"),
  );
  writeFileSync(
    join(workspaceSkillsDir(ws), "review.md"),
    skillDoc("review", "workspace review skill", "WORKSPACE REVIEW BODY"),
  );

  resetPluginsForTest();
  resetSkillsForTest();
  await ensureSkillsLoaded(ws);
});

afterAll(() => {
  resetSkillsForTest();
  resetPluginsForTest();
  resetStorageForTest();
  for (const [key, value] of [
    ["PI_PLUGINS_DIR", prevPluginsDir],
    ["PI_SKILLS_DIR", prevSkillsDir],
    ["PI_COMPAT_SKILLS_DIR", prevCompatDir],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("插件技能命名空间", () => {
  test("跨插件同名技能共存，qualifiedName 进入提示词", () => {
    const active = skillsSnapshot(ws).activeSkills;
    expect(active.some((skill) => skill.qualifiedName === "alpha:shared")).toBe(true);
    expect(active.some((skill) => skill.qualifiedName === "beta:shared")).toBe(true);
    const prompt = skillsPromptBlock(ws);
    expect(prompt).toContain("<name>alpha:shared</name>");
    expect(prompt).toContain("<name>beta:shared</name>");
    // 插件描述上限放宽到 400：250 字符之后的触发场景尾部不能被截掉
    expect(prompt).toContain("TAIL-MARKER");
    const entries = skillsSnapshot(ws).entries.filter((entry) => entry.name === "shared");
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => !entry.shadowed)).toBe(true);
    expect(entries.map((entry) => entry.qualifiedName).sort()).toEqual([
      "alpha:shared",
      "beta:shared",
    ]);
  });

  test("use_skill：qualified 精确加载；裸名歧义报错", async () => {
    const tool = buildSkillUseTool(ws, "thread-ns");
    const qualified = await call(tool, { name: "alpha:shared" });
    expect(qualified.text).toContain("ALPHA SHARED BODY");
    expect(qualified.details).toMatchObject({ qualifiedName: "alpha:shared" });

    const ambiguous = await call(tool, { name: "shared" });
    expect(ambiguous.text).toContain("多个插件中重名");
    expect(ambiguous.text).toContain("alpha:shared");
    expect(ambiguous.text).toContain("beta:shared");
  });

  test("use_skill：普通技能裸名优先于插件同名技能", async () => {
    const tool = buildSkillUseTool(ws, "thread-ns");
    const bare = await call(tool, { name: "review" });
    expect(bare.text).toContain("WORKSPACE REVIEW BODY");
    const qualified = await call(tool, { name: "beta:review" });
    expect(qualified.text).toContain("BETA REVIEW BODY");
  });

  test("agents/openai.yaml：allow_implicit_invocation=false 不进模型目录，依赖声明进诊断", async () => {
    const snap = skillsSnapshot(ws);
    const manual = snap.entries.find((entry) => entry.name === "manual");
    expect(manual?.disableModelInvocation).toBe(true);
    expect(skillsPromptBlock(ws)).not.toContain("policy:manual");
    expect(snap.diagnostics.some((d) => d.includes("github"))).toBe(true);
    // 显式调用也被拒绝：该技能只留给用户侧入口
    const tool = buildSkillUseTool(ws, "thread-ns");
    const denied = await call(tool, { name: "policy:manual" });
    expect(denied.text).toContain("不可模型调用");
  });
});
