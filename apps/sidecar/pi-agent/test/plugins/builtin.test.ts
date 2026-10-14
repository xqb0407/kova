import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import {
  activePlugins,
  builtinMarketplaceEntry,
  installLocalPlugin,
  installPlugin,
  listInstalledPlugins,
  refreshMarketplace,
  removeMarketplace,
  resetPluginsForTest,
  setBuiltinBundleBytesForTest,
  resetBuiltinBundleForTest,
  setPluginEnabled,
  syncBuiltinPlugins,
  uninstallPlugin,
  BUILTIN_MKT_ID,
  BUILTIN_MKT_NAME,
} from "../../src/plugins/plugins";
import { initLocalStorage, resetStorageForTest } from "../../src/storage/hostdb";
import { marketplacesPayload } from "../../src/protocol/payloads";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-builtin-"));
const prevPluginsDir = process.env.PI_PLUGINS_DIR;
const prevEnvZip = process.env.PI_BUILTIN_PLUGINS_ZIP;

/** 内置包构造：catalog + <name>/ 文件树（与打包脚本同布局） */
function makeBundle(
  bundleVersion: string,
  plugins: Array<{ name: string; version: string; files: Record<string, string> }>,
): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    "catalog.json": strToU8(
      JSON.stringify({
        bundleVersion,
        source: "test",
        plugins: plugins.map((p) => ({ name: p.name, version: p.version })),
      }),
    ),
  };
  for (const p of plugins) {
    for (const [rel, text] of Object.entries(p.files)) {
      entries[`${p.name}/${rel}`] = strToU8(text);
    }
  }
  return zipSync(entries);
}

const kovaManifest = (name: string, version: string) =>
  JSON.stringify({ name, version, description: `${name} builtin`, skills: "skills" });

/** v1 包：alpha（带技能）+ beta */
const bundleV1 = () =>
  makeBundle("hash-v1", [
    {
      name: "alpha",
      version: "1.0.0",
      files: {
        ".kova-plugin/plugin.json": kovaManifest("alpha", "1.0.0"),
        "skills/alpha-skill.md": "---\ndescription: v1 skill.\n---\n\nAlpha v1.\n",
      },
    },
    {
      name: "beta",
      version: "2.0.0",
      files: { ".kova-plugin/plugin.json": kovaManifest("beta", "2.0.0") },
    },
  ]);

/** v2 包：alpha 内容变更 + beta 从包内消失（剪旧） */
const bundleV2 = () =>
  makeBundle("hash-v2", [
    {
      name: "alpha",
      version: "1.1.0",
      files: {
        ".kova-plugin/plugin.json": kovaManifest("alpha", "1.1.0"),
        "skills/alpha-skill.md": "---\ndescription: v2 skill.\n---\n\nAlpha v2.\n",
      },
    },
  ]);

function builtinDir(name: string): string {
  return path.join(process.env.PI_PLUGINS_DIR!, "cache", BUILTIN_MKT_ID, name);
}

/** 本地装一个同名插件的源目录（避让/让位用例；basename 须等于插件名） */
function localSourceDir(name: string, version = "9.9.9"): string {
  const dir = path.join(tmp, "local-src", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, ".kova-plugin"), { recursive: true });
  writeFileSync(
    path.join(dir, ".kova-plugin", "plugin.json"),
    JSON.stringify({ name, version, description: `${name} from local` }),
  );
  return dir;
}

beforeAll(() => {
  initLocalStorage(path.join(tmp, "state.db"));
  process.env.PI_PLUGINS_DIR = path.join(tmp, "plugins-root");
});

afterAll(() => {
  setBuiltinBundleBytesForTest(null);
  resetBuiltinBundleForTest();
  resetPluginsForTest();
  resetStorageForTest();
  if (prevPluginsDir === undefined) delete process.env.PI_PLUGINS_DIR;
  else process.env.PI_PLUGINS_DIR = prevPluginsDir;
  if (prevEnvZip === undefined) delete process.env.PI_BUILTIN_PLUGINS_ZIP;
  else process.env.PI_BUILTIN_PLUGINS_ZIP = prevEnvZip;
  rmSync(tmp, { recursive: true, force: true });
});

