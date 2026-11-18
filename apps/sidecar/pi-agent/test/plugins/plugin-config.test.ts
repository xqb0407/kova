/**
 * 插件装后配置：清单 config 声明归一（kova config 块 / codex interface.userConfig）、
 * 值存储（kv 非敏感 + hostdb 密钥库敏感）、注入（def.env 合并 + mcp-secrets 绑定）、
 * 三态（configured/missing/stale）与卸载清理。
 *
 * 与 mcp-secrets.test.ts 同款 local 存储模式：kv → secret_set/secret_list（local
 * 实现）→ mcp-secrets 绑定整条链在测试内闭环。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { initLocalStorage, resetStorageForTest, secretList } from "../../src/storage/hostdb";
import {
  installLocalPlugin,
  installedPluginDir,
  listInstalledPlugins,
  parsePluginManifest,
  resetPluginsForTest,
  setPluginEnabled,
  uninstallPlugin,
} from "../../src/plugins/plugins";
import { invalidateCaches } from "../../src/plugins/store";
import {
  getPluginConfigState,
  initPluginConfig,
  pluginConfigView,
  purgePluginConfig,
  rebindPluginConfig,
  resetPluginConfigForTest,
  savePluginConfig,
} from "../../src/plugins/plugin-config";
import { loadMcpServers } from "../../src/mcp/mcp-config";
import { mcpSecretBindingFor } from "../../src/mcp/mcp-secrets";
import { resetMcpSecretBindingsForTest } from "../../src/mcp/mcp-secrets";
import type { McpServerDef } from "../../src/mcp/mcp-config";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-plugin-config-"));
const prevPluginsDir = process.env.PI_PLUGINS_DIR;

const pluginDir = path.join(tmp, "configpack");
const manifest = (config: unknown) =>
  JSON.stringify({
    name: "configpack",
    displayName: "配置包",
    version: "1.0.0",
    description: "config test bundle",
    skills: "skills",
    mcpServers: "mcp.json",
    ...(config ? { config } : {}),
  });

const mcpJson = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ mcpServers: { gitlab: { command: "echo", args: ["hi"], ...extra } } });

const skillDoc = `---
name: config-skill
description: Skill from config test plugin.
---

Do config-skill.
`;

function seedPlugin(config: unknown, mcpExtra: Record<string, unknown> = {}): void {
  rmSync(pluginDir, { recursive: true, force: true });
  mkdirSync(path.join(pluginDir, ".kova-plugin"), { recursive: true });
  mkdirSync(path.join(pluginDir, "skills"), { recursive: true });
  writeFileSync(path.join(pluginDir, ".kova-plugin", "plugin.json"), manifest(config));
  writeFileSync(path.join(pluginDir, "mcp.json"), mcpJson(mcpExtra));
  writeFileSync(path.join(pluginDir, "skills", "config-skill.md"), skillDoc);
}

const validConfig = [
  {
    key: "url",
    title: "GitLab 地址",
    type: "string",
    default: "https://gitlab.com",
    env: "GITLAB_URL",
    description: "自建实例填根地址",
  },
  { key: "token", title: "Access Token", type: "secret", required: true, env: "GITLAB_TOKEN" },
];

beforeAll(() => {
  prevPluginsDir === undefined
    ? delete process.env.PI_PLUGINS_DIR
    : (process.env.PI_PLUGINS_DIR = prevPluginsDir);
  process.env.PI_PLUGINS_DIR = path.join(tmp, "plugins");
  initLocalStorage(join(tmp, "state.db"));
  resetPluginsForTest();
  resetMcpSecretBindingsForTest();
  resetPluginConfigForTest();
  return initPluginConfig();
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  prevPluginsDir === undefined
    ? delete process.env.PI_PLUGINS_DIR
    : (process.env.PI_PLUGINS_DIR = prevPluginsDir);
  resetStorageForTest();
  resetPluginsForTest();
  resetMcpSecretBindingsForTest();
  resetPluginConfigForTest();
});

/** 该插件名下的 MCP def（loadMcpServers 缓存 + pluginId 过滤） */
async function defsOf(pluginId: string): Promise<McpServerDef[]> {
  const { defs } = await loadMcpServers();
  return defs.filter((d) => d.pluginId === pluginId);
}

/** 当前 manifest（闭包测试共享；插件只有一个） */
function manifestOf() {
  return listInstalledPlugins()[0].manifest;
}

