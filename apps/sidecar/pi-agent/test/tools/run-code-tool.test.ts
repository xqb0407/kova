import { describe, expect, test } from "bun:test";
import type {
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import { obj, str } from "@earendil-works/pi-schema";
import type { Running } from "../../src/types";
import { createRunCodeTool } from "../../src/tools/ptc/run-code-tool";

function readTool(delayMs = 5): AgentTool {
  return {
    name: "read",
    label: "Read",
    description: "Read a file",
    parameters: obj({ path: str({ description: "File path" }) }),
    execute: async (_id, params) => {
      const { path } = params as { path: string };
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        content: [{ type: "text", text: `content:${path}` }],
        details: { path },
        structuredContent: { path, content: `content:${path}` },
      };
    },
  };
}

function makeRun(
  tools: AgentTool[],
  beforeToolCall?: (
    context: BeforeToolCallContext,
  ) => Promise<BeforeToolCallResult | undefined>,
  ptcEnabled = true,
): Running {
  const assistant = {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name: "run_code", arguments: {} }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;

  return {
    agent: {
      state: {
        messages: [assistant],
        model: { api: "openai-completions", provider: "test", id: "test" },
        tools,
      },
      beforeToolCall,
      afterToolCall: undefined,
    },
    baseTools: tools,
    ptcEnabled,
    pendingToolApprovals: new Map(),
  } as unknown as Running;
}

