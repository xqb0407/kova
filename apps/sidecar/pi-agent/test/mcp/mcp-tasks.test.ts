import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { mcpManager } from "../../src/mcp/mcp-manager";
import { resetMcpCacheForTest, getValidServerMeta, updateServerMeta } from "../../src/mcp/mcp-cache";
import {
  resetMcpTasksForTest,
  getMcpTask,
  mcpTasksPath,
  upsertMcpTask,
  settleMcpTask,
  updateMcpTaskStatus,
} from "../../src/mcp/mcp-task-store";
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

describe("审查回归（M2.2 后）", () => {
  test("optional 工具在服务器未声明 tasks 时走普通 call（不炸能力闸门）", async () => {
    // fake server 用 MCP_FAKE_TASK=1；这里构造 taskSupport=optional 但
    // capabilities.tasks=false 的组合，走 executeCall 普通路径。
    const { writeFileSync, rmSync } = await import("node:fs");
    const optConfig = path.join(tmpdir(), "opt-mcp.json");
    process.env.PI_MCP_CONFIG = optConfig;
    writeFileSync(
      optConfig,
      JSON.stringify({
        mcpServers: {
          "opt-fake": {
            type: "stdio",
            command: process.execPath,
            args: [FAKE_SERVER],
          },
        },
      }),
      "utf8",
    );
    const { resetMcpConfigForTest } = await import("../../src/mcp/mcp-config");
    resetMcpConfigForTest();
    resetMcpCacheForTest();
    resetMcpTasksForTest();
    const def: McpServerDef = {
      name: "opt-fake",
      transport: "stdio",
      command: process.execPath,
      args: [FAKE_SERVER],
      layer: "system",
      source: "",
      // 无 MCP_FAKE_TASK → 服务器不声明 tasks 能力
    };
    await mcpManager.ensureConnected(def);
    // 手工把工具元数据改成 optional（fake server 的 echo 无 execution 字段）
    const meta = getValidServerMeta(def)!;
    meta.tools = meta.tools.map((t) =>
      t.name === "echo" ? { ...t, taskSupport: "optional" as const } : t,
    );
    updateServerMeta(def, meta);

    const { buildMcpTool } = await import("../../src/mcp/mcp-tools");
    // 完全访问档：本测试只验证分流，不验证审批
    const tool = buildMcpTool(tmpdir(), "opt-thread", undefined, () => "auto");
    const result = (await tool.execute("opt-1", {
      action: "call",
      tool: "opt-fake__echo",
      args: '{"text":"plain"}',
    })) as { content: Array<{ text: string }>; details?: Record<string, unknown> };
    expect(result.content[0]?.text).toContain("echo:plain");
    expect(result.details?.task).toBeUndefined();
    rmSync(optConfig, { force: true });
    delete process.env.PI_MCP_CONFIG;
    resetMcpConfigForTest();
  });

  test("mcpSecretBindingStale 对 http 绑定按哈希判定", async () => {
    const { mcpSecretBindingStale, saveMcpSecretBindings, resetMcpSecretBindingsForTest } =
      await import("../../src/mcp/mcp-secrets");
    const { initLocalStorage, resetStorageForTest } = await import(
      "../../src/storage/hostdb"
    );
    initLocalStorage(path.join(tmpdir(), "pi-agent-stale-http"));
    try {
      const def: McpServerDef = {
        name: "stale-hdr",
        transport: "http",
        url: "https://stale.example/mcp",
        layer: "system",
        source: "",
      };
      resetMcpSecretBindingsForTest();
      await saveMcpSecretBindings(def, [{ headerName: "Authorization", name: "T" }]);
      expect(await mcpSecretBindingStale(def)).toBe(false);
      const edited = { ...def, url: "https://stale.example/v2/mcp" };
      expect(await mcpSecretBindingStale(edited)).toBe(true);
    } finally {
      resetStorageForTest();
      resetMcpSecretBindingsForTest();
    }
  });
});

describe("task 台账冻结语义（第四轮审查回归）", () => {
  test("已结算条目：迟到轮询不覆盖终态状态/消息", async () => {
    resetMcpTasksForTest();
    upsertMcpTask({
      taskId: "f1",
      server: "s",
      tool: "longjob",
      threadId: "frozen-thread",
      createdAt: Date.now(),
      status: "working",
      statusMessage: "job finished",
      ttl: null,
    });
    settleMcpTask("s", "f1");
    // settle 后 status 变 "settled" + settled=true；SDK Task.statusMessage 可选，
    // 迟到轮询无消息时不得抹掉
    updateMcpTaskStatus("s", "f1", "completed", undefined);
    const rec = getMcpTask("s", "f1");
    expect(rec?.status).toBe("settled");
    expect(rec?.settled).toBe(true);
    // 未结算条目保持原语义：undefined 清消息
    upsertMcpTask({
      taskId: "f2",
      server: "s",
      tool: "longjob",
      threadId: "frozen-thread",
      createdAt: Date.now(),
      status: "working",
      statusMessage: "halfway",
      ttl: null,
    });
    updateMcpTaskStatus("s", "f2", "working", undefined);
    expect(getMcpTask("s", "f2")?.statusMessage).toBeUndefined();
  });
});