describe("manifest config 归一", () => {
  test("kova config 块：合法字段进 schema，非法整条丢弃并记诊断", () => {
    seedPlugin([
      ...validConfig,
      // 非法：secret 禁 default
      { key: "bad1", title: "bad", type: "secret", default: "x", env: "BAD1" },
      // 非法：非敏感缺 env
      { key: "bad2", title: "bad", type: "string" },
      // 非法：env 名不合法
      { key: "bad3", title: "bad", type: "string", env: "1BAD" },
    ]);
    const m = parsePluginManifest(pluginDir);
    // bad1：secret 带 default 只丢 default 值，字段本身合法保留；bad2/bad3 整条丢弃
    expect(m.config?.length).toBe(3);
    expect(m.config?.[0]).toMatchObject({ key: "url", type: "string", default: "https://gitlab.com", env: "GITLAB_URL" });
    expect(m.config?.[1]).toMatchObject({ key: "token", type: "secret", required: true });
    expect(m.config?.[2]).toMatchObject({ key: "bad1", type: "secret", env: "BAD1" });
    expect(m.config?.[2].default).toBeUndefined();
    expect(m.diagnostics.some((d) => d.includes("bad1") && d.includes("default"))).toBe(true);
    expect(m.diagnostics.some((d) => d.includes("bad2") && d.includes("env"))).toBe(true);
    expect(m.diagnostics.some((d) => d.includes("bad3") && d.includes("env"))).toBe(true);
  });

  test("codex interface.userConfig 归一进同一 schema（形状宽容：映射也认）", () => {
    seedPlugin(undefined);
    rmSync(path.join(pluginDir, ".kova-plugin"), { recursive: true, force: true });
    mkdirSync(path.join(pluginDir, ".codex-plugin"), { recursive: true });
    writeFileSync(
      path.join(pluginDir, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "configpack",
        version: "1.0.0",
        interface: {
          userConfig: {
            // 有 env：可注入，收进 schema
            apikey: { type: "password", required: true, env: "CODEX_KEY" },
            // 无 env：没有注入目标，按设计丢弃并记诊断（生态清单通常不写 env）
            endpoint: { type: "string", description: "API endpoint", default: "https://x" },
          },
        },
      }),
    );
    const m = parsePluginManifest(pluginDir);
    expect(m.manifestKind).toBe("codex");
    expect(m.config?.length).toBe(1);
    expect(m.config?.[0]).toMatchObject({ key: "apikey", type: "secret", required: true, env: "CODEX_KEY" });
    expect(m.diagnostics.some((d) => d.includes("endpoint") && d.includes("env"))).toBe(true);
    // 还原 kova 清单，后续用例依赖它
    seedPlugin(validConfig);
  });
});

