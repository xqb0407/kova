/**
 * 技能管理工具（skills_list/save/delete）的行为测试：
 * 执行体走真实存储层（tmp 目录 + 本地 SQLite kv），reload 用计数器注入。
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { initLocalStorage, resetStorageForTest } from "./hostdb";
import {
  ensureSkillsLoaded,
  resetSkillsForTest,
  skillsSnapshot,
  workspaceSkillsDir,
} from "./skills";
import { APPROVAL_REQUIRED_TOOLS } from "./modes";
import {
  SKILL_MGMT_TOOL_NAMES,
  buildSkillMgmtTools,
} from "./skill-mgmt-tools";
import type { Running } from "./types";

const tmp = mkdtempSync(join(tmpdir(), "pi-agent-skillmgmt-"));
const prevSkillsDir = process.env.PI_SKILLS_DIR;
const prevCompatDir = process.env.PI_COMPAT_SKILLS_DIR;

beforeAll(() => {
  initLocalStorage(join(tmp, "state.db"));
  // 目录钉到 tmp：技能读写实时落盘，绝不碰真实 ~/.xulux / ~/.agents
  process.env.PI_SKILLS_DIR = join(tmp, "system-skills");
  process.env.PI_COMPAT_SKILLS_DIR = join(tmp, "compat-empty");
  mkdirSync(process.env.PI_SKILLS_DIR, { recursive: true });
  mkdirSync(process.env.PI_COMPAT_SKILLS_DIR, { recursive: true });
});

afterAll(() => {
  resetSkillsForTest();
  resetStorageForTest();
  if (prevSkillsDir === undefined) delete process.env.PI_SKILLS_DIR;
  else process.env.PI_SKILLS_DIR = prevSkillsDir;
  if (prevCompatDir === undefined) delete process.env.PI_COMPAT_SKILLS_DIR;
  else process.env.PI_COMPAT_SKILLS_DIR = prevCompatDir;
});

function makeRun(cwd: string): Running {
  return {
    cwd,
    mode: "agent",
    baseTools: [],
    subagentTools: [],
  } as unknown as Running;
}

function toolByName(tools: AgentTool[], name: string): AgentTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not built: ${name}`);
  return t;
}

async function call(
  tools: AgentTool[],
  name: string,
  params: Record<string, unknown>,
): Promise<{ text: string; details?: unknown }> {
  const r = (await toolByName(tools, name).execute("tc-1", params as never)) as {
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  };
  return {
    text: r.content.map((c) => c.text ?? "").join("\n"),
    details: r.details,
  };
}

const validSave = {
  scope: "system",
  name: "commit-style",
  description: "为本仓库撰写提交信息时使用。",
  content: "# 提交信息规范\n\n遵循 Conventional Commits，中文描述。",
};

describe("skills_save", () => {
  test("系统级保存：落盘 + reload 触发 + 快照即见", async () => {
    const run = makeRun(join(tmp, "ws-a"));
    let reloads = 0;
    const tools = buildSkillMgmtTools(run, async () => {
      reloads += 1;
    });
    const res = await call(tools, SKILL_MGMT_TOOL_NAMES.save, validSave);
    expect(res.text).toContain("已保存（系统级）");
    expect(reloads).toBe(1);
    expect(existsSync(join(process.env.PI_SKILLS_DIR!, "commit-style.md"))).toBe(true);
    await ensureSkillsLoaded(run.cwd);
    const entry = skillsSnapshot(run.cwd).entries.find((e) => e.name === "commit-style");
    expect(entry?.scope).toBe("system");
    expect(entry?.enabled).toBe(true);
    expect(entry?.description).toBe("为本仓库撰写提交信息时使用。");
  });

  test("同名覆盖即更新：不报错、不重复落盘", async () => {
    const run = makeRun(join(tmp, "ws-a"));
    let reloads = 0;
    const tools = buildSkillMgmtTools(run, async () => {
      reloads += 1;
    });
    const res = await call(tools, SKILL_MGMT_TOOL_NAMES.save, {
      ...validSave,
      description: "为本仓库撰写提交信息，含 scope 与正文规范。",
    });
    expect(res.text).toContain("已保存");
    expect(reloads).toBe(1);
    expect(
      readdirSync(process.env.PI_SKILLS_DIR!).filter((f) => f.endsWith(".md")).length,
    ).toBe(1);
  });

  test("校验失败：中文错误直回，不落盘不 reload", async () => {
    const run = makeRun(join(tmp, "ws-a"));
    let reloads = 0;
    const tools = buildSkillMgmtTools(run, async () => {
      reloads += 1;
    });
    const res = await call(tools, SKILL_MGMT_TOOL_NAMES.save, {
      ...validSave,
      name: "no-desc",
      description: "",
    });
    expect(res.text.startsWith("错误：")).toBe(true);
    expect(reloads).toBe(0);
    await ensureSkillsLoaded(run.cwd);
    expect(skillsSnapshot(run.cwd).entries.some((e) => e.name === "no-desc")).toBe(false);
  });

  test("scope 枚举外的值直回错误（含旧词 workspace）", async () => {
    const run = makeRun(join(tmp, "ws-a"));
    const tools = buildSkillMgmtTools(run, async () => {});
    for (const scope of ["compat", "builtin", "workspace"]) {
      const res = await call(tools, SKILL_MGMT_TOOL_NAMES.save, {
        ...validSave,
        scope,
        name: `bad-${scope}`,
      });
      expect(res.text.startsWith("错误：")).toBe(true);
    }
  });

  test("项目保存落到 <cwd>/.xulux/skills/", async () => {
    const ws = join(tmp, "ws-b");
    const run = makeRun(ws);
    let reloads = 0;
    const tools = buildSkillMgmtTools(run, async () => {
      reloads += 1;
    });
    const res = await call(tools, SKILL_MGMT_TOOL_NAMES.save, {
      ...validSave,
      scope: "project",
      name: "repo-rules",
    });
    expect(res.text).toContain("已保存（项目级）");
    expect(reloads).toBe(1);
    expect(existsSync(join(workspaceSkillsDir(ws), "repo-rules.md"))).toBe(true);
  });

  test("改名保存：replace_name 清掉旧文件", async () => {
    const run = makeRun(join(tmp, "ws-a"));
    const tools = buildSkillMgmtTools(run, async () => {});
    const res = await call(tools, SKILL_MGMT_TOOL_NAMES.save, {
      ...validSave,
      name: "commit-convention",
      replace_name: "commit-style",
    });
    expect(res.text).toContain("已保存");
    const files = readdirSync(process.env.PI_SKILLS_DIR!).filter((f) => f.endsWith(".md"));
    expect(files).toEqual(["commit-convention.md"]);
  });
});

describe("skills_delete", () => {
  test("删除存在的技能：文件消失 + reload", async () => {
    const run = makeRun(join(tmp, "ws-a"));
    let reloads = 0;
    const tools = buildSkillMgmtTools(run, async () => {
      reloads += 1;
    });
    const del = await call(tools, SKILL_MGMT_TOOL_NAMES.delete, {
      scope: "system",
      name: "commit-convention",
    });
    expect(del.text).toContain("已删除");
    expect(reloads).toBe(1);
    expect(existsSync(join(process.env.PI_SKILLS_DIR!, "commit-convention.md"))).toBe(false);
  });

  test("未知名称：错误直回，不触发 reload", async () => {
    const run = makeRun(join(tmp, "ws-a"));
    let reloads = 0;
    const tools = buildSkillMgmtTools(run, async () => {
      reloads += 1;
    });
    const res = await call(tools, SKILL_MGMT_TOOL_NAMES.delete, {
      scope: "system",
      name: "no-such-skill",
    });
    expect(res.text.startsWith("错误：")).toBe(true);
    expect(res.text).toContain("未找到");
    expect(reloads).toBe(0);
  });
});

describe("skills_list", () => {
  test("输出四层目录与条目状态", async () => {
    const ws = join(tmp, "ws-c");
    const run = makeRun(ws);
    const tools = buildSkillMgmtTools(run, async () => {});
    await call(tools, SKILL_MGMT_TOOL_NAMES.save, {
      ...validSave,
      scope: "project",
      name: "listee",
    });
    const res = await call(tools, SKILL_MGMT_TOOL_NAMES.list, {});
    expect(res.text).toContain(process.env.PI_SKILLS_DIR!);
    expect(res.text).toContain(workspaceSkillsDir(ws));
    expect(res.text).toContain("[项目] listee");
    expect(res.text).toContain("compat-empty");
  });
});

describe("审批门", () => {
  test("save/delete 进审批门，list 不进", () => {
    expect(APPROVAL_REQUIRED_TOOLS.has(SKILL_MGMT_TOOL_NAMES.save)).toBe(true);
    expect(APPROVAL_REQUIRED_TOOLS.has(SKILL_MGMT_TOOL_NAMES.delete)).toBe(true);
    expect(APPROVAL_REQUIRED_TOOLS.has(SKILL_MGMT_TOOL_NAMES.list)).toBe(false);
  });
});

describe("缺省 scope", () => {
  test("保存与删除不传 scope 均按系统级，路径由工具解析", async () => {
    const run = makeRun(join(tmp, "ws-a"));
    let reloads = 0;
    const tools = buildSkillMgmtTools(run, async () => {
      reloads += 1;
    });
    const { scope: _omit, ...noScope } = validSave;
    const saved = await call(tools, SKILL_MGMT_TOOL_NAMES.save, {
      ...noScope,
      name: "default-scope",
    });
    expect(saved.text).toContain("已保存（系统级）");
    expect(saved.text).toContain(process.env.PI_SKILLS_DIR!); // 回执回显真实落盘目录
    expect(existsSync(join(process.env.PI_SKILLS_DIR!, "default-scope.md"))).toBe(true);
    const deleted = await call(tools, SKILL_MGMT_TOOL_NAMES.delete, {
      name: "default-scope",
    });
    expect(deleted.text).toContain("已删除（系统级）");
    expect(existsSync(join(process.env.PI_SKILLS_DIR!, "default-scope.md"))).toBe(false);
    expect(reloads).toBe(2);
  });
});
