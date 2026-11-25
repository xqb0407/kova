import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_SANDBOX_CONFIG, realResolve } from "pi-sandbox";
import type { Running } from "../../src/types";
import {
  initSandboxConfig,
  resetSandboxConfigForTest,
  setSandboxConfig,
} from "../../src/permissions/sandbox-config";
import {
  invalidateSandboxPlans,
  sandboxPlanForRun,
} from "../../src/permissions/sandbox-plan";
import { pluginDataRootFor } from "../../src/plugins/plugins";
import { resetPluginsForTest } from "../../src/plugins/store";
import { initLocalStorage } from "../../src/storage/hostdb";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-sandbox-plan-"));
const workspace = mkdtempSync(path.join(tmpdir(), "pi-agent-sandbox-ws-"));

beforeAll(() => {
  initLocalStorage(path.join(tmp, "state.db"));
});

function fakeRun(): Running {
  return {
    cwd: workspace,
    sessionId: "sandbox-plan-test",
    externalDirs: [],
  } as unknown as Running;
}

describe("sandboxPlanForRun", () => {
  test("设置切换后下一次 plan 立即变化（无需重启）", async () => {
    resetSandboxConfigForTest();
    await initSandboxConfig();
    // 发布默认 off
    expect(await sandboxPlanForRun(fakeRun())).toBeNull();

    await setSandboxConfig({
      ...DEFAULT_SANDBOX_CONFIG,
      tier: "workspace",
      allowPackageCaches: false,
    });
    invalidateSandboxPlans();
    const plan = await sandboxPlanForRun(fakeRun());
    expect(plan).not.toBeNull();
    expect(plan!.cwd).toBe(realResolve(workspace));

    await setSandboxConfig({ ...DEFAULT_SANDBOX_CONFIG, tier: "off" });
    invalidateSandboxPlans();
    expect(await sandboxPlanForRun(fakeRun())).toBeNull();
  });

  test("KOVA_SANDBOX=off 优先于设置页：全局 kill switch", async () => {
    resetSandboxConfigForTest();
    await initSandboxConfig();
    await setSandboxConfig({
      ...DEFAULT_SANDBOX_CONFIG,
      tier: "workspace",
      allowPackageCaches: false,
    });
    process.env.KOVA_SANDBOX = "off";
    invalidateSandboxPlans();
    try {
      expect(await sandboxPlanForRun(fakeRun())).toBeNull();
    } finally {
      delete process.env.KOVA_SANDBOX;
    }
  });

  test("已启用插件只有 PLUGIN_DATA 进入可写根，安装根保持只读", async () => {
    const prevPluginsDir = process.env.PI_PLUGINS_DIR;
    process.env.PI_PLUGINS_DIR = path.join(tmp, "plugins");
    const pluginRoot = path.join(tmp, "plugins", "cache", "local", "sandbox-pack");
    mkdirSync(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
    writeFileSync(
      path.join(pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "sandbox-pack", version: "1.0.0" }),
    );
    resetPluginsForTest();
    resetSandboxConfigForTest();
    await initSandboxConfig();
    await setSandboxConfig({
      ...DEFAULT_SANDBOX_CONFIG,
      tier: "workspace",
      allowPackageCaches: false,
    });
    invalidateSandboxPlans();
    try {
      const plan = await sandboxPlanForRun(fakeRun());
      expect(plan).not.toBeNull();
      expect(plan!.writeRoots).toContain(
        realResolve(pluginDataRootFor("sandbox-pack@local")),
      );
      expect(plan!.writeRoots).not.toContain(realResolve(pluginRoot));
    } finally {
      resetPluginsForTest();
      if (prevPluginsDir === undefined) delete process.env.PI_PLUGINS_DIR;
      else process.env.PI_PLUGINS_DIR = prevPluginsDir;
      await setSandboxConfig({ ...DEFAULT_SANDBOX_CONFIG, tier: "off" });
      invalidateSandboxPlans();
    }
  });

  test("KOVA_SANDBOX=workspace 强开设置页为 off 的会话", async () => {
    resetSandboxConfigForTest();
    await initSandboxConfig();
    await setSandboxConfig({
      ...DEFAULT_SANDBOX_CONFIG,
      tier: "off",
      allowPackageCaches: false,
    });
    process.env.KOVA_SANDBOX = "workspace";
    invalidateSandboxPlans();
    try {
      expect(await sandboxPlanForRun(fakeRun())).not.toBeNull();
    } finally {
      delete process.env.KOVA_SANDBOX;
    }
  });
});
