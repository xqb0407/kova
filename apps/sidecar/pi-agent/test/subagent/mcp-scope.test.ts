/**
 * 作用域化 MCP 网关测试（设计文档 §8 测试 4、§5）。
 *
 * 守的是最要紧的一条：**子代理够不到它没被声明的 MCP 服务器**。
 * 这条一旦漏，子代理就获得了主代理的全部外部集成能力——业务 agent
 * 本来只该看 CRM 和 Notion，却能连上任何已配置服务器。
 *
 * 用 buildMcpTool 的作用域参数直接构造网关，executeSearch/executeCall
 * 的越权路径在连接与审批之前就返回，不需要真的连上任何服务器。
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetMcpConfigForTest } from "../../src/mcp/mcp-config";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pi-mcp-scope-"));
  resetMcpConfigForTest();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetMcpConfigForTest();
});

/** 取网关工具的文本结果（execute 返回 content 数组） */
async function callTool(
  tool: { execute: (id: string, params: unknown) => Promise<unknown> },
  params: unknown,
): Promise<string> {
  const res = (await tool.execute("tc1", params)) as {
    content: Array<{ type: string; text?: string }>;
  };
  return res.content.map((c) => c.text ?? "").join("\n");
}

describe("MCP 网关作用域", () => {
  test("无作用域时行为不变（主代理路径）", async () => {
    const { buildMcpTool } = await import("../../src/mcp/mcp-tools");
    const tool = buildMcpTool(tmp, "thread-1");
    // 不变式是"不带白名单文案"：无论本机配没配服务器，主代理路径都不该
    // 出现作用域声明（否则会给主代理凭空加一层限制）
    expect(tool.description).not.toContain("ONLY");
    const text = await callTool(tool, { action: "search", query: "anything" });
    expect(text).not.toContain("you may ONLY use");
    expect(text).not.toContain("this agent may only use");
  });

  test("白名单网关的描述声明了可用服务器", async () => {
    const { buildMcpTool } = await import("../../src/mcp/mcp-tools");
    const tool = buildMcpTool(tmp, "thread-1", {
      allowedServers: ["crm", "notion"],
      allowedNames: ["crm", "notion"],
    });
    expect(tool.description).toContain("crm, notion");
    expect(tool.description).toContain("ONLY");
  });

  test("无服务器时 search 的提示指名被授权的服务器", async () => {
    const { buildMcpTool } = await import("../../src/mcp/mcp-tools");
    const tool = buildMcpTool(tmp, "thread-1", {
      allowedServers: ["crm", "notion"],
      allowedNames: ["crm", "notion"],
    });
    const text = await callTool(tool, { action: "search", query: "anything" });
    expect(text).toContain("crm, notion");
    expect(text).not.toContain("No MCP tools available.");
  });

  test("越权 call 在连接/审批之前被拒绝", async () => {
    const { buildMcpTool } = await import("../../src/mcp/mcp-tools");
    const tool = buildMcpTool(tmp, "thread-1", {
      allowedServers: ["crm"],
      allowedNames: ["crm"],
    });
    // 未声明的服务器：既没有配置、也不在白名单
    const text = await callTool(tool, { action: "call", tool: "notion__search", args: "{}" });
    // 不该出现"未知服务器"（那是没配置的情形），而是明确的越权拒绝
    expect(text).toContain("not allowed to use the MCP server");
    expect(text).toContain("crm");
  });

  test("拒绝文案不把球踢回问用户", async () => {
    const { buildMcpTool } = await import("../../src/mcp/mcp-tools");
    const tool = buildMcpTool(tmp, "thread-1", {
      allowedServers: ["crm"],
      allowedNames: ["crm"],
    });
    const text = await callTool(tool, { action: "call", tool: "notion__search", args: "{}" });
    // 子代理问不了用户，文案不该把球踢回"问用户"
    expect(text).not.toContain("ask the user");
  });

  test("status 只列白名单内的服务器", async () => {
    const { buildMcpTool } = await import("../../src/mcp/mcp-tools");
    const tool = buildMcpTool(tmp, "thread-1", {
      allowedServers: ["crm"],
      allowedNames: ["crm"],
    });
    const text = await callTool(tool, { action: "status" });
    expect(text).not.toContain("notion");
  });

  test("describe 越权工具按未知处理（索引已过滤）", async () => {
    const { buildMcpTool } = await import("../../src/mcp/mcp-tools");
    const tool = buildMcpTool(tmp, "thread-1", {
      allowedServers: ["crm"],
      allowedNames: ["crm"],
    });
    const text = await callTool(tool, { action: "describe", tool: "notion__page" });
    expect(text).toContain("Unknown MCP tool");
  });

  test("args 非法 JSON 在作用域检查前就被拒（不泄露服务器存在性）", async () => {
    const { buildMcpTool } = await import("../../src/mcp/mcp-tools");
    const tool = buildMcpTool(tmp, "thread-1", {
      allowedServers: ["crm"],
      allowedNames: ["crm"],
    });
    const text = await callTool(tool, { action: "call", tool: "notion__x", args: "not json" });
    expect(text).toContain("not valid JSON");
  });
});