/**
 * session/load e2e：先跑一轮真实 prompt 落转录，再开新进程 load，
 * 验证 user / tool_call / tool_result / assistant 文本的回放。
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
  id?: number | string;
  method?: string;
  result?: Record<string, unknown>;
  error?: unknown;
  params?: Record<string, unknown>;
};

function startAgent(dataDir: string, ws: string) {
  const entry = join(import.meta.dir, "..", "..", "src", "index.ts");
  const child = spawn(process.execPath, [entry, "--acp"], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, KOVA_ACP_DATA_DIR: dataDir, KOVA_CREDENTIALS_FILE: join(dataDir, "no-shared.json") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const updates: Array<Record<string, unknown>> = [];
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
        updates.push(msg.params?.update as Record<string, unknown>);
        continue;
      }
      if (msg.method === "session/request_permission") {
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { outcome: { outcome: "selected", optionId: "allow_once" } },
          }) + "\n",
        );
        continue;
      }
      if (msg.id !== undefined) waiters.get(msg.id)?.(msg);
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
    updates,
    request,
    close: async () => {
      child.stdin.end();
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    },
  };
}

describe("ACP session/load e2e", () => {
  test("回放 user/tool/assistant 历史", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kova-acp-load-e2e-"));
    const ws = join(dir, "ws");
    mkdirSync(ws, { recursive: true });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    let sawToolResult = false;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json().catch(() => ({}))) as {
          messages?: Array<{ role?: string }>;
        };
        sawToolResult = (body.messages ?? []).some(
          (m) => m.role === "tool" || m.role === "toolResult",
        );
        const chunk = (delta: unknown, finish: string | null) =>
          `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "mock-model",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        const sse = sawToolResult
          ? chunk({ role: "assistant", content: "final answer from mock" }, null) +
            chunk({}, "stop") +
            "data: [DONE]\n\n"
          : chunk(
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: "call_load_1",
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({ command: "echo load-test" }),
                    },
                  },
                ],
              },
              null,
            ) +
            chunk({ tool_calls: [{ index: 0, function: { arguments: "" } }] }, "tool_calls") +
            "data: [DONE]\n\n";
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      },
    });
    cleanups.push(() => server.stop(true));

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

    const first = startAgent(dir, ws);
    let sessionId = "";
    try {
      await first.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const created = await first.request("session/new", { cwd: ws, mcpServers: [] });
      sessionId = String(created.result?.sessionId ?? "");
      await first.request("session/set_model", { sessionId, modelId: "mock/mock-model" });
      const result = await first.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "run load test" }],
      });
      expect(result.result?.stopReason).toBe("end_turn");
    } finally {
      await first.close();
    }

    const second = startAgent(dir, ws);
    try {
      await second.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const loaded = await second.request("session/load", {
        sessionId,
        cwd: ws,
        mcpServers: [],
      });
      expect(loaded.result?.modes).toMatchObject({ currentModeId: "agent" });
      const kinds = second.updates.map((u) => u.sessionUpdate);
      expect(kinds).toContain("user_message_chunk");
      expect(kinds).toContain("tool_call");
      expect(kinds).toContain("tool_call_update");
      expect(kinds).toContain("agent_message_chunk");
      const user = second.updates.find((u) => u.sessionUpdate === "user_message_chunk");
      expect(JSON.stringify(user)).toContain("run load test");
      const text = second.updates.find(
        (u) =>
          u.sessionUpdate === "agent_message_chunk" &&
          JSON.stringify(u).includes("final answer from mock"),
      );
      expect(text).toBeTruthy();
    } finally {
      await second.close();
    }
  }, 40_000);
});
