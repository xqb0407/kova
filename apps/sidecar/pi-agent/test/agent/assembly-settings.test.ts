import { afterEach, describe, expect, test } from "bun:test";
import {
  applyCapabilityEnablement,
  getCapabilitiesPayload,
  getCapabilityRegistry,
  initCapabilities,
  resetCapabilitiesForTest,
} from "../../src/agent/assembly";
import {
  normalizeCapabilitySettings,
  readCapabilityParams,
  setCapabilitySettingsForTest,
} from "../../src/agent/assembly/settings";

afterEach(() => resetCapabilitiesForTest());

describe("capability 设置规整", () => {
  test("坏条目剔除，合法开关与参数保留", () => {
    const settings = normalizeCapabilitySettings({
      enabled: { "tool-budget": true, "loop-guard": "yes", "": true },
      params: { "tool-budget": { maxInlineBytes: 4096 }, bad: [] },
      extra: "ignored",
    });
    expect(settings.enabled).toEqual({ "tool-budget": true });
    expect(settings.params).toEqual({ "tool-budget": { maxInlineBytes: 4096 } });
  });

  test("readCapabilityParams 返回能力自己的参数或空对象", () => {
    setCapabilitySettingsForTest({
      enabled: {},
      params: { "loop-guard": { mode: "steer", threshold: 4 } },
    });
    expect(readCapabilityParams("loop-guard")).toEqual({
      mode: "steer",
      threshold: 4,
    });
    expect(readCapabilityParams("unknown")).toEqual({});
  });
});

describe("initCapabilities", () => {
  test("无存储环境下也能安装内置能力：tool-budget/两个 reminder 默认开、loop-guard 默认关", async () => {
    await initCapabilities();
    const registry = getCapabilityRegistry();
    expect(registry.lifecycleState()).toBe("ready");
    expect(registry.list().map((item) => item.id).sort()).toEqual([
      "loop-guard",
      "silent-turn-reminder",
      "todo-stale-reminder",
      "tool-budget",
    ]);
    expect(registry.isEnabled("tool-budget")).toBe(true);
    expect(registry.isEnabled("loop-guard")).toBe(false);
    expect(registry.isEnabled("silent-turn-reminder")).toBe(true);
    expect(registry.isEnabled("todo-stale-reminder")).toBe(true);
  });

  test("开关应用后诊断快照可见", async () => {
    await initCapabilities();
    const settings = setCapabilitySettingsForTest({
      enabled: { "tool-budget": false },
      params: {},
    });
    applyCapabilityEnablement(settings);

    const payload = getCapabilitiesPayload();
    expect(payload.lifecycle).toBe("ready");
    expect(payload.items.find((item) => item.id === "tool-budget")?.enabled).toBe(false);
    expect(payload.items.find((item) => item.id === "loop-guard")?.enabled).toBe(false);
  });

  test("显式值压过默认：关掉默认开的 tool-budget 后保持关", async () => {
    await initCapabilities();
    applyCapabilityEnablement(
      setCapabilitySettingsForTest({ enabled: { "tool-budget": false }, params: {} }),
    );
    expect(getCapabilityRegistry().isEnabled("tool-budget")).toBe(false);
  });

  test("全量设置删除 key 后回落各自默认：tool-budget 回开、loop-guard 回关", async () => {
    await initCapabilities();
    applyCapabilityEnablement(
      setCapabilitySettingsForTest({
        enabled: { "tool-budget": false, "loop-guard": true },
        params: {},
      }),
    );
    expect(getCapabilityRegistry().isEnabled("tool-budget")).toBe(false);
    expect(getCapabilityRegistry().isEnabled("loop-guard")).toBe(true);

    applyCapabilityEnablement(setCapabilitySettingsForTest({ enabled: {}, params: {} }));
    expect(getCapabilityRegistry().isEnabled("tool-budget")).toBe(true);
    expect(getCapabilityRegistry().isEnabled("loop-guard")).toBe(false);
  });
});
