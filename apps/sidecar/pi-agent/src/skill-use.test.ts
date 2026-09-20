/**
 * 技能调用工具（use_skill）的行为测试：
 * 走真实存储层（tmp 目录 + 本地 SQLite kv），覆盖加载回执、磁盘现值、
 * 未知名/停用/遮蔽/不可模型调用的拒绝路径，以及目录段提示词的改道指引。
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { initLocalStorage, resetStorageForTest } from "./hostdb";
import {
  ensureSkillsLoaded,
  renderSkillDoc,
  resetSkillsForTest,
  setSkillsEnabled,
  skillsPromptBlock,
  workspaceSkillsDir,
} from "./skills";
import { SKILL_USE_TOOL_NAME, buildSkillUseTool } from "./skill-use-tool";

const tmp = mkdtempSync(join(tmpdir(), "pi-agent-skilluse-"));
const prevSkillsDir = process.env.PI_SKILLS_DIR;
const prevCompatDir = process.env.PI_COMPAT_SKILLS_DIR;
const sysDir = join(tmp, "system-skills");
const ws = join(tmp, "repo");

beforeAll(async () => {
  initLocalStorage(join(tmp, "state.db"));
  // 目录钉到 tmp：绝不碰真实 ~/.xulux / ~/.agents
  process.env.PI_SKILLS_DIR = sysDir;
  process.env.PI_COMPAT_SKILLS_DIR = join(tmp, "compat-empty");
  mkdirSync(sysDir, { recursive: true });
  mkdirSync(process.env.PI_COMPAT_SKILLS_DIR, { recursive: true });
  mkdirSync(workspaceSkillsDir(ws), { recursive: true });
});

afterAll(() => {
  resetSkillsForTest();
  resetStorageForTest();
  if (prevSkillsDir === undefined) delete process.env.PI_SKILLS_DIR;
  else process.env.PI_SKILLS_DIR = prevSkillsDir;
  if (prevCompatDir === undefined) delete process.env.PI_COMPAT_SKILLS_DIR;
  else process.env.PI_COMPAT_SKILLS_DIR = prevCompatDir;
});

function writeSkill(dir: string, file: string, doc: Parameters<typeof renderSkillDoc>[0]) {
  writeFileSync(join(dir, file), renderSkillDoc(doc), "utf8");
}

async function call(
  tool: AgentTool,
  params: Record<string, unknown>,
): Promise<{ text: string; details?: unknown }> {
  const r = (await tool.execute("tc-1", params as never)) as {
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  };
  return {
    text: r.content.map((c) => c.text ?? "").join("\n"),
    details: r.details,
  };
}

describe("use_skill", () => {
  test("按名加载正文，回执带来源层与技能目录锚点", async () => {
    writeSkill(sysDir, "commit-style.md", {
      name: "commit-style",
      description: "写提交信息时使用",
      content: "遵循 Conventional Commits，参考 templates/example.txt。",
    });
    const tool = buildSkillUseTool(ws);
    const res = await call(tool, { name: "commit-style" });
    expect(res.text).toContain('已加载技能 "commit-style"（系统）');
    expect(res.text).toContain(join(sysDir, "commit-style.md"));
    expect(res.text).toContain(`技能目录：${sysDir}`);
    expect(res.text).toContain("遵循 Conventional Commits");
    expect(res.details).toMatchObject({ name: "commit-style", scope: "system" });
  });

  test("正文改动即时生效（磁盘现值，不等目录缓存）", async () => {
    writeSkill(sysDir, "commit-style.md", {
      name: "commit-style",
      description: "写提交信息时使用",
      content: "更新后的指令正文。",
    });
    const tool = buildSkillUseTool(ws);
    const res = await call(tool, { name: "commit-style" });
    expect(res.text).toContain("更新后的指令正文");
  });

  test("工作区同名技能遮蔽系统层", async () => {
    writeSkill(workspaceSkillsDir(ws), "commit-style.md", {
      name: "commit-style",
      description: "本仓库提交规范",
      content: "项目层指令。",
    });
    const tool = buildSkillUseTool(ws);
    const res = await call(tool, { name: "commit-style" });
    expect(res.text).toContain("项目层指令");
    expect(res.text).toContain("（项目）");
  });

  test("未知名报错并列出可用技能", async () => {
    const tool = buildSkillUseTool(ws);
    const res = await call(tool, { name: "no-such-skill" });
    expect(res.text).toMatch(/^错误：/);
    expect(res.text).toContain("commit-style");
  });

  test("开关关闭的技能不可加载", async () => {
    writeSkill(sysDir, "quiet-skill.md", {
      name: "quiet-skill",
      description: "临时停用",
      content: "不应被读到",
    });
    await ensureSkillsLoaded(ws);
    await setSkillsEnabled([{ scope: "system", name: "quiet-skill" }], false);
    const tool = buildSkillUseTool(ws);
    const res = await call(tool, { name: "quiet-skill" });
    expect(res.text).toMatch(/^错误：/);
    expect(res.text).toContain("启用开关已关闭");
    await setSkillsEnabled([{ scope: "system", name: "quiet-skill" }], true);
  });

  test("disable-model-invocation 技能不可经工具加载", async () => {
    writeSkill(sysDir, "manual-only.md", {
      name: "manual-only",
      description: "仅用户显式调用",
      content: "不应被模型读到",
      disableModelInvocation: true,
    });
    await ensureSkillsLoaded(ws);
    const tool = buildSkillUseTool(ws);
    const res = await call(tool, { name: "manual-only" });
    expect(res.text).toMatch(/^错误：/);
    expect(res.text).toContain("不可模型调用");
  });

  test("空名报错", async () => {
    const tool = buildSkillUseTool(ws);
    const res = await call(tool, { name: "  " });
    expect(res.text).toMatch(/^错误：/);
  });
});

describe("skillsPromptBlock 指引改道", () => {
  test("目录段指向 use_skill 而非 read", async () => {
    await ensureSkillsLoaded(ws);
    const block = skillsPromptBlock(ws);
    expect(block).toContain("<available_skills>");
    expect(block).toContain("call the use_skill tool");
    expect(block).not.toContain("Read the full skill file");
  });
});
