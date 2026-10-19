import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { buildPluginPackPlan } from "../../scripts/builtin-plugins-lib";

/**
 * 打包计划硬校验：清单声明的组件缺文件、或存在但收不进包，都必须直接失败——
 * manifest 层的缺失只是软诊断（安装照常，加载层自然为空），对首方内置包不够。
 * 真实事故：各插件目录下的 .mcp.json 被 .gitignore 裸模式误伤、从未入库 → CI 干净
 * 检出缺件 → 出包照样成功 → Windows/macOS 发行版里 ui-design 的 MCP server 永不注册
 * （面板还能开，只留一条「声明的路径不存在」诊断）。这里钉住两类失败，并给真实的
 * plugins/ 源目录钉一条「ui-design 的 .mcp.json 必须在包里」的回归锚点。
 */

const tmp = mkdtempSync(join(tmpdir(), "pi-agent-pack-plan-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const pkgRoot = resolve(import.meta.dir, "../..");

/** 造一个最小市场根：marketplace.json + <name>/.kova-plugin/plugin.json + 附加文件 */
function makeMarketplace(
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): string {
  const root = mkdtempSync(join(tmp, "mkt-"));
  const write = (rel: string, text: string): void => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  };
  write("marketplace.json", JSON.stringify({ plugins: [{ name, source: `./${name}` }] }));
  write(`${name}/.kova-plugin/plugin.json`, JSON.stringify({ name, version: "1.0.0", ...manifest }));
  for (const [rel, text] of Object.entries(files)) write(`${name}/${rel}`, text);
  return root;
}

describe("内置插件打包计划：清单声明的组件硬校验", () => {
  test("声明的 mcpServers 文件缺失 → 打包失败，而不是出一个无 MCP 的包", () => {
    const root = makeMarketplace("nodep", { mcpServers: ".mcp.json" });
    expect(() => buildPluginPackPlan(root)).toThrow(/mcpServers.*不存在或类型不符/);
  });

  test("声明的 mcpServers 存在但收不进包（收集口径外）→ 打包失败", () => {
    const root = makeMarketplace(
      "oddpath",
      { mcpServers: "config/servers.json" },
      { "config/servers.json": "{}" },
    );
    expect(() => buildPluginPackPlan(root)).toThrow(/mcpServers.*未被收集进包/);
  });

  test("声明的组件齐备 → 打包成功且条目进包", () => {
    const root = makeMarketplace(
      "withdep",
      { mcpServers: ".mcp.json" },
      { ".mcp.json": JSON.stringify({ mcpServers: {} }) },
    );
    const plan = buildPluginPackPlan(root);
    expect(Object.keys(plan.entries)).toContain("withdep/.mcp.json");
  });

  test("仓库 plugins/ 源目录：ui-design 的 .mcp.json 必须在包内（事故回归锚点）", () => {
    const plan = buildPluginPackPlan(resolve(pkgRoot, "../../../plugins"));
    expect(Object.keys(plan.entries)).toContain("ui-design/.mcp.json");
  });
});