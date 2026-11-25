import { describe, test, expect, afterAll, afterEach, beforeEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  formatSearchResults,
  buildDirectMcpTools,
  mcpSurfaceSignatureOfTools,
  mcpToolSurfaceSignature,
  type ToolIndexEntry,
} from "../../src/mcp/mcp-tools";
import { mcpManager } from "../../src/mcp/mcp-manager";
import {
  loadMcpServersSync,
  resetMcpConfigForTest,
  setMcpServerEnabled,
  workspaceOverrideMcpPath,
} from "../../src/mcp/mcp-config";
import {
  rememberMcpTool,
  setWriteRootsHomeForTest,
} from "../../src/permissions/write-roots";
import { resetMcpCacheForTest, updateTools } from "../../src/mcp/mcp-cache";
import {
  approveMcpToolForSession,
  forgetSessionMcpApprovals,
  isSessionApprovedMcpTool,
  migrateSessionMcpApprovals,
  resetSessionMcpApprovalsForTest,
} from "../../src/mcp/session-approvals";
import { setActiveReqId } from "../../src/protocol/stream";
import type { McpServerDef } from "../../src/mcp/mcp-config";
import {
  resetAutoReviewForTest,
  setAutoReviewerForTest,
  type ReviewSessionFacts,
} from "../../src/permissions/auto-review";
import { ledgerSnapshotForTest, rememberThreadSession } from "../../src/sessions/pending-interactions";

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
  // 本机免审批清单是跨用例共享的落盘事实：不清会让后续用例直接跳过审批卡
  const localPerms = path.join(tmp, ".kova", "permissions.local.json");
  if (existsSync(localPerms)) unlinkSync(localPerms);
  mcpManager.disposeAll();
  resetMcpConfigForTest();
  resetMcpCacheForTest();
  resetSessionMcpApprovalsForTest();
  // 用户级权限文件钉到 tmp：homedir() 不跟随 HOME，绝不能读写真实 ~/.kova
  setWriteRootsHomeForTest(path.join(tmp, "home"));
  // 用户级清单同样是跨用例落盘事实：不清会让后续用例直接跳过审批卡
  const userPerms = path.join(tmp, "home", ".kova", "permissions.json");
  if (existsSync(userPerms)) unlinkSync(userPerms);
});

