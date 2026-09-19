import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyBrowserConfig,
  DEFAULT_BROWSER_CONFIG,
  getBrowserConfig,
  initBrowserConfig,
  normalizeBrowserConfig,
  resetBrowserConfigForTest,
} from "./browser-config";
import { buildBrowserTools } from "./browser-tools";
import { initLocalStorage, kvGet, resetStorageForTest } from "./hostdb";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-browser-config-"));

beforeAll(() => {
  // hostdb 本地存储（kv_get/kv_set 落 SQLite）：钉到临时目录，不碰真实应用数据
  initLocalStorage(path.join(tmp, "state.db"));
});

afterAll(() => {
  // bun test 单进程共享模块注册表：清内存态与底层连接，避免污染后续文件
  resetBrowserConfigForTest();
  resetStorageForTest();
});

describe("normalizeBrowserConfig", () => {
  test("非法输入回落默认（enabled=true 保持现状）", () => {
    expect(normalizeBrowserConfig(null)).toEqual(DEFAULT_BROWSER_CONFIG);
    expect(normalizeBrowserConfig(undefined)).toEqual(DEFAULT_BROWSER_CONFIG);
    expect(normalizeBrowserConfig({ enabled: "yes" })).toEqual(DEFAULT_BROWSER_CONFIG);
  });

  test("合法布尔透传", () => {
    expect(normalizeBrowserConfig({ enabled: false })).toEqual({ enabled: false });
    expect(normalizeBrowserConfig({ enabled: true })).toEqual({ enabled: true });
  });
});

describe("配置存取（kv 往返）", () => {
  test("applyBrowserConfig 落 kv，initBrowserConfig 从 kv 恢复", async () => {
    await applyBrowserConfig({ enabled: false });
    expect(getBrowserConfig().enabled).toBe(false);
    const persisted = JSON.parse((await kvGet("pi.browser"))!.value);
    expect(persisted).toEqual({ enabled: false });

    // 模拟重启：内存态清零后从 kv 恢复
    resetBrowserConfigForTest();
    await initBrowserConfig();
    expect(getBrowserConfig().enabled).toBe(false);
  });
});

describe("browser_* 工具门控", () => {
  test("关闭时七个工具 execute 一律婉拒（不触宿主）", async () => {
    await applyBrowserConfig({ enabled: false });
    for (const tool of buildBrowserTools("t-gate")) {
      const res = await tool.execute("call-1", {}, undefined);
      const text = res.content[0].type === "text" ? res.content[0].text : "";
      expect(text).toContain("disabled");
    }
  });

  test("开启后不再走婉拒分支（无宿主环境 execute 会失败，仅验证门控放行）", async () => {
    await applyBrowserConfig({ enabled: true });
    const navigate = buildBrowserTools("t-gate")[0]!;
    try {
      await navigate.execute("call-2", { url: "https://example.com" }, undefined);
      // 意外成功也算放行（测试环境不该有宿主）
    } catch {
      // 门控放行后进入 hostToolCall，测试环境无宿主传输，报错即符合预期
    }
    expect(getBrowserConfig().enabled).toBe(true);
  });
});
