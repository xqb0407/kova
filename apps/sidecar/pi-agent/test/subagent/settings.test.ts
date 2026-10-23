import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initLocalStorage, kvGet } from "../../src/storage/hostdb";
import {
  SUBAGENT_SETTINGS_KV_KEY,
  getSubagentMaxConcurrency,
  initSubagentSettings,
  normalizeSubagentMaxConcurrency,
  resetSubagentSettingsForTest,
  setSubagentMaxConcurrency,
} from "../../src/subagent/settings";
import {
  SUBAGENT_MAX_CONCURRENCY_DEFAULT,
  SUBAGENT_MAX_CONCURRENCY_MAX,
  SUBAGENT_MAX_CONCURRENCY_MIN,
} from "pi-protocol";
import { subagentConcurrencyState } from "../../src/subagent/tools";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-subagent-settings-"));
initLocalStorage(path.join(tmp, "state.db"));

beforeEach(() => {
  resetSubagentSettingsForTest();
});

describe("normalizeSubagentMaxConcurrency", () => {
  test("非法值回落默认", () => {
    expect(normalizeSubagentMaxConcurrency(undefined)).toBe(SUBAGENT_MAX_CONCURRENCY_DEFAULT);
    expect(normalizeSubagentMaxConcurrency("")).toBe(SUBAGENT_MAX_CONCURRENCY_DEFAULT);
    expect(normalizeSubagentMaxConcurrency("abc")).toBe(SUBAGENT_MAX_CONCURRENCY_DEFAULT);
    expect(normalizeSubagentMaxConcurrency(Number.NaN)).toBe(SUBAGENT_MAX_CONCURRENCY_DEFAULT);
  });

  test("按共享值域钳制并取整", () => {
    expect(normalizeSubagentMaxConcurrency(0)).toBe(SUBAGENT_MAX_CONCURRENCY_MIN);
    expect(normalizeSubagentMaxConcurrency(99)).toBe(SUBAGENT_MAX_CONCURRENCY_MAX);
    expect(normalizeSubagentMaxConcurrency(5.6)).toBe(6);
    expect(normalizeSubagentMaxConcurrency("7")).toBe(7);
  });
});

describe("set/get/init", () => {
  test("保存后内存即时生效并落 kv", async () => {
    expect(getSubagentMaxConcurrency()).toBe(SUBAGENT_MAX_CONCURRENCY_DEFAULT);
    const saved = await setSubagentMaxConcurrency(5);
    expect(saved).toBe(5);
    expect(getSubagentMaxConcurrency()).toBe(5);
    expect(JSON.parse((await kvGet(SUBAGENT_SETTINGS_KV_KEY))!.value)).toBe(5);
  });

  test("启动恢复读回 kv；清内存后重新 init 仍拿到保存值", async () => {
    await setSubagentMaxConcurrency(3);
    resetSubagentSettingsForTest();
    expect(getSubagentMaxConcurrency()).toBe(SUBAGENT_MAX_CONCURRENCY_DEFAULT);
    await initSubagentSettings();
    expect(getSubagentMaxConcurrency()).toBe(3);
  });

  test("Task/resume 的并发状态读取运行时上限，并用实际运行数判定", async () => {
    const run = {
      delegations: new Map<string, { status: string }>(),
    } as unknown as Parameters<typeof subagentConcurrencyState>[0];
    for (let i = 0; i < 3; i += 1) {
      run.delegations.set(`d${i}`, { status: "running" } as never);
    }
    await setSubagentMaxConcurrency(3);
    expect(subagentConcurrencyState(run)).toEqual({
      running: 3,
      limit: 3,
      reached: true,
    });
    await setSubagentMaxConcurrency(4);
    expect(subagentConcurrencyState(run)).toEqual({
      running: 3,
      limit: 4,
      reached: false,
    });
  });
});
