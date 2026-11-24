import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fireSessionStartHook, runStopHooks } from "../../src/protocol/prompt-pipeline";
import {
  resetHooksForTest,
  setHookConfigs,
  setHooksExecutorForTest,
  type HookPayload,
} from "../../src/agent/hooks";
import { initLocalStorage } from "../../src/storage/hostdb";
import type { Running } from "../../src/types";

/**
 * 生命周期钩子的回合边界：
 * - SessionStart 只在首个真实用户回合消费一次（管理类物化不触发），
 *   additionalContext 作为本轮隐藏提醒注入；
 * - Stop 在整轮回复收尾时执行，block 表示钩子要求继续，用户主动 Stop 不触发。
 * 触发点收敛在 prompt-pipeline，避免 resolveSession / agent_end / turn_end
 * 的多次触发回归。
 */

const fakeRun = (over: Partial<Running> = {}): Running =>
  ({
    sessionId: "s-stop",
    threadId: "t-stop",
    cwd: ".",
    stopRequested: false,
    ...over,
  }) as unknown as Running;

// setHookConfigs 先落 kv 再提交内存：测试需要可用的本地存储
const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-turn-hooks-"));
beforeAll(() => initLocalStorage(path.join(tmp, "state.db")));

const stopHook = {
  id: "stop",
  name: "stop",
  command: "true",
  event: "Stop" as const,
  enabled: true,
};

const sessionStartHook = {
  id: "session-start",
  name: "session-start",
  command: "true",
  event: "SessionStart" as const,
  enabled: true,
};

describe("SessionStart 钩子：首个真实回合", () => {
  afterEach(() => resetHooksForTest());

  test("resume 来源只消费一次，负载带 source/cwd", async () => {
    const seen: HookPayload[] = [];
    await setHookConfigs([sessionStartHook]);
    setHooksExecutorForTest(async (_hook, payload) => {
      seen.push(payload);
      return undefined;
    });
    const run = fakeRun({ sessionStartSource: "resume" });

    expect(await fireSessionStartHook(run)).toBeUndefined();
    expect(await fireSessionStartHook(run)).toBeUndefined(); // 第二个用户回合不应重复触发

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      event: "SessionStart",
      source: "resume",
      sessionId: "s-stop",
      threadId: "t-stop",
      cwd: ".",
    });
    expect(run.sessionStartSource).toBeUndefined();
  });

  test("additionalContext 合并后返回，供本轮隐藏提醒注入", async () => {
    await setHookConfigs([sessionStartHook]);
    setHooksExecutorForTest(async () => ({
      decision: "approve",
      context: "project uses pnpm",
    }));

    expect(await fireSessionStartHook(fakeRun({ sessionStartSource: "create" }))).toBe(
      "project uses pnpm",
    );
  });

  test("没有待消费来源（管理类物化）不触发", async () => {
    let calls = 0;
    await setHookConfigs([sessionStartHook]);
    setHooksExecutorForTest(async () => {
      calls += 1;
      return undefined;
    });

    expect(await fireSessionStartHook(fakeRun())).toBeUndefined();

    expect(calls).toBe(0);
  });
});

describe("Stop 钩子：整轮收尾", () => {
  afterEach(() => resetHooksForTest());

  test("正常收尾执行一次，负载带会话/线程/工作区", async () => {
    const seen: HookPayload[] = [];
    await setHookConfigs([stopHook]);
    setHooksExecutorForTest(async (_hook, payload) => {
      seen.push(payload);
      return undefined;
    });

    expect(await runStopHooks(fakeRun())).toBeUndefined();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      event: "Stop",
      sessionId: "s-stop",
      threadId: "t-stop",
      cwd: ".",
    });
  });

  test("block 返回给调用方用于续跑", async () => {
    await setHookConfigs([stopHook]);
    setHooksExecutorForTest(async () => ({
      decision: "block",
      reason: "tests not run yet",
    }));

    expect(await runStopHooks(fakeRun())).toEqual({
      decision: "block",
      reason: "tests not run yet",
    });
  });

  test("用户主动 Stop 不触发", async () => {
    let calls = 0;
    await setHookConfigs([stopHook]);
    setHooksExecutorForTest(async () => {
      calls += 1;
      return undefined;
    });

    expect(await runStopHooks(fakeRun({ stopRequested: true }))).toBeUndefined();

    expect(calls).toBe(0);
  });
});
