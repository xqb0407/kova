import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  activePluginHooks,
  addMarketplace,
  getMarketplaceCatalog,
  installLocalPlugin,
  installPlugin,
  installedPluginDir,
  listInstalledPlugins,
  listMarketplaces,
  localMarketplaceEntry,
  parsePluginManifest,
  readPluginHooksFile,
  refreshMarketplace,
  removeMarketplace,
  resetPluginsForTest,
  setPluginEnabled,
  uninstallPlugin,
  LOCAL_MKT_ID,
  LOCAL_MKT_NAME,
} from "../../src/plugins/plugins";
import { ensureSkillsLoaded, skillsSnapshot, setSkillEnabled } from "../../src/skills/skills";
import { loadSubagentDefinitions } from "../../src/subagent/subagent-definitions";
import { loadMcpServers } from "../../src/mcp/mcp-config";
import { initLocalStorage, resetStorageForTest } from "../../src/storage/hostdb";
import { marketplacesPayload } from "../../src/protocol/payloads";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-plugins-"));
const prevPluginsDir = process.env.PI_PLUGINS_DIR;

/** 市场根：含一个 kova 原生四件套插件 + 一个 claude 生态兼容插件 */
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
  // — demo-pack（kova 原生：四类组件全带）—
  mkdirSync(path.join(demoDir, ".kova-plugin"), { recursive: true });
  writeFileSync(
    path.join(demoDir, ".kova-plugin", "plugin.json"),
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
    JSON.stringify({
      mcpServers: {
        "demo-server": { command: "echo", args: ["hi"] },
        // 占位符展开探针：${PLUGIN_ROOT}/${BUN}/${WORKSPACE}（仅插件层展开）
        "probe-server": {
          type: "stdio",
          command: "${BUN}",
          args: ["run", "${PLUGIN_ROOT}/mcp/server.ts"],
          env: { KOVA_WORKSPACE: "${WORKSPACE}", PLAIN: "keep" },
        },
      },
    }),
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
  // 插件根钉到 tmp：绝不碰真实 ~/.kova/plugins
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
  test("kova 原生清单解析出全部组件", () => {
    const m = parsePluginManifest(demoDir);
    expect(m.name).toBe("demo-pack");
    expect(m.manifestKind).toBe("kova");
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
    mkdirSync(path.join(dir, ".kova-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".kova-plugin", "plugin.json"),
      JSON.stringify({ name: "escape-pack", skills: "../outside" }),
    );
    expect(() => parsePluginManifest(dir)).not.toThrow();
    const m = parsePluginManifest(dir);
    expect(m.components.skills).toBeUndefined();
  });

  test("name 与目录名不一致 / 非法 name 抛错", () => {
    const dir = path.join(tmp, "mismatch-pack");
    mkdirSync(path.join(dir, ".kova-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".kova-plugin", "plugin.json"),
      JSON.stringify({ name: "other-name" }),
    );
    expect(() => parsePluginManifest(dir)).toThrow(/目录名/);
    const dir2 = path.join(tmp, "Bad_Name");
    mkdirSync(path.join(dir2, ".kova-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir2, ".kova-plugin", "plugin.json"),
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
    // Claude 的 type:"command" 语义是整串交 shell；不映射会被当 argv 直执行
    expect(hooks[0]!.type).toBe("shell");
  });

  test("Claude hooks.json 的外层 {hooks:{...}} 包装被拆开（裸事件名对象仍兼容）", () => {
    const wrapped = path.join(tmp, "hooks-wrapped.json");
    writeFileSync(
      wrapped,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: "startup", hooks: [{ type: "command", command: "echo hi", shell: "bash" }] },
          ],
        },
      }),
    );
    const hooks = readPluginHooksFile(wrapped, "w@m", "w", []);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.event).toBe("SessionStart");
    expect(hooks[0]!.matcher).toBe("startup");
    expect(hooks[0]!.shell).toBe("bash");
    expect(hooks[0]!.type).toBe("shell");

    // 裸形状（无 hooks 包装）行为不变
    const bare = path.join(tmp, "hooks-bare.json");
    writeFileSync(bare, JSON.stringify({ Stop: [{ hooks: [{ type: "command", command: "echo" }] }] }));
    expect(readPluginHooksFile(bare, "b@m", "b", [])[0]!.event).toBe("Stop");
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

    // —— 插件层占位符展开：${BUN}/${PLUGIN_ROOT}/${WORKSPACE}（仅 plugin 层）——
    const wsDir = path.join(tmp, "ws");
    mkdirSync(wsDir, { recursive: true });
    const expanded = await loadMcpServers(wsDir);
    const probe = expanded.defs.find((d) => d.name === "probe-server");
    expect(probe).toBeDefined();
    expect(probe!.command).toBe(process.execPath);
    expect(probe!.args).toEqual([
      "run",
      path.join(installedPluginDir(record.id, "demo-pack"), "mcp", "server.ts"),
    ]);
    expect(probe!.env?.BUN_BE_BUN).toBe("1");
    expect(probe!.env?.KOVA_WORKSPACE).toBe(wsDir);
    expect(probe!.env?.PLAIN).toBe("keep");
    // 用户层（工作区标准层）不展开：字面量保持，语义不意外
    writeFileSync(
      path.join(wsDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { "user-probe": { command: "echo", args: ["${PLUGIN_ROOT}/x"] } },
      }),
    );
    const withUser = await loadMcpServers(wsDir);
    const userProbe = withUser.defs.find((d) => d.name === "user-probe");
    expect(userProbe).toBeDefined();
    expect(userProbe!.args).toEqual(["${PLUGIN_ROOT}/x"]);

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

  // 单插件仓库（市场根本身就是插件根，如 obra/superpowers）：source 写 "./"。
  // 回归点是两处：containedRelPath 曾把 "./" 剥成空串判非法，条目被静默丢弃
  // （市场加得进去、插件列表恒为空）；安装时目录名一致性校验又拿 clone 目录名
  // git-<hash> 去比清单名。两条都断在"扫不到插件"。
  test("单插件仓库：source './' 的条目可解析、可安装，hooks 占位符按插件根展开", async () => {
    const rootMkt = path.join(tmp, "root-market");
    mkdirSync(path.join(rootMkt, ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(rootMkt, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "single-plugin-market",
        plugins: [{ name: "solo", version: "2.0.0", description: "Solo", source: "./" }],
      }),
    );
    writeFileSync(
      path.join(rootMkt, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "solo", version: "2.0.0", description: "Solo" }),
    );
    mkdirSync(path.join(rootMkt, "skills", "solo-skill"), { recursive: true });
    writeFileSync(
      path.join(rootMkt, "skills", "solo-skill", "SKILL.md"),
      skillDoc("solo-skill", "Skill from a single-plugin repo."),
    );
    // Claude 形状 hooks：外层包装 + ${CLAUDE_PLUGIN_ROOT} 占位符（第三方生态通例）
    mkdirSync(path.join(rootMkt, "hooks"), { recursive: true });
    writeFileSync(
      path.join(rootMkt, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: '"${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" start', shell: "bash" }] },
          ],
        },
      }),
    );

    const { record } = await addMarketplace({ type: "directory", path: rootMkt });
    const { catalog } = getMarketplaceCatalog(record.id);
    expect(catalog.plugins).toHaveLength(1);
    expect(catalog.plugins[0]!.name).toBe("solo");
    // 根写法归一为空相对路径（= 市场根本身）
    expect(catalog.plugins[0]!.path).toBe("");

    const { plugin } = await installPlugin(record.id, "solo");
    expect(plugin.name).toBe("solo");

    // 占位符在 activePluginHooks 侧展开为插件根；命令串不再含 ${...}
    const hooks = activePluginHooks().filter((h) => h.event === "SessionStart");
    expect(hooks.length).toBeGreaterThan(0);
    const soloHook = hooks.find((h) => h.command.includes("run.sh"));
    expect(soloHook).toBeDefined();
    expect(soloHook!.command).not.toContain("${");
    expect(soloHook!.command).toContain(path.join(installedPluginDir(record.id, "solo"), "hooks", "run.sh"));
    expect(soloHook!.type).toBe("shell");

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