function textOf(result: Awaited<ReturnType<AgentTool["execute"]>>): string {
  return result.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

describe("run_code", () => {
  test("refuses to run when the session snapshot is disabled", async () => {
    const tool = createRunCodeTool(makeRun([readTool()], undefined, false));
    const result = await tool.execute("tc1", { code: "return 1" }, undefined);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("PTC is disabled");
  });

  test("calls read-only tools and records child calls without leaking them to content", async () => {
    const tool = createRunCodeTool(makeRun([readTool()]));
    const result = await tool.execute(
      "tc1",
      {
        code: `
          const [a, b] = await Promise.all([
            tools.read({ path: "a" }),
            tools.read({ path: "b" }),
          ]);
          text("done");
          return { a: a.output, b: b.data?.content, statuses: [a.status, b.status] };
        `,
        description: "read two files",
      },
      undefined,
    );

    const text = textOf(result);
    expect(text).toContain("Script completed");
    expect(text).toContain("done");
    expect(text).toContain('"a":"content:a"');
    const calls = result.details?.ptc.calls ?? [];
    expect(calls.map((call) => [call.name, call.status])).toEqual([
      ["read", "ok"],
      ["read", "ok"],
    ]);
  });

  test("a blocked child call is reported to the script and does not fail the script", async () => {
    const tool = createRunCodeTool(
      makeRun([readTool()], async () => ({ block: true, reason: "denied by test" })),
    );
    const result = await tool.execute(
      "tc1",
      {
        code: `
          const r = await tools.read({ path: "x" });
          return { isError: r.isError, status: r.status, output: r.output };
        `,
      },
      undefined,
    );

    const text = textOf(result);
    expect(text).toContain("Script completed");
    expect(text).toContain('"isError":true');
    expect(result.isError).toBeUndefined();
    expect(result.details?.ptc.calls[0]?.status).toBe("error");
  });

  test("console output is separated from text/return output", async () => {
    const tool = createRunCodeTool(makeRun([readTool()]));
    const result = await tool.execute(
      "tc1",
      {
        code: `
          text("first");
          console.log("log line");
          return 42;
        `,
      },
      undefined,
    );

    const text = textOf(result);
    expect(text).toContain("==> text 1/2 <==");
    expect(text).toContain("==> text 2/2 <==");
    expect(text).toContain("<console_output>\nlog line\n</console_output>");
  });

  test("the guest has no Node, fetch, or require", async () => {
    const tool = createRunCodeTool(makeRun([readTool()]));
    const result = await tool.execute(
      "tc1",
      {
        code: `return { process: typeof process, fetch: typeof fetch, require: typeof require };`,
      },
      undefined,
    );

    const text = textOf(result);
    expect(text).toContain('"process":"undefined"');
    expect(text).toContain('"fetch":"undefined"');
    expect(text).toContain('"require":"undefined"');
  });

  test("a tight loop hits the wall clock", async () => {
    const tool = createRunCodeTool(makeRun([readTool()]));
    const result = await tool.execute(
      "tc1",
      { code: "while (true) {}", timeout_ms: 200 },
      undefined,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Script timed out");
  }, 10_000);

  test("the 101st child call is refused with PTC_TOOL_CALL_LIMIT_EXCEEDED and not recorded", async () => {
    const tool = createRunCodeTool(makeRun([readTool()]));
    const result = await tool.execute(
      "tc1",
      {
        code: `
          const results = [];
          for (let i = 0; i < 102; i++) results.push(await tools.read({ path: String(i) }));
          return {
            total: results.length,
            ok: results.filter((r) => r.status === "ok").length,
            refused: results.filter((r) => r.error?.code === "PTC_TOOL_CALL_LIMIT_EXCEEDED").length,
          };
        `,
      },
      undefined,
    );

    expect(textOf(result)).toContain('"total":102');
    expect(textOf(result)).toContain('"ok":100');
    expect(textOf(result)).toContain('"refused":2');
    // 被拒绝的调用不进 UI 记录：只有实际执行（含失败）的调用才出现在 calls 里
    expect(result.details?.ptc.calls).toHaveLength(100);
  }, 20_000);

  test("output over 64 KiB keeps head and tail around an omission marker", async () => {
    const tool = createRunCodeTool(makeRun([readTool()]));
    const result = await tool.execute(
      "tc1",
      {
        code: `
          text("HEAD".repeat(20000));
          text("TAIL".repeat(20000));
          return "returned marker";
        `,
      },
      undefined,
    );

    const text = textOf(result);
    expect(text).toContain("output truncated");
    // 组合文本以 header 开头，HEAD/TAIL 紧随其后；尾部以 return 值收尾
    //（textOf 用 \n 连接各 text 块，末段带 ==> text 3/3 <== 标头）
    expect(text).toContain("Script completed");
    expect(text.slice(0, 80)).toContain("HEADHEAD");
    expect(text.trimEnd().endsWith("==> text 3/3 <==\nreturned marker")).toBe(true);
  });

  test("finalize settles approvals left pending by the script", async () => {
    // 审批永不返回：模拟「脚本已结束，但子调用还挂在审批上」
    const neverResolvingGate = async (): Promise<never> =>
      await new Promise(() => {});
    const run = makeRun([readTool(50)], neverResolvingGate);
    const tool = createRunCodeTool(run);
    const script = tool.execute(
      "tc1",
      { code: `const r = await tools.read({ path: "x" }); return r.status;`, timeout_ms: 300 },
      undefined,
    );
    const result = await script;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Script timed out");
    // 脚本结束 = 挂起审批按拒绝结算，卡消失、await 解除
    const pending = (run.pendingToolApprovals as Map<string, unknown>).size;
    expect(pending).toBe(0);
  }, 10_000);
});

describe("run_code 的 MCP 可见性", () => {
  test("网关与直接暴露工具都不进脚本工具面", async () => {
    let called = false;
    const makeMcpTool = (name: string): AgentTool => ({
      name,
      label: name,
      description: "mcp test tool",
      parameters: obj({}),
      execute: async () => {
        called = true;
        return { content: [{ type: "text", text: "should not run" }], details: {} };
      },
    });
    const tool = createRunCodeTool(
      makeRun([readTool(), makeMcpTool("mcp"), makeMcpTool("mcp__fake__echo")]),
    );
    const result = await tool.execute(
      "tc1",
      {
        code: `
          let gatewayError = "";
          let directError = "";
          try { await tools.mcp({ action: "status" }); } catch (e) { gatewayError = String(e); }
          try { await tools.mcp__fake__echo({ text: "x" }); } catch (e) { directError = String(e); }
          return { gatewayError, directError };
        `,
      },
      undefined,
    );
    const text = textOf(result);
    expect(text).toContain("tools.mcp does not exist");
    expect(text).toContain("tools.mcp__fake__echo does not exist");
    expect(called).toBe(false);
  });
});
