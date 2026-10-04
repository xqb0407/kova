import { describe, test, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import {
  buildMcpTool,
  resolveMcpApproval,
  cancelPendingMcpApprovals,
  pendingMcpApprovalCount,
  hasPendingMcpApproval,
  parseMcpToolFullName,
  isToolApprovedBy,
  scoreToolEntry,
  type ToolIndexEntry,
} from "../../src/mcp/mcp-tools";
import { mcpManager } from "../../src/mcp/mcp-manager";
import { resetMcpConfigForTest } from "../../src/mcp/mcp-config";
import { resetMcpCacheForTest } from "../../src/mcp/mcp-cache";
import { setActiveReqId } from "../../src/protocol/stream";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-mcp-tools-"));
const systemConfig = path.join(tmp, "mcp.json");
const cacheFile = path.join(tmp, "cache.json");
const prevConfig = process.env.PI_MCP_CONFIG;
const prevCachePath = process.env.PI_MCP_CACHE_PATH;
const prevAuditPath = process.env.PI_MCP_AUDIT_PATH;
const FAKE_SERVER = join(import.meta.dir, "..", "fake-mcp-server.mjs");

beforeEach(() => {
  process.env.PI_MCP_CONFIG = systemConfig;
  // 钉住缓存路径：绝不读写开发者真实的 ~/.kova/mcp-cache.json
  process.env.PI_MCP_CACHE_PATH = cacheFile;
  // 审计同理：绝不写真实的 ~/.kova/mcp-audit.jsonl
  process.env.PI_MCP_AUDIT_PATH = path.join(tmp, "audit.jsonl");
  if (existsSync(systemConfig)) unlinkSync(systemConfig);
  if (existsSync(cacheFile)) unlinkSync(cacheFile);
  mcpManager.disposeAll();
  resetMcpConfigForTest();
  resetMcpCacheForTest();
});

afterAll(() => {
  mcpManager.disposeAll();
  if (prevConfig === undefined) delete process.env.PI_MCP_CONFIG;
  else process.env.PI_MCP_CONFIG = prevConfig;
  if (prevCachePath === undefined) delete process.env.PI_MCP_CACHE_PATH;
  else process.env.PI_MCP_CACHE_PATH = prevCachePath;
  if (prevAuditPath === undefined) delete process.env.PI_MCP_AUDIT_PATH;
  else process.env.PI_MCP_AUDIT_PATH = prevAuditPath;
});

const writeConfig = (approveTools?: string[]) => {
  writeFileSync(
    systemConfig,
    JSON.stringify({
      mcpServers: {
        fake: {
          type: "stdio",
          command: process.execPath,
          args: [FAKE_SERVER],
          description: "fake server for tests",
          ...(approveTools ? { approveTools } : {}),
        },
      },
    }),
    "utf8",
  );
};

const tool = () => buildMcpTool(tmp, "thread-test");
type ToolResult = { content: Array<{ text: string }>; details?: Record<string, unknown> };
const textOf = (r: unknown) => (r as ToolResult).content[0].text;

/** 轮询等待审批挂起出现（execute 的握手是异步的） */
async function waitForApproval(approvalId: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasPendingMcpApproval(approvalId)) return;
    await Bun.sleep(20);
  }
  throw new Error(`approval ${approvalId} never appeared`);
}

describe("全名解析与 glob", () => {
  const servers = ["fake", "my_server", "my_server_2"];
  test("parseMcpToolFullName 最长前缀匹配（名字可含下划线）", () => {
    expect(parseMcpToolFullName("fake__echo", servers)).toEqual({ server: "fake", tool: "echo" });
    expect(parseMcpToolFullName("my_server_2__deep_tool_name", servers)).toEqual({
      server: "my_server_2",
      tool: "deep_tool_name",
    });
    expect(parseMcpToolFullName("unknown__echo", servers)).toBeNull();
    expect(parseMcpToolFullName("fake__", servers)).toBeNull();
  });

  test("isToolApprovedBy 匹配裸名与全名", () => {
    const def = {
      name: "fake",
      transport: "stdio" as const,
      layer: "system" as const,
      source: "",
      approveTools: ["echo*", "get_*"],
    };
    expect(isToolApprovedBy(def, "echo")).toBe(true);
    expect(isToolApprovedBy(def, "fake__echo")).toBe(true);
    expect(isToolApprovedBy(def, "get_file")).toBe(true);
    expect(isToolApprovedBy(def, "getfile")).toBe(false);
    expect(isToolApprovedBy(def, "echo_extra")).toBe(true);
    expect(isToolApprovedBy({ ...def, approveTools: ["*"] }, "anything")).toBe(true);
    expect(isToolApprovedBy({ ...def, approveTools: undefined }, "echo")).toBe(false);
  });
});

describe("搜索排名", () => {
  const mk = (name: string, description?: string): ToolIndexEntry => ({
    server: "s",
    def: { name: "s", transport: "stdio", layer: "system", source: "" },
    tool: { name, description },
  });
  test("名字命中 > 描述命中；前缀 > 包含", () => {
    const nameExact = scoreToolEntry(mk("screenshot"), "screenshot")!;
    const descOnly = scoreToolEntry(mk("other", "takes a screenshot"), "screenshot")!;
    expect(nameExact).toBeGreaterThan(descOnly);
    const prefix = scoreToolEntry(mk("search_files"), "search")!;
    const contains = scoreToolEntry(mk("files_search"), "search")!;
    expect(prefix).toBeGreaterThan(contains);
    expect(scoreToolEntry(mk("unrelated"), "screenshot")).toBeNull();
  });
});

