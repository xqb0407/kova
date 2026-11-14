/**
 * 共享凭据 e2e：桌面导出镜像（含自定义 provider + key + 模型条目）→
 * 真进程 --acp → session/new 返回的 models 命中镜像里的模型。
 * 不触发模型请求（没有真实网关），所以不依赖网络。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCredentialFile } from "pi-protocol/credential-file";

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

function startAgent(dataDir: string, credentialsFile: string) {
  const entry = join(import.meta.dir, "..", "..", "src", "index.ts");
  const child = spawn(process.execPath, [entry, "--acp"], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, KOVA_ACP_DATA_DIR: dataDir, KOVA_CREDENTIALS_FILE: credentialsFile },
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

describe("ACP shared credentials e2e", () => {
  test("session/new 的 models 命中桌面镜像注入的自定义 provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kova-acp-shared-cred-"));
    dirs.push(dir);
    const cwd = join(dir, "ws");
    mkdirSync(cwd, { recursive: true });
    const credentialsFile = join(dir, "credentials.json");
    writeCredentialFile(credentialsFile, {
      credentials: { "e2e-gateway": "e2e-key" },
      customProviders: [
        {
          id: "e2e-gateway",
          name: "E2E Gateway",
          baseUrl: "https://e2e.invalid",
          models: JSON.stringify([{ modelId: "e2e-mini" }]),
          api: "openai-chat",
          enabled: true,
          autoDiscover: false,
          headers: "{}",
        },
      ],
      models: [
        {
          provider: "e2e-gateway",
          modelId: "e2e-mini",
          name: "E2E Mini",
          contextWindow: 32000,
          enabled: true,
        },
      ],
    });

    const agent = startAgent(dir, credentialsFile);
    try {
      await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, 1);
      const created = await agent.request("session/new", { cwd, mcpServers: [] }, 2);
      const models = (created.result?.models as
        | { availableModels?: Array<{ modelId?: string; name?: string }>; currentModelId?: string }
        | undefined);
      expect(models).toBeTruthy();
      const ids = (models?.availableModels ?? []).map((m) => m.modelId ?? "");
      expect(ids).toContain("e2e-gateway/e2e-mini");
      expect(models?.currentModelId).toBe("e2e-gateway/e2e-mini");
      expect(agent.parseError()).toBeNull();
    } finally {
      await agent.close();
    }
  }, 30_000);

  test("共享文件缺失：session/new 仍成功（回退 env，模型列表为空/缺省）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kova-acp-shared-cred-absent-"));
    dirs.push(dir);
    const cwd = join(dir, "ws");
    mkdirSync(cwd, { recursive: true });
    const agent = startAgent(dir, join(dir, "absent.json"));
    try {
      await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, 1);
      const created = await agent.request("session/new", { cwd, mcpServers: [] }, 2);
      expect(typeof created.result?.sessionId).toBe("string");
      // 无凭据时 loadModels 拿不到 authed 模型，models 字段缺省
      expect(created.result?.models).toBeUndefined();
      expect(agent.parseError()).toBeNull();
    } finally {
      await agent.close();
    }
  }, 30_000);
});