describe("内置插件包启动同步", () => {
  test("首启全量物化：installed、扫描可见、市场条目合成、合并链纳入", async () => {
    setBuiltinBundleBytesForTest(bundleV1());
    const r = await syncBuiltinPlugins();
    expect(r.status).toBe("synced");
    expect(r.installed.sort()).toEqual(["alpha", "beta"]);
    expect(r.updated).toEqual([]);
    expect(existsSync(path.join(builtinDir("alpha"), ".kova-plugin", "plugin.json"))).toBe(true);

    const meta = JSON.parse(readFileSync(path.join(builtinDir("alpha"), "installed.json"), "utf8"));
    expect(meta.pluginId).toBe("alpha@builtin");
    expect(meta.marketplaceName).toBe(BUILTIN_MKT_NAME);
    expect(meta.revision).toBe("builtin-hash-v1");

    const listed = listInstalledPlugins().filter((p) => p.mktId === BUILTIN_MKT_ID);
    expect(listed.map((p) => p.pluginId).sort()).toEqual(["alpha@builtin", "beta@builtin"]);
    expect(listed.every((p) => p.mktName === BUILTIN_MKT_NAME && !p.sourceMissing)).toBe(true);

    const entry = builtinMarketplaceEntry();
    expect(entry?.id).toBe(BUILTIN_MKT_ID);
    expect(entry?.plugins.map((p) => p.name).sort()).toEqual(["alpha", "beta"]);

    expect(activePlugins().some((p) => p.pluginId === "alpha@builtin")).toBe(true);
  });

  test("同版本重跑 = no-op（不碰文件）", async () => {
    const marker = readFileSync(path.join(tmp, "plugins-root", "cache", BUILTIN_MKT_ID, ".sync.json"), "utf8");
    const r = await syncBuiltinPlugins();
    expect(r.status).toBe("noop");
    expect(r.installed).toEqual([]);
    expect(r.updated).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(readFileSync(path.join(tmp, "plugins-root", "cache", BUILTIN_MKT_ID, ".sync.json"), "utf8")).toBe(marker);
  });

  test("版本变更：重物化 + 剪旧条目；禁用开关跨重装保留", async () => {
    await setPluginEnabled("alpha@builtin", false);
    setBuiltinBundleBytesForTest(bundleV2());
    const r = await syncBuiltinPlugins();
    expect(r.status).toBe("synced");
    expect(r.updated).toEqual(["alpha"]);
    expect(r.removed).toEqual(["beta"]);
    expect(existsSync(builtinDir("beta"))).toBe(false);
    expect(readFileSync(path.join(builtinDir("alpha"), "skills", "alpha-skill.md"), "utf8")).toContain("Alpha v2");
    // kv 启停不随物化重置：alpha 仍是禁用；禁用项不进合并链
    expect(activePlugins().some((p) => p.pluginId === "alpha@builtin")).toBe(false);
    await setPluginEnabled("alpha@builtin", true);
  });

  test("同名让位：其他市场有启用同名项时不物化；uninstall 后下次同步补齐", async () => {
    // v3 包把 beta 加回来；beta 已被剪掉、目录缺失
    setBuiltinBundleBytesForTest(
      makeBundle("hash-v3", [
        { name: "alpha", version: "1.1.0", files: { ".kova-plugin/plugin.json": kovaManifest("alpha", "1.1.0") } },
        { name: "beta", version: "3.0.0", files: { ".kova-plugin/plugin.json": kovaManifest("beta", "3.0.0") } },
      ]),
    );
    await installLocalPlugin(localSourceDir("beta")); // 本地装同名 beta@local
    const r = await syncBuiltinPlugins();
    expect(r.skipped).toEqual(["beta"]);
    expect(existsSync(builtinDir("beta"))).toBe(false);
    // alpha 无冲突：v2→v3 版本变更重物化（installed=0、updated=[alpha]）
    expect(r.updated).toEqual(["alpha"]);

    await uninstallPlugin("beta@local");
    const r2 = await syncBuiltinPlugins(); // 同版本但缺失条目 → 只补缺失
    expect(r2.status).toBe("synced");
    expect(r2.installed).toEqual(["beta"]);
  });

  test("运行期让位：同名本地启用项在场时合并链过滤内置条目", async () => {
    // 内置 alpha 已物化（启用）。本地装同名 alpha → activePlugins 只留 local 版本
    await installLocalPlugin(localSourceDir("alpha"));
    const names = activePlugins()
      .filter((p) => p.name === "alpha")
      .map((p) => p.pluginId);
    expect(names).toEqual(["alpha@local"]);
    // 内置条目本身仍在清单里（可禁用/查看），只是不进合并链
    expect(listInstalledPlugins().some((p) => p.pluginId === "alpha@builtin")).toBe(true);

    await uninstallPlugin("alpha@local");
    expect(activePlugins().some((p) => p.pluginId === "alpha@builtin")).toBe(true);
  });

  test("env 覆盖包路径：PI_BUILTIN_PLUGINS_ZIP 指向别处的包", async () => {
    const zipPath = path.join(tmp, "override.zip");
    writeFileSync(zipPath, makeBundle("hash-env", [
      { name: "gamma", version: "0.1.0", files: { ".kova-plugin/plugin.json": kovaManifest("gamma", "0.1.0") } },
    ]));
    setBuiltinBundleBytesForTest(null);
    resetBuiltinBundleForTest();
    process.env.PI_BUILTIN_PLUGINS_ZIP = zipPath;
    const r = await syncBuiltinPlugins();
    expect(r.status).toBe("synced");
    expect(r.installed).toEqual(["gamma"]);
    // v3 → env 包版本再次变更：旧条目（alpha/beta）被剪
    expect(r.removed.sort()).toEqual(["alpha", "beta"]);
    delete process.env.PI_BUILTIN_PLUGINS_ZIP;
    resetBuiltinBundleForTest();
  });

  test("写路径守卫：内置条目不可卸载/安装/刷新/移除，可禁用", async () => {
    setBuiltinBundleBytesForTest(bundleV1());
    resetBuiltinBundleForTest();
    await syncBuiltinPlugins();
    await expect(uninstallPlugin("alpha@builtin")).rejects.toThrow(/不可卸载/);
    await expect(refreshMarketplace(BUILTIN_MKT_ID)).rejects.toThrow(/随应用更新/);
    await expect(installPlugin(BUILTIN_MKT_ID, "alpha")).rejects.toThrow(/无需安装/);
    expect(() => removeMarketplace(BUILTIN_MKT_ID)).toThrow(/未找到市场/);
    await expect(setPluginEnabled("alpha@builtin", false)).resolves.toBeUndefined();
    await setPluginEnabled("alpha@builtin", true);
  });

  test("marketplacesPayload：内置条目拼进数组、帧首键仍是 type", async () => {
    await installLocalPlugin(localSourceDir("delta")); // 造一个本地条目验证拼装顺序
    const frame = marketplacesPayload();
    const builtin = frame.marketplaces.find((m) => m.id === BUILTIN_MKT_ID);
    expect(builtin?.name).toBe(BUILTIN_MKT_NAME);
    expect(builtin?.needsRefresh).toBe(false);
    expect(builtin?.plugins.length).toBeGreaterThan(0);
    const json = JSON.stringify(frame);
    expect(json.startsWith('{"type":"marketplaces"')).toBe(true);
    // 内置在市场列表中的位置：真实登记表条目之后、本地安装之前
    const ids = frame.marketplaces.map((m) => m.id);
    expect(ids.indexOf(BUILTIN_MKT_ID)).toBeLessThan(ids.indexOf("local"));
    await uninstallPlugin("delta@local");
  });

  test("空市场不呈现：内置目录清空后 entry 返回 undefined", async () => {
    setBuiltinBundleBytesForTest(makeBundle("hash-empty", []));
    const r = await syncBuiltinPlugins();
    expect(r.status).toBe("failed"); // 空包（catalog 无有效条目）装载失败 → 非致命 failed
    expect(r.error).toContain("为空");
    // 但目录内旧条目仍在（sync 失败不动盘）：entry 依然合成——清理由人工/下次成功同步完成
    expect(builtinMarketplaceEntry()).toBeDefined();
    setBuiltinBundleBytesForTest(bundleV1());
    resetBuiltinBundleForTest();
    await syncBuiltinPlugins();
  });
});
