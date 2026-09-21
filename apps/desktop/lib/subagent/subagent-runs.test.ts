import { afterAll, describe, expect, test } from "bun:test";
import type { PiChannel, SubagentActivityItem } from "@/lib/pi/pi-channel";
import type { PiResponse } from "@/lib/pi/pi-bridge";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

// openSubagentTab 用例直接覆写 globalThis.window（dispatchEvent 桩）→ 收尾还原，
// 避免把空壳 window 漏给同进程后续文件
const prevWindow = (globalThis as Record<string, unknown>).window;
afterAll(() => {
  restoreAllMocks();
  (globalThis as Record<string, unknown>).window = prevWindow;
});

/**
 * 子智能体运行 store 测试（lib/subagent-runs.ts）：
 * - 绑定 chunk 立条目 / toolCallId 查询
 * - 活动流合并：thinking/text 增量并进开放块、delta 丢失兜底起块、
 *   工具起止配对与权威计数、status 终态覆盖
 * - id 解析：完整 id / ≥4 位唯一前缀 / 歧义与过短前缀不猜
 * - 快照水合：meta 权威覆盖、blocks 仅本地为空时回放、失败置 expired、幂等
 * - openSubagentTab：同委派复用激活、新委派开 tab
 * mock Tauri API 与 panel-tabs（沿用 pi-running.test.ts 的桩风格）。
 */

type ActivityCb = (delegationId: string, item: SubagentActivityItem) => void;

let emitActivity: ActivityCb | null = null;
const snapshotResponses = new Map<string, unknown>();
const requestCounts = new Map<string, number>();