describe("装后配置闭环", () => {
  let pluginId = "";

  beforeAll(async () => {
    seedPlugin(validConfig);
    const { plugin } = await installLocalPlugin(pluginDir);
    pluginId = plugin.pluginId; // configpack@local
    await initPluginConfig();
  });

  test("未配置时 missing（required 字段缺值）", async () => {
    const state = await getPluginConfigState(pluginId, listInstalledPlugins()[0].manifest, await defsOf(pluginId), await secretList());
    expect(state?.state).toBe("missing");
    expect(state?.keys).toEqual(["token"]);
    // 非敏感字段有 default：不进 missing
    expect(state?.keys).not.toContain("url");
  });

  test("保存：非敏感进 kv、secret 进密钥库并自动建绑定；三态转 configured", async () => {
    const manifest = listInstalledPlugins()[0].manifest;
    const state = await savePluginConfig(manifest, pluginId, { token: "tok-123", url: "https://gl.example.com" }, []);
    expect(state?.state).toBe("configured");

    // 掩码视图：非敏感回显、secret 只回「已设置」
    const view = pluginConfigView(pluginId, manifest);
    expect(view.values.url).toBe("https://gl.example.com");
    expect(view.secrets.token).toBe(true);
    expect(JSON.stringify(view)).not.toContain("tok-123");

    // 密钥已入密钥库（约定名）
    const rows = await secretList();
    expect(rows.some((r) => r.name === "plugin_configpack_local_token" && r.readable)).toBe(true);
  });

  test("注入：非敏感值并入 def.env，secret 经绑定在握手时解析", async () => {
    invalidateCaches();
    const defs = await defsOf(pluginId);
    const def = defs.find((d) => d.name === "gitlab");
    expect(def?.env?.GITLAB_URL).toBe("https://gl.example.com");
    const binding = await mcpSecretBindingFor(def!);
    expect(binding?.env.some((e) => e.envName === "GITLAB_TOKEN" && e.name === "plugin_configpack_local_token")).toBe(true);
  });

  test("插件升级（def 变化）→ stale；不重输值即可重绑语义就绪", async () => {
    // 模拟升级：改 cache 物化目录里的 mcp.json（插件层读 cache，不读源目录）
    // → def 变化 → configHash 失配 → 绑定判 stale
    writeFileSync(
      path.join(installedPluginDir("local", "configpack"), "mcp.json"),
      mcpJson({ env: { MARKER: "upgraded" } }),
    );
    invalidateCaches();
    const state = await getPluginConfigState(pluginId, listInstalledPlugins()[0].manifest, await defsOf(pluginId), await secretList());
    expect(state?.state).toBe("stale");
    expect(state?.keys).toEqual(["token"]);
    // 重绑后回到 configured（值都在 hostdb，无需重输）
    const rebound = await rebindPluginConfig(manifestOf(), pluginId, []);
    expect(rebound?.state).toBe("configured");
  });

  test("停用插件：defs 为空时跳过绑定校验，值在即 configured（不误报 stale）", async () => {
    // 停用 → activePlugins 过滤 → defsOf 为空 → 只验值存在
    await setPluginEnabled(pluginId, false);
    invalidateCaches();
    const state = await getPluginConfigState(pluginId, manifestOf(), [], await secretList());
    expect(state?.state).toBe("configured");
    // 重新启用 → def 回归；绑定哈希对齐（上一轮重绑按当前 def 建），仍 configured
    await setPluginEnabled(pluginId, true);
    invalidateCaches();
    const after = await getPluginConfigState(pluginId, manifestOf(), await defsOf(pluginId), await secretList());
    expect(after?.state).toBe("configured");
  });

  test("卸载清理：kv 分桶、密钥值、绑定全清", async () => {
    const defs = await defsOf(pluginId);
    await uninstallPlugin(pluginId);
    await purgePluginConfig(pluginId, defs.map((d) => d.name));

    const rows = await secretList();
    expect(rows.some((r) => r.name === "plugin_configpack_local_token")).toBe(false);
    const view = pluginConfigView(pluginId, listInstalledPlugins()[0]?.manifest ?? { config: [] } as never);
    expect(view.values.url).toBeUndefined();
    expect(view.secrets.token).toBeUndefined();
    expect(listInstalledPlugins().some((p) => p.pluginId === pluginId)).toBe(false);
  });
});

describe("http 服务器的 header 注入", () => {
  const httpDir = path.join(tmp, "httppack");
  let httpId = "";

  beforeAll(async () => {
    mkdirSync(path.join(httpDir, ".kova-plugin"), { recursive: true });
    writeFileSync(
      path.join(httpDir, ".kova-plugin", "plugin.json"),
      JSON.stringify({
        name: "httppack",
        displayName: "HTTP 包",
        version: "1.0.0",
        mcpServers: "mcp.json",
        config: [
          // 非敏感走 header：http 服务器没有 env，头名允许连字符（RFC 7230）
          { key: "zone", title: "Zone", type: "string", required: true, header: "X-Zone-Id" },
        ],
      }),
    );
    writeFileSync(
      path.join(httpDir, "mcp.json"),
      JSON.stringify({
        mcpServers: { cfapi: { type: "http", url: "https://cf.example.com/mcp" } },
      }),
    );
    const { plugin } = await installLocalPlugin(httpDir);
    httpId = plugin.pluginId;
    await initPluginConfig();
  });

  afterAll(async () => {
    await uninstallPlugin(httpId).catch(() => {});
    await purgePluginConfig(httpId, ["cfapi"]);
  });

  test("非敏感值按 header 目标并入 http def.headers（不经 env，secret 才走绑定）", async () => {
    await savePluginConfig(listInstalledPlugins()[0].manifest, httpId, { zone: "z-123" }, []);
    invalidateCaches();
    const def = (await defsOf(httpId)).find((d) => d.name === "cfapi");
    expect(def?.transport).toBe("http");
    expect(def?.headers?.["X-Zone-Id"]).toBe("z-123");
    expect(def?.env).toBeUndefined();
    // 非敏感字段不产生密钥绑定
    const rows = await secretList();
    expect(rows.some((r) => r.name.includes("httppack"))).toBe(false);
  });
});
