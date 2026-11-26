import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
  listPluginHookEntriesWithDiagnostics,
  localMarketplaceEntry,
  parsePluginManifest,
  pruneGitSourceCache,
  readPluginHooksFile,
  refreshMarketplace,
  removeMarketplace,
  resetPluginsForTest,
  resolvePluginComponents,
  setPluginEnabled,
  uninstallPlugin,
  LOCAL_MKT_ID,
  LOCAL_MKT_NAME,
} from "../../src/plugins/plugins";
import { ensureSkillsLoaded, skillsSnapshot, setSkillEnabled } from "../../src/skills/skills";
import { loadSubagentDefinitions } from "../../src/subagent/subagent-definitions";
import { loadMcpServers } from "../../src/mcp/mcp-config";
import { replacePluginDirAtomically } from "../../src/plugins/marketplaces";
import { initLocalStorage, resetStorageForTest } from "../../src/storage/hostdb";
import { marketplacePluginPreviewPayload, marketplacesPayload, pluginsPayload } from "../../src/protocol/payloads";
import { readPluginComponentDoc } from "../../src/protocol/plugin-component-docs";

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
  // 插件自带图标：市场条目没声明 icon，安装前卡片也要能取到（清单回退）
  writeFileSync(
    path.join(demoDir, "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>',
  );
  writeFileSync(
    path.join(demoDir, ".kova-plugin", "plugin.json"),
    JSON.stringify({
      name: "demo-pack",
      displayName: "演示包",
      version: "1.0.0",
      description: "Demo bundle",
      icon: "icon.svg",
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
      { name: "demo-hook", command: "echo", event: "SessionStart" },
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
        // demo-pack 不在目录里重复 displayName：应回退读插件清单的中文展示名
        { name: "demo-pack", version: "1.0.0", source: { source: "directory", path: "./plugins/demo-pack" } },
        // claude-pack 在目录里显式声明展示名（目录值优先）
        { name: "claude-pack", displayName: "Claude 兼容包", version: "0.2.0", source: "./plugins/claude-pack" },
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
    expect(m.components.skills).toEqual(["skills"]);
    expect(m.components.mcpServers).toEqual(["mcp.json"]);
    expect(m.components.hooks).toEqual(["hooks.json"]);
    expect(m.components.subagents).toEqual(["subagents"]);
    // 展示名允许中文；name 仍是 ASCII 稳定标识
    expect(m.name).toBe("demo-pack");
    expect(m.displayName).toBe("演示包");
  });

  test("claude 生态清单规范化：默认 skills/ + 根级 .mcp.json + hooks/hooks.json", () => {
    const m = parsePluginManifest(claudeDir);
    expect(m.manifestKind).toBe("claude");
    expect(m.components.skills).toEqual(["skills"]);
    expect(m.components.mcpServers).toEqual([".mcp.json"]);
    expect(m.components.hooks).toEqual(["hooks/hooks.json"]);
    expect(m.unsupported.length).toBe(0);
  });

  test("commands 组件：目录形态合法且无诊断（曾误按文件校验）", () => {
    const dir = path.join(tmp, "cmd-pack");
    mkdirSync(path.join(dir, ".kova-plugin"), { recursive: true });
    mkdirSync(path.join(dir, "commands"), { recursive: true });
    writeFileSync(
      path.join(dir, ".kova-plugin", "plugin.json"),
      JSON.stringify({ name: "cmd-pack", commands: "commands" }),
    );
    const m = parsePluginManifest(dir);
    expect(m.components.commands).toEqual(["commands"]);
    expect(m.diagnostics).toEqual([]);
  });

  test("codex 插件 package.json 只有元数据：不误报依赖未安装", () => {
    const dir = path.join(tmp, "codex-no-deps");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.join(dir, ".codex-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "codex-no-deps", version: "1.0.0" }),
    );
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "codex-no-deps", version: "1.0.0", private: true }),
    );
    const m = parsePluginManifest(dir);
    expect(m.diagnostics.some((d) => d.includes("依赖未安装"))).toBe(false);
  });

  test("codex 插件声明运行期依赖且缺 node_modules：报依赖未安装并指向安装入口", () => {
    const dir = path.join(tmp, "codex-with-deps");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.join(dir, ".codex-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "codex-with-deps", version: "1.0.0" }),
    );
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "codex-with-deps",
        version: "1.0.0",
        dependencies: { "left-pad": "^1.0.0" },
      }),
    );
    const m = parsePluginManifest(dir);
    expect(m.diagnostics.some((d) => d.includes("依赖未安装"))).toBe(true);
    // 无 lockfile 时提示 npm install（npm ci 会直接失败）
    expect(m.diagnostics.some((d) => d.includes("npm install --omit=dev"))).toBe(true);
  });

  test("codex 清单：name 回退 + skills 数组 + 内联 mcpServers/hooks + interface 元数据", () => {
    const dir = path.join(tmp, "codex-shape");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.join(dir, ".codex-plugin"), { recursive: true });
    mkdirSync(path.join(dir, "s1", "one"), { recursive: true });
    mkdirSync(path.join(dir, "s2", "two"), { recursive: true });
    writeFileSync(path.join(dir, "s1", "one", "SKILL.md"), skillDoc("one", "First skill."));
    writeFileSync(path.join(dir, "s2", "two", "SKILL.md"), skillDoc("two", "Second skill."));
    writeFileSync(
      path.join(dir, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        version: "1.0.0",
        skills: ["./s1", "./s2"],
        mcpServers: {
          inline: { command: "echo", args: ["hi"], cwd: "." },
        },
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "./hook.sh" }] }],
        },
        interface: {
          displayName: "Codex Shape",
          shortDescription: "Inline metadata",
          category: "Developer Tools",
        },
      }),
    );
    const m = parsePluginManifest(dir);
    expect(m.name).toBe("codex-shape");
    expect(m.manifestKind).toBe("codex");
    expect(m.components.skills).toEqual(["s1", "s2"]);
    expect(m.components.mcpServersInline).toBeDefined();
    expect(m.components.hooksInline).toHaveLength(1);
    expect(m.displayName).toBe("Codex Shape");
    expect(m.description).toBe("Inline metadata");
    expect(m.category).toBe("Developer Tools");
  });

  test("Agent Plugins v1：根 plugin.json + skills/ + mcp.json", () => {
    const dir = path.join(tmp, "agent-pack");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.join(dir, "skills", "agent-skill"), { recursive: true });
    writeFileSync(
      path.join(dir, "skills", "agent-skill", "SKILL.md"),
      skillDoc("agent-skill", "Agent plugin skill."),
    );
    writeFileSync(
      path.join(dir, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "agent-pack",
        version: "1.0.0",
        description: "Agent plugin",
        author: { name: "Tester" },
      }),
    );
    writeFileSync(
      path.join(dir, "mcp.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: { agent: { type: "stdio", command: "echo", args: ["ok"] } },
      }),
    );
    const m = parsePluginManifest(dir);
    expect(m.manifestKind).toBe("agent");
    expect(m.components.skills).toEqual(["skills"]);
    expect(m.components.mcpServers).toEqual(["mcp.json"]);
  });

  test("Agent Plugins：extensions.com.openai.interface 归一为展示元数据", () => {
    const dir = path.join(tmp, "agent-interface");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "agent-interface",
        version: "1.0.0",
        extensions: {
          "com.openai": {
            interface: {
              displayName: "Agent UI",
              shortDescription: "Overlay metadata",
              category: "Productivity",
            },
          },
        },
      }),
    );
    const m = parsePluginManifest(dir);
    expect(m.manifestKind).toBe("agent");
    expect(m.displayName).toBe("Agent UI");
    expect(m.description).toBe("Overlay metadata");
    expect(m.category).toBe("Productivity");
    // interface 已被消费，不再作为不支持项告警
    expect(m.unsupported.some((item) => item.includes("interface"))).toBe(false);
  });

  test("双清单探测顺序：codex 优先于 claude；cursor 清单可识别", () => {
    const dir = path.join(tmp, "order-pack");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
    mkdirSync(path.join(dir, ".codex-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "order-pack", skills: "./claude-skills" }),
    );
    writeFileSync(
      path.join(dir, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "order-pack", skills: "./codex-skills" }),
    );
    const m = parsePluginManifest(dir);
    expect(m.manifestKind).toBe("codex");
    expect(m.components.skills).toEqual(["codex-skills"]);

    const cursorDir = path.join(tmp, "cursor-pack");
    rmSync(cursorDir, { recursive: true, force: true });
    mkdirSync(path.join(cursorDir, ".cursor-plugin"), { recursive: true });
    writeFileSync(
      path.join(cursorDir, ".cursor-plugin", "plugin.json"),
      JSON.stringify({ name: "cursor-pack", skills: "./skills" }),
    );
    const cursor = parsePluginManifest(cursorDir);
    expect(cursor.manifestKind).toBe("cursor");
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
  test("Codex 新增事件与 handler 字段可解析", () => {
    const dir = path.join(tmp, "hooks-codex-events");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "hooks.json");
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          SubagentStart: [{ hooks: [{ type: "command", command: "./start.sh" }] }],
          PostCompact: [{ hooks: [{ type: "command", command: "./post.sh" }] }],
          Interrupt: [{ hooks: [{ type: "command", command: "./interrupt.sh" }] }],
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: "./check.sh",
                  commandWindows: ".\\check.ps1",
                  onFailure: "block",
                  timeout: 5,
                },
              ],
            },
          ],
        },
      }),
    );
    const diagnostics: string[] = [];
    const hooks = readPluginHooksFile(file, "codex-events@m", "codex-events", diagnostics);
    expect(diagnostics).toEqual([]);
    expect(hooks.map((hook) => hook.event).sort()).toEqual([
      "Interrupt",
      "PostCompact",
      "PreToolUse",
      "SubagentStart",
    ]);
    const pre = hooks.find((hook) => hook.event === "PreToolUse");
    expect(pre).toMatchObject({
      commandWindows: ".\\check.ps1",
      onFailure: "block",
      timeoutMs: 5000,
    });
  });

  test("自有数组形状原样接收，enabled 缺省为 true", () => {
    const hooks = readPluginHooksFile(path.join(demoDir, "hooks.json"), "demo-pack@m", "demo", []);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.event).toBe("SessionStart");
    expect(hooks[0]!.id).toBe("demo-pack@m:hook-0");
    expect(hooks[0]!.enabled).toBe(true);
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

    // 市场条目未声明 icon：回退读插件清单里的 icon.svg（安装前也能显示图标）
    const demoCatalogEntry = getMarketplaceCatalog(record.id).catalog.plugins.find(
      (p) => p.name === "demo-pack",
    );
    expect(demoCatalogEntry?.icon?.startsWith("data:image/svg+xml;base64,")).toBe(true);
    // 展示名：目录条目未声明时回退插件清单；目录显式声明则优先
    expect(demoCatalogEntry?.displayName).toBe("演示包");
    expect(
      getMarketplaceCatalog(record.id).catalog.plugins.find(
        (p) => p.name === "claude-pack",
      )?.displayName,
    ).toBe("Claude 兼容包");

    // 未安装条目预览：直接从市场源读组件清单（不能等装完才知道带了什么）；
    // 未安装没有本机开关，组件一律按启用呈现
    const preview = await marketplacePluginPreviewPayload(record.id, "demo-pack");
    expect(preview.name).toBe("demo-pack");
    expect(preview.displayName).toBe("演示包");
    expect(preview.manifestKind).toBe("kova");
    expect(preview.components.skills.map((s) => s.name)).toContain("demo-skill");
    expect(preview.components.skills.every((s) => s.enabled)).toBe(true);
    expect(preview.components.mcpServers.map((s) => s.name)).toContain("demo-server");
    expect(preview.components.subagents.map((s) => s.name)).toContain("demo-agent");
    expect(preview.components.hooks.length).toBeGreaterThan(0);
    expect(preview.components.hooks.every((h) => h.enabled)).toBe(true);

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

    // —— hooks 组件：列表摘要与详情原文（详情页"查看内容"必须与运行时同源）——
    const pluginsPayloadNow = await pluginsPayload();
    const demoEntry = pluginsPayloadNow.plugins.find(
      (p) => p.pluginId === "demo-pack@" + record.id,
    );
    expect(demoEntry).toBeDefined();
    expect(demoEntry!.displayName).toBe("演示包");
    expect(demoEntry!.components.hooks).toEqual([
      {
        id: `demo-pack@${record.id}:hook-0`,
        name: "demo-hook",
        description: "SessionStart",
        enabled: true,
        event: "SessionStart",
      },
    ]);
    const hookDoc = await readPluginComponentDoc(
      "demo-pack@" + record.id,
      "hook",
      "demo-hook",
    );
    expect(hookDoc).toBeDefined();
    expect(hookDoc!.path).toContain("hooks.json");
    expect(JSON.parse(hookDoc!.content)).toMatchObject({
      name: "demo-hook",
      event: "SessionStart",
      command: "echo",
    });
    // 非 hooks 的插件与不存在的钩子名都返回 undefined（handler 转协议错误）
    expect(await readPluginComponentDoc("demo-pack@" + record.id, "hook", "ghost")).toBeUndefined();

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

  test("市场卡片图标：条目声明优先，声明失效回退清单", async () => {
    const iconRoot = path.join(tmp, "icon-market");
    const iconDir = path.join(iconRoot, "plugins", "icon-pack");
    mkdirSync(path.join(iconDir, ".kova-plugin"), { recursive: true });
    writeFileSync(
      path.join(iconDir, "manifest-icon.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" data-source="manifest"/>',
    );
    writeFileSync(
      path.join(iconDir, "declared-icon.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" data-source="declared"/>',
    );
    writeFileSync(
      path.join(iconDir, ".kova-plugin", "plugin.json"),
      JSON.stringify({ name: "icon-pack", version: "1.0.0", icon: "manifest-icon.svg" }),
    );
    writeFileSync(
      path.join(iconRoot, "marketplace.json"),
      JSON.stringify({
        name: "icon-market",
        plugins: [
          {
            name: "icon-pack",
            source: "./plugins/icon-pack",
            version: "1.0.0",
            icon: "declared-icon.svg",
          },
        ],
      }),
    );

    const { record } = await addMarketplace({ type: "directory", path: iconRoot });
    await refreshMarketplace(record.id);
    const iconOf = () =>
      getMarketplaceCatalog(record.id).catalog.plugins.find((p) => p.name === "icon-pack")?.icon;
    const decoded = (src: string | undefined) =>
      Buffer.from((src ?? "").split(",")[1] ?? "", "base64").toString("utf8");

    // 条目声明的图标优先于插件清单里的 icon
    expect(decoded(iconOf())).toContain('data-source="declared"');

    // 声明失效（文件被删）→ 回退插件清单图标
    rmSync(path.join(iconDir, "declared-icon.svg"));
    expect(decoded(iconOf())).toContain('data-source="manifest"');

    // 两处都没有 → 无图标（前端回落首字母色块）
    rmSync(path.join(iconDir, "manifest-icon.svg"));
    expect(iconOf()).toBeUndefined();

    removeMarketplace(record.id);
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

  test("Codex personal marketplace：source 相对 $HOME（清单在 .agents/plugins 下）", async () => {
    const home = path.join(tmp, "personal-home");
    const marketDir = path.join(home, ".agents", "plugins");
    const plugDir = path.join(home, "plugins", "personal-pack");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(marketDir, { recursive: true });
    mkdirSync(path.join(plugDir, ".codex-plugin"), { recursive: true });
    writeFileSync(
      path.join(marketDir, "marketplace.json"),
      JSON.stringify({
        name: "personal",
        plugins: [
          { name: "personal-pack", source: { source: "local", path: "./plugins/personal-pack" } },
          {
            name: "gone-pack",
            source: { source: "local", path: "./plugins/gone-pack" },
            policy: { installation: "NOT_AVAILABLE" },
          },
        ],
      }),
    );
    writeFileSync(
      path.join(plugDir, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "personal-pack", version: "1.0.0" }),
    );

    const { record, catalog } = await addMarketplace({ type: "directory", path: marketDir });
    expect(record.sourceBase).toBe(home);
    expect(catalog.plugins[0]?.path).toBe("plugins/personal-pack");
    // NOT_AVAILABLE 的条目隐藏，并在目录诊断中留痕
    expect(catalog.plugins.some((p) => p.name === "gone-pack")).toBe(false);
    expect(catalog.diagnostics?.join("\n")).toContain("NOT_AVAILABLE");
    const { plugin } = await installPlugin(record.id, "personal-pack");
    expect(plugin.pluginId).toBe(`personal-pack@${record.id}`);
    await uninstallPlugin(plugin.pluginId);
    removeMarketplace(record.id);
  });

  test("Codex git-subdir source：相对市场根的 URL、预览/安装材料化", async () => {
    const market = path.join(tmp, "git-source-market");
    const repo = path.join(market, "vendor", "repo");
    const pluginDir = path.join(repo, "plugins", "toolkit");
    rmSync(market, { recursive: true, force: true });
    mkdirSync(path.join(pluginDir, ".codex-plugin"), { recursive: true });
    mkdirSync(path.join(pluginDir, "skills", "remote-skill"), { recursive: true });
    writeFileSync(
      path.join(pluginDir, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "toolkit",
        version: "1.2.3",
        description: "Remote toolkit",
        icon: "./icon.svg",
      }),
    );
    writeFileSync(
      path.join(pluginDir, "icon.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>',
    );
    writeFileSync(
      path.join(pluginDir, "skills", "remote-skill", "SKILL.md"),
      skillDoc("remote-skill", "Remote skill from git."),
    );
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init"],
      { cwd: repo },
    );
    mkdirSync(path.join(market, ".agents", "plugins"), { recursive: true });
    writeFileSync(
      path.join(market, ".agents", "plugins", "marketplace.json"),
      JSON.stringify({
        name: "remote-market",
        plugins: [
          {
            name: "toolkit",
            source: {
              source: "git-subdir",
              url: "./vendor/repo",
              path: "plugins/toolkit",
              ref: "main",
            },
            interface: {
              displayName: "Toolkit Remote",
              shortDescription: "Remote toolkit catalog",
            },
            policy: { authentication: "ON_USE" },
          },
          {
            name: "insecure-pack",
            source: {
              source: "url",
              url: "http://example.com/insecure.git",
              path: "plugins/toolkit",
            },
          },
        ],
      }),
    );

    const { record, catalog } = await addMarketplace({ type: "directory", path: market });
    expect(catalog.plugins[0]?.source).toMatchObject({
      kind: "git",
      url: repo,
      path: "plugins/toolkit",
      ref: "main",
    });
    expect(catalog.plugins[0]?.displayName).toBe("Toolkit Remote");
    expect(catalog.plugins[0]?.authPolicy).toBe("on_use");
    // 明文 http git source 被拒绝（只信任 https/ssh/file）
    expect(catalog.plugins.some((p) => p.name === "insecure-pack")).toBe(false);
    expect(catalog.diagnostics?.join("\n")).toContain("不支持的 git source URL");
    const preview = await marketplacePluginPreviewPayload(record.id, "toolkit");
    expect(preview.name).toBe("toolkit");
    expect(preview.authPolicy).toBe("on_use");
    expect(preview.icon).toContain("data:image/svg+xml");
    expect(preview.components.skills.map((s) => s.name)).toContain("remote-skill");
    const { plugin } = await installPlugin(record.id, "toolkit");
    expect(plugin.pluginId).toBe(`toolkit@${record.id}`);
    expect(plugin.manifest.components.skills).toEqual(["skills"]);
    // 远程 source 的清单图标在安装后回填目录缓存
    expect(getMarketplaceCatalog(record.id).catalog.plugins[0]?.icon).toContain(
      "data:image/svg+xml",
    );
    await uninstallPlugin(plugin.pluginId);
    removeMarketplace(record.id);
  });

  test("git source 缓存按访问时间清理，旧/中断临时目录不长期堆积", () => {
    const sources = path.join(tmp, "plugins-root", "sources");
    const oldDir = path.join(sources, "old-source");
    const freshDir = path.join(sources, "fresh-source");
    const tmpDir = path.join(sources, "broken.cloning.tmp-1");
    rmSync(sources, { recursive: true, force: true });
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(freshDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
    const now = Date.now();
    const old = new Date(now - 40 * 24 * 60 * 60 * 1000);
    const staleTmp = new Date(now - 2 * 60 * 60 * 1000);
    utimesSync(oldDir, old, old);
    utimesSync(tmpDir, staleTmp, staleTmp);
    expect(pruneGitSourceCache(undefined, now)).toBe(2);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(tmpDir)).toBe(false);
    expect(existsSync(freshDir)).toBe(true);
  });

  test("市场条目 name 与 source 目录名不同（./plugins/gitlab-src）可预览/安装", async () => {
    const market = path.join(tmp, "alias-market");
    const plugDir = path.join(market, "plugins", "gitlab-src");
    rmSync(market, { recursive: true, force: true });
    mkdirSync(path.join(market, ".agents", "plugins"), { recursive: true });
    mkdirSync(path.join(plugDir, ".codex-plugin"), { recursive: true });
    writeFileSync(
      path.join(market, ".agents", "plugins", "marketplace.json"),
      JSON.stringify({
        name: "alias-market",
        plugins: [{ name: "gitlab", source: { source: "local", path: "./plugins/gitlab-src" } }],
      }),
    );
    writeFileSync(
      path.join(plugDir, ".codex-plugin", "plugin.json"),
      // 清单 name 与市场条目名刻意不同：更新时仍要能按条目名定位
      JSON.stringify({ name: "gitlab-plugin", version: "0.1.0" }),
    );
    const { record } = await addMarketplace({ type: "directory", path: market });
    const preview = await marketplacePluginPreviewPayload(record.id, "gitlab");
    expect(preview.name).toBe("gitlab-plugin");
    const first = await installPlugin(record.id, "gitlab");
    expect(first.plugin.pluginId).toBe(`gitlab-plugin@${record.id}`);
    expect(first.plugin.catalogName).toBe("gitlab");
    const second = await installPlugin(record.id, "gitlab");
    expect(second.updated).toBe(true);
    await uninstallPlugin(first.plugin.pluginId);
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

  test("本地安装：目录名与清单 name 不一致（GitHub zip 的 *-main）仍可安装", async () => {
    const dir = path.join(tmp, "downloaded", "codex-canvas-main");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.join(dir, ".codex-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "codex-canvas", version: "0.4.4" }),
    );
    const { plugin } = await installLocalPlugin(dir);
    expect(plugin.pluginId).toBe("codex-canvas@local");
    expect(plugin.manifest.manifestKind).toBe("codex");
    await uninstallPlugin("codex-canvas@local");
  });

  test("本地安装：源目录是符号链接（Codex 官方 ~/plugins/<name>）时拷贝内容而非链接", async () => {
    const real = path.join(tmp, "downloaded", "sym-real");
    const link = path.join(tmp, "downloaded", "sym-pack");
    rmSync(real, { recursive: true, force: true });
    rmSync(link, { recursive: true, force: true });
    mkdirSync(path.join(real, ".codex-plugin"), { recursive: true });
    writeFileSync(
      path.join(real, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "sym-pack", version: "1.0.0" }),
    );
    symlinkSync(real, link, "dir");
    const { plugin } = await installLocalPlugin(link);
    expect(plugin.pluginId).toBe("sym-pack@local");
    const installed = installedPluginDir(LOCAL_MKT_ID, "sym-pack");
    expect(existsSync(path.join(installed, ".codex-plugin", "plugin.json"))).toBe(true);
    // 源目录不应被写入 installed.json
    expect(existsSync(path.join(real, "installed.json"))).toBe(false);
    await uninstallPlugin("sym-pack@local");
  });

  test("Codex 插件 hooks：插件根 cwd / PLUGIN_DATA / commandWindows / onFailure", async () => {
    const dir = path.join(tmp, "downloaded", "codex-hooks");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.join(dir, ".codex-plugin"), { recursive: true });
    mkdirSync(path.join(dir, "hooks"), { recursive: true });
    writeFileSync(
      path.join(dir, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "codex-hooks", version: "1.0.0" }),
    );
    writeFileSync(
      path.join(dir, "hooks", "hooks.json"),
      JSON.stringify({
        PreToolUse: [
          {
            matcher: "shell",
            hooks: [
              {
                type: "command",
                command: "./hooks/check.sh",
                commandWindows: ".\\hooks\\check.ps1",
                onFailure: "block",
                async: true,
                statusMessage: "checking tools",
                timeout: 5,
              },
            ],
          },
        ],
        // Agent Plugins 语义：${PLUGIN_DATA} 在 hooks 命令里也要展开
        PreCompact: [{ hooks: [{ type: "command", command: "echo ${PLUGIN_DATA}/state.json" }] }],
        PreModelRequest: [{ hooks: [{ type: "command", command: "echo model-request" }] }],
      }),
    );
    const { plugin } = await installLocalPlugin(dir);
    const hooks = activePluginHooks();
    const hook = hooks.find((entry) => entry.command === "./hooks/check.sh");
    expect(hook).toBeDefined();
    expect(hook!.event).toBe("PreToolUse");
    expect(hook!.cwd).toBe(plugin.manifest.root);
    expect(hook!.pluginRoot).toBe(plugin.manifest.root);
    expect(hook!.pluginDataRoot).toContain("plugin-data");
    expect(hook!.commandWindows).toBe(".\\hooks\\check.ps1");
    expect(hook!.onFailure).toBe("block");
    expect(hook!.background).toBe(true);
    expect(hook!.statusMessage).toBe("checking tools");
    const dataHook = hooks.find((entry) => entry.event === "PreCompact");
    expect(dataHook!.command).toBe(`echo ${hook!.pluginDataRoot}/state.json`);
    expect(hooks.find((entry) => entry.event === "PreModelRequest")?.command).toBe(
      "echo model-request",
    );
    await uninstallPlugin(plugin.pluginId);
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

  test("钩子边界：同名按 id 取文、enable 门控、WORKSPACE/BUN 按上下文展开", async () => {
    const dir = path.join(tmp, "hooks-edge-pack");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.join(dir, ".kova-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".kova-plugin", "plugin.json"),
      JSON.stringify({ name: "hooks-edge-pack", version: "1.0.0", hooks: "hooks.json" }),
    );
    writeFileSync(
      path.join(dir, "hooks.json"),
      JSON.stringify([
        { name: "dup", command: "echo first", event: "SessionStart" },
        { name: "dup", command: "echo second", event: "Stop" },
        { name: "off", command: "echo off", event: "SessionStart", enabled: false },
        { name: "ws", command: "echo ${WORKSPACE}", args: ["--at", "${WORKSPACE}"], event: "SessionStart" },
        { name: "bun", command: "${BUN} run run.ts", event: "SessionStart" },
      ]),
    );
    const { plugin } = await installLocalPlugin(dir);
    try {
      const payload = await pluginsPayload();
      const entry = payload.plugins.find((p) => p.pluginId === plugin.pluginId);
      expect(entry).toBeDefined();
      const hooks = entry!.components.hooks;
      expect(hooks).toHaveLength(5);
      const dupHooks = hooks.filter((h) => h.name === "dup");
      expect(dupHooks).toHaveLength(2);
      // 同名条目各自有稳定 id；停用条目保留在列表里但状态为 false
      expect(dupHooks[0]!.id).not.toBe(dupHooks[1]!.id);
      expect(hooks.find((h) => h.name === "off")!.enabled).toBe(false);
      // 占位符诊断依赖运行时上下文，不随全局插件详情下发（避免未选工作区时误报）
      expect(entry!.diagnostics.some((d) => d.includes("${WORKSPACE}"))).toBe(false);

      // 详情按 id 命中的是第二条，而不是第一条同名钩子
      const second = await readPluginComponentDoc(plugin.pluginId, "hook", dupHooks[1]!.id!);
      expect(second).toBeDefined();
      // 响应里的 name 仍是展示名，id 只用于定位
      expect(second!.name).toBe("dup");
      expect(JSON.parse(second!.content)).toMatchObject({
        name: "dup",
        command: "echo second",
      });

      // 显式传工作区：命令与 args 都展开，诊断不再误报
      const wsDir = path.join(tmp, "hooks-edge-ws");
      mkdirSync(wsDir, { recursive: true });
      const withWs = listPluginHookEntriesWithDiagnostics(plugin, wsDir);
      const wsHook = withWs.hooks.find((h) => h.name === "ws")!;
      expect(wsHook.command).toBe(`echo ${wsDir}`);
      expect(wsHook.args).toEqual(["--at", wsDir]);
      expect(withWs.expansionDiagnostics.some((d) => d.includes("${WORKSPACE}"))).toBe(false);
      const noWs = listPluginHookEntriesWithDiagnostics(plugin);
      expect(noWs.hooks.find((h) => h.name === "ws")!.command).toBe("echo ${WORKSPACE}");
      expect(noWs.expansionDiagnostics.some((d) => d.includes("${WORKSPACE}"))).toBe(true);

      // ${BUN} 展开为运行时可执行文件，并标记 usedBun 供 spawn 补 BUN_BE_BUN
      const bunHook = withWs.hooks.find((h) => h.name === "bun")!;
      expect(bunHook.command).toBe(`${process.execPath} run run.ts`);
      expect(bunHook.usedBun).toBe(true);
      expect(wsHook.usedBun).toBeUndefined();
      // 插件根只随运行时条目下发（执行层据此注入 CLAUDE_PLUGIN_ROOT），
      // 插件详情负载不带本机绝对路径
      expect(wsHook.pluginRoot).toBeUndefined();

      // 运行时只取启用的条目，并按工作区展开
      const runtime = activePluginHooks(wsDir).filter((h) => h.id.startsWith(plugin.pluginId));
      expect(runtime.some((h) => h.name === "dup")).toBe(true);
      expect(runtime.some((h) => h.name === "off")).toBe(false);
      expect(runtime.find((h) => h.name === "ws")!.command).toBe(`echo ${wsDir}`);
      expect(runtime.find((h) => h.name === "ws")!.pluginRoot).toBe(plugin.manifest.root);
    } finally {
      await uninstallPlugin(plugin.pluginId);
    }
  });

  test("插件钩子执行时注入 CLAUDE_PLUGIN_ROOT（兼容 $CLAUDE_PLUGIN_ROOT）", async () => {
    const dir = path.join(tmp, "hooks-env-pack");
    const marker = path.join(tmp, `hooks-env-${Date.now()}.txt`);
    rmSync(dir, { recursive: true, force: true });
    rmSync(marker, { force: true });
    mkdirSync(path.join(dir, ".kova-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".kova-plugin", "plugin.json"),
      JSON.stringify({ name: "hooks-env-pack", version: "1.0.0", hooks: "hooks.json" }),
    );
    writeFileSync(
      path.join(dir, "hooks.json"),
      JSON.stringify([
        {
          name: "env",
          event: "Stop",
          type: "process",
          command: "${BUN}",
          args: [
            "-e",
            `require("fs").writeFileSync(${JSON.stringify(marker)}, process.env.CLAUDE_PLUGIN_ROOT || "")`,
          ],
        },
      ]),
    );
    const { plugin } = await installLocalPlugin(dir);
    try {
      const { runHooks } = await import("../../src/agent/hooks");
      await runHooks(
        "Stop",
        { event: "Stop", sessionId: "s-env", timestamp: new Date().toISOString() },
        { workspace: dir },
      );
      expect(readFileSync(marker, "utf8")).toBe(plugin.manifest.root);
    } finally {
      await uninstallPlugin(plugin.pluginId);
      rmSync(marker, { force: true });
    }
  });

  test("坏 hooks.json：解析诊断随插件负载下发，详情能解释空列表", async () => {
    const dir = path.join(tmp, "hooks-bad-pack");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.join(dir, ".kova-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".kova-plugin", "plugin.json"),
      JSON.stringify({ name: "hooks-bad-pack", version: "1.0.0", hooks: "hooks.json" }),
    );
    writeFileSync(path.join(dir, "hooks.json"), "{ not json");
    const { plugin } = await installLocalPlugin(dir);
    try {
      const payload = await pluginsPayload();
      const entry = payload.plugins.find((p) => p.pluginId === plugin.pluginId);
      expect(entry).toBeDefined();
      expect(entry!.components.hooks).toEqual([]);
      expect(entry!.diagnostics.some((d) => d.includes("hooks: 解析失败"))).toBe(true);
    } finally {
      await uninstallPlugin(plugin.pluginId);
    }
  });
});

describe("hooks 无 node 运行时回退", () => {
  async function installHookPlugin(name: string, hook: Record<string, unknown>) {
    const dir = path.join(tmp, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.join(dir, ".kova-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".kova-plugin", "plugin.json"),
      JSON.stringify({ name, version: "1.0.0", hooks: "hooks.json" }),
    );
    writeFileSync(path.join(dir, "hooks.json"), JSON.stringify([hook]));
    return installLocalPlugin(dir);
  }

  test("process 形态 command: node 回退内置运行时", async () => {
    const stamp = Date.now();
    const marker = path.join(tmp, `hook-node-process-${stamp}.txt`);
    const script = path.join(tmp, `hook-node-process-${stamp}.mjs`);
    writeFileSync(
      script,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "ok");\n`,
    );
    const { plugin } = await installHookPlugin("hook-node-process", {
      name: "node-process",
      event: "Stop",
      type: "process",
      command: "node",
      args: [script],
    });
    const prevPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const { runHooks } = await import("../../src/agent/hooks");
      await runHooks(
        "Stop",
        { event: "Stop", sessionId: "s-node-process", timestamp: new Date().toISOString() },
        { workspace: plugin.manifest.root },
      );
      expect(readFileSync(marker, "utf8")).toBe("ok");
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      await uninstallPlugin(plugin.pluginId);
      rmSync(marker, { force: true });
      rmSync(script, { force: true });
    }
  });

  test("shell 形态 node 命令通过 PATH 软链命中内置运行时", async () => {
    const stamp = Date.now();
    const marker = path.join(tmp, `hook-node-shell-${stamp}.txt`);
    const script = path.join(tmp, `hook-node-shell-${stamp}.mjs`);
    writeFileSync(
      script,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "ok");\n`,
    );
    const { plugin } = await installHookPlugin("hook-node-shell", {
      name: "node-shell",
      event: "Stop",
      type: "shell",
      command: `node ${script}`,
    });
    const prevPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const { runHooks } = await import("../../src/agent/hooks");
      await runHooks(
        "Stop",
        { event: "Stop", sessionId: "s-node-shell", timestamp: new Date().toISOString() },
        { workspace: plugin.manifest.root },
      );
      expect(readFileSync(marker, "utf8")).toBe("ok");
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      await uninstallPlugin(plugin.pluginId);
      rmSync(marker, { force: true });
      rmSync(script, { force: true });
    }
  });
});

describe("物化原子性与符号链接源", () => {  test("build 失败时旧目录原样保留，staging 清理", () => {
    const dest = path.join(tmp, "atomic-dest");
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, "old.txt"), "old");
    expect(() =>
      replacePluginDirAtomically(dest, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(readFileSync(path.join(dest, "old.txt"), "utf8")).toBe("old");
    expect(readdirSync(tmp).some((name) => name.includes(".staging-"))).toBe(false);
  });

  test("替换成功后旧内容消失，不留 staging/backup", () => {
    const dest = path.join(tmp, "atomic-ok-dest");
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, "old.txt"), "old");
    replacePluginDirAtomically(dest, (staging) => {
      mkdirSync(staging);
      writeFileSync(path.join(staging, "new.txt"), "new");
    });
    expect(existsSync(path.join(dest, "old.txt"))).toBe(false);
    expect(readFileSync(path.join(dest, "new.txt"), "utf8")).toBe("new");
    expect(
      readdirSync(tmp).filter((name) => name.includes(".staging-") || name.includes(".backup-")),
    ).toEqual([]);
  });

  test("Windows 平台优先 .mcp.windows.json，其它平台仍用 .mcp.json", () => {
    const dir = path.join(tmp, "win-mcp-plugin");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.join(dir, ".codex-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "win-mcp-plugin", version: "1.0.0" }),
    );
    writeFileSync(
      path.join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { win: { command: "sh", args: ["./scripts/start.sh", "mcp"] } } }),
    );
    writeFileSync(
      path.join(dir, ".mcp.windows.json"),
      JSON.stringify({
        mcpServers: {
          win: { command: "powershell.exe", args: ["-File", "./scripts/start.ps1", "mcp"] },
        },
      }),
    );
    try {
      const manifest = parsePluginManifest(dir);
      const win = resolvePluginComponents(manifest, "mcpServers", "win32");
      const mac = resolvePluginComponents(manifest, "mcpServers", "darwin");
      expect(win[0]?.endsWith(".mcp.windows.json")).toBe(true);
      expect(mac[0]?.endsWith(".mcp.json")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("缓存里的隐藏 staging/backup 目录不会被扫描成插件", () => {
    const mktCache = path.join(tmp, "plugins", "cache", "hidden-mkt");
    const hidden = path.join(mktCache, ".hidden-pack.staging-1");
    mkdirSync(path.join(hidden, ".codex-plugin"), { recursive: true });
    writeFileSync(
      path.join(hidden, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "hidden-pack", version: "1.0.0" }),
    );
    try {
      resetPluginsForTest();
      expect(listInstalledPlugins().some((p) => p.name === "hidden-pack")).toBe(false);
    } finally {
      rmSync(mktCache, { recursive: true, force: true });
      resetPluginsForTest();
    }
  });

  test("目录市场里插件源是符号链接：拷贝安装按真实目录物化", async () => {
    const mkt = path.join(tmp, "symlink-market");
    const real = path.join(tmp, "symlink-real-pack");
    rmSync(mkt, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
    mkdirSync(path.join(mkt, "plugins"), { recursive: true });
    writeFileSync(
      path.join(mkt, "marketplace.json"),
      JSON.stringify({
        name: "symlink-market",
        plugins: [
          { name: "symlink-pack", source: { source: "local", path: "./plugins/symlink-pack" } },
        ],
      }),
    );
    mkdirSync(path.join(real, ".codex-plugin"), { recursive: true });
    writeFileSync(
      path.join(real, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "symlink-pack", version: "1.0.0" }),
    );
    writeFileSync(path.join(real, "payload.txt"), "real");
    symlinkSync(real, path.join(mkt, "plugins", "symlink-pack"), "dir");

    const { record } = await addMarketplace({ type: "directory", path: mkt });
    const { plugin } = await installPlugin(record.id, "symlink-pack");
    try {
      expect(plugin.name).toBe("symlink-pack");
      const installed = installedPluginDir(record.id, "symlink-pack");
      expect(readFileSync(path.join(installed, "payload.txt"), "utf8")).toBe("real");
      // 拷贝装必须是真目录，不是指向源的链接
      expect(lstatSync(installed).isSymbolicLink()).toBe(false);
    } finally {
      await uninstallPlugin(plugin.pluginId);
      removeMarketplace(record.id);
    }
  });
});

function exists(p: string): boolean {
  return existsSync(p);
}
