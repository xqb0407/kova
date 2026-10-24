/**
 * shell 策略场景 e2e：真实宿主 tool-exec + 真实 buildTools，
 * 验证“用户让 agent 改文件”时 Plan/Agent/子代理各自会被怎么挡住，
 * 以及允许的 read/edit 仍能落盘。
 *
 * 不启动 Electron/sidecar 进程：host_query 的 tool 分支直接转给宿主 handleTool，
 * 和运行时的执行代码路径一致。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { buildTools } from "../../src/tools/tools";
import { setTransport, type RpcOptions } from "../../src/storage/hostdb/transport";
import {
  approvalBeforeToolCall,
  modeBeforeToolCall,
  subagentToolGate,
} from "../../src/agent/modes";
import { initShellPolicy } from "../../src/permissions/shell-policy";
import { createRetryBudget } from "../../src/model/provider-retry";
import type { Running, SessionMode } from "../../src/types";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-agent-shell-e2e-"));
  dirs.push(dir);
  return dir;
}

function bashCtx(command: string): BeforeToolCallContext {
  return {
    assistantMessage: {
      content: [{ type: "toolCall", name: "bash", id: "bash", arguments: { command } }],
    },
    toolCall: { name: "bash", id: "bash", arguments: { command } },
    args: { command },
  } as unknown as BeforeToolCallContext;
}

function makeRun(mode: SessionMode, cwd: string, approvalLevel: Running["approvalLevel"] = "ask"): Running {
  return {
    agent: { state: { messages: [] } } as unknown as Running["agent"],
    threadId: `e2e-${mode}`,
    sessionId: "s",
    cwd,
    externalDirs: [],
    persistedSeq: 0,
    jsonlSeq: 0,
    compactionGeneration: 0,
    pendingOverflowRecovery: false,
    providerRetry: createRetryBudget(),
    retryCapture: {},
    providerRetryChunkId: "retry-1",
    providerRetryActive: false,
    providerRetryTurnSeq: 1,
    delegations: new Map(),
    stopRequested: false,
    mode,
    approvalLevel,
    appMode: "code",
    planning: mode === "plan" ? "planning" : "inactive",
    baseTools: [],
    subagentTools: [],
    pendingToolApprovals: new Map(),
    lastSeenAt: Date.now(),
    usagePending: 0,
  };
}

const toolOf = (tools: AgentTool[], name: string): AgentTool => {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`tool ${name} missing`);
  return tool;
};

const textOf = (result: unknown): string => {
  const content = (result as { content: Array<{ text?: string }> }).content;
  return content.map((part) => part.text ?? "").join("\n");
};

beforeAll(async () => {
  await initShellPolicy();
  setTransport(async (kind: string, params: Record<string, unknown>, _opts?: RpcOptions) => {
    if (kind !== "tool") throw new Error(`unexpected transport kind: ${kind}`);
    const { handleTool } = await import("../../../../electron/main/tool-exec");
    return handleTool(`e2e-${Date.now()}`, params);
  });
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  setTransport(null);
});

describe("shell policy e2e", () => {
  test("Plan：只读查看放行，sed -i/heredoc 拦截，文件不变", () => {
    const cwd = tempDir();
    const file = join(cwd, "a.txt");
    writeFileSync(file, "hello\n");
    const run = makeRun("plan", cwd);

    expect(modeBeforeToolCall(run, bashCtx("sed -n '1,3p' a.txt"))).toBeUndefined();
    expect(modeBeforeToolCall(run, bashCtx("pnpm test"))).toBeUndefined();
    expect(modeBeforeToolCall(run, bashCtx("sed -i 's/hello/world/' a.txt"))?.block).toBe(true);
    expect(modeBeforeToolCall(run, bashCtx("echo x > a.txt"))?.block).toBe(true);
    expect(
      modeBeforeToolCall(run, bashCtx("cat <<EOF > a.txt\nx\nEOF"))?.block,
    ).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("hello\n");
  });

  test("Agent：sed -i 拦截；sed -n 与命令自身写不被 mode gate 拦", () => {
    const cwd = tempDir();
    const run = makeRun("agent", cwd);
    expect(modeBeforeToolCall(run, bashCtx("sed -i 's/a/b/' a.txt"))?.block).toBe(true);
    expect(modeBeforeToolCall(run, bashCtx("sed -n '1,3p' a.txt"))).toBeUndefined();
    expect(modeBeforeToolCall(run, bashCtx("prettier --write a.ts"))).toBeUndefined();
  });

  test("完全访问也不能绕过手写拦截", () => {
    const cwd = tempDir();
    const run = makeRun("agent", cwd, "auto");
    expect(modeBeforeToolCall(run, bashCtx("sed -i 's/a/b/' a.txt"))?.block).toBe(true);
  });

  test("手写拦截发生在审批前，不产生挂起项", async () => {
    const cwd = tempDir();
    const run = makeRun("agent", cwd, "ask");
    const result = await approvalBeforeToolCall(
      run,
      bashCtx("sed -i 's/a/b/' a.txt"),
    );
    expect(result?.block).toBe(true);
    expect(run.pendingToolApprovals.size).toBe(0);
  });

  test("子代理复用同一拦截", async () => {
    const cwd = tempDir();
    const run = makeRun("agent", cwd, "auto");
    const gate = subagentToolGate(run, "delegation-e2e");
    expect((await gate(bashCtx("sed -i 's/a/b/' a.txt")))?.block).toBe(true);
    expect(await gate(bashCtx("pnpm test"))).toBeUndefined();
  });

  test("read → edit 仍能真实落盘；bash 手写被拦后文件保持原样", async () => {
    const cwd = tempDir();
    const file = join(cwd, "a.txt");
    writeFileSync(file, "hello\n");
    const tools = buildTools(cwd, "e2e-thread");
    const run = makeRun("agent", cwd);

    expect(
      modeBeforeToolCall(run, bashCtx(`sed -i 's/hello/world/' ${JSON.stringify(file)}`))
        ?.block,
    ).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("hello\n");

    const read = toolOf(tools, "read");
    const readResult = await read.execute("r1", { file_path: "a.txt" });
    expect(textOf(readResult)).toContain("hello");

    const edit = toolOf(tools, "edit");
    await edit.execute("e1", {
      file_path: "a.txt",
      old_string: "hello",
      new_string: "world",
    });
    expect(readFileSync(file, "utf8")).toBe("world\n");
  });
});
