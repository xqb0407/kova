import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyImageGenConfig,
  DEFAULT_IMAGEGEN_CONFIG,
  getImageGenConfig,
  initImageGenConfig,
  normalizeImageGenConfig,
  resetImageGenConfigForTest,
} from "../../src/tools/imagegen-config";
import { initLocalStorage, kvGet, resetStorageForTest } from "../../src/storage/hostdb";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-imagegen-config-"));

beforeAll(() => {
  // hostdb 本地存储（kv_get/kv_set 落 SQLite）：钉到临时目录，不碰真实应用数据
  initLocalStorage(path.join(tmp, "state.db"));
});

afterAll(() => {
  // bun test 单进程共享模块注册表：清内存态与底层连接，避免污染后续文件
  resetImageGenConfigForTest();
  resetStorageForTest();
});

describe("normalizeImageGenConfig", () => {
  test("非法输入回落默认（默认关闭：生图按张计费需显式开启）", () => {
    expect(normalizeImageGenConfig(null)).toEqual(DEFAULT_IMAGEGEN_CONFIG);
    expect(normalizeImageGenConfig({ enabled: "yes" })).toEqual(DEFAULT_IMAGEGEN_CONFIG);
    expect(DEFAULT_IMAGEGEN_CONFIG.enabled).toBe(false);
  });

  test("字符串去空白；空 size 回落默认", () => {
    expect(
      normalizeImageGenConfig({
        enabled: true,
        provider: " gw ",
        modelId: " gpt-image-1 ",
        size: "  ",
      }),
    ).toEqual({
      enabled: true,
      provider: "gw",
      modelId: "gpt-image-1",
      size: "1024x1024",
      imageModels: [],
    });
  });

  test("imageModels 去空白去重丢空项；非数组回落空清单", () => {
    expect(
      normalizeImageGenConfig({
        imageModels: [" gw/gpt-image-1 ", "gw/gpt-image-1", "", "  ", "p/m"],
      }).imageModels,
    ).toEqual(["gw/gpt-image-1", "p/m"]);
    expect(normalizeImageGenConfig({ imageModels: "no" }).imageModels).toEqual([]);
  });
});

describe("配置存取（kv 往返）", () => {
  test("applyImageGenConfig 落 kv，initImageGenConfig 从 kv 恢复", async () => {
    await applyImageGenConfig({
      enabled: true,
      provider: "p",
      modelId: "m",
      size: "auto",
      imageModels: ["p/m"],
    });
    expect(getImageGenConfig().provider).toBe("p");
    const persisted = JSON.parse((await kvGet("pi.imagegen"))!.value);
    expect(persisted).toEqual({
      enabled: true,
      provider: "p",
      modelId: "m",
      size: "auto",
      imageModels: ["p/m"],
    });

    // 模拟重启：内存态清零后从 kv 恢复
    resetImageGenConfigForTest();
    await initImageGenConfig();
    expect(getImageGenConfig()).toEqual({
      enabled: true,
      provider: "p",
      modelId: "m",
      size: "auto",
      imageModels: ["p/m"],
    });
  });
});
