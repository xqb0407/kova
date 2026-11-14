/**
 * ACP prompt e2e：本地 mock OpenAI provider 驱动一次真实工具调用，验证
 *   session/prompt → tool_call → session/request_permission → tool_confirm
 *   → 本地 bash 执行 → tool_call_update → agent_message_chunk → end_turn
 * 另外覆盖拒绝与取消。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initStorage } from "../../src/storage/storage";
import {
  credentialSet,
  customProviderUpsert,
  resetStorageForTest,
} from "../../src/storage/hostdb";

const cleanups: Array<() => void> = [];

afterAll(() => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup();
    } catch {
      /* ignore */
    }
  }
});

type RpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  result?: Record<string, unknown>;
  error?: unknown;
  params?: Record<string, unknown>;
};

type Update = Record<string, unknown> & { sessionUpdate?: string };

async function createFixture(behavior: "normal" | "always-tool") {
  const dir = mkdtempSync(join(tmpdir(), "kova-acp-prompt-e2e-"));
  const ws = join(dir, "ws");
  mkdirSync(ws, { recursive: true });

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json().catch(() => ({}))) as {
        messages?: Array<{ role?: string }>;
      };
      const hasToolResult = (body.messages ?? []).some(
        (m) => m.role === "tool" || m.role === "toolResult",
      );
      const useTool = behavior === "always-tool" || !hasToolResult;
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          created: 0,
          model: "mock-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      const sse = useTool
        ? chunk(
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({ command: "echo hello-from-acp" }),
                  },
                },
              ],
            },
            null,
          ) +
          chunk({ tool_calls: [{ index: 0, function: { arguments: "" } }] }, "tool_calls") +
          "data: [DONE]\n\n"
        : chunk({ role: "assistant", content: "final answer from mock" }, null) +
          chunk({}, "stop") +
          "data: [DONE]\n\n";
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    },
  });

  initStorage(join(dir, "state.db"), join(dir, "sessions"));
  await credentialSet("mock", "sk-test");
  await customProviderUpsert({
    id: "mock",
    name: "Mock",
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    api: "openai-chat",
    models: JSON.stringify([
      {
        id: "mock-model",
        name: "Mock Model",
        reasoning: false,
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ]),
  });
  resetStorageForTest();

  cleanups.push(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir, ws };
}

function startAgent(dataDir: string, onPermission?: (msg: RpcMessage) => void) {
  const entry = join(import.meta.dir, "..", "..", "src", "index.ts");
  const child = spawn(process.execPath, [entry, "--acp"], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, KOVA_ACP_DATA_DIR: dataDir, KOVA_CREDENTIALS_FILE: join(dataDir, "no-shared.json") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const updates: Update[] = [];
  const waiters = new Map<number | string, (msg: RpcMessage) => void>();
  let nextId = 1;

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as RpcMessage;
      if (msg.method === "session/update") {
        updates.push(msg.params?.update as Update);
        continue;
      }
      if (msg.method === "session/request_permission") {
        onPermission?.(msg);
        continue;
      }
      if (msg.id !== undefined) {
        waiters.get(msg.id)?.(msg);
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const request = (method: string, params: Record<string, unknown>) => {
    const id = nextId++;
    return new Promise<RpcMessage>((resolve, reject) => {
      waiters.set(id, (msg) => {
        waiters.delete(id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (!waiters.has(id)) return;
        waiters.delete(id);
        reject(new Error(`${method} timeout; stderr:\n${stderr.slice(-2000)}`));
      }, 20_000).unref?.();
    });
  };

  return {
    child,
    updates,
    request,
    notify: (method: string, params: Record<string, unknown>) => {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
    stderr: () => stderr,
    close: async () => {
      child.stdin.end();
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    },
  };
}

describe("ACP prompt e2e", () => {
  test("allow：工具调用→权限→本地 bash→结果→最终文本", async () => {
    const { dir, ws } = await createFixture("normal");
    let permissionTitle = "";
    const agent = startAgent(dir, (msg) => {
      permissionTitle = String(
        (msg.params?.toolCall as { title?: unknown } | undefined)?.title ?? "",
      );
      agent.child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { outcome: { outcome: "selected", optionId: "allow_once" } },
        }) + "\n",
      );
    });
    try {
      await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const created = await agent.request("session/new", { cwd: ws, mcpServers: [] });
      const sessionId = String(created.result?.sessionId ?? "");
      await agent.request("session/set_model", {
        sessionId,
        modelId: "mock/mock-model",
      });
      const result = await agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "run echo" }],
      });
      expect(result.result?.stopReason).toBe("end_turn");
      expect(permissionTitle).toContain("echo hello-from-acp");
      expect(agent.updates.some((u) => u.sessionUpdate === "tool_call")).toBe(true);
      expect(
        agent.updates.some(
          (u) => u.sessionUpdate === "tool_call_update" && u.status === "completed",
        ),
      ).toBe(true);
      expect(
        agent.updates.some(
          (u) =>
            u.sessionUpdate === "agent_message_chunk" &&
            String((u.content as { text?: string } | undefined)?.text ?? "").includes(
              "final answer from mock",
            ),
        ),
      ).toBe(true);
    } finally {
      await agent.close();
    }
  }, 30_000);

  test("reject：工具行 failed，prompt 仍正常收尾", async () => {
    const { dir, ws } = await createFixture("normal");
    const agent = startAgent(dir, (msg) => {
      agent.child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { outcome: { outcome: "selected", optionId: "reject_once" } },
        }) + "\n",
      );
    });
    try {
      await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const created = await agent.request("session/new", { cwd: ws, mcpServers: [] });
      const sessionId = String(created.result?.sessionId ?? "");
      await agent.request("session/set_model", {
        sessionId,
        modelId: "mock/mock-model",
      });
      const result = await agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "run echo" }],
      });
      expect(result.result?.stopReason).toBe("end_turn");
      expect(
        agent.updates.some(
          (u) => u.sessionUpdate === "tool_call_update" && u.status === "failed",
        ),
      ).toBe(true);
    } finally {
      await agent.close();
    }
  }, 30_000);

  test("cancel：权限挂起时 session/cancel → cancelled", async () => {
    const { dir, ws } = await createFixture("normal");
    const agent = startAgent(dir, () => {
      // 不响应权限：模拟用户停在审批卡上，随后编辑器发 session/cancel
    });
    try {
      await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const created = await agent.request("session/new", { cwd: ws, mcpServers: [] });
      const sessionId = String(created.result?.sessionId ?? "");
      await agent.request("session/set_model", {
        sessionId,
        modelId: "mock/mock-model",
      });
      const promptPromise = agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "run echo" }],
      });
      setTimeout(() => {
        agent.notify("session/cancel", { sessionId });
      }, 800);
      const result = await promptPromise;
      expect(result.result?.stopReason).toBe("cancelled");
    } finally {
      await agent.close();
    }
  }, 30_000);
});
