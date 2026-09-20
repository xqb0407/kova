import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addMarketplace,
  getMarketplaceCatalog,
  installPlugin,
  installedPluginDir,
  listInstalledPlugins,
  listMarketplaces,
  parsePluginManifest,
  readPluginHooksFile,
  refreshMarketplace,
  removeMarketplace,
  resetPluginsForTest,
  setPluginEnabled,
  uninstallPlugin,
} from "./plugins";
import { ensureSkillsLoaded, skillsSnapshot, setSkillEnabled } from "./skills";
import { loadSubagentDefinitions } from "./subagent-definitions";
import { loadMcpServers } from "./mcp-config";
import { initLocalStorage, resetStorageForTest } from "./hostdb";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-plugins-"));
const prevPluginsDir = process.env.PI_PLUGINS_DIR;

/** 市场根：含一个 xulux 原生四件套插件 + 一个 claude 生态兼容插件 */
const marketRoot = path.join(tmp, "market");
const demoDir = path.join(marketRoot, "plugins", "demo-pack");
const claudeDir = path.join(marketRoot, "plugins", "claude-pack");

const skillDoc = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nDo ${name}.\n`;

const subagentYaml = (name: string) =>
  `name: ${name}\ndescription: Plugin delegate for ${name}.\ntools: [read, grep]\nprompt: You are ${name}.\n`;

/** 布市场源（每次 install 前重建：物化是 copy，源目录保持干净无影响） */
function seedMarket(): void {
  rmSync(marketRoot, { recursive: true, force: true });
  // — demo-pack（xulux 原生：四类组件全带）—
  mkdirSync(path.join(demoDir, ".xulux-plugin"), { recursive: true });
  writeFileSync(
    path.join(demoDir, ".xulux-plugin", "plugin.json"),
    JSON.stringify({
      name: "demo-pack",
      version: "1.0.0",
      description: "Demo bundle",
      skills: "skills",
      mcpServers: "mcp.json",
      hooks: "hooks.json",
      subagents: "subagents",
    }),
  );
  mkdirSync(path.join(demoDir, "skills"), { recursive: true });
  writeFileSync(path.join(demoDir, "skills", "demo-skill.md"), skillDoc("demo-skill", "Skill from plugin."));
  writeFileSync(
    path.join(demoDir, "mcp.json"),
    JSON.stringify({ mcpServers: { "demo-server": { command: "echo", args: ["hi"] } } }),
  );
  writeFileSync(
    path.join(demoDir, "hooks.json"),
    JSON.stringify([
      { name: "demo-hook", command: "echo", event: "SessionStart", enabled: true },
    ]),
  );
  mkdirSync(path.join(demoDir, "subagents"), { recursive: true });
  writeFileSync(path.join(demoDir, "subagents", "demo-agent.yml"), subagentYaml("demo-agent"));

  // — claude-pack（生态兼容：.claude-plugin 清单 + 根级 .mcp.json + Claude hooks 形状）—
  mkdirSync(path.join(claudeDir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(claudeDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: "claude-pack",
      version: "0.2.0",
      description: "Claude-style bundle",
    }),
  );
  mkdirSync(path.join(claudeDir, "skills", "claude-skill"), { recursive: true });
  writeFileSync(
    path.join(claudeDir, "skills", "claude-skill", "SKILL.md"),
    "---\ndescription: Skill from claude plugin.\n---\n\nUse pandoc.\n",
  );
  writeFileSync(
    path.join(claudeDir, ".mcp.json"),
    JSON.stringify({ mcpServers: { "claude-server": { command: "echo", args: ["ok"] } } }),
  );
  mkdirSync(path.join(claudeDir, "hooks"), { recursive: true });
  writeFileSync(
    path.join(claudeDir, "hooks", "hooks.json"),
    JSON.stringify({
      PreToolUse: [
        { matcher: "bash", hooks: [{ type: "command", command: "echo", timeout: 5 }] },
      ],
    }),
  );
  // 市场清单
  writeFileSync(
    path.join(marketRoot, "marketplace.json"),
    JSON.stringify({
      name: "test-market",
      plugins: [
        { name: "demo-pack", version: "1.0.0", source: { source: "directory", path: "./plugins/demo-pack" } },
        { name: "claude-pack", version: "0.2.0", source: "./plugins/claude-pack" },
      ],
    }),
  );
}

beforeAll(async () => {
  initLocalStorage(path.join(tmp, "state.db"));
  // 插件根钉到 tmp：绝不碰真实 ~/.xulux/plugins
  process.env.PI_PLUGINS_DIR = path.join(tmp, "plugins-root");
  seedMarket();
});

afterAll(async () => {
  // bun test 单进程共享模块注册表：清内存态/env，避免污染后续文件
  resetPluginsForTest();
  resetStorageForTest();
  if (prevPluginsDir === undefined) delete process.env.PI_PLUGINS_DIR;
  else process.env.PI_PLUGINS_DIR = prevPluginsDir;
  rmSync(tmp, { recursive: true, force: true });
});

describe("parsePluginManifest", () => {
  test("xulux 原生清单解析出全部组件", () => {
    const m = parsePluginManifest(demoDir);
    expect(m.name).toBe("demo-pack");
    expect(m.manifestKind).toBe("xulux");
    expect(m.components.skills).toBe("skills");
    expect(m.components.mcpServers).toBe("mcp.json");
    expect(m.components.hooks).toBe("hooks.json");
    expect(m.components.subagents).toBe("subagents");
  });

  test("claude 生态清单规范化：默认 skills/ + 根级 .mcp.json + hooks/hooks.json", () => {
    const m = parsePluginManifest(claudeDir);
    expect(m.manifestKind).toBe("claude");
    expect(m.components.skills).toBe("skills");
    expect(m.components.mcpServers).toBe(".mcp.json");
    expect(m.components.hooks).toBe("hooks/hooks.json");
    expect(m.unsupported.length).toBe(0);
  });

  test("组件路径逃逸被拒绝", () => {
    const dir = path.join(tmp, "escape-pack");
    mkdirSync(path.join(dir, ".xulux-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".xulux-plugin", "plugin.json"),
      JSON.stringify({ name: "escape-pack", skills: "../outside" }),
    );
    expect(() => parsePluginManifest(dir)).not.toThrow();
    const m = parsePluginManifest(dir);
    expect(m.components.skills).toBeUndefined();
  });

  test("name 与目录名不一致 / 非法 name 抛错", () => {
    const dir = path.join(tmp, "mismatch-pack");
    mkdirSync(path.join(dir, ".xulux-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".xulux-plugin", "plugin.json"),
      JSON.stringify({ name: "other-name" }),
    );
    expect(() => parsePluginManifest(dir)).toThrow(/目录名/);
    const dir2 = path.join(tmp, "Bad_Name");
    mkdirSync(path.join(dir2, ".xulux-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir2, ".xulux-plugin", "plugin.json"),
      JSON.stringify({ name: "Bad_Name" }),
    );
    expect(() => parsePluginManifest(dir2)).toThrow(/name 需匹配/);
  });
});

describe("readPluginHooksFile", () => {
  test("自有数组形状原样接收并强制 enabled", () => {
    const hooks = readPluginHooksFile(path.join(demoDir, "hooks.json"), "demo-pack@m", "demo", []);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.event).toBe("SessionStart");
    expect(hooks[0]!.id).toBe("demo-pack@m:hook-0");
  });

  test("Claude 形状按事件分组转换，timeout 秒转毫秒", () => {
    const hooks = readPluginHooksFile(
      path.join(claudeDir, "hooks", "hooks.json"),
      "claude-pack@m",
      "claude",
      [],
    );
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.event).toBe("PreToolUse");
    expect(hooks[0]!.matcher).toBe("bash");
    expect(hooks[0]!.timeoutMs).toBe(5000);
  });
});

describe("市场与安装全链路", () => {
  test("add → list → refresh → install → 组件合并 → 卸载", async () => {
    const { record } = await addMarketplace({ type: "directory", path: marketRoot });
    expect(record.type).toBe("directory");
    expect(listMarketplaces()).toHaveLength(1);
    expect(listMarketplaces()[0]!.name).toBe("test-market");

    // 幂等重加：同源同 id，不产生重复登记
    await addMarketplace({ type: "directory", path: marketRoot });
    expect(listMarketplaces()).toHaveLength(1);

    const { catalog } = await refreshMarketplace(record.id);
    expect(catalog.plugins).toHaveLength(2);
    expect(getMarketplaceCatalog(record.id).catalog.plugins).toHaveLength(2);

    // 安装（受理异步，直接 await 函数）
    const { plugin, updated } = await installPlugin(record.id, "demo-pack");
    expect(updated).toBe(false);
    expect(plugin.pluginId).toBe("demo-pack@" + record.id);
    expect(plugin.enabled).toBe(true);
    expect(listInstalledPlugins()).toHaveLength(1);

    // 卸载 → 重装 claude-pack，随后再装回 demo（多插件排序确定性）
    await uninstallPlugin(plugin.pluginId);
    expect(listInstalledPlugins()).toHaveLength(0);
    const claudeInstall = await installPlugin(record.id, "claude-pack");
    expect(claudeInstall.plugin.manifest.manifestKind).toBe("claude");
    const reinstall = await installPlugin(record.id, "demo-pack");
    expect(reinstall.updated).toBe(false);

    // —— skills 插件层（垫底遮蔽 + scope=plugin）——
    await ensureSkillsLoaded();
    const snap = skillsSnapshot();
    const demoSkill = snap.entries.find((e) => e.name === "demo-skill");
    expect(demoSkill).toBeDefined();
    expect(demoSkill!.scope).toBe("plugin");
    expect(demoSkill!.editable).toBe(false);
    // 组件级开关：关掉 demo-skill 后不再出现在生效集合
    await setSkillEnabled("plugin", "demo-skill", false, undefined, "demo-pack@" + record.id);
    await ensureSkillsLoaded();
    const afterDisable = skillsSnapshot();
    expect(afterDisable.activeSkills.some((s) => s.name === "demo-skill")).toBe(false);
    await setSkillEnabled("plugin", "demo-skill", true, undefined, "demo-pack@" + record.id);

    // —— MCP 插件层（standard 字段 + plugin layer）——
    const mcp = await loadMcpServers();
    const demoServer = mcp.defs.find((d) => d.name === "demo-server");
    expect(demoServer).toBeDefined();
    expect(demoServer!.layer).toBe("plugin");
    expect(demoServer!.pluginId).toBe("demo-pack@" + record.id);
    const claudeServer = mcp.defs.find((d) => d.name === "claude-server");
    expect(claudeServer).toBeDefined();

    // —— 子智能体插件层 ——
    const subs = await loadSubagentDefinitions();
    const demoAgent = subs.definitions.find((d) => d.name === "demo-agent");
    expect(demoAgent).toBeDefined();
    expect(demoAgent!.scope).toBe("plugin");

    // —— 插件级开关：关闭后全部组件从合并链消失 ——
    await setPluginEnabled("demo-pack@" + record.id, false);
    const mcpOff = await loadMcpServers();
    expect(mcpOff.defs.some((d) => d.name === "demo-server")).toBe(false);
    const subsOff = await loadSubagentDefinitions();
    expect(subsOff.definitions.some((d) => d.name === "demo-agent")).toBe(false);

    // —— 卸载清残留 ——
    await uninstallPlugin("demo-pack@" + record.id);
    expect(exists(installedPluginDir(record.id, "demo-pack"))).toBe(false);
  });

  test("claude 生态市场：.claude-plugin/marketplace.json + 字符串/对象路径 source", async () => {
    const claudeMkt = path.join(tmp, "claude-market");
    const plugDir = path.join(claudeMkt, "plugins", "eco-pack");
    mkdirSync(path.join(claudeMkt, ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(claudeMkt, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "eco-market",
        plugins: [
          { name: "eco-pack", description: "Eco plugin", source: "./plugins/eco-pack" },
        ],
      }),
    );
    mkdirSync(path.join(plugDir, ".claude-plugin"), { recursive: true });
    mkdirSync(path.join(plugDir, "skills"), { recursive: true });
    writeFileSync(
      path.join(plugDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "eco-pack", version: "1.1.0", description: "Eco bundle" }),
    );
    writeFileSync(path.join(plugDir, "skills", "eco.md"), skillDoc("eco-skill", "Skill from eco plugin."));

    const { record } = await addMarketplace({ type: "directory", path: claudeMkt });
    expect(record.name).toBe("eco-market");
    const { catalog } = getMarketplaceCatalog(record.id);
    expect(catalog.plugins).toHaveLength(1);
    expect(catalog.plugins[0]!.name).toBe("eco-pack");

    const { plugin } = await installPlugin(record.id, "eco-pack");
    expect(plugin.manifest.manifestKind).toBe("claude");
    await ensureSkillsLoaded();
    const snap = skillsSnapshot();
    expect(snap.activeSkills.some((s) => s.name === "eco-skill")).toBe(true);
    await uninstallPlugin(plugin.pluginId);
    removeMarketplace(record.id);
  });

  test("codex 生态市场：.agents/plugins/marketplace.json + local source + .codex-plugin 清单", async () => {
    const codexMkt = path.join(tmp, "codex-market");
    const plugDir = path.join(codexMkt, "plugins", "codex-pack");
    mkdirSync(path.join(codexMkt, ".agents", "plugins"), { recursive: true });
    writeFileSync(
      path.join(codexMkt, ".agents", "plugins", "marketplace.json"),
      JSON.stringify({
        name: "codex-market",
        plugins: [
          {
            name: "codex-pack",
            source: { source: "local", path: "./plugins/codex-pack" },
          },
        ],
      }),
    );
    mkdirSync(path.join(plugDir, ".codex-plugin"), { recursive: true });
    mkdirSync(path.join(plugDir, "skills"), { recursive: true });
    writeFileSync(
      path.join(plugDir, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "codex-pack", version: "1.0.0", skills: "./skills/" }),
    );
    writeFileSync(path.join(plugDir, "skills", "codex-skill.md"), skillDoc("codex-skill", "Skill from codex plugin."));

    const { record, catalog } = await addMarketplace({ type: "directory", path: codexMkt });
    expect(record.name).toBe("codex-market");
    expect(catalog.plugins.map((p) => p.name)).toEqual(["codex-pack"]);

    const { plugin } = await installPlugin(record.id, "codex-pack");
    expect(plugin.manifest.manifestKind).toBe("codex");
    await ensureSkillsLoaded();
    expect(skillsSnapshot().activeSkills.some((s) => s.name === "codex-skill")).toBe(true);
    await uninstallPlugin(plugin.pluginId);
    removeMarketplace(record.id);
  });

  test("安装未知插件 / 双重添加 git 类型校验报错", async () => {
    const records = listMarketplaces();
    const id = records[0]!.id;
    await expect(installPlugin(id, "no-such-plugin")).rejects.toThrow(/没有插件/);
    await expect(addMarketplace({ type: "git", repo: "not-a-url" })).rejects.toThrow(/repo 需为/);
  });

  test("remove 市场后已装插件保留且标记 sourceMissing", async () => {
    const records = listMarketplaces();
    const id = records[0]!.id;
    const { plugin } = await installPlugin(id, "claude-pack");
    removeMarketplace(id);
    expect(listMarketplaces()).toHaveLength(0);
    const still = listInstalledPlugins().find((p) => p.pluginId === plugin.pluginId);
    expect(still).toBeDefined();
    expect(still!.sourceMissing).toBe(true);
    // 清理：卸载，不污染其他用例
    await uninstallPlugin(plugin.pluginId);
  });
});

function exists(p: string): boolean {
  return existsSync(p);
}
