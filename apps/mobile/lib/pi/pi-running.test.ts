/**
 * 会话运行集合（种子 ⊕ 增量）单测：这是"后台跑起来的会话在列表里亮起来"的唯一来源，
 * 合并规则错一次就是行状态骗人——种子项被收尾事件清掉、迟到事件又能补上。
 */
import { beforeEach, describe, expect, test } from "vitest";
import { setPiChannel, type PiChannel } from "./pi-channel";
import {
  __resetPiRunningForTests,
  isSessionRunning,
  resyncPiRunning,
  startPiRunningWatch,
} from "./pi-running";

/** 假通道：只有运行集合需要的三个能力（listRunning / subscribeTurns / status） */
function fakeChannel(initialRunning: string[] = []) {
  const turnCbs = new Set<(id: string | null, active: boolean) => void>();
  let running = [...initialRunning];
  let listCalls = 0;
  const channel = {
    kind: "ws",
    async request() {
      throw new Error("not used");
    },
    async listRunning() {
      listCalls += 1;
      return [...running];
    },
    subscribeTurns(cb: (id: string | null, active: boolean) => void) {
      turnCbs.add(cb);
      return () => turnCbs.delete(cb);
    },
  } as unknown as PiChannel;
  return {
    channel,
    // 种子里"服务端事实源"的变化（下一次 listRunning 返回它）
    setRunning: (ids: string[]) => {
      running = [...ids];
    },
    emit: (id: string | null, active: boolean) => {
      for (const cb of turnCbs) cb(id, active);
    },
    listeners: turnCbs.size,
    listCalls: () => listCalls,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("会话运行集合", () => {
  beforeEach(() => {
    __resetPiRunningForTests();
    setPiChannel(null);
  });

  test("种子 + 起止增量：新起即亮、收尾即灭，其它会话不受影响", async () => {
    const fake = fakeChannel(["s-a"]);
    setPiChannel(fake.channel);
    startPiRunningWatch();
    await flush();
    expect(isSessionRunning("s-a")).toBe(true);
    expect(isSessionRunning("s-b")).toBe(false);

    fake.emit("s-b", true);
    expect(isSessionRunning("s-b")).toBe(true);
    fake.emit("s-a", false);
    expect(isSessionRunning("s-a")).toBe(false);

    // 收尾幂等：重复 end 不改变投影（也不会 notify 抖动）
    fake.emit("s-a", false);
    expect(isSessionRunning("s-a")).toBe(false);
  });

  test("事件源失效（null）清空并重新水合：种子里的在跑项回来，陈旧增量被纠偏", async () => {
    const fake = fakeChannel(["s-a"]);
    setPiChannel(fake.channel);
    startPiRunningWatch();
    await flush();

    // 孤立 start（end 丢了）先亮起来，随后事件源失效提示要重来
    fake.emit("s-ghost", true);
    expect(isSessionRunning("s-ghost")).toBe(true);
    const callsBefore = fake.listCalls();
    fake.setRunning(["s-a", "s-b"]);
    fake.emit(null, false);
    await flush();

    expect(fake.listCalls()).toBeGreaterThan(callsBefore); // 确实重拉了一次种子
    expect(isSessionRunning("s-ghost")).toBe(false); // 陈旧增量被清
    expect(isSessionRunning("s-b")).toBe(true); // 种子里的新项在
  });

  test("resync 的种子是权威：种子说没在跑，就清掉陈旧增量（end 帧丢了的纠偏）", async () => {
    const fake = fakeChannel([]);
    setPiChannel(fake.channel);
    startPiRunningWatch();
    await flush();
    // 先收到 start（此时种子为空但还没重拉：行上亮着）
    fake.emit("s-live", true);
    expect(isSessionRunning("s-live")).toBe(true);

    // 重拉种子：sidecar 的 stdout 全序保证响应晚于那次 start 写出，
    // 不在响应里 = 它已经收尾（end 帧丢了）→ 必须清掉，否则行上永远转着
    resyncPiRunning();
    await flush();
    expect(isSessionRunning("s-live")).toBe(false);

    // 种子带回来的在跑项照常亮
    fake.setRunning(["s-live"]);
    resyncPiRunning();
    await flush();
    expect(isSessionRunning("s-live")).toBe(true);
  });
});
