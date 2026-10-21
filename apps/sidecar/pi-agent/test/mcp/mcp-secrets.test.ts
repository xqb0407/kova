/**
 * MCP 密钥绑定：用户级授权、configHash 失效、宿主解析、子进程注入与输出脱敏。
 *
 * 这里用 local 存储模式打通整条链：kv 绑定 → secret_env_resolve（local 实现）
 * → StdioClientTransport env → fake server 回显 → callTool 脱敏。
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import {
  initLocalStorage,
  resetStorageForTest,
  secretDelete,
  secretSet,
} from "../../src/storage/hostdb";
import { computeConfigHash } from "../../src/mcp/mcp-cache";
import {
  mcpSecretBindingFor,
  mcpSecretBindingStale,
  redactMcpSecretText,
  redactMcpSecretValue,
  resetMcpSecretBindingsForTest,
  resolveMcpSecretEnvForSpawn,
  saveMcpSecretBindings,
} from "../../src/mcp/mcp-secrets";
import { mcpChildEnv, mcpManager } from "../../src/mcp/mcp-manager";
import type { McpServerDef } from "../../src/mcp/mcp-config";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-mcp-secrets-"));
const FAKE_SERVER = join(import.meta.dir, "..", "fake-mcp-server.mjs");
const prevCachePath = process.env.PI_MCP_CACHE_PATH;
const prevAuditPath = process.env.PI_MCP_AUDIT_PATH;

const stdioDef = (name: string, overrides: Partial<McpServerDef> = {}): McpServerDef => ({
  name,
  transport: "stdio",
  command: process.execPath,
  args: [FAKE_SERVER],
  layer: "system",
  source: "",
  ...overrides,
});

beforeAll(() => {
  process.env.PI_MCP_CACHE_PATH = join(tmp, "cache.json");
  process.env.PI_MCP_AUDIT_PATH = join(tmp, "audit.jsonl");
  initLocalStorage(join(tmp, "state.db"));
});

afterAll(() => {
  mcpManager.disposeAll();
  resetStorageForTest();
  resetMcpSecretBindingsForTest();
  if (prevCachePath === undefined) delete process.env.PI_MCP_CACHE_PATH;
  else process.env.PI_MCP_CACHE_PATH = prevCachePath;
  if (prevAuditPath === undefined) delete process.env.PI_MCP_AUDIT_PATH;
  else process.env.PI_MCP_AUDIT_PATH = prevAuditPath;
});

afterEach(() => {
  mcpManager.disposeAll();
});

describe("绑定存储与 configHash", () => {
  test("保存后按 effective def 命中；命令变更后失效但保留 stale 标记", async () => {
    const def = stdioDef("bind-hash");
    await saveMcpSecretBindings(def, [{ envName: "TOKEN", name: "TOKEN" }]);
    expect(await mcpSecretBindingFor(def)).toEqual({
      configHash: computeConfigHash(def),
      env: [{ envName: "TOKEN", name: "TOKEN", scope: "global" }],
    });
    expect(await mcpSecretBindingStale(def)).toBe(false);

    const edited = { ...def, command: "bun" };
    expect(await mcpSecretBindingFor(edited)).toBeNull();
    expect(await mcpSecretBindingStale(edited)).toBe(true);
  });

  test("env/header 键序不影响哈希；参数变化会影响", () => {
    const a = stdioDef("hash-order", { env: { B: "2", A: "1" } });
    const b = stdioDef("hash-order", { env: { A: "1", B: "2" } });
    expect(computeConfigHash(a)).toBe(computeConfigHash(b));
    expect(computeConfigHash(a)).not.toBe(
      computeConfigHash({ ...a, args: [FAKE_SERVER, "--x"] }),
    );
  });

  test("只接受 global 作用域，拒绝工作区密钥与 HTTP 服务器", async () => {
    const def = stdioDef("bind-scope");
    await expect(
      saveMcpSecretBindings(def, [
        { envName: "TOKEN", name: "TOKEN", scope: "workspace:/tmp/x" },
      ]),
    ).rejects.toThrow(/全局作用域/);
    await expect(
      saveMcpSecretBindings(
        { ...def, transport: "http", url: "http://127.0.0.1:1/mcp", command: undefined, args: undefined },
        [{ envName: "TOKEN", name: "TOKEN" }],
      ),
    ).rejects.toThrow(/不是本地进程/);
  });

  test("空数组解除绑定", async () => {
    const def = stdioDef("bind-clear");
    await saveMcpSecretBindings(def, [{ envName: "A", name: "A" }]);
    expect(await mcpSecretBindingFor(def)).not.toBeNull();
    await saveMcpSecretBindings(def, []);
    expect(await mcpSecretBindingFor(def)).toBeNull();
    expect(await mcpSecretBindingStale(def)).toBe(false);
  });

  test("__proto__ 作为服务器名不会污染绑定状态", async () => {
    const def = stdioDef("__proto__");
    await saveMcpSecretBindings(def, [{ envName: "TOKEN", name: "TOKEN" }]);
    expect(await mcpSecretBindingFor(def)).toEqual({
      configHash: computeConfigHash(def),
      env: [{ envName: "TOKEN", name: "TOKEN", scope: "global" }],
    });
    expect(({} as { configHash?: unknown }).configHash).toBeUndefined();
    await saveMcpSecretBindings(def, []);
  });
});

describe("宿主解析与子进程注入", () => {
  test("绑定密钥注入 stdio 子进程，工具回显被脱敏", async () => {
    const def = stdioDef("inject", { env: { MCP_FAKE_DECLARED: "declared" } });
    await secretSet("MCP_E2E_TOKEN", "global", "sk-very-secret-123456");
    await saveMcpSecretBindings(def, [
      { envName: "PI_MCP_TEST_SECRET", name: "MCP_E2E_TOKEN" },
    ]);

    const resolved = await resolveMcpSecretEnvForSpawn(def);
    expect(resolved?.env).toEqual({ PI_MCP_TEST_SECRET: "sk-very-secret-123456" });
    expect(resolved?.values).toEqual([
      { name: "MCP_E2E_TOKEN", value: "sk-very-secret-123456" },
    ]);

    await mcpManager.ensureConnected(def);
    const raw = (await mcpManager.callTool(def, "env_check", {})) as {
      content: Array<{ text: string }>;
    };
    const seen = JSON.parse(raw.content[0].text) as {
      declared: string | null;
      secret: string | null;
      pathPresent: boolean;
    };
    expect(seen.declared).toBe("declared");
    expect(seen.secret).toBe("[REDACTED:MCP_E2E_TOKEN]");
    expect(seen.pathPresent).toBe(true);
    // 密钥轮换/删除会踢掉旧子进程；下次调用重新解析
    expect(mcpManager.statusFor(def).state).toBe("ready");
    expect(mcpManager.invalidateSecretValues(["MCP_E2E_TOKEN"])).toBe(1);
    expect(mcpManager.statusFor(def).state).toBe("idle");
    await secretDelete("MCP_E2E_TOKEN", "global");
  });

  test("未绑定不注入；配置变更后旧绑定不会再进子进程", async () => {
    const plain = stdioDef("inject-unbound");
    await mcpManager.ensureConnected(plain);
    const plainRaw = (await mcpManager.callTool(plain, "env_check", {})) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(plainRaw.content[0].text).secret).toBeNull();

    const bound = stdioDef("inject-stale");
    await secretSet("MCP_STALE_TOKEN", "global", "sk-stale-secret-123456");
    await saveMcpSecretBindings(bound, [
      { envName: "PI_MCP_TEST_SECRET", name: "MCP_STALE_TOKEN" },
    ]);
    const changed = { ...bound, args: [FAKE_SERVER, "--changed"] };
    await mcpManager.ensureConnected(changed);
    const staleRaw = (await mcpManager.callTool(changed, "env_check", {})) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(staleRaw.content[0].text).secret).toBeNull();
    await secretDelete("MCP_STALE_TOKEN", "global");
  });

  test("绑定密钥覆盖同名 literal env", () => {
    expect(mcpChildEnv({ TOKEN: "literal" }, { TOKEN: "secret-value" })).toEqual({
      TOKEN: "secret-value",
    });
  });
});

describe("脱敏工具", () => {
  test("文本原值/base64 都替换，图片 data 保持原样", () => {
    const value = "sk-abcdefghijkl";
    const b64 = Buffer.from(value, "utf8").toString("base64");
    expect(redactMcpSecretText(`raw=${value} b64=${b64}`, [{ name: "TOKEN", value }])).toBe(
      "raw=[REDACTED:TOKEN] b64=[REDACTED:TOKEN]",
    );
    const result = redactMcpSecretValue(
      {
        content: [
          { type: "text", text: `prefix ${value}` },
          { type: "image", data: value, mimeType: "image/png" },
        ],
        structuredContent: { token: value },
      },
      [{ name: "TOKEN", value }],
    ) as {
      content: Array<{ text?: string; data?: string; mimeType?: string }>;
      structuredContent: { token: string };
    };
    expect(result.content[0].text).toBe("prefix [REDACTED:TOKEN]");
    expect(result.content[1].data).toBe(value);
    expect(result.content[1].mimeType).toBe("image/png");
    expect(result.structuredContent.token).toBe("[REDACTED:TOKEN]");
  });
});
