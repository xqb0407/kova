import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { initStorage } from "../storage/storage";
import { dispatch, setInitGate } from "../protocol/protocol";
import { mcpManager } from "./mcp-manager";
import { resetMcpConfigForTest } from "./mcp-config";
import { resetMcpCacheForTest } from "./mcp-cache";
import { resetMcpOAuthForTest } from "./mcp-oauth";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-mcp-protocol-"));
const systemConfig = path.join(tmp, "mcp.json");
const cacheFile = path.join(tmp, "cache.json");
const cwd = path.join(tmp, "repo");
const FAKE_SERVER = join(import.meta.dir, "..", "..", "test", "fake-mcp-server.mjs");

const prevConfig = process.env.PI_MCP_CONFIG;
const prevCachePath = process.env.PI_MCP_CACHE_PATH;
const prevAuditPath = process.env.PI_MCP_AUDIT_PATH;

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
  process.env.PI_MCP_CONFIG = systemConfig;
  process.env.PI_MCP_CACHE_PATH = cacheFile;
  // 审计事件也进临时文件：绝不写开发者真实的 ~/.xulux/mcp-audit.jsonl
  process.env.PI_MCP_AUDIT_PATH = path.join(tmp, "audit.jsonl");
  setInitGate(Promise.resolve());
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

beforeEach(() => {
  for (const p of [systemConfig, cacheFile]) {
    if (existsSync(p)) unlinkSync(p);
  }
  mcpManager.disposeAll();
  resetMcpConfigForTest();
  resetMcpCacheForTest();
});

/** 捕获协议流（send 写 process.stdout） */
const lines: string[] = [];
let origWrite: typeof process.stdout.write;
beforeAll(() => {
  origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
    lines.push(String(c));
    return true;
  };
});
afterAll(() => {
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write =
    origWrite as unknown as (c: unknown) => boolean;
});

const last = (): Record<string, unknown> => JSON.parse(lines[lines.length - 1]);

const writeSystemConfig = () => {
  writeFileSync(
    systemConfig,
    JSON.stringify({
      mcpServers: {
        fake: {
          type: "stdio",
          command: process.execPath,
          args: [FAKE_SERVER],
          description: "fake for protocol test",
        },
      },
    }),
    "utf8",
  );
};

