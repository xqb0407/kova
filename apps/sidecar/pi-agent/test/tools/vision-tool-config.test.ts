import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyVisionToolConfig,
  DEFAULT_VISION_TOOL_CONFIG,
  getVisionToolConfig,
  initVisionToolConfig,
  normalizeVisionToolConfig,
  resetVisionToolConfigForTest,
} from "../../src/tools/vision-tool-config";
import { initLocalStorage, kvGet, resetStorageForTest } from "../../src/storage/hostdb";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-vision-tool-config-"));

beforeAll(() => {
  // hostdb 本地存储（kv_get/kv_set 落 SQLite）：钉到临时目录，不碰真实应用数据
  initLocalStorage(path.join(tmp, "state.db"));
});

afterAll(() => {
  // bun test 单进程共享模块注册表：清内存态与底层连接，避免污染后续文件
  resetVisionToolConfigForTest();
  resetStorageForTest();
});

describe("normalizeVisionToolConfig", () => {
  test("非法输入回落默认（默认关闭：防提示词污染，需显式开启）", () => {
    expect(normalizeVisionToolConfig(null)).toEqual(DEFAULT_VISION_TOOL_CONFIG);
    expect(normalizeVisionToolConfig(undefined)).toEqual(DEFAULT_VISION_TOOL_CONFIG);
    expect(normalizeVisionToolConfig({})).toEqual(DEFAULT_VISION_TOOL_CONFIG);
    expect(normalizeVisionToolConfig({ enabled: "yes" })).toEqual(DEFAULT_VISION_TOOL_CONFIG);
    expect(normalizeVisionToolConfig({ enabled: 1 })).toEqual(DEFAULT_VISION_TOOL_CONFIG);
    expect(DEFAULT_VISION_TOOL_CONFIG.enabled).toBe(false);
    expect(DEFAULT_VISION_TOOL_CONFIG.provider).toBe("");
    expect(DEFAULT_VISION_TOOL_CONFIG.modelId).toBe("");
  });

  test("开启 + 显式模型：字符串去空白后保留", () => {
    expect(
      normalizeVisionToolConfig({ enabled: true, provider: " openai ", modelId: " gpt-4o " }),
    ).toEqual({ enabled: true, provider: "openai", modelId: "gpt-4o" });
  });

  test("模型成对才保留：缺 modelId/provider 按自动挑选存空串", () => {
    expect(normalizeVisionToolConfig({ enabled: true, provider: "p" })).toEqual({
      enabled: true,
      provider: "",
      modelId: "",
    });
    expect(normalizeVisionToolConfig({ enabled: true, modelId: "m" })).toEqual({
      enabled: true,
      provider: "",
      modelId: "",
    });
  });

  test("模型选择独立于开关：关闭时不清空（关掉再开不丢选择）", () => {
    expect(
      normalizeVisionToolConfig({ enabled: false, provider: "p", modelId: "m" }),
    ).toEqual({ enabled: false, provider: "p", modelId: "m" });
  });
});

describe("配置存取（kv 往返）", () => {
  test("applyVisionToolConfig 落 kv，initVisionToolConfig 从 kv 恢复", async () => {
    await applyVisionToolConfig({ enabled: true, provider: "p", modelId: "m" });
    expect(getVisionToolConfig()).toEqual({
      enabled: true,
      provider: "p",
      modelId: "m",
    });
    const persisted = JSON.parse((await kvGet("pi.visionTool"))!.value);
    expect(persisted).toEqual({ enabled: true, provider: "p", modelId: "m" });

    // 模拟重启：内存态清零后从 kv 恢复
    resetVisionToolConfigForTest();
    await initVisionToolConfig();
    expect(getVisionToolConfig()).toEqual({
      enabled: true,
      provider: "p",
      modelId: "m",
    });

    // 关闭同样落库生效，且保留模型选择
    await applyVisionToolConfig({ enabled: false, provider: "p", modelId: "m" });
    resetVisionToolConfigForTest();
    await initVisionToolConfig();
    expect(getVisionToolConfig()).toEqual({
      enabled: false,
      provider: "p",
      modelId: "m",
    });
  });

  test("持久化失败不阻断：内存态即时生效（kv 故障仅记日志）", async () => {
    // 非法 key 触发底层报错路径：apply 仍返回规整后的配置
    resetVisionToolConfigForTest();
    const applied = await applyVisionToolConfig({ enabled: true });
    expect(applied.enabled).toBe(true);
    expect(getVisionToolConfig().enabled).toBe(true);
    resetVisionToolConfigForTest();
  });
});
