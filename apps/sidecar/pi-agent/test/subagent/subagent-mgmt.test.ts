/**
 * 子智能体管理工具（subagents_list/save/delete）的行为测试：
 * 执行体走真实存储层（tmp 目录 + 本地 SQLite kv），reload 用计数器注入。
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { initLocalStorage, resetStorageForTest } from "../../src/storage/hostdb";
import {
  loadSubagentDefinitions,
  resetSubagentsForTest,
  workspaceSubagentsDir,
} from "../../src/subagent/subagent-definitions";
import { APPROVAL_REQUIRED_TOOLS } from "../../src/agent/modes";
import { buildSubagentTools } from "../../src/subagent/subagent";
import {
  SUBAGENT_MGMT_TOOL_NAMES,
  buildSubagentMgmtTools,
} from "../../src/subagent/subagent-mgmt-tools";
import type { Running } from "../../src/types";

const tmp = mkdtempSync(join(tmpdir(), "pi-agent-mgmt-"));

beforeAll(() => {
  initLocalStorage(join(tmp, "state.db"));
  process.env.PI_SUBAGENTS_DIR = join(tmp, "system-subs");
});

afterAll(() => {
  resetSubagentsForTest();
  resetStorageForTest();
  delete process.env.PI_SUBAGENTS_DIR;
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
  name: "api-doc-writer",
  description: "为指定模块整理对外 API 文档时使用。",
  tools: ["read", "grep", "glob"],
  prompt: "你是文档工程师：读源码，输出用法与参数表。",
};

describe("subagents_save", () => {
  test("系统级保存：落盘 + reload 触发 + 下一轮即可列出", async () => {
    const run = makeRun(join(tmp, "ws-a"));
    let reloads = 0;
    const tools = buildSubagentMgmtTools(run, async () => {
      reloads += 1;
    });
    const res = await call(tools, SUBAGENT_MGMT_TOOL_NAMES.save, validSave);
    expect(res.text).toContain("已保存（系统级）");
    expect(reloads).toBe(1);
    const sysDir = process.env.PI_SUBAGENTS_DIR!;
    expect(readdirSync(sysDir).some((f) => f.endsWith(".yml"))).toBe(true);
    const load = await loadSubagentDefinitions({ cwd: run.cwd });
    expect(
      load.entries.some(
        (e) => e.scope === "system" && e.name === "api-doc-writer" && e.enabled,
      ),
    ).toBe(true);
  });

  test("同名覆盖即更新：不报错、不重复落盘", async () => {
    const run = makeRun(join(tmp, "ws-a"));
    let reloads = 0;
    const tools = buildSubagentMgmtTools(run, async () => {
      reloads += 1;
    });
    const res = await call(tools, SUBAGENT_MGMT_TOOL_NAMES.save, {
      ...validSave,
      description: "为指定模块整理 API 文档，含示例。",
    });
    expect(res.text).toContain("已保存");
    expect(reloads).toBe(1);
    const sysDir = process.env.PI_SUBAGENTS_DIR!;
    expect(readdirSync(sysDir).filter((f) => f.endsWith(".yml")).length).toBe(1);
  });

  test("非法工具名单：中文错误直回，不落盘不 reload", async () => {
    const run = makeRun(join(tmp, "ws-a"));
    let reloads = 0;
    const tools = buildSubagentMgmtTools(run, async () => {
      reloads += 1;
    });
    const res = await call(tools, SUBAGENT_MGMT_TOOL_NAMES.save, {
      ...validSave,
      name: "bad-tools",
      tools: ["read", "Task"],
    });
    expect(res.text.startsWith("错误：")).toBe(true);
    expect(reloads).toBe(0);
    const load = await loadSubagentDefinitions({ cwd: run.cwd });
    expect(load.entries.some((e) => e.name === "bad-tools")).toBe(false);
  });

  test("与内置重名被拒；scope=builtin 直接拒", async () => {
    const run = makeRun(join(tmp, "ws-a"));
    const tools = buildSubagentMgmtTools(run, async () => {});
    const dup = await call(tools, SUBAGENT_MGMT_TOOL_NAMES.save, {
      ...validSave,
      name: "explorer",
    });
    expect(dup.text).toContain("内置");
    const builtinScope = await call(tools, SUBAGENT_MGMT_TOOL_NAMES.save, {
      ...validSave,
      scope: "builtin",
    });
    expect(builtinScope.text).toContain("内置");
  });

  test("工作区保存即挂载并热重载", async () => {
    const ws = join(tmp, "ws-untrusted");
    const run = makeRun(ws);
    let reloads = 0;
    const tools = buildSubagentMgmtTools(run, async () => {
      reloads += 1;
    });
    const res = await call(tools, SUBAGENT_MGMT_TOOL_NAMES.save, {
      ...validSave,
      scope: "workspace",
      name: "repo-helper",
    });
    expect(res.text).toContain("已保存（工作区级）");
    expect(existsSync(join(workspaceSubagentsDir(ws), "repo-helper.yml"))).toBe(true);
    const load = await loadSubagentDefinitions({ cwd: ws });
    expect(load.definitions.some((e) => e.name === "repo-helper")).toBe(true);
    expect(reloads).toBe(1);
  });
});

describe("subagents_delete", () => {
  test("删除存在的定义：文件消失 + reload", async () => {
    const run = makeRun(join(tmp, "ws-a"));
    let reloads = 0;
    const tools = buildSubagentMgmtTools(run, async () => {
      reloads += 1;
    });
    const del = await call(tools, SUBAGENT_MGMT_TOOL_NAMES.delete, {
      scope: "system",
      name: "api-doc-writer",
    });
    expect(del.text).toContain("已删除");
    expect(reloads).toBe(1);
    expect(readdirSync(process.env.PI_SUBAGENTS_DIR!).length).toBe(0);
    const load = await loadSubagentDefinitions({ cwd: run.cwd });
    expect(load.entries.some((e) => e.name === "api-doc-writer")).toBe(false);
  });

  test("未知名称：错误直回，不触发 reload", async () => {
    const run = makeRun(join(tmp, "ws-a"));
    let reloads = 0;
    const tools = buildSubagentMgmtTools(run, async () => {
      reloads += 1;
    });
    const res = await call(tools, SUBAGENT_MGMT_TOOL_NAMES.delete, {
      scope: "system",
      name: "no-such-agent",
    });
    expect(res.text.startsWith("错误：")).toBe(true);
    expect(res.text).toContain("未找到");
    expect(reloads).toBe(0);
  });
});

describe("subagents_list", () => {
  test("输出目录与挂载条目", async () => {
    const run = makeRun(join(tmp, "ws-list"));
    const tools = buildSubagentMgmtTools(run, async () => {});
    const res = await call(tools, SUBAGENT_MGMT_TOOL_NAMES.list, {});
    expect(res.text).toContain(process.env.PI_SUBAGENTS_DIR!);
    expect(res.text).toContain(workspaceSubagentsDir(run.cwd));
    expect(res.text).toContain("[内置] Explorer");
  });
});

describe("挂载与审批门", () => {
  test("buildSubagentTools 返回 Task 组 + 三个管理工具", () => {
    const run = makeRun(tmp);
    const tools = buildSubagentTools(run, [], [], async () => {});
    expect(tools.map((t) => t.name)).toEqual([
      "Task",
      "TaskWait",
      "TaskList",
      "TaskStop",
      SUBAGENT_MGMT_TOOL_NAMES.list,
      SUBAGENT_MGMT_TOOL_NAMES.save,
      SUBAGENT_MGMT_TOOL_NAMES.delete,
    ]);
  });

  test("save/delete 进审批门，list 不进", () => {
    expect(APPROVAL_REQUIRED_TOOLS.has(SUBAGENT_MGMT_TOOL_NAMES.save)).toBe(true);
    expect(APPROVAL_REQUIRED_TOOLS.has(SUBAGENT_MGMT_TOOL_NAMES.delete)).toBe(true);
    expect(APPROVAL_REQUIRED_TOOLS.has(SUBAGENT_MGMT_TOOL_NAMES.list)).toBe(false);
  });
});
