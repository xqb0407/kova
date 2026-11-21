import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createServer } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { initStorage } from "../../src/storage/storage";
import { dispatch, handleLine, setInitGate } from "../../src/protocol/protocol";
import { mcpManager } from "../../src/mcp/mcp-manager";
import { loadMcpServers, resetMcpConfigForTest } from "../../src/mcp/mcp-config";
import { resetPluginsForTest } from "../../src/plugins/plugins";
import { resetMcpSecretBindingsForTest } from "../../src/mcp/mcp-secrets";
import { resetMcpCacheForTest } from "../../src/mcp/mcp-cache";
import { resetMcpOAuthForTest } from "../../src/mcp/mcp-oauth";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-mcp-protocol-"));
const systemConfig = path.join(tmp, "mcp.json");
const cacheFile = path.join(tmp, "cache.json");
const cwd = path.join(tmp, "repo");
const FAKE_SERVER = join(import.meta.dir, "..", "fake-mcp-server.mjs");

const prevConfig = process.env.PI_MCP_CONFIG;
const prevCachePath = process.env.PI_MCP_CACHE_PATH;
const prevAuditPath = process.env.PI_MCP_AUDIT_PATH;

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
  process.env.PI_MCP_CONFIG = systemConfig;
  process.env.PI_MCP_CACHE_PATH = cacheFile;
  // 审计事件也进临时文件：绝不写开发者真实的 ~/.kova/mcp-audit.jsonl
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
  resetMcpSecretBindingsForTest();
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

