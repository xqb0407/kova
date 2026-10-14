import { afterAll, describe, expect, test } from "bun:test";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";
import type { PluginEntry } from "@/lib/plugins/plugins";

/**
 * 设计模式门禁（design-mode-gate）单测：mock 插件 store 的镜像与动作，
 * 验证四态探测（ready/disabled/missing/unreachable）、市场目录安装源发现
 * （含 needsRefresh 目录先刷一轮）、启用与安装动作的落库语义。
 * 弹窗编排（useEnsureUiDesignPlugin）是纯 UI 状态机，不在本文件覆盖。
 */

/** 门禁只读 name/enabled/pluginId，余字段 cast 补全为合法 PluginEntry */
const mkPlug = (name: string, enabled: boolean, pluginId: string): PluginEntry =>
  ({ name, enabled, pluginId }) as PluginEntry;

type Mkt = { id: string; name: string; needsRefresh: boolean; plugins: { name: string }[] };

let installed: PluginEntry[] = [];
let marketplaces: Mkt[] = [];
let snapshotError: string | null = null;
/** 下一次 waitForPluginOp 结算时的副作用（模拟结果帧回流刷新镜像） */
let opSettle: (() => void) | null = null;

mockModule("@/lib/plugins/plugins", () => ({
  getPluginsSnapshot: () => ({
    loading: false,
    error: snapshotError,
    plugins: installed,
    workspaceCwd: "/ws",
  }),
  getMarketplacesSnapshot: () => ({ loading: false, error: null, marketplaces }),
  refreshPlugins: async () => {},
  refreshMarketplaces: async () => {},
  setPluginEnabled: async (pluginId: string, enabled: boolean) => {
    installed = installed.map((p) => (p.pluginId === pluginId ? { ...p, enabled } : p));
  },
  refreshMarketplace: async () => "op-refresh",
  installPlugin: async (_mktId: string, name: string) => `op-install-${name}`,
  waitForPluginOp: async () => {
    opSettle?.();
    return { ok: true };
  },
}));

mockModule("@/lib/workspace/workspace-store", () => ({
  getWorkspace: () => "/ws",
}));

afterAll(() => restoreAllMocks());

const {
  probeUiDesignGate,
  enableUiDesignPlugin,
  installUiDesignPlugin,
} = await import("@/lib/pi/design-mode-gate");

function reset() {
  installed = [];
  marketplaces = [];
  snapshotError = null;
  opSettle = null;
}

describe("probeUiDesignGate", () => {
  test("已装已启用 → ready", async () => {
    reset();
    installed = [mkPlug("ui-design", true, "ui-design@local")];
    const state = await probeUiDesignGate();
    expect(state.kind).toBe("ready");
  });

  test("已装被禁用 → disabled（带条目）", async () => {
    reset();
    installed = [mkPlug("ui-design", false, "ui-design@local")];
    const state = await probeUiDesignGate();
    expect(state.kind).toBe("disabled");
    if (state.kind === "disabled") expect(state.entry.pluginId).toBe("ui-design@local");
  });

  test("未装且市场有目录 → missing + 安装源", async () => {
    reset();
    marketplaces = [{ id: "m1", name: "M1", needsRefresh: false, plugins: [{ name: "ui-design" }] }];
    const state = await probeUiDesignGate();
    expect(state.kind).toBe("missing");
    if (state.kind === "missing") expect(state.installMarketplaceId).toBe("m1");
  });

  test("未装且无任何来源 → missing + null", async () => {
    reset();
    marketplaces = [{ id: "m1", name: "M1", needsRefresh: false, plugins: [{ name: "other" }] }];
    const state = await probeUiDesignGate();
    expect(state.kind).toBe("missing");
    if (state.kind === "missing") expect(state.installMarketplaceId).toBeNull();
  });

  test("needsRefresh 空目录先刷一轮再找（刷新即现身）", async () => {
    reset();
    marketplaces = [{ id: "m1", name: "M1", needsRefresh: true, plugins: [] }];
    opSettle = () => {
      marketplaces = [{ id: "m1", name: "M1", needsRefresh: false, plugins: [{ name: "ui-design" }] }];
    };
    const state = await probeUiDesignGate();
    expect(state.kind).toBe("missing");
    if (state.kind === "missing") expect(state.installMarketplaceId).toBe("m1");
  });

  test("清单拉取失败（快照 error 且空清单）→ unreachable", async () => {
    reset();
    snapshotError = "sidecar offline";
    const state = await probeUiDesignGate();
    expect(state.kind).toBe("unreachable");
  });
});

describe("enableUiDesignPlugin / installUiDesignPlugin", () => {
  test("启用翻转条目 enabled", async () => {
    reset();
    installed = [mkPlug("ui-design", false, "ui-design@local")];
    await enableUiDesignPlugin(installed[0]!);
    expect(installed[0]!.enabled).toBe(true);
  });

  test("安装走受理+等待结果帧，成功后镜像含插件", async () => {
    reset();
    opSettle = () => {
      installed = [mkPlug("ui-design", true, "ui-design@m1")];
    };
    const result = await installUiDesignPlugin("m1");
    expect(result.ok).toBe(true);
    const state = await probeUiDesignGate();
    expect(state.kind).toBe("ready");
  });
});
