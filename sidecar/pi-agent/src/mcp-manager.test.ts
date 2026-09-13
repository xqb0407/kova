import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { mcpManager, McpManager, mcpChildEnv, MCP_FAILURE_BACKOFF_MS } from "./mcp-manager";
import { resetMcpCacheForTest, getValidTools } from "./mcp-cache";
import type { McpServerDef } from "./mcp-config";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-mcp-manager-"));
const prevCachePath = process.env.PI_MCP_CACHE_PATH;
const prevSecret = process.env.PI_MCP_TEST_SECRET;

const FAKE_SERVER = join(import.meta.dir, "..", "test", "fake-mcp-server.mjs");

const stdioDef = (overrides: Partial<McpServerDef> = {}): McpServerDef => ({
  name: "fake",
  transport: "stdio",
  command: process.execPath,
  args: [FAKE_SERVER],
  layer: "system",
  source: "",
  ...overrides,
});

beforeAll(() => {
  process.env.PI_MCP_CACHE_PATH = path.join(tmp, "cache.json");
  process.env.PI_MCP_TEST_SECRET = "should-not-leak";
});

afterAll(() => {
  mcpManager.disposeAll();
  if (prevCachePath === undefined) delete process.env.PI_MCP_CACHE_PATH;
  else process.env.PI_MCP_CACHE_PATH = prevCachePath;
  if (prevSecret === undefined) delete process.env.PI_MCP_TEST_SECRET;
  else process.env.PI_MCP_TEST_SECRET = prevSecret;
});

const freshManager = () => {
  mcpManager.disposeAll();
  resetMcpCacheForTest();
  return mcpManager;
};

describe("stdio 传输（fake server）", () => {
  test("懒连接 + 分页 tools/list + 缓存写入", async () => {
    const mgr = freshManager();
    const def = stdioDef();
    // 未连接前状态 idle
    expect(mgr.statusFor(def).state).toBe("idle");
    const tools = await mgr.ensureConnected(def);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "crash",
      "echo",
      "env_check",
      "fail",
      "page2_a",
      "page2_b",
    ]);
    expect(mgr.statusFor(def).state).toBe("ready");
    expect(mgr.statusFor(def).toolCount).toBe(6);
    // 握手后元数据缓存可独立命中
    expect(getValidTools(def)?.length).toBe(6);
    // 二次调用走已连接路径
    expect(await mgr.ensureConnected(def)).toHaveLength(6);
  });

  test("callTool 成功与白名单拒绝", async () => {
    const mgr = freshManager();
    const def = stdioDef();
    const ok = await mgr.callTool(def, "echo", { text: "hi" });
    const text = (ok as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toBe("echo:hi");
    // 服务器未广播的名字拒绝转发（不直达服务器）
    expect(mgr.callTool(def, "nonexistent", {})).rejects.toThrow("未提供工具");
  });

  test("业务错误（isError）不清连接；传输死亡后自动重连", async () => {
    const mgr = freshManager();
    const def = stdioDef();
    await mgr.ensureConnected(def);
    const state1 = mgr.statusFor(def).state;
    // isError 结果：SDK 会把它作为结果返回（不 throw），连接保持
    await mgr.callTool(def, "fail", {});
    expect(mgr.statusFor(def).state).toBe(state1);
    // crash：服务器退出 → 进行中的调用以错误收场（调用确实未完成），onclose 置 idle
    await expect(mgr.callTool(def, "crash", {})).rejects.toThrow();
    await Bun.sleep(100); // 等 onclose 结算
    expect(mgr.statusFor(def).state).toBe("idle");
    const tools = await mgr.ensureConnected(def);
    expect(tools).toHaveLength(6);
  });

  test("stdio 子进程环境隔离：宿主环境变量不外泄，显式 env 通过", async () => {
    const mgr = freshManager();
    const def = stdioDef({ env: { MCP_FAKE_DECLARED: "yes" } });
    const raw = await mgr.callTool(def, "env_check", {});
    const envState = JSON.parse(
      (raw as { content: Array<{ text: string }> }).content[0].text,
    ) as { declared: string | null; secret: string | null; pathPresent: boolean };
    expect(envState.declared).toBe("yes");
    // PI_MCP_TEST_SECRET 在测试进程里存在，但不得进入子进程
    expect(envState.secret).toBeNull();
    expect(envState.pathPresent).toBe(true);
  });

  test("配置热重载：配置变更断连，未变保持", async () => {
    const mgr = freshManager();
    const def = stdioDef();
    await mgr.ensureConnected(def);
    expect(mgr.statusFor(def).state).toBe("ready");
    // 同配置 applyConfig：连接保持
    mgr.applyConfig([def]);
    expect(mgr.statusFor(def).state).toBe("ready");
    // 配置变更：断连
    mgr.applyConfig([stdioDef({ args: [FAKE_SERVER, "--changed"] })]);
    expect(mgr.statusFor(def).state).toBe("idle");
    // 变更后重连用新配置（fake server 忽略多余参数，仍能握手）
    const tools = await mgr.ensureConnected(stdioDef({ args: [FAKE_SERVER, "--changed"] }));
    expect(tools).toHaveLength(6);
    // 删除：从池中移除
    mgr.applyConfig([]);
    expect(mgr.statusFor(def).state).toBe("idle");
  });
});