afterAll(() => {
  setWriteRootsHomeForTest(undefined);
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

const writeAppConfig = () => {
  writeFileSync(
    systemConfig,
    JSON.stringify({
      mcpServers: {
        fake: {
          type: "stdio",
          command: process.execPath,
          args: [FAKE_SERVER],
          env: { MCP_FAKE_APP: "1" },
          approveTools: ["app_*"],
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

/**
 * 读一条挂起审批的卡面 payload。
 *
 * 走交互台账而不是 stdout：`send` 直接写进程 stdout，没有注入点，而在台账里
 * 断言等价——`beginInteraction` 与 `sendEventChunk` 拿的是同一个 payload。
 */
function approvalCard(approvalId: string): Record<string, unknown> | undefined {
  const entry = ledgerSnapshotForTest().find((e) => e.interactionId === approvalId);
  return entry?.payload as Record<string, unknown> | undefined;
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

describe("search 结果格式化", () => {
  const entry = (
    name: string,
    description: string | undefined,
    inputSchema?: unknown,
  ): ToolIndexEntry => ({
    server: "fake",
    def: { name: "fake", transport: "stdio", layer: "system", source: "" },
    tool: { name, description, inputSchema },
  });

  test("内联参数摘要；简单 schema 不附原文", () => {
    const { text, omitted } = formatSearchResults([
      {
        entry: entry("echo", "echo back the text", {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        }),
        score: 10,
      },
    ]);
    expect(text).toContain("fake__echo — echo back the text");
    expect(text).toContain("params: text: string");
    expect(text).not.toContain("schema:");
    expect(omitted).toBe(0);
  });

  test("复杂 schema 附原文（受 topN 与字节上限约束）", () => {
    const { text } = formatSearchResults([
      {
        entry: entry("complex", "complex tool", {
          type: "object",
          properties: { payload: { $ref: "#/$defs/Payload" } },
        }),
        score: 9,
      },
    ]);
    expect(text).toContain("params: payload?: object");
    expect(text).toContain('schema: {"type":"object"');
  });

  test("超预算时整条省略并报告剩余数量", () => {
    const hits = Array.from({ length: 10 }, (_, i) => ({
      entry: entry(`tool_${i}`, `description ${i}`, {
        type: "object",
        properties: { text: { type: "string" } },
      }),
      score: 10 - i,
    }));
    const { text, omitted } = formatSearchResults(hits, 120);
    expect(omitted).toBeGreaterThan(0);
    expect(text).toContain("more matches");
  });

  test("被预算丢弃的条目不占输出，也不留前导换行", () => {
    const { text, omitted } = formatSearchResults(
      [
        {
          entry: entry("complex", "complex tool", {
            type: "object",
            properties: { payload: { $ref: "#/$defs/Payload" } },
          }),
          score: 1,
        },
      ],
      10,
    );
    expect(omitted).toBe(1);
    expect(text.startsWith("…")).toBe(true);
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

  test("MCP Apps：app-only 工具不进模型索引；call 返回 mcpApp 渲染详情", async () => {
    writeAppConfig();
    setActiveReqId("thread-test", "req-1");
    const t = tool();
    const echo = (await t.execute("app-1", {
      action: "call",
      tool: "fake__app_echo",
      args: '{"text":"hi"}',
    })) as ToolResult;
    expect(textOf(echo)).toBe("app:hi");
    expect(echo.details?.mcpApp).toMatchObject({
      server: "fake",
      tool: "app_echo",
      resourceUri: "ui://fake/app.html",
      arguments: { text: "hi" },
      content: [{ type: "text", text: "app:hi" }],
      structuredContent: { text: "hi", count: 1 },
    });
    const appOnly = (await t.execute("app-2", {
      action: "call",
      tool: "fake__app_refresh",
      args: "{}",
    })) as ToolResult;
    expect(textOf(appOnly)).toContain("app-only");
    const search = (await t.execute("app-3", {
      action: "search",
      query: "refresh",
    })) as ToolResult;
    expect(textOf(search)).not.toContain("app_refresh");
    setActiveReqId("thread-test", null);
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
    // 参数表内联：模型无需再 describe 即可 call
    expect(textOf(after)).toContain("params: text?: string");
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
    expect(textOf(ready)).toContain("2 resources");
    expect(textOf(ready)).toContain("2 prompts");
  });

  test("resources / resource_read：懒连接、列表、读取与 URI 去敏", async () => {
    writeConfig();
    const t = tool();
    const listed = (await t.execute("r1", {
      action: "resources",
      server: "fake",
    })) as ToolResult;
    const text = textOf(listed);
    expect(text).toContain("readme");
    expect(text).toContain("config");
    expect(text).toContain("[template]");
    expect(text).not.toContain("token=secret");

    const read = (await t.execute("r2", {
      action: "resource_read",
      server: "fake",
      uri: "file:///fake/readme.md?token=secret",
    })) as ToolResult;
    expect(textOf(read)).toContain("# Fake");
    expect(JSON.stringify(read)).not.toContain("token=secret");

    const missing = (await t.execute("r3", {
      action: "resource_read",
      server: "fake",
      uri: "file:///fake/missing",
    })) as ToolResult;
    expect(textOf(missing)).toContain("MCP resource read failed");
  });

  test("prompts / prompt_get：列表、参数与消息渲染", async () => {
    writeConfig();
    const t = tool();
    const listed = (await t.execute("p1", {
      action: "prompts",
      server: "fake",
    })) as ToolResult;
    expect(textOf(listed)).toContain("summarize");
    expect(textOf(listed)).toContain("topic*");
    expect(textOf(listed)).toContain("review");

    const got = (await t.execute("p2", {
      action: "prompt_get",
      server: "fake",
      prompt: "summarize",
      args: '{"topic":"MCP"}',
    })) as ToolResult;
    expect(textOf(got)).toContain("[user]");
    expect(textOf(got)).toContain("Summarize MCP");

    const badArgs = (await t.execute("p3", {
      action: "prompt_get",
      server: "fake",
      prompt: "summarize",
      args: '{"topic":{"nested":true}}',
    })) as ToolResult;
    expect(textOf(badArgs)).toContain("must be a string, number or boolean");

    const unknown = (await t.execute("p4", {
      action: "prompt_get",
      server: "fake",
      prompt: "missing",
      args: "{}",
    })) as ToolResult;
    expect(textOf(unknown)).toContain("未提供 prompt");
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

/**
 * 审批档位对 MCP 的效力：MCP 此前完全在审批体系之外（选「完全访问」也照样弹卡），
 * 这组用例是那道口径的回归闸。
 *
 * 方向性：找**该问的没问**与**该放行的误拦**，前者是权限边界上的洞。
 */
describe("审批档位（getApprovalLevel）", () => {
  // 每次用独立工作区：本组的「记住」会往 <cwd>/.kova/permissions.local.json 落盘，
  // 共用一个 cwd 会让前一个用例的授权漏进下一个（那正是要防的串味）
  let ws: string;
  let level: "ask" | "workspace-write" | "auto-edit" | "auto";
  const toolAt = () =>
    buildMcpTool(ws, "thread-test", undefined, () => level);

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "mcp-level-"));
    mkdirSync(join(ws, ".kova"), { recursive: true });
    level = "ask";
    // 交互台账按 threadId→sessionId 绑定才收条目；没绑定时 beginInteraction
    // 直接降级为「只走直播流」，approvalCard 就什么都读不到
    rememberThreadSession("thread-test", "sess-level");
  });

  test("完全访问档：直接执行，不挂起审批", async () => {
    writeConfig();
    level = "auto";
    setActiveReqId("thread-test", "req-1");
    const result = (await toolAt().execute("lv-auto", {
      action: "call",
      tool: "fake__echo",
      args: '{"text":"free"}',
    })) as ToolResult;
    setActiveReqId("thread-test", null);
    expect(pendingMcpApprovalCount()).toBe(0);
    expect(textOf(result)).toBe("echo:free");
  });

  test("变更前确认档：仍逐次挂起（且不给「记住」）", async () => {
    writeConfig();
    level = "ask";
    setActiveReqId("thread-test", "req-1");
    const pending = toolAt().execute("lv-ask", {
      action: "call",
      tool: "fake__echo",
      args: "{}",
    });
    await waitForApproval("lv-ask:mcp");
    // ask 档的语义就是每次都问：给了「记住」就等于悄悄把它变成别的档
    expect(approvalCard("lv-ask:mcp")?.canRemember).toBeUndefined();
    expect(resolveMcpApproval("lv-ask:mcp", true)).toBe(true);
    await pending;
    setActiveReqId("thread-test", null);
  });

  for (const lv of ["workspace-write", "auto-edit"] as const) {
    test(`${lv} 档：挂起且带「记住」`, async () => {
      writeConfig();
      level = lv;
      setActiveReqId("thread-test", "req-1");
      const pending = toolAt().execute(`lv-${lv}`, {
        action: "call",
        tool: "fake__echo",
        args: "{}",
      });
      await waitForApproval(`lv-${lv}:mcp`);
      const card = approvalCard(`lv-${lv}:mcp`);
      expect(card?.canRemember).toBe(true);
      // 卡上必须写清「记住」的后果，否则用户以为只放行这一次
      expect(String(card?.note ?? "")).toContain("permissions.local.json");
      resolveMcpApproval(`lv-${lv}:mcp`, true);
      await pending;
      setActiveReqId("thread-test", null);
    });
  }

  test("「记住」落盘后同一工具免审批；同 server 其他工具仍问", async () => {
    writeConfig();
    level = "workspace-write";

    // 第一次：批准并记住
    setActiveReqId("thread-test", "req-1");
    const first = toolAt().execute("rm-1", {
      action: "call",
      tool: "fake__echo",
      args: '{"text":"once"}',
    });
    await waitForApproval("rm-1:mcp");
    resolveMcpApproval("rm-1:mcp", true, true);
    expect(textOf(await first)).toBe("echo:once");

    // 落盘内容：只有被批准的那一个工具
    const local = JSON.parse(
      readFileSync(join(ws, ".kova", "permissions.local.json"), "utf8"),
    ) as { allowMcpTools?: string[] };
    expect(local.allowMcpTools).toEqual(["fake__echo"]);

    // 第二次调同一工具：不再问
    const second = toolAt().execute("rm-2", {
      action: "call",
      tool: "fake__echo",
      args: '{"text":"twice"}',
    });
    expect(textOf((await second) as ToolResult)).toBe("echo:twice");
    expect(pendingMcpApprovalCount()).toBe(0);

    // 回归闸：记住的粒度是**单个工具**，不是整条 server。
    // 放行成整条就等于让一个 server 里最危险的那个工具（dbx__execute_query）
    // 也跟着免审批——那正是这条规则要防的事
    const other = toolAt().execute("rm-3", {
      action: "call",
      tool: "fake__img",
      args: "{}",
    });
    await waitForApproval("rm-3:mcp");
    resolveMcpApproval("rm-3:mcp", false);
    await other;
    setActiveReqId("thread-test", null);
  });

  test("拒绝时不落盘（记住只对批准生效）", async () => {
    writeConfig();
    level = "workspace-write";
    setActiveReqId("thread-test", "req-1");
    const pending = toolAt().execute("rj-1", {
      action: "call",
      tool: "fake__echo",
      args: "{}",
    });
    await waitForApproval("rj-1:mcp");
    resolveMcpApproval("rj-1:mcp", false, true);
    await pending;
    setActiveReqId("thread-test", null);
    expect(existsSync(join(ws, ".kova", "permissions.local.json"))).toBe(false);
  });

  test("仅「这一次」不落盘", async () => {
    writeConfig();
    level = "workspace-write";
    setActiveReqId("thread-test", "req-1");
    const pending = toolAt().execute("on-1", {
      action: "call",
      tool: "fake__echo",
      args: "{}",
    });
    await waitForApproval("on-1:mcp");
    resolveMcpApproval("on-1:mcp", true, false);
    await pending;
    setActiveReqId("thread-test", null);
    expect(existsSync(join(ws, ".kova", "permissions.local.json"))).toBe(false);
  });

  test("项目共享的 permissions.json 不产生授权效力（只提议不生效）", async () => {
    // 仓库跟着走的那份声明了也不算数：授权只能来自用户自己机器上的文件
    writeFileSync(
      join(ws, ".kova", "permissions.json"),
      JSON.stringify({ allowMcpTools: ["fake__echo"] }),
      "utf8",
    );
    writeConfig();
    level = "workspace-write";
    setActiveReqId("thread-test", "req-1");
    const pending = toolAt().execute("pj-1", {
      action: "call",
      tool: "fake__echo",
      args: "{}",
    });
    await waitForApproval("pj-1:mcp");
    resolveMcpApproval("pj-1:mcp", false);
    await pending;
    setActiveReqId("thread-test", null);
  });
});

describe("工作区层 approveTools 不产生授权效力（仓库不能给自己免审批）", () => {
  // 与可写根清单的纪律一致：跟着仓库走的文件只能**提议**，不能授权。
  // 工作区层声明 approveTools 是"这个项目请求这些工具免审批"，
  // 真正能授权的是本机审批卡上的「允许并记住这个工具」（写进
  // .kova/permissions.local.json 的 allowMcpTools，逐工具、逐字相等）。
  const workspaceOverride = () => workspaceOverrideMcpPath(tmp);
  const cleanup = () => {
    const file = workspaceOverride();
    if (existsSync(file)) unlinkSync(file);
    const local = join(tmp, ".kova", "permissions.local.json");
    if (existsSync(local)) unlinkSync(local);
    cancelPendingMcpApprovals("thread-test"); // 失败路径也别把挂起项留给下一条用例
    resetMcpConfigForTest();
  };
  const writeWorkspaceApproveTools = (globs: string[]) => {
    mkdirSync(join(tmp, ".kova"), { recursive: true });
    writeFileSync(
      workspaceOverride(),
      JSON.stringify({ mcpServers: { fake: { approveTools: globs } } }),
      "utf8",
    );
  };

  test("工作区层的 glob 不豁免：照常弹卡，卡上说明项目请求了什么", async () => {
    try {
      writeConfig(); // 系统层定义服务器（不带 approveTools）
      writeWorkspaceApproveTools(["echo*"]);
      await setMcpServerEnabled("workspace", "fake", true, tmp); // 本机显式启用该服务器
      setActiveReqId("thread-test", "req-ws");
      // workspace-write 档才有「允许并记住这个工具」，让卡面文案的后半段也出现
      const pending = buildMcpTool(tmp, "thread-test", undefined, () => "workspace-write").execute(
        "call-ws",
        { action: "call", tool: "fake__echo", args: '{"text": "no-auto"}' },
      );
      await waitForApproval("call-ws:mcp"); // 关键：豁免没有生效
      const card = approvalCard("call-ws:mcp");
      expect(String(card?.note ?? "")).toContain("项目");
      expect(String(card?.note ?? "")).toContain("仓库文件不能给自己授权");
      expect(String(card?.note ?? "")).toContain("允许并记住");
      resolveMcpApproval("call-ws:mcp", false);
      const result = (await pending) as ToolResult;
      setActiveReqId("thread-test", null);
      expect(textOf(result)).toContain("User rejected");
    } finally {
      cleanup();
    }
  });

  test("同一台机器上点过「记住这个工具」之后照旧豁免（本机授权是唯一生效路径）", async () => {
    try {
      writeConfig();
      writeWorkspaceApproveTools(["echo*"]);
      await setMcpServerEnabled("workspace", "fake", true, tmp);
      await rememberMcpTool(tmp, "fake__echo");
      setActiveReqId("thread-test", "req-ws2");
      const result = (await tool().execute("call-ws2", {
        action: "call",
        tool: "fake__echo",
        args: '{"text": "auto"}',
      })) as ToolResult;
      setActiveReqId("thread-test", null);
      expect(pendingMcpApprovalCount()).toBe(0);
      expect(textOf(result)).toBe("echo:auto");
    } finally {
      cleanup();
    }
  });
});

/**
 * AI 审查档（review）对 MCP 的效力：审查排在弹卡之前，三种去向各一条——
 * allow → 不弹卡直接执行；deny → 拦截并把理由回给模型（工具不执行）；
 * 失败 → 退回弹卡（卡上说明原因，且不给「记住」：一次审查故障不该换来永久免审）。
 */
describe("审批档位：AI 审查（review）", () => {
  let ws: string;
  const facts: ReviewSessionFacts = {};
  const toolAt = () => buildMcpTool(ws, "thread-test", undefined, () => "review", () => facts);

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "mcp-review-"));
    mkdirSync(join(ws, ".kova"), { recursive: true });
    // 绑定沿用同文件既有的 thread→session（台账行落 sess-level.jsonl，与其它
    // 用例同款）；另起一个会话 id 只会在仓库里多出一个测试残留文件
    rememberThreadSession("thread-test", "sess-level");
    resetAutoReviewForTest();
  });
  afterEach(() => {
    resetAutoReviewForTest();
  });

  test("审查 allow → 不弹卡，直接执行", async () => {
    writeConfig();
    setAutoReviewerForTest(async () => ({
      ok: true,
      decision: { risk: "low", decision: "allow" },
    }));
    const result = (await toolAt().execute("rv-allow", {
      action: "call",
      tool: "fake__echo",
      args: '{"text":"free"}',
    })) as ToolResult;
    expect(pendingMcpApprovalCount()).toBe(0);
    expect(textOf(result)).toBe("echo:free");
  });

  test("审查 deny → 拦截并把理由回给模型，工具不执行", async () => {
    writeConfig();
    setAutoReviewerForTest(async () => ({
      ok: true,
      decision: { risk: "medium", decision: "deny", reason: "用户没授权删这条记录" },
    }));
    const result = (await toolAt().execute("rv-deny", {
      action: "call",
      tool: "fake__echo",
      args: '{"text":"boom"}',
    })) as ToolResult;
    expect(pendingMcpApprovalCount()).toBe(0);
    expect(textOf(result)).toContain("AI review");
    expect(textOf(result)).toContain("用户没授权删这条记录");
    // 拦截必须是"没跑"：拿不到服务器回显
    expect(textOf(result)).not.toContain("echo:boom");
  });

  test("审查失败 → 退回弹卡：卡上说明原因、不给「记住」、审查输入带全名与真实参数", async () => {
    writeConfig();
    let seenTool: unknown;
    let seenArgs: unknown;
    setAutoReviewerForTest(async (_facts, input) => {
      seenTool = input.action.tool;
      seenArgs = input.action.arguments;
      return { ok: false, error: "模型不可用" };
    });
    setActiveReqId("thread-test", "req-1");
    const pending = toolAt().execute("rv-fail", {
      action: "call",
      tool: "fake__echo",
      args: '{"text":"later"}',
    });
    await waitForApproval("rv-fail:mcp");
    const card = approvalCard("rv-fail:mcp");
    expect(card?.canRemember).toBeUndefined();
    expect(String(card?.note ?? "")).toContain("AI 审查这次没跑起来");
    expect(seenTool).toBe("fake__echo");
    expect(seenArgs).toEqual({ text: "later" });
    resolveMcpApproval("rv-fail:mcp", true);
    expect(textOf(await pending)).toBe("echo:later");
    setActiveReqId("thread-test", null);
  });
});

describe("enabledTools 白名单（M2.2）", () => {
  test("isToolEnabledBy：glob 匹配裸名/全名，未声明全放行", async () => {
    const { isToolEnabledBy } = await import("../../src/mcp/mcp-tools");
    const def: McpServerDef = {
      name: "wl",
      transport: "http",
      url: "https://wl.example/mcp",
      layer: "system",
      source: "",
      enabledTools: ["echo*", "read_*"],
    };
    expect(isToolEnabledBy(def, "echo")).toBe(true);
    expect(isToolEnabledBy(def, "wl__read_file")).toBe(true);
    expect(isToolEnabledBy(def, "write_file")).toBe(false);
    // 未声明 = 全放行
    expect(isToolEnabledBy({ ...def, enabledTools: undefined }, "anything")).toBe(true);
    // 工作区层由调用方判定（本函数是纯匹配）
    expect(isToolEnabledBy({ ...def, layer: "workspace" }, "echo")).toBe(true);
  });
});

describe("直接暴露（expose: direct）", () => {
  const directConfig = (extra: Record<string, unknown> = {}) => {
    writeFileSync(
      systemConfig,
      JSON.stringify({
        mcpServers: {
          fake: {
            type: "stdio",
            command: process.execPath,
            args: [FAKE_SERVER],
            description: "fake server for tests",
            expose: "direct",
            ...extra,
          },
        },
      }),
      "utf8",
    );
  };

  const warmCache = async (t = tool()) => {
    const warm = t.execute("warm", { action: "call", tool: "fake__echo", args: '{"text":"w"}' });
    await waitForApproval("warm:mcp");
    resolveMcpApproval("warm:mcp", true);
    await warm;
  };

  test("缓存为空时不下发；连接后按 mcp__server__tool 暴露", async () => {
    directConfig();
    expect(buildDirectMcpTools(tmp, "thread-test")).toEqual([]);
    await warmCache();
    const direct = buildDirectMcpTools(tmp, "thread-test");
    const echo = direct.find((entry) => entry.name === "mcp__fake__echo");
    expect(echo).toBeDefined();
    expect(JSON.stringify(echo!.parameters)).toContain('"text"');
    // 表面签名与装配同一口径：重载判定不会因上限/去重差异反复重建
    expect(mcpSurfaceSignatureOfTools([{ name: "mcp" }, ...direct])).toBe(
      mcpToolSurfaceSignature(tmp),
    );
  });

  test("直接工具执行复用审批管线", async () => {
    directConfig();
    await warmCache();
    const echo = buildDirectMcpTools(tmp, "thread-test").find(
      (entry) => entry.name === "mcp__fake__echo",
    )!;
    setActiveReqId("thread-test", "req-direct");
    const pending = echo.execute("direct-1", { text: "hi" });
    await waitForApproval("direct-1:mcp");
    expect(resolveMcpApproval("direct-1:mcp", true)).toBe(true);
    const result = (await pending) as ToolResult;
    setActiveReqId("thread-test", null);
    expect(textOf(result)).toBe("echo:hi");
  });

  test("gateway 暴露的服务器不产生直接工具", async () => {
    writeConfig();
    await warmCache();
    expect(buildDirectMcpTools(tmp, "thread-test")).toEqual([]);
  });

  test("enabledTools 白名单对直接工具生效", async () => {
    directConfig({ enabledTools: ["echo"] });
    await warmCache();
    const names = buildDirectMcpTools(tmp, "thread-test").map((entry) => entry.name);
    expect(names).toContain("mcp__fake__echo");
    expect(names).not.toContain("mcp__fake__fail");
    expect(names).not.toContain("mcp__fake__env_check");
  });

  test("超大 schema 不声明为直接工具（网关仍可调用）", async () => {
    directConfig();
    const { defs } = loadMcpServersSync(tmp);
    const def = defs.find((entry) => entry.name === "fake")!;
    updateTools(def, [
      {
        name: "huge",
        description: "huge schema",
        inputSchema: {
          type: "object",
          properties: { blob: { type: "string", description: "x".repeat(20_000) } },
        },
      },
    ]);
    const names = buildDirectMcpTools(tmp, "thread-test").map((entry) => entry.name);
    expect(names).not.toContain("mcp__fake__huge");
    expect(names).toEqual([]);
  });
});

describe("审批作用域（rememberScope）", () => {
  test("session：批准后本线程同工具不再询问", async () => {
    writeConfig();
    const t = tool();
    const first = t.execute("sc1", { action: "call", tool: "fake__echo", args: '{"text":"one"}' });
    await waitForApproval("sc1:mcp");
    expect(resolveMcpApproval("sc1:mcp", true, true, "session")).toBe(true);
    await first;
    const second = (await t.execute("sc2", {
      action: "call",
      tool: "fake__echo",
      args: '{"text":"two"}',
    })) as ToolResult;
    expect(textOf(second)).toBe("echo:two");
    expect(pendingMcpApprovalCount()).toBe(0);
  });

  test("user：写用户级 permissions.json，不写 local", async () => {
    writeConfig();
    const home = path.join(tmp, "home");
    const t = tool();
    const pending = t.execute("us1", {
      action: "call",
      tool: "fake__echo",
      args: '{"text":"hi"}',
    });
    await waitForApproval("us1:mcp");
    resolveMcpApproval("us1:mcp", true, true, "user");
    await pending;
    const doc = JSON.parse(
      readFileSync(path.join(home, ".kova", "permissions.json"), "utf8"),
    ) as { allowMcpTools?: string[] };
    expect(doc.allowMcpTools).toContain("fake__echo");
    expect(existsSync(path.join(tmp, ".kova", "permissions.local.json"))).toBe(false);
  });

  test("project：写本机 local 文件（缺省作用域）", async () => {
    writeConfig();
    const t = tool();
    const pending = t.execute("pr1", {
      action: "call",
      tool: "fake__echo",
      args: '{"text":"hi"}',
    });
    await waitForApproval("pr1:mcp");
    resolveMcpApproval("pr1:mcp", true, true, "project");
    await pending;
    const doc = JSON.parse(
      readFileSync(path.join(tmp, ".kova", "permissions.local.json"), "utf8"),
    ) as { allowMcpTools?: string[] };
    expect(doc.allowMcpTools).toContain("fake__echo");
  });

  test("会话级授权随 thread 改绑迁移，线程结束时清理", () => {
    approveMcpToolForSession("old-thread", "fake__echo");
    migrateSessionMcpApprovals("old-thread", "new-thread");
    expect(isSessionApprovedMcpTool("old-thread", "fake__echo")).toBe(false);
    expect(isSessionApprovedMcpTool("new-thread", "fake__echo")).toBe(true);
    forgetSessionMcpApprovals("new-thread");
    expect(isSessionApprovedMcpTool("new-thread", "fake__echo")).toBe(false);
  });

  test("拒绝时即使带 remember 也不授予会话级免审批", async () => {
    writeConfig();
    const t = tool();
    const denied = t.execute("dn1", { action: "call", tool: "fake__echo", args: '{"text":"no"}' });
    await waitForApproval("dn1:mcp");
    resolveMcpApproval("dn1:mcp", false, true, "session");
    const result = (await denied) as ToolResult;
    expect(textOf(result)).toContain("User rejected");
    // 下一次仍然要审批：没有留下任何授权
    const next = t.execute("dn2", { action: "call", tool: "fake__echo", args: '{"text":"ok"}' });
    await waitForApproval("dn2:mcp");
    resolveMcpApproval("dn2:mcp", true);
    await next;
  });
});

describe("Codex 工具全名别名", () => {
  test("server.tool 与 server__tool 都能解析", () => {
    expect(parseMcpToolFullName("codex-canvas__open_canvas", ["codex-canvas"])).toEqual({
      server: "codex-canvas",
      tool: "open_canvas",
    });
    expect(parseMcpToolFullName("codex-canvas.open_canvas", ["codex-canvas"])).toEqual({
      server: "codex-canvas",
      tool: "open_canvas",
    });
    expect(parseMcpToolFullName("unknown.tool", ["codex-canvas"])).toBeNull();
  });
});