describe("MCP 协议消息", () => {
  test("save → list 回读；应答带状态与启用标志", async () => {
    await dispatch("m1", {
      type: "save_mcp_server",
      layer: "system",
      definition: {
        name: "fake",
        transport: "stdio",
        command: process.execPath,
        args: [FAKE_SERVER],
        description: "fake for protocol test",
      },
    });
    const res = last();
    expect(res.type).toBe("mcp_servers");
    const servers = res.servers as Array<Record<string, unknown>>;
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("fake");
    expect(servers[0].enabled).toBe(true);
    expect(servers[0].layer).toBe("system");
    expect(servers[0].transport).toBe("stdio");
    expect(servers[0].command).toBe(process.execPath);
    expect((servers[0].status as Record<string, unknown>).state).toBe("idle");
  });

  test("保存校验失败：dispatch 抛错（handleLine 统一转 error 应答）", async () => {
    await expect(
      dispatch("m2", {
        type: "save_mcp_server",
        layer: "system",
        definition: { name: "bad name", transport: "stdio", command: "npx" },
      }),
    ).rejects.toThrow("名称需匹配");
  });

  test("set_mcp_server_enabled 落 kv 并回到应答", async () => {
    writeSystemConfig();
    await dispatch("m3", {
      type: "set_mcp_server_enabled",
      layer: "system",
      name: "fake",
      enabled: false,
    });
    const res = last();
    expect(res.type).toBe("mcp_servers");
    expect((res.servers as Array<Record<string, unknown>>)[0].enabled).toBe(false);
    // 禁用后重连池里没有该服务器（applyConfig diff）
    expect(mcpManager.activeCount).toBe(0);
    await dispatch("m4", {
      type: "set_mcp_server_enabled",
      layer: "system",
      name: "fake",
      enabled: true,
    });
    expect((last().servers as Array<Record<string, unknown>>)[0].enabled).toBe(true);
  });

  test("test_mcp_server 强制握手返回 ready + 工具数", async () => {
    writeSystemConfig();
    await dispatch("m5", { type: "test_mcp_server", layer: "system", name: "fake" });
    const res = last();
    expect(res.type).toBe("mcp_server_test");
    const status = res.status as Record<string, unknown>;
    expect(status.state).toBe("ready");
    expect(status.toolCount).toBe(6);
    // 未知服务器报错
    await expect(
      dispatch("m6", { type: "test_mcp_server", layer: "system", name: "ghost" }),
    ).rejects.toThrow("not found");
  });

  test("test_mcp_server 成功应答带全量状态：oauthAuthorized 测完不丢", async () => {
    // 极简 streamable-HTTP fake：initialize + tools/list（形态照抄 manager 测试的服务器）
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let m: { id?: unknown; method?: string };
        try {
          m = JSON.parse(body || "{}");
        } catch {
          m = {};
        }
        if (m.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: m.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "authfake", version: "1" },
              },
            }),
          );
        } else if (m.method === "tools/list") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: m.id,
              result: {
                tools: [{ name: "t", inputSchema: { type: "object", properties: {} } }],
              },
            }),
          );
        } else if (m.id !== undefined) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nope" } }),
          );
        } else {
          res.writeHead(202);
          res.end();
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/mcp`;
    const prevOAuth = process.env.PI_MCP_OAUTH_PATH;
    try {
      // 存量凭据（按 URL 键控）：OAuth store 临时指向放了 token 的文件
      const oauthFile = path.join(tmp, "oauth-regression.json");
      writeFileSync(
        oauthFile,
        JSON.stringify({ [url]: { tokens: { access_token: "tok", token_type: "Bearer" } } }),
        "utf8",
      );
      process.env.PI_MCP_OAUTH_PATH = oauthFile;
      resetMcpOAuthForTest();
      writeFileSync(systemConfig, JSON.stringify({ mcpServers: { authed: { type: "http", url } } }), "utf8");
      await dispatch("mr", { type: "test_mcp_server", layer: "system", name: "authed" });
      const res = last();
      expect(res.type).toBe("mcp_server_test");
      const status = res.status as Record<string, unknown>;
      expect(status.state).toBe("ready");
      expect(status.toolCount).toBe(1);
      // 回归点：前端测试后整段覆盖行状态，应答漏 oauthAuthorized = 取消授权按钮测一次就消失
      expect(status.oauthAuthorized).toBe(true);
    } finally {
      if (prevOAuth === undefined) delete process.env.PI_MCP_OAUTH_PATH;
      else process.env.PI_MCP_OAUTH_PATH = prevOAuth;
      resetMcpOAuthForTest();
      srv.closeAllConnections?.();
      srv.close();
    }
  });

  test("delete_mcp_server 删条目并断连", async () => {
    writeSystemConfig();
    await dispatch("m7", { type: "test_mcp_server", layer: "system", name: "fake" });
    expect((last() as { status?: { state?: string } }).status?.state).toBe("ready");
    await dispatch("m8", { type: "delete_mcp_server", layer: "system", name: "fake" });
    const res = last();
    expect(res.type).toBe("mcp_servers");
    expect(res.servers).toHaveLength(0);
    expect(mcpManager.activeCount).toBe(0);
  });

  test("list_mcp_servers 带诊断", async () => {
    writeFileSync(systemConfig, "{broken", "utf8");
    await dispatch("m9", { type: "list_mcp_servers" });
    const res = last();
    expect(res.type).toBe("mcp_servers");
    expect(res.servers).toHaveLength(0);
    expect((res.diagnostics as string[]).length).toBeGreaterThan(0);
  });

  test("workspace 层保存需要 cwd", async () => {
    await expect(
      dispatch("m10", {
        type: "save_mcp_server",
        layer: "workspace",
        definition: { name: "w", transport: "stdio", command: "npx" },
      }),
    ).rejects.toThrow("cwd");
  });
});
