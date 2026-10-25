import { afterEach, describe, expect, test } from "bun:test";
import { running } from "../../src/sessions/registry";
import { reloadCapabilityTools } from "../../src/sessions/resolve";
import type { Running } from "../../src/types";

/**
 * reloadRunTools 逐 run 隔离：设置已持久化的前提下，一个 run 重建失败不能
 * 阻断其余 run（否则 set_capabilities 留下「重启才自愈」的半生效状态）。
 * 毒化手法：run.agent 缺失会让 rebuildRunTools 在 composeRunPrompt 处抛错，
 * 而前面几步（能力装配/子代理定义）都容忍 agent 缺席。
 */
function stubRun(
  threadId: string,
  sessionId: string,
  withAgent: boolean,
): Running {
  return {
    threadId,
    sessionId,
    cwd: "/tmp/kova-reload-run-tools",
    mode: "agent",
    appMode: "code",
    approvalLevel: "ask",
    agent: withAgent
      ? ({
          state: { model: null, messages: [], tools: [] },
        } as unknown as Running["agent"])
      : (undefined as unknown as Running["agent"]),
    baseTools: [],
    subagentTools: [],
  } as unknown as Running;
}

const THREADS = ["reload-broken", "reload-ok"];

afterEach(() => {
  for (const threadId of THREADS) running.delete(threadId);
});

describe("reloadRunTools 逐 run 隔离", () => {
  test("坏 run 只进 failures，好 run 照常重建", async () => {
    const broken = stubRun("reload-broken", "sess-broken", false);
    const healthy = stubRun("reload-ok", "sess-ok", true);
    // 故意把坏 run 放前面：证明失败不阻断后续
    running.set("reload-broken", broken);
    running.set("reload-ok", healthy);

    const failures = await reloadCapabilityTools();

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ threadId: "reload-broken", sessionId: "sess-broken" });
    expect(typeof failures[0]!.message).toBe("string");
    // 好 run 完成整组重建：baseTools 非空且系统头已写入
    expect(healthy.baseTools.length).toBeGreaterThan(0);
    expect(
      (healthy.agent.state.messages[0] as { role?: string }).role,
    ).toBe("system");
  });

  test("没有失败时返回空数组", async () => {
    running.set("reload-ok", stubRun("reload-ok", "sess-ok", true));
    const failures = await reloadCapabilityTools();
    expect(failures).toEqual([]);
  });
});
