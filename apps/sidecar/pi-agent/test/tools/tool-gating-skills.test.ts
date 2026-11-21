/**
 * use_skill 条件注册回归门：没有任何生效技能时工具不进工具表（提示词里也
 * 没有技能目录，给了只会让模型白调一次），新增技能后 next build 即恢复。
 * 目录/插件根全部钉到 tmp，不碰真实 ~/.kova / ~/.agents。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalStorage, resetStorageForTest } from "../../src/storage/hostdb";
import {
  ensureSkillsLoaded,
  renderSkillDoc,
  resetSkillsForTest,
  workspaceSkillsDir,
} from "../../src/skills/skills";
import { buildTools } from "../../src/tools/tools";

const tmp = mkdtempSync(join(tmpdir(), "pi-agent-skill-gate-"));
const ws = join(tmp, "repo");
const prevSkillsDir = process.env.PI_SKILLS_DIR;
const prevCompatDir = process.env.PI_COMPAT_SKILLS_DIR;
const prevPluginsDir = process.env.PI_PLUGINS_DIR;

beforeAll(() => {
  initLocalStorage(join(tmp, "state.db"));
  process.env.PI_SKILLS_DIR = join(tmp, "system-skills");
  process.env.PI_COMPAT_SKILLS_DIR = join(tmp, "compat-skills");
  process.env.PI_PLUGINS_DIR = join(tmp, "plugins");
  mkdirSync(process.env.PI_SKILLS_DIR, { recursive: true });
  mkdirSync(process.env.PI_COMPAT_SKILLS_DIR, { recursive: true });
  mkdirSync(process.env.PI_PLUGINS_DIR, { recursive: true });
  mkdirSync(workspaceSkillsDir(ws), { recursive: true });
});

afterAll(() => {
  resetSkillsForTest();
  resetStorageForTest();
  for (const [key, value] of [
    ["PI_SKILLS_DIR", prevSkillsDir],
    ["PI_COMPAT_SKILLS_DIR", prevCompatDir],
    ["PI_PLUGINS_DIR", prevPluginsDir],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function toolNames(): string[] {
  return buildTools(ws, "t-skill-gate").map((tool) => tool.name);
}

describe("条件注入：use_skill", () => {
  test("没有任何生效技能不注入；新增技能后注入", async () => {
    await ensureSkillsLoaded(ws, []);
    expect(toolNames()).not.toContain("use_skill");

    writeFileSync(
      join(workspaceSkillsDir(ws), "demo.md"),
      renderSkillDoc({
        name: "demo",
        description: "演示技能",
        content: "按演示步骤执行。",
      }),
      "utf8",
    );
    await ensureSkillsLoaded(ws, []);
    expect(toolNames()).toContain("use_skill");
  });
});
