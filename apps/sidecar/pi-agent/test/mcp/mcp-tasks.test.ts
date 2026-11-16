import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { mcpManager } from "../../src/mcp/mcp-manager";
import { resetMcpCacheForTest, getValidServerMeta } from "../../src/mcp/mcp-cache";
import { resetMcpTasksForTest, getMcpTask, mcpTasksPath } from "../../src/mcp/mcp-task-store";
import { shouldUseTask } from "../../src/mcp/mcp-tasks";
import { readMcpAudit } from "../../src/mcp/mcp-audit";
import type { McpServerDef } from "../../src/mcp/mcp-config";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-mcp-tasks-"));
const prevCachePath = process.env.PI_MCP_CACHE_PATH;
const prevAuditPath = process.env.PI_MCP_AUDIT_PATH;
const prevTasksPath = process.env.PI_MCP_TASKS_PATH;

const FAKE_SERVER = join(import.meta.dir, "..", "fake-mcp-server.mjs");

// StdioClientTransport 只传显式 env（白名单纪律）：MCP_FAKE_TASK 必须经
// def.env 进子进程，不能依赖测试进程的环境。
const taskDef = (): McpServerDef => ({
  name: "taskfake",
  transport: "stdio",
  command: process.execPath,
  args: [FAKE_SERVER],
  env: { MCP_FAKE_TASK: "1" },
  layer: "system",
  source: "",
});

beforeAll(() => {
  process.env.PI_MCP_CACHE_PATH = path.join(tmp, "cache.json");
  process.env.PI_MCP_AUDIT_PATH = path.join(tmp, "audit.jsonl");
  process.env.PI_MCP_TASKS_PATH = path.join(tmp, "tasks.json");
});

afterAll(() => {
  mcpManager.disposeAll();
  for (const k of ["PI_MCP_CACHE_PATH", "PI_MCP_AUDIT_PATH", "PI_MCP_TASKS_PATH", "MCP_FAKE_TASK"]) {
    const prev = { "PI_MCP_CACHE_PATH": prevCachePath, "PI_MCP_AUDIT_PATH": prevAuditPath, "PI_MCP_TASKS_PATH": prevTasksPath }[k];
    if (prev === undefined) delete process.env[k];
    else process.env[k] = prev as string;
  }
});

describe("MCP Tasks（M2.1）", () => {
  test("握手记录 tasks 能力与 taskSupport 元数据", async () => {
    resetMcpCacheForTest();
    resetMcpTasksForTest();
    const def = taskDef();
    await mcpManager.ensureConnected(def);
    const status = mcpManager.statusFor(def);
    expect(status.capabilities.tasks).toBe(true);
    expect(status.toolNames).toContain("longjob");
    const meta = getValidServerMeta(def);
    const longjob = meta?.tools.find((t) => t.name === "longjob");
    expect(longjob?.taskSupport).toBe("required");
    expect(shouldUseTask(longjob!, { tasks: true })).toBe(true);
  });

  test("required 工具经 task 调用：taskCreated 记账 + result 结算", async () => {
    const def = taskDef();
    const outcome = await mcpManager.callToolAsTask(
      def,
      "longjob",
      {},
      { threadId: "task-thread", sessionId: "task-session" },
    );
    // fake 服务器立即完成：manager 返回 { kind: "result", result: CallToolResult }
    expect(
      typeof outcome === "object" && outcome !== null && (outcome as { kind?: string }).kind,
    ).toBe("result");
    const result = (outcome as { kind: "result"; result: unknown }).result as {
      content?: Array<{ text: string }>;
    };
    expect(result.content?.[0]?.text).toBe("job:ok");
    const events = readMcpAudit({ server: "taskfake", limit: 50 });
    expect(events.some((e) => e.kind === "task_start")).toBe(true);
    expect(events.some((e) => e.kind === "task_done")).toBe(true);
    // 台账条目已结算
    const tasks = Array.from(
      new Set(
        events.filter((e) => e.kind === "task_start").map((e) => e.detail?.split("→ ")[1] ?? ""),
      ),
    );
    expect(tasks.length).toBeGreaterThan(0);
  });

  test("hang 任务：pending 信封 + task_status/task_result/task_cancel", async () => {
    const def = taskDef();
    const outcome = (await mcpManager.callToolAsTask(
      def,
      "longjob",
      { mode: "hang" },
      { threadId: "hang-thread" },
    )) as { kind: string; taskId: string; record: { status: string } };
    expect(outcome.kind).toBe("pending");
    expect(outcome.record.status).toBe("working");
    const taskId = outcome.taskId;

    // status：working
    const working = await mcpManager.taskStatus(def, taskId);
    expect(working.ok).toBe(true);
    if (working.ok) expect(working.task.status).toBe("working");

    // result（未完成）：失败信息
    const early = await mcpManager.taskResult(def, taskId);
    expect(early.ok).toBe(false);

    // cancel：OK，状态转 cancelled
    const cancel = await mcpManager.taskCancel(def, taskId);
    expect(cancel.ok).toBe(true);
    const after = await mcpManager.taskStatus(def, taskId);
    if (after.ok) expect(after.task.status).toBe("cancelled");
    const record = getMcpTask("taskfake", taskId);
    expect(record?.settled).toBe(true);
  });

  test("未知 taskId：报错不落地", async () => {
    const def = taskDef();
    const status = await mcpManager.taskStatus(def, "no-such-task");
    expect(status.ok).toBe(false);
  });
});
