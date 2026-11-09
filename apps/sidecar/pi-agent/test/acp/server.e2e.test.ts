/**
 * ACP 协议骨架 e2e：真进程 --acp，验证 initialize/session/new 与 stdout 纯净。
 * 不触发模型请求（没有凭据），所以不依赖网络。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
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

function startAgent(dataDir: string) {
  const entry = join(import.meta.dir, "..", "..", "src", "index.ts");
  const child = spawn(process.execPath, [entry, "--acp"], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, KOVA_ACP_DATA_DIR: dataDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const messages: RpcMessage[] = [];
  const waiters = new Map<number | string, (msg: RpcMessage) => void>();
  let parseError: Error | null = null;

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as RpcMessage;
        if (msg.jsonrpc !== "2.0") throw new Error(`non JSON-RPC line: ${line.slice(0, 200)}`);
        messages.push(msg);
        if (msg.id !== undefined) waiters.get(msg.id)?.(msg);
      } catch (err) {
        parseError = err instanceof Error ? err : new Error(String(err));
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const request = (method: string, params: Record<string, unknown>, id: number) =>
    new Promise<RpcMessage>((resolve, reject) => {
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

  return {
    child,
    messages,
    request,
    stderr: () => stderr,
    parseError: () => parseError,
    close: async () => {
      child.stdin.end();
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    },
  };
}

describe("ACP server e2e", () => {
  test("initialize + session/new，stdout 全部是 JSON-RPC", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kova-acp-server-e2e-"));
    dirs.push(dir);
    const cwd = join(dir, "ws");
    mkdirSync(cwd, { recursive: true });
    const agent = startAgent(dir);
    try {
      const init = await agent.request(
        "initialize",
        { protocolVersion: 1, clientCapabilities: {} },
        1,
      );
      expect(init.result?.protocolVersion).toBe(1);
      expect(init.result?.agentCapabilities).toMatchObject({ loadSession: true });

      const created = await agent.request(
        "session/new",
        { cwd, mcpServers: [] },
        2,
      );
      expect(typeof created.result?.sessionId).toBe("string");
      expect(created.result?.modes).toMatchObject({ currentModeId: "agent" });

      const sessionId = String(created.result?.sessionId ?? "");
      const mode = await agent.request(
        "session/set_mode",
        { sessionId, modeId: "plan" },
        3,
      );
      expect(mode.result).toEqual({});
      // 模式变化通知（current_mode_update）应该跟着发出
      const modeUpdate = agent.messages.find(
        (m) =>
          m.method === "session/update" &&
          (m.params?.update as { sessionUpdate?: string } | undefined)?.sessionUpdate ===
            "current_mode_update",
      );
      expect(modeUpdate).toBeTruthy();

      await expect(
        agent.request("session/set_mode", { sessionId, modeId: "nope" }, 4),
      ).rejects.toThrow(/unknown mode/);
      // 内部命令错误必须把真实文案带到 JSON-RPC message，而不是 "Internal error"
      await expect(
        agent.request("session/set_model", { sessionId, modelId: "nope/nope" }, 5),
      ).rejects.toThrow(/model not found/);

      const updates = agent.messages.filter((m) => m.method === "session/update");
      expect(updates.length).toBeGreaterThanOrEqual(0);
      expect(agent.parseError()).toBeNull();
    } finally {
      await agent.close();
    }
  }, 30_000);

  test("空会话跨进程 session/load（messageCount=0 不能被误判为不存在）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kova-acp-load-empty-e2e-"));
    dirs.push(dir);
    const cwd = join(dir, "ws");
    mkdirSync(cwd, { recursive: true });

    const first = startAgent(dir);
    let sessionId = "";
    try {
      await first.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, 1);
      const created = await first.request("session/new", { cwd, mcpServers: [] }, 2);
      sessionId = String(created.result?.sessionId ?? "");
      await first.request("session/set_mode", { sessionId, modeId: "plan" }, 3);
    } finally {
      await first.close();
    }

    const second = startAgent(dir);
    try {
      await second.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, 1);
      const loaded = await second.request(
        "session/load",
        { sessionId, cwd, mcpServers: [] },
        2,
      );
      expect(loaded.result?.modes).toMatchObject({ currentModeId: "plan" });
    } finally {
      await second.close();
    }
  }, 30_000);
});
