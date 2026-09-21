import { describe, expect, mock, test } from "bun:test";

/**
 * 前端镜像 store 的写世代 guard 回归：
 * 运行帧/事件触发的 refreshAutomations 与用户暂停操作竞速时，先出单后应答的
 * 陈旧清单不得覆盖已落盘的写结果（曾致暂停开关回弹）。
 * 桩掉 pi-bridge（手动控制应答顺序）与 tauri/事件通道（模块求值依赖）。
 */

type Deferred = {
  promise: Promise<unknown>;
  resolve: (v: unknown) => void;
};
function deferred(): Deferred {
  let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>((r) => (resolve = r));
  return { promise, resolve };
}

type Sent = { payload: Record<string, unknown>; d: Deferred };
const sent: Sent[] = [];

mock.module("@/lib/pi/pi-bridge", () => ({
  piRequest: (payload: Record<string, unknown>) => {
    const d = deferred();
    sent.push({ payload, d });
    return d.promise;
  },
}));
mock.module("@/lib/pi/agent-events", () => ({
  subscribeAgentEvents: (_cb: unknown) => () => {},
}));
mock.module("@tauri-apps/api/core", () => ({
  invoke: () => Promise.resolve(),
}));

const { refreshAutomations, setAutomationEnabled, getAutomationsSnapshot } =
  await import("@/lib/automation/automations");

const listResp = (enabled: boolean) => ({
  type: "automations",
  tasks: [
    {
      id: "t1",
      name: "晨报",
      prompt: "p",
      type: "interval",
      schedule: "3600000",
      enabled,
      model: { provider: "x", model: "y" },
      toolPolicyProfile: "read-only",
    },
  ],
});

function settle() {
  // 让 promise 微任务链（await piRequest 之后的 emit）跑完
  return new Promise((r) => setTimeout(r, 0));
}

describe("automations store 写世代 guard", () => {
  test("写之后晚到的陈旧刷新应答被丢弃（暂停不回弹）", async () => {
    void refreshAutomations(); // seq 1：初始装载
    sent[0].d.resolve(listResp(true));
    await settle();
    expect(getAutomationsSnapshot().tasks[0]?.enabled).toBe(true);

    void refreshAutomations(); // seq 2：运行帧触发的慢刷新（快照在写之前取）
    const slowRefresh = sent[1];
    void setAutomationEnabled("t1", false); // seq 3：用户暂停（写）
    const write = sent[2];
    write.d.resolve(listResp(false));
    await settle();
    expect(getAutomationsSnapshot().tasks[0]?.enabled).toBe(false);

    slowRefresh.d.resolve(listResp(true)); // 陈旧清单晚到
    await settle();
    expect(getAutomationsSnapshot().tasks[0]?.enabled).toBe(false);
    expect(getAutomationsSnapshot().error).toBeNull();
  });

  test("写之后新发单的正常刷新仍然生效", async () => {
    void refreshAutomations(); // seq 4：晚于上一切写世代的刷新
    sent[3].d.resolve(listResp(true));
    await settle();
    expect(getAutomationsSnapshot().tasks[0]?.enabled).toBe(true);
  });
});