mockModule("@tauri-apps/api/core", () => ({
  invoke: () => Promise.reject(new Error("unused in store tests")),
}));
mockModule("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

// pi-bridge 边界自锚：全量跑时其他文件（app-mode/automations）对 pi-bridge 的
// mock.module 会泄漏进本文件（bun 1.3.14 的 restore() 对别名解析模块跨文件不可靠，
// 见 lib/testing/mock-module.ts），导致 hydrate 走到别人的假 piRequest（sidecar offline）。
// 这里显式接管，语义与真实 pi-bridge 一致：piRequest 委托当前注册通道。
mockModule("@/lib/pi/pi-bridge", () => {
  const { getPiChannel } = require("@/lib/pi/pi-channel") as typeof import("@/lib/pi/pi-channel");
  return {
    piRequest: (payload: Record<string, unknown>, timeoutMs?: number) =>
      getPiChannel().request(payload, timeoutMs),
  };
});

// panel-tabs 桩：localStorage 依赖换为内存数组，记录 open/activate 语义
type FakeTab = { id: string; type: string; delegationId?: string; title?: string };
const fakeTabs: FakeTab[] = [];
let fakeActiveId: string | null = null;
mockModule("@/lib/panels/panel-tabs", () => ({
  getPanelTabs: () => ({ tabs: fakeTabs, activeId: fakeActiveId }),
  openPanelTab: (type: string, extra?: { delegationId?: string; title?: string }) => {
    const id = `tab-${fakeTabs.length}`;
    fakeTabs.push({ id, type, ...extra });
    fakeActiveId = id;
    return id;
  },
  setActivePanelTab: (id: string) => {
    fakeActiveId = id;
  },
}));

const { setPiChannel } = await import("@/lib/pi/pi-channel");
const {
  applyDelegationChunk,
  getSubagentRun,
  getSubagentRunByToolCall,
  hydrateSubagentSnapshot,
  openSubagentTab,
  parseDelegationIdFromResult,
  resolveDelegationId,
  startSubagentRunsWatch,
  subagentElapsedSeconds,
} = await import("@/lib/subagent/subagent-runs");

// 假通道：request 按 delegationId 应答快照；subscribeSubagentActivity 捕获广播回调
const channel: PiChannel = {
  kind: "tauri",
  request: async (payload): Promise<PiResponse> => {
    if (payload.type === "get_subagent_activity") {
      const id = String(payload.delegationId);
      requestCounts.set(id, (requestCounts.get(id) ?? 0) + 1);
      // 贴近 sidecar：完整 id 或 ≥4 位唯一前缀可查
      let res = snapshotResponses.get(id);
      if (!res && id.length >= 4) {
        for (const [k, v] of snapshotResponses) {
          if (k.startsWith(id)) {
            res = v;
            break;
          }
        }
      }
      if (!res) throw new Error(`delegation not found: ${id}`);
      return res as PiResponse;
    }
    return { type: "sessions", sessions: [] } as unknown as PiResponse;
  },
  promptStream: () => new ReadableStream(),
  abort: async () => {},
  subscribeSubagentActivity: (cb) => {
    emitActivity = cb;
    return Promise.resolve(() => {
      emitActivity = null;
    });
  },
};
setPiChannel(channel);
startSubagentRunsWatch();
await new Promise((r) => setTimeout(r, 0)); // 让订阅登记完成

const snapshot = (
  delegationId: string,
  record: Record<string, unknown>,
  items: SubagentActivityItem[] = [],
) => ({ type: "subagent_activity_snapshot", record, items });

describe("绑定与条目", () => {
  test("data-subagentDelegation 绑定：立条目 + toolCallId 查询", () => {
    applyDelegationChunk({
      toolCallId: "tc-explore",
      delegationId: "11111111-2222-3333-4444-555555555555",
      agentName: "Explore",
      description: "探索消息与工具渲染管线",
    });
    const run = getSubagentRunByToolCall("tc-explore");
    expect(run?.agentName).toBe("Explore");
    expect(run?.description).toBe("探索消息与工具渲染管线");
    expect(run?.status).toBe("running");
    expect(getSubagentRunByToolCall("tc-unknown")).toBeUndefined();
    // 坏载荷（缺字段）不炸不立条目
    applyDelegationChunk({ agentName: "x" });
    expect(getSubagentRun("x")).toBeUndefined();
  });

  test("结果文本兜底解析 8 位短 id", () => {
    expect(
      parseDelegationIdFromResult("Delegation abc12345 started, running in background."),
    ).toBe("abc12345");
    expect(parseDelegationIdFromResult("no delegation here")).toBeUndefined();
    // 短 id 经唯一前缀认领绑定条目
    expect(resolveDelegationId("abc12345")).toBeUndefined();
    expect(resolveDelegationId("11111111")).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    expect(getSubagentRun("11111111")?.agentName).toBe("Explore");
  });
});

describe("活动流合并", () => {
  const ID = "22222222-2222-2222-2222-222222222222";
  // startedAt 由 defaultState 用 Date.now 立；时间戳同基准才有意义
  const base = Date.now();
  const at = (sec: number) => base + sec * 1000;

  test("增量并块 / 工具配对 / status 权威覆盖", () => {
    applyDelegationChunk({
      toolCallId: "tc-a",
      delegationId: ID,
      agentName: "worker",
    });
    const emit = (item: SubagentActivityItem) => emitActivity!(ID, item);

    emit({ kind: "turn", n: 1, at: at(0) });
    emit({ kind: "thinking", op: "start", id: "c0", at: at(0) });
    emit({ kind: "thinking", op: "delta", id: "c0", delta: "先看", at: at(1) });
    emit({ kind: "thinking", op: "delta", id: "c0", delta: "结构", at: at(2) });
    emit({ kind: "thinking", op: "end", id: "c0", at: at(5) });
    emit({ kind: "text", op: "start", id: "c1", at: at(5) });
    emit({ kind: "text", op: "delta", id: "c1", delta: "结论", at: at(6) });
    emit({ kind: "text", op: "end", id: "c1", at: at(7) });
    // delta 找不到开放 start：兜底直接起块
    emit({ kind: "text", op: "delta", id: "c9", delta: "丢起点", at: at(7) });
    emit({
      kind: "tool",
      op: "start",
      toolCallId: "s1",
      toolName: "read",
      argsSummary: "a.ts",
      at: at(8),
    });
    emit({
      kind: "tool",
      op: "end",
      toolCallId: "s1",
      toolName: "read",
      resultSummary: "120 行",
      failed: false,
      at: at(9),
    });
    emit({
      kind: "status",
      status: "completed",
      turns: 3,
      toolCalls: 7,
      report: "## 完成",
      at: at(10),
    });

    const run = getSubagentRun(ID)!;
    const thinking = run.blocks.find((b) => b.kind === "thinking")!;
    expect(thinking.kind === "thinking" && thinking.text).toBe("先看结构");
    expect(thinking.kind === "thinking" && thinking.done).toBe(true);
    expect(thinking.kind === "thinking" && thinking.endedAt).toBe(at(5));
    const texts = run.blocks.filter((b) => b.kind === "text");
    expect(texts.length).toBe(2);
    const tool = run.blocks.find((b) => b.kind === "tool")!;
    expect(tool.kind === "tool" && tool.done && tool.resultSummary).toBe("120 行");
    expect(run.turns).toBe(3); // status 权威覆盖（live 计数只是中间态）
    expect(run.toolCalls).toBe(7);
    expect(run.status).toBe("completed");
    expect(run.report).toBe("## 完成");
    expect(run.completedAt).toBe(at(10));
  });

  test("用时：running 取当下、结算取 completedAt", () => {
    const run = getSubagentRun(ID)!;
    expect(subagentElapsedSeconds(run, at(30))).toBe(10); // 结算后不再随 now 增长
    expect(subagentElapsedSeconds(undefined)).toBe(0);
  });
});

describe("id 解析", () => {
  test("歧义与过短前缀不猜", () => {
    applyDelegationChunk({
      toolCallId: "tc-p1",
      delegationId: "abcd1111-x",
      agentName: "a",
    });
    applyDelegationChunk({
      toolCallId: "tc-p2",
      delegationId: "abcd2222-x",
      agentName: "b",
    });
    expect(resolveDelegationId("abcd")).toBeUndefined(); // 双命中
    expect(resolveDelegationId("abc")).toBeUndefined(); // <4 位
    expect(resolveDelegationId("abcd1111")).toBe("abcd1111-x");
    expect(resolveDelegationId(undefined)).toBeUndefined();
  });
});

describe("快照水合", () => {
  const ID = "33333333-3333-3333-3333-333333333333";

  test("meta 权威 + 空 blocks 回放 items", async () => {
    snapshotResponses.set(
      ID,
      snapshot(
        ID,
        {
          delegationId: ID, // 规范全量 id：别名条目应被迁移到正式键下
          agentName: "Explore",
          description: "历史补水",
          status: "completed",
          startedAt: 500,
          completedAt: 9_500,
          turns: 2,
          toolCalls: 4,
          report: "done",
        },
        [
          { kind: "turn", n: 1, at: 500 },
          { kind: "text", op: "start", id: "c0", at: 500 },
          { kind: "text", op: "delta", id: "c0", delta: "回放正文", at: 600 },
          { kind: "text", op: "end", id: "c0", at: 700 },
        ] as SubagentActivityItem[],
      ),
    );
    await hydrateSubagentSnapshot(ID.slice(0, 8));
    const run = getSubagentRun(ID)!;
    expect(run.agentName).toBe("Explore");
    expect(run.status).toBe("completed");
    expect(run.hydrated).toBe(true);
    expect(run.blocks.filter((b) => b.kind === "text")[0]!.kind === "text").toBe(true);
    const textBlock = run.blocks.find((b) => b.kind === "text")!;
    expect(textBlock.kind === "text" && textBlock.text).toBe("回放正文");
    // 幂等：hydrated 后不再重复请求
    await hydrateSubagentSnapshot(ID);
    expect(requestCounts.get(ID.slice(0, 8))).toBe(1);
  });

  test("查无记录 ⇒ expired 空态，不再重试", async () => {
    const missing = "40404040-0000-0000-0000-000000000000";
    await hydrateSubagentSnapshot(missing);
    const run = getSubagentRun(missing)!;
    expect(run.expired).toBe(true);
    expect(run.hydrated).toBe(true);
    await hydrateSubagentSnapshot(missing);
    expect(requestCounts.get(missing)).toBe(1);
  });
});

describe("openSubagentTab", () => {
  test("新委派开 tab，同委派复用激活", () => {
    (globalThis as Record<string, unknown>).window = {
      dispatchEvent: () => {},
    };
    const ID = "11111111-2222-3333-4444-555555555555";
    openSubagentTab("11111111", "探索消息与工具渲染管线");
    const created = fakeTabs.find((t) => t.delegationId === ID);
    expect(created?.type).toBe("subagent");
    expect(created?.title).toBe("探索消息与工具渲染管线");
    // 前缀在 store 解析成完整 id 再落 tab，避免同委派双 tab
    fakeActiveId = "tab-xyz";
    openSubagentTab("11111111");
    expect(fakeActiveId).toBe(created!.id);
    expect(fakeTabs.filter((t) => t.delegationId === ID).length).toBe(1);
  });
});
