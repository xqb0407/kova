import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyObservabilityConfig,
  DEFAULT_OBSERVABILITY_CONFIG,
  getObservabilityConfig,
  initObservability,
  normalizeObservabilityConfig,
  resetObservabilityConfigForTest,
} from "../../src/observability/observability";
import { initLocalStorage, resetStorageForTest } from "../../src/storage/hostdb";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-observability-"));

beforeAll(() => {
  // hostdb 本地存储（kv_get/kv_set 落 SQLite）：钉到临时目录，不碰真实应用数据
  initLocalStorage(path.join(tmp, "state.db"));
});

afterAll(() => {
  // bun test 单进程共享模块注册表：清内存态与底层连接，避免污染后续文件
  resetObservabilityConfigForTest();
  resetStorageForTest();
});

describe("normalizeObservabilityConfig", () => {
  test("非法输入回落默认（enabled=false / endpoint 空 / sampleRate=1 / 脱敏开）", () => {
    expect(normalizeObservabilityConfig(null)).toEqual(DEFAULT_OBSERVABILITY_CONFIG);
    expect(normalizeObservabilityConfig(undefined)).toEqual(DEFAULT_OBSERVABILITY_CONFIG);
    expect(normalizeObservabilityConfig("junk")).toEqual(DEFAULT_OBSERVABILITY_CONFIG);
  });

  test("合法字段透传、endpoint 去空白、sampleRate 钳到 0~1", () => {
    expect(
      normalizeObservabilityConfig({
        enabled: true,
        endpoint: "  https://cloud.langfuse.com/api/public/otel/v1/traces  ",
        sampleRate: 1.7,
        redactContent: false,
        headers: { Authorization: "Basic abc" },
      }),
    ).toEqual({
      enabled: true,
      endpoint: "https://cloud.langfuse.com/api/public/otel/v1/traces",
      sampleRate: 1,
      redactContent: false,
      headers: { Authorization: "Basic abc" },
    });
  });

  test("headers 只收字符串键值，非字符串值丢弃", () => {
    expect(
      normalizeObservabilityConfig({
        headers: { ok: "1", bad: 42, "": "empty-key", "x-a": true },
      }).headers,
    ).toEqual({ ok: "1" });
  });
});

describe("applyObservabilityConfig（kv 持久化 + 内存生效）", () => {
  test("apply 后 get 返回新配置，init 可从 kv 恢复", async () => {
    const applied = await applyObservabilityConfig({
      enabled: true,
      endpoint: "https://example.com/otel/v1/traces",
      headers: { Authorization: "Basic pk:sk" },
      sampleRate: 0.5,
    });
    expect(applied.enabled).toBe(true);
    expect(getObservabilityConfig().endpoint).toContain("example.com");

    // 模拟重启：清内存后 init 恢复
    resetObservabilityConfigForTest();
    expect(getObservabilityConfig().enabled).toBe(false);
    await initObservability();
    expect(getObservabilityConfig().enabled).toBe(true);
    expect(getObservabilityConfig().sampleRate).toBe(0.5);
    expect(getObservabilityConfig().headers.Authorization).toBe("Basic pk:sk");
  });
});