describe("网关工具（fake server 集成）", () => {
  test("call：审批挂起 → 批准 → 执行返回", async () => {
    writeConfig();
    setActiveReqId("thread-test", "req-1");
    const pending = tool().execute("call-1", {
      action: "call",
      tool: "fake__echo",
      args: '{"text": "hello"}',
    });
    await waitForApproval("call-1:mcp");
    expect(resolveMcpApproval("call-1:mcp", true)).toBe(true);
    const result = (await pending) as ToolResult;
    setActiveReqId("thread-test", null);
    expect(textOf(result)).toBe("echo:hello");
    expect((result as ToolResult).details?.durationMs).toBeNumber();
    expect(pendingMcpApprovalCount()).toBe(0);
  });

  test("call：拒绝返回提示，不执行", async () => {
    writeConfig();
    setActiveReqId("thread-test", "req-1");
    const pending = tool().execute("call-2", {
      action: "call",
      tool: "fake__echo",
      args: "{}",
    });
    await waitForApproval("call-2:mcp");
    resolveMcpApproval("call-2:mcp", false);
    const result = (await pending) as ToolResult;
    setActiveReqId("thread-test", null);
    expect(textOf(result)).toContain("User rejected");
    expect((result as ToolResult).details?.approved).toBe(false);
  });

  test("call：approveTools glob 豁免审批", async () => {
    writeConfig(["echo*"]);
    setActiveReqId("thread-test", "req-1");
    const result = (await tool().execute("call-3", {
      action: "call",
      tool: "fake__echo",
      args: '{"text": "auto"}',
    })) as ToolResult;
    setActiveReqId("thread-test", null);
    expect(pendingMcpApprovalCount()).toBe(0);
    expect(textOf(result)).toBe("echo:auto");
  });

  test("call：返回图片的服务器 → image 块透进 content（供投影上屏）", async () => {
    writeConfig(["echo*"]); // glob 豁免审批，直达执行
    setActiveReqId("thread-test", "req-1");
    const result = (await tool().execute("img-1", {
      action: "call",
      tool: "fake__echo",
      args: '{"text": "IMG"}',
    })) as {
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    };
    setActiveReqId("thread-test", null);
    // text 块在前、image 块在后；image 携带 base64 与 mimeType
    expect(result.content[0]).toMatchObject({ type: "text", text: "echo:IMG" });
    const img = result.content.find((b) => b.type === "image");
    expect(img).toBeTruthy();
    expect(img!.mimeType).toBe("image/png");
    expect(typeof img!.data).toBe("string");
    expect((img!.data ?? "").length).toBeGreaterThan(0);
  });

  test("call：args 非法 JSON / 未知服务器 / 未知工具的降级文案", async () => {
    writeConfig(["*"]);
    const t = tool();
    const badArgs = (await t.execute("c1", {
      action: "call",
      tool: "fake__echo",
      args: "{broken",
    })) as ToolResult;
    expect(textOf(badArgs)).toContain("args is not valid JSON");
    const unknownServer = (await t.execute("c2", {
      action: "call",
      tool: "ghost__echo",
      args: "{}",
    })) as ToolResult;
    expect(textOf(unknownServer)).toContain("Unknown MCP server");
    const notAdvertised = (await t.execute("c3", {
      action: "call",
      tool: "fake__no_such",
      args: "{}",
    })) as ToolResult;
    expect(textOf(notAdvertised)).toContain("未提供工具");
  });

  test("search：连接前走缓存为空提示，连接后命中", async () => {
    writeConfig();
    const t = tool();
    const before = (await t.execute("s1", { action: "search", query: "echo" })) as ToolResult;
    expect(textOf(before)).toContain("No MCP tools available");
    // 触发连接（审批放行后调用并写入缓存）
    const warm = t.execute("s2", { action: "call", tool: "fake__echo", args: '{"text":"warm"}' });
    await waitForApproval("s2:mcp");
    resolveMcpApproval("s2:mcp", true);
    await warm;
    const after = (await t.execute("s3", { action: "search", query: "echo" })) as ToolResult;
    expect(textOf(after)).toContain("fake__echo");
  });

  test("describe：返回 JSON Schema", async () => {
    writeConfig();
    const t = tool();
    const warm = t.execute("d0", { action: "call", tool: "fake__echo", args: '{"text":"warm"}' });
    await waitForApproval("d0:mcp");
    resolveMcpApproval("d0:mcp", true);
    await warm;
    const result = (await t.execute("d1", {
      action: "describe",
      tool: "fake__echo",
    })) as ToolResult;
    expect(textOf(result)).toContain("fake__echo");
    expect(textOf(result)).toContain("JSON Schema");
    expect(textOf(result)).toContain('"text"');
  });

  test("status：列出状态行", async () => {
    writeConfig();
    const t = tool();
    const result = (await t.execute("st1", { action: "status" })) as ToolResult;
    expect(textOf(result)).toContain("fake: idle");
    const warm = t.execute("st2", { action: "call", tool: "fake__echo", args: '{"text":"w"}' });
    await waitForApproval("st2:mcp");
    resolveMcpApproval("st2:mcp", true);
    await warm;
    const ready = (await t.execute("st3", { action: "status" })) as ToolResult;
    expect(textOf(ready)).toMatch(/fake: ready \(6 tools\)/);
  });

  test("取消挂起审批按拒绝结算（Stop 兜底）", async () => {
    writeConfig();
    setActiveReqId("thread-test", "req-1");
    const pending = tool().execute("x1", {
      action: "call",
      tool: "fake__echo",
      args: "{}",
    });
    await waitForApproval("x1:mcp");
    cancelPendingMcpApprovals("thread-test");
    const result = (await pending) as ToolResult;
    setActiveReqId("thread-test", null);
    expect(textOf(result)).toContain("User rejected");
    expect(pendingMcpApprovalCount()).toBe(0);
  });
});