/** 等某个 reqId 的应答落地：派活式命令（test/tools/授权）的应答晚于 dispatch 返回 */
async function waitForLine(id: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { id?: unknown };
        if (parsed?.id === id) return parsed as Record<string, unknown>;
      } catch {
        /* 非 JSON 行（日志等）忽略 */
      }
    }
    if (Date.now() > deadline) throw new Error(`等待应答超时：${id}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

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

  test("save 携带 secretEnv：回读绑定；配置变更且未重新授权时丢弃旧绑定", async () => {
    const base = {
      name: "fake-secret",
      transport: "stdio" as const,
      command: process.execPath,
      args: [FAKE_SERVER],
    };
    const binding = [{ envName: "TOKEN", name: "TOKEN", scope: "global" as const }];
    await dispatch("s1", {
      type: "save_mcp_server",
      layer: "system",
      definition: base,
      secretEnv: binding,
    });
    let entry = (last().servers as Array<Record<string, unknown>>)[0];
    expect(entry.secretEnv).toEqual(binding);
    expect(entry.configHash).toEqual(expect.any(String));
    const originalHash = entry.configHash as string;

    // 改启动参数，但只带了旧的 secretEnv（模拟用户没动密钥行）→ 绑定被解除
    await dispatch("s2", {
      type: "save_mcp_server",
      layer: "system",
      name: "fake-secret",
      definition: { ...base, args: [FAKE_SERVER, "--changed"] },
      secretEnv: binding,
      secretBindingHash: originalHash,
    });
    entry = (last().servers as Array<Record<string, unknown>>)[0];
    expect(entry.secretEnv).toBeUndefined();
    expect(entry.secretBindingStale).toBeUndefined();

    // 显式重新提交（不带旧哈希）→ 绑定按新配置生效
    await dispatch("s3", {
      type: "save_mcp_server",
      layer: "system",
      name: "fake-secret",
      definition: { ...base, args: [FAKE_SERVER, "--changed"] },
      secretEnv: binding,
    });
    entry = (last().servers as Array<Record<string, unknown>>)[0];
    expect(entry.secretEnv).toEqual(binding);
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
    // 派活式：握手结果晚点用同一 reqId 回帧
    const res = await waitForLine("m5");
    expect(res.type).toBe("mcp_server_test");
    const status = res.status as Record<string, unknown>;
    expect(status.state).toBe("ready");
    expect(status.toolCount).toBe(6);
    expect(status.capabilities).toEqual({ resources: true, prompts: true, tasks: false });
    // 未知服务器报错（校验前置，仍在 dispatch 内同步抛）
    await expect(
      dispatch("m6", { type: "test_mcp_server", layer: "system", name: "ghost" }),
    ).rejects.toThrow("not found");
  });

  test("resources/prompts 协议：列表、读取、取 Prompt", async () => {
    writeSystemConfig();
    await dispatch("cap0", { type: "test_mcp_server", layer: "system", name: "fake" });
    await waitForLine("cap0");

    await dispatch("cap-res-list", { type: "list_mcp_resources", name: "fake" });
    const resources = await waitForLine("cap-res-list");
    expect(resources.type).toBe("mcp_resources");
    expect((resources.resources as unknown[]).length).toBe(2);
    expect((resources.resourceTemplates as unknown[]).length).toBe(1);

    await dispatch("cap-res-read", {
      type: "read_mcp_resource",
      name: "fake",
      uri: "file:///fake/readme.md?token=secret",
    });
    const read = await waitForLine("cap-res-read");
    expect(read.type).toBe("mcp_resource_content");
    expect(read.text).toContain("# Fake");
    expect(JSON.stringify(read)).not.toContain("token=secret");

    await dispatch("cap-prompt-list", { type: "list_mcp_prompts", name: "fake" });
    const prompts = await waitForLine("cap-prompt-list");
    expect(prompts.type).toBe("mcp_prompts");
    expect((prompts.prompts as unknown[]).length).toBe(2);

    await dispatch("cap-prompt-get", {
      type: "get_mcp_prompt",
      name: "fake",
      prompt: "summarize",
      args: { topic: "MCP" },
    });
    const prompt = await waitForLine("cap-prompt-get");
    expect(prompt.type).toBe("mcp_prompt");
    expect(prompt.text).toContain("Summarize MCP");
    expect(prompt.messages).toEqual([{ role: "user", text: "Summarize MCP" }]);
  });

  test("test_mcp_server 支持 plugin 层：插件 MCP 也能从 UI 首次连接", async () => {
    const pluginsRoot = path.join(tmp, "plugins");
    const pluginDir = path.join(pluginsRoot, "cache", "dev", "proto-pack");
    const prevPluginsDir = process.env.PI_PLUGINS_DIR;
    try {
      process.env.PI_PLUGINS_DIR = pluginsRoot;
      mkdirSync(path.join(pluginDir, ".kova-plugin"), { recursive: true });
      writeFileSync(
        path.join(pluginDir, ".kova-plugin", "plugin.json"),
        JSON.stringify({
          name: "proto-pack",
          version: "1.0.0",
          mcpServers: "mcp.json",
        }),
      );
      writeFileSync(
        path.join(pluginDir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            fakePlugin: {
              type: "stdio",
              command: process.execPath,
              args: [FAKE_SERVER],
            },
          },
        }),
      );
      resetPluginsForTest();
      resetMcpConfigForTest();

      // 先确认合并链确实把插件条目放进了 plugin 层
      const { defs } = await loadMcpServers(cwd);
      expect(defs.find((d) => d.name === "fakePlugin")?.layer).toBe("plugin");

      await dispatch("mp", {
        type: "test_mcp_server",
        layer: "plugin",
        name: "fakePlugin",
      });
      const res = await waitForLine("mp");
      expect(res.type).toBe("mcp_server_test");
      const status = res.status as Record<string, unknown>;
      expect(status.state).toBe("ready");
      expect(status.toolCount).toBe(6);

      // 卸载插件后该服务器已无任何层定义：缓存也要一起清，避免重装同名
      // 同配置的服务器时 search 先读到上一份工具面
      await dispatch("mpu", {
        type: "uninstall_plugin",
        pluginId: "proto-pack@dev",
      });
      const cache = JSON.parse(readFileSync(cacheFile, "utf8")) as {
        servers: Record<string, unknown>;
      };
      expect(cache.servers.fakePlugin).toBeUndefined();
    } finally {
      mcpManager.disposeAll();
      rmSync(pluginsRoot, { recursive: true, force: true });
      resetPluginsForTest();
      resetMcpConfigForTest();
      if (prevPluginsDir === undefined) delete process.env.PI_PLUGINS_DIR;
      else process.env.PI_PLUGINS_DIR = prevPluginsDir;
    }
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
      const res = await waitForLine("mr");
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
    expect((await waitForLine("m7")).status).toMatchObject({ state: "ready" });
    await dispatch("m8", { type: "delete_mcp_server", layer: "system", name: "fake" });
    const res = last();
    expect(res.type).toBe("mcp_servers");
    expect(res.servers).toHaveLength(0);
    expect(mcpManager.activeCount).toBe(0);
  });

  test("delete_mcp_server 清掉工具元数据缓存", async () => {
    writeSystemConfig();
    await dispatch("md1", { type: "test_mcp_server", layer: "system", name: "fake" });
    await waitForLine("md1");
    const before = JSON.parse(readFileSync(cacheFile, "utf8")) as {
      servers: Record<string, unknown>;
    };
    expect(before.servers.fake).toBeDefined();

    await dispatch("md2", { type: "delete_mcp_server", layer: "system", name: "fake" });
    const after = JSON.parse(readFileSync(cacheFile, "utf8")) as {
      servers: Record<string, unknown>;
    };
    expect(after.servers.fake).toBeUndefined();
  });

  test("reload_mcp_connections 按新 cwd 断开已删除的 workspace 服务器", async () => {
    const wsCwd = path.join(tmp, "ws-reload");
    const stdConfig = path.join(wsCwd, ".mcp.json");
    mkdirSync(wsCwd, { recursive: true });
    writeFileSync(
      stdConfig,
      JSON.stringify({
        mcpServers: {
          wsFake: { command: process.execPath, args: [FAKE_SERVER] },
        },
      }),
      "utf8",
    );
    await dispatch("mr1", {
      type: "set_mcp_server_enabled",
      layer: "workspace",
      name: "wsFake",
      enabled: true,
      cwd: wsCwd,
    });
    await dispatch("mr2", {
      type: "test_mcp_server",
      layer: "workspace",
      name: "wsFake",
      cwd: wsCwd,
    });
    expect((await waitForLine("mr2")).status).toMatchObject({ state: "ready" });
    expect(mcpManager.activeCount).toBe(1);

    // 模拟外部删除 .mcp.json：list 不会断连，reload 才按新启用集合 diff
    unlinkSync(stdConfig);
    await dispatch("mr3", { type: "reload_mcp_connections", cwd: wsCwd });
    expect(mcpManager.activeCount).toBe(0);
    const res = last();
    expect(res.type).toBe("mcp_servers");
    expect(
      (res.servers as Array<{ name: string }>).some((s) => s.name === "wsFake"),
    ).toBe(false);
    const cache = JSON.parse(readFileSync(cacheFile, "utf8")) as {
      servers: Record<string, unknown>;
    };
    expect(cache.servers.wsFake).toBeUndefined();
    rmSync(wsCwd, { recursive: true, force: true });
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

  /**
   * 回归点（"全应用假死"根因之一）：非 prompt 命令走 mgmt 串行队列，任何在 handler
   * 里 await 十几秒的命令（握手 10s 起）都会把这段时间的所有请求一起堵死。test/tools
   * 已改派活——这里用可控的 ensureConnected 模拟"握手迟迟不回"，验证：
   *   1) 长命令不占队列（后到的短命令先回）
   *   2) 长命令的结果仍按同一个 reqId 回帧
   * 走 handleLine（而非直接 dispatch）才有队列语义。
   */
  test("派活：长握手不占 mgmt 队列，结果按同一 reqId 回帧", async () => {
    writeSystemConfig();
    const original = mcpManager.ensureConnected;
    let release: () => void = () => {};
    mcpManager.ensureConnected = () =>
      new Promise<never[]>((resolve) => {
        release = () => resolve([]);
      });
    try {
      handleLine(JSON.stringify({ type: "test_mcp_server", id: "slow1", layer: "system", name: "fake" }));
      handleLine(JSON.stringify({ type: "list_mcp_servers", id: "fast1" }));
      // 后到的短命令先回 = 队列没被长命令占住
      const fast = await waitForLine("fast1", 2000);
      expect(fast.type).toBe("mcp_servers");
      // 长命令还没结算，且不阻塞别人
      expect(lines.some((l) => l.includes('"id":"slow1"'))).toBe(false);
      release();
      const slow = await waitForLine("slow1", 2000);
      expect(slow.type).toBe("mcp_server_test");
    } finally {
      mcpManager.ensureConnected = original;
    }
  });
});