describe("本地安装（旁路市场）", () => {
  /** 模拟用户下载的 codex 系插件目录：.codex-plugin/plugin.json + skills/<name>/SKILL.md */
  function seedDownloadedPlugin(): string {
    const dir = path.join(tmp, "downloaded", "temporal");
    rmSync(path.join(tmp, "downloaded"), { recursive: true, force: true });
    mkdirSync(path.join(dir, ".codex-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "temporal", version: "0.2.2", description: "Temporal lifecycle skill" }),
    );
    mkdirSync(path.join(dir, "skills", "temporal-developer"), { recursive: true });
    writeFileSync(
      path.join(dir, "skills", "temporal-developer", "SKILL.md"),
      skillDoc("temporal-developer", "Develop with Temporal."),
    );
    return dir;
  }

  test("installLocalPlugin 直装生态目录：身份 name@local、扫描与本地市场视图可见", async () => {
    const dir = seedDownloadedPlugin();
    const { plugin, updated } = await installLocalPlugin(dir);
    expect(updated).toBe(false);
    expect(plugin.pluginId).toBe("temporal@local");
    expect(plugin.mktId).toBe(LOCAL_MKT_ID);
    expect(plugin.mktName).toBe(LOCAL_MKT_NAME);
    expect(plugin.sourceMissing).toBe(false);
    expect(plugin.sourcePath).toBe(dir);
    expect(plugin.manifest.manifestKind).toBe("codex");
    expect(exists(path.join(plugin.manifest.root, "skills", "temporal-developer", "SKILL.md"))).toBe(
      true,
    );

    const entry = localMarketplaceEntry();
    expect(entry).toBeDefined();
    expect(entry!.plugins.find((e) => e.name === "temporal")?.version).toBe("0.2.2");

    await uninstallPlugin("temporal@local");
    expect(localMarketplaceEntry()).toBeUndefined();
  });

  test("本地安装项的更新：installPlugin(local, name) 从 sourcePath 重拷", async () => {
    const dir = seedDownloadedPlugin();
    await installLocalPlugin(dir);
    writeFileSync(
      path.join(dir, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "temporal", version: "0.3.0", description: "Temporal lifecycle skill" }),
    );
    const { plugin, updated } = await installPlugin(LOCAL_MKT_ID, "temporal");
    expect(updated).toBe(true);
    expect(plugin.version).toBe("0.3.0");
    const entry = localMarketplaceEntry();
    expect(entry!.plugins.find((e) => e.name === "temporal")?.version).toBe("0.3.0");
    await uninstallPlugin("temporal@local");
  });

  test("入参校验：目录缺失 / 无清单 / local 市场拒绝刷新 / 未装的 local 更新", async () => {
    await expect(installLocalPlugin(path.join(tmp, "nope"))).rejects.toThrow(/插件目录不存在/);
    const broken = path.join(tmp, "downloaded", "broken");
    mkdirSync(broken, { recursive: true });
    await expect(installLocalPlugin(broken)).rejects.toThrow(/未找到插件清单/);
    await expect(refreshMarketplace(LOCAL_MKT_ID)).rejects.toThrow(/无需刷新/);
    await expect(installPlugin(LOCAL_MKT_ID, "ghost")).rejects.toThrow(/本地安装中没有/);
  });

  test("marketplacesPayload 帧形状：local 条目在数组内、序列化首键仍是 type", async () => {
    // 前端订阅按 startsWith('{"type":"plugin_op_result"') 前缀预筛帧——
    // 本地条目若展开进对象顶层会产生数字键顶掉首键，整帧被静默丢弃
    const dir = seedDownloadedPlugin();
    await installLocalPlugin(dir);
    const payload = marketplacesPayload();
    expect("0" in payload).toBe(false);
    const local = payload.marketplaces.find((m) => m.id === LOCAL_MKT_ID);
    expect(local).toBeDefined();
    expect(local!.plugins.some((p) => p.name === "temporal")).toBe(true);
    const { type: _t, ...data } = payload;
    const frame = JSON.stringify({ type: "plugin_op_result", opId: "x", op: "install_plugin_local", ok: true, ...data });
    expect(frame.startsWith('{"type":"plugin_op_result"')).toBe(true);
    await uninstallPlugin("temporal@local");
  });
});

function exists(p: string): boolean {
  return existsSync(p);
}
