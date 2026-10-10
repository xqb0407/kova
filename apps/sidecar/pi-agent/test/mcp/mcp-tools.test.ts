import { describe, test, expect, afterAll, beforeEach } from "bun:test";
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
  type ToolIndexEntry,
} from "../../src/mcp/mcp-tools";
import { mcpManager } from "../../src/mcp/mcp-manager";
import { resetMcpConfigForTest, setMcpServerEnabled, workspaceOverrideMcpPath } from "../../src/mcp/mcp-config";
import { rememberMcpTool } from "../../src/permissions/write-roots";
import { resetMcpCacheForTest } from "../../src/mcp/mcp-cache";
import { setActiveReqId } from "../../src/protocol/stream";
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
