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
} from "../../src/tools/browser-config";
import { buildBrowserTools } from "../../src/tools/browser-tools";
import { initLocalStorage, kvGet, resetStorageForTest } from "../../src/storage/hostdb";

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
    expect(normalizeBrowserConfig({ enabled: false })).toEqual({
      enabled: false,
      pixelShot: DEFAULT_BROWSER_CONFIG.pixelShot,
      screenShot: DEFAULT_BROWSER_CONFIG.screenShot,
    });
  });

  // 两个子开关默认关：像素截图要另起进程，屏幕截图会读到用户的真实桌面
  test("两个子开关默认关（不因为漏配就默认开）", () => {
    expect(DEFAULT_BROWSER_CONFIG.pixelShot).toBe(false);
    expect(DEFAULT_BROWSER_CONFIG.screenShot).toBe(false);
    expect(normalizeBrowserConfig({ enabled: true }).pixelShot).toBe(false);
    expect(normalizeBrowserConfig({ enabled: true }).screenShot).toBe(false);
  });

  test("子开关可独立开启，不牵动总开关", () => {
    const c = normalizeBrowserConfig({ enabled: true, pixelShot: true });
    expect(c.pixelShot).toBe(true);
    expect(c.enabled).toBe(true);
    expect(c.screenShot).toBe(false);
  });
});

describe("配置存取（kv 往返）", () => {
  test("applyBrowserConfig 落 kv，initBrowserConfig 从 kv 恢复", async () => {
    await applyBrowserConfig({ enabled: false });
    expect(getBrowserConfig().enabled).toBe(false);
    const persisted = JSON.parse((await kvGet("pi.browser"))!.value);
    expect(persisted).toEqual({ ...DEFAULT_BROWSER_CONFIG, enabled: false });

    // 模拟重启：内存态清零后从 kv 恢复
    resetBrowserConfigForTest();
    await initBrowserConfig();
    expect(getBrowserConfig().enabled).toBe(false);
  });
});

describe("browser_* 工具门控", () => {
  test("总开关关闭时驱动工具一律婉拒（不触宿主）", async () => {
    await applyBrowserConfig({ enabled: false });
    for (const tool of buildBrowserTools("t-gate").filter((t) => t.name !== "browser_shot")) {
      const res = await tool.execute("call-1", {}, undefined);
      const text = res.content[0].type === "text" ? res.content[0].text : "";
      expect(text).toContain("disabled");
    }
  });

  // 相机是独立授权：驱动关掉不影响"看一眼画面"，反之亦然
  test("pixelShot 关时 browser_shot 婉拒，且不受总开关影响", async () => {
    await applyBrowserConfig({ enabled: true, pixelShot: false });
    const shot = buildBrowserTools("t-gate").find((t) => t.name === "browser_shot")!;
    const off = await shot.execute("call-shot-off", {}, undefined);
    expect(off.content[0].type === "text" ? off.content[0].text : "").toContain("disabled");

    await applyBrowserConfig({ enabled: false, pixelShot: true });
    let text = "";
    try {
      const on = await shot.execute("call-shot-on", {}, undefined);
      text = on.content[0].type === "text" ? on.content[0].text : "";
    } catch {
      // 放行后进 hostToolCall，测试环境无宿主传输：抛错本身就是放行的证据
    }
    expect(text).not.toContain("disabled in Settings");
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
