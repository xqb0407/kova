/**
 * Codex 插件端到端冒烟：
 *   GitHub zip 风格目录（<name>-main）本地安装 → 清单规范化 → 插件根 cwd 的
 *   相对路径 MCP server 启动 → 工具握手 → 实际调用。
 *
 * 这条链覆盖 M1 修复的核心回归点：目录名不一致、stdio 相对 args、插件根 cwd、
 * node/内置运行时启动。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installLocalPlugin,
  uninstallPlugin,
} from "../../src/plugins/plugins";
import { loadMcpServers } from "../../src/mcp/mcp-config";
import { mcpManager } from "../../src/mcp/mcp-manager";
import { resetMcpCacheForTest } from "../../src/mcp/mcp-cache";
import { resetPluginsForTest } from "../../src/plugins/store";

const tmp = mkdtempSync(join(tmpdir(), "pi-agent-codex-e2e-"));
const prevPluginsDir = process.env.PI_PLUGINS_DIR;
const prevMcpConfig = process.env.PI_MCP_CONFIG;
const prevCache = process.env.PI_MCP_CACHE_PATH;
const prevAudit = process.env.PI_MCP_AUDIT_PATH;

beforeAll(() => {
  process.env.PI_PLUGINS_DIR = join(tmp, "plugins");
  process.env.PI_MCP_CONFIG = join(tmp, "system-mcp.json");
  process.env.PI_MCP_CACHE_PATH = join(tmp, "mcp-cache.json");
  process.env.PI_MCP_AUDIT_PATH = join(tmp, "mcp-audit.jsonl");
  writeFileSync(process.env.PI_MCP_CONFIG, JSON.stringify({ mcpServers: {} }));
});

afterAll(() => {
  mcpManager.disposeAll();
  resetMcpCacheForTest();
  resetPluginsForTest();
  for (const [key, value] of [
    ["PI_PLUGINS_DIR", prevPluginsDir],
    ["PI_MCP_CONFIG", prevMcpConfig],
    ["PI_MCP_CACHE_PATH", prevCache],
    ["PI_MCP_AUDIT_PATH", prevAudit],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("Codex 插件端到端", () => {
  test("zip 风格目录安装 → 相对路径 MCP 启动 → 工具可调用", async () => {
    // 模拟 GitHub zip 解压目录：目录名带 -main，清单 name 不带
    const source = join(tmp, "download", "codex-e2e-main");
    mkdirSync(join(source, ".codex-plugin"), { recursive: true });
    writeFileSync(
      join(source, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "codex-e2e",
        version: "1.0.0",
        description: "Codex e2e fixture",
        interface: { displayName: "Codex E2E" },
      }),
    );
    // 相对 args + Codex 的 cwd 语义：server 脚本就在插件根
    writeFileSync(
      join(source, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "codex-e2e": {
            command: "node",
            args: ["./fake-mcp-server.mjs"],
            cwd: ".",
          },
        },
      }),
    );
    cpSync(join(import.meta.dir, "..", "fake-mcp-server.mjs"), join(source, "fake-mcp-server.mjs"));

    const { plugin } = await installLocalPlugin(source);
    expect(plugin.pluginId).toBe("codex-e2e@local");
    expect(plugin.manifest.manifestKind).toBe("codex");
    expect(plugin.manifest.displayName).toBe("Codex E2E");
    expect(plugin.manifest.components.mcpServers).toEqual([".mcp.json"]);

    const { defs } = await loadMcpServers();
    const def = defs.find((entry) => entry.name === "codex-e2e");
    expect(def).toBeDefined();
    expect(def!.layer).toBe("plugin");
    expect(def!.cwd).toBe(plugin.manifest.root);
    expect(def!.command).toBe("node");
    expect(def!.args).toEqual(["./fake-mcp-server.mjs"]);

    const tools = await mcpManager.ensureConnected(def!);
    expect(tools.map((tool) => tool.name)).toContain("echo");

    const result = (await mcpManager.callTool(def!, "echo", { text: "codex-e2e-ok" })) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = result.content?.find((item) => item.type === "text")?.text ?? "";
    expect(text).toContain("codex-e2e-ok");

    await uninstallPlugin(plugin.pluginId);
  });
});
