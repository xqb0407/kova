import { afterAll, describe, expect, test } from "bun:test";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

/**
 * stopBgTask（快速查看「停止」按钮 → stop_bg_task 协议命令）的请求形态与
 * 错误透传：sidecar 的错误应答经 piRequest reject，文案原样交给 UI toast。
 * 帧通道 mock 掉（pi-bridge），线程键归一桩成恒等（本命令不依赖键归一）。
 */

type Req = Record<string, unknown>;

let calls: Req[] = [];
let timeouts: unknown[] = [];
let respondError: Error | null = null;

mockModule("@/lib/pi/pi-bridge", () => ({
  piRequest: (payload: Req, timeoutMs?: number) => {
    calls.push(payload);
    timeouts.push(timeoutMs);
    if (respondError) return Promise.reject(respondError);
    return Promise.resolve({ type: "bg_task_stop_result", ok: true });
  },
}));
mockModule("@/lib/pi/pi-thread-adapter", () => ({
  piSessionIdForThread: (threadId: string) => threadId,
}));

afterAll(() => {
  restoreAllMocks();
});

const { stopBgTask } = await import("@/lib/pi/pi-bg-tasks");

describe("stopBgTask（快速查看停止按钮）", () => {
  test("发 stop_bg_task 帧，带 threadId 与 taskId，显式 8s 预算", async () => {
    calls = [];
    timeouts = [];
    respondError = null;
    await stopBgTask("sess-bg-stop", 9);
    expect(calls).toEqual([{ type: "stop_bg_task", threadId: "sess-bg-stop", taskId: 9 }]);
    // 覆盖 sidecar 侧宿主 task_stop 的 5s 上限 + 余量（见 pi-bg-tasks.ts 注释）
    expect(timeouts).toEqual([8_000]);
  });

  test("sidecar 错误应答 reject：归属拒绝文案透传给 toast", async () => {
    calls = [];
    respondError = new Error(
      "background task 9 belongs to another thread; it is not readable or stoppable from here.",
    );
    await expect(stopBgTask("sess-bg-stop", 9)).rejects.toThrow(/belongs to another thread/);
  });
});