describe("退避与上限", () => {
  test("握手失败进入退避，退避期内快速失败", async () => {
    const mgr = freshManager();
    const bad = stdioDef({ name: "bad", command: "definitely-not-a-command-xyz" });
    await expect(mgr.ensureConnected(bad)).rejects.toThrow();
    expect(mgr.statusFor(bad).state).toBe("backoff");
    const t0 = Date.now();
    await expect(mgr.ensureConnected(bad)).rejects.toThrow("退避中");
    expect(Date.now() - t0).toBeLessThan(MCP_FAILURE_BACKOFF_MS / 2);
  });

  test("空闲回收只作用于 lazy；keep-alive 豁免", async () => {
    const mgr = freshManager();
    const lazyDef = stdioDef({ name: "lazy", idleTimeout: 1000 });
    const keepDef = stdioDef({ name: "keep", lifecycle: "keep-alive", idleTimeout: 1000 });
    await mgr.ensureConnected(lazyDef);
    await mgr.ensureConnected(keepDef);
    // 前推 2 秒再回收
    mgr.reapIdle(Date.now() + 2000);
    expect(mgr.statusFor(lazyDef).state).toBe("idle");
    expect(mgr.statusFor(keepDef).state).toBe("ready");
  });

  test("活跃连接上限按 LRU 驱逐", async () => {
    const mgr = freshManager();
    // 占满上限
    for (let i = 0; i < 16; i++) {
      await mgr.ensureConnected(stdioDef({ name: `s${i}` }));
    }
    expect(mgr.activeCount).toBe(16);
    // 最旧的 s0 被驱逐，新连接成功
    const tools = await mgr.ensureConnected(stdioDef({ name: "extra" }));
    expect(tools).toHaveLength(6);
    expect(mgr.activeCount).toBeLessThanOrEqual(16);
    expect(mgr.statusFor(stdioDef({ name: "s0" })).state).toBe("idle");
  });
});

describe("streamable HTTP 传输", () => {
  let srv: Server;
  let baseUrl: string;

  beforeAll(async () => {
    srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let m: { id?: unknown; method?: string; params?: { name?: string } };
        try {
          m = JSON.parse(body || "{}");
        } catch {
          m = {};
        }
        const reply = (result: unknown) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
        };
        if (m.method === "initialize") {
          reply({
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-http", version: "1" },
          });
        } else if (m.method === "tools/list") {
          reply({
            tools: [{ name: "ping", description: "p", inputSchema: { type: "object", properties: {} } }],
          });
        } else if (m.method === "tools/call") {
          const seenAuth = req.headers.authorization ?? "";
          reply({ content: [{ type: "text", text: `pong:${seenAuth}` }] });
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
    baseUrl = `http://127.0.0.1:${(srv.address() as { port: number }).port}/mcp`;
  });

  afterAll(() => {
    srv.closeAllConnections?.();
    srv.close();
  });

  test("connect + callTool + headers 透传", async () => {
    const mgr = freshManager();
    const def: McpServerDef = {
      name: "httpfake",
      transport: "http",
      url: baseUrl,
      headers: { Authorization: "Bearer t0k" },
      layer: "system",
      source: "",
    };
    const tools = await mgr.ensureConnected(def);
    expect(tools.map((t) => t.name)).toEqual(["ping"]);
    const raw = await mgr.callTool(def, "ping", {});
    const text = (raw as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toBe("pong:Bearer t0k");
    expect(mgr.statusFor(def).state).toBe("ready");
  });
});

describe("mcpChildEnv", () => {
  test("只透传声明值", () => {
    expect(mcpChildEnv({ A: "1" })).toEqual({ A: "1" });
    expect(mcpChildEnv(undefined)).toEqual({});
  });
});
