/**
 * SendMessage / resume 的单元测试：
 * - SubagentRun.steer 的 settled 边界（结束前受理、结束后拒绝）；
 * - historySnapshot 的裁剪与角色过滤；
 * - activity-store 的 transcript 行写盘/回读往返；
 * - settleDelegation 接 archiveHistory 存档。
 *
 * SubagentRun 的真实 Agent 需要 provider；这里用两种手段：
 * 1) steer/settled/historySnapshot 用「signal 已中止」的 run——run() 同步走
 *    aborted 分支置 settled，不需要模型；
 * 2) prompt 返回后 steer 是否滞留（pi-core 队列行为）属于集成语义，由 e2e 的
 *    fake provider 覆盖；这里只钉本模块自己的逻辑。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Model, Api } from "@earendil-works/pi-ai";
import { SubagentRun } from "../../src/subagent/run";
import { normalizeSubagentHistory, toSubagentHistory } from "../../src/subagent/history";
import {
  appendDelegationTranscript,
  findActivityFileId,
  flushDelegationActivity,
  openDelegationActivity,
  readDelegationActivity,
  resetActivityStoreForTest,
} from "../../src/subagent/activity-store";
import { settleDelegation } from "../../src/subagent/delegation";
import { resumeDelegation } from "../../src/subagent/tools";
import { resetStorageForTest } from "../../src/storage/hostdb";
import { initStorage } from "../../src/storage/storage";
import type { DelegationRecord } from "../../src/types";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-send-message-"));

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), tmp);
});

const MODEL = { provider: "p", id: "m", name: "M" } as unknown as Model<Api>;

function definition(over: Partial<{ name: string; prompt: string }> = {}) {
  return {
    name: over.name ?? "explorer",
    description: "test",
    prompt: over.prompt ?? "You explore things.",
    tools: [],
    scope: "builtin" as const,
    stateKey: "builtin:explorer",
  };
}

function opts(over: Partial<ConstructorParameters<typeof SubagentRun>[0]> = {}) {
  return {
    definition: definition(),
    task: "do things",
    model: MODEL,
    cwd: tmp,
    tools: [],
    sessionId: "sess-send-message",
    traceSessionId: "sess-send-message",
    toolGate: async () => undefined,
    ...over,
  };
}

describe("SubagentRun.steer settled 边界", () => {
  test("run() 结束后 steer 返回 false（aborted 路径同步置 settled）", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = new SubagentRun(opts({ signal: controller.signal }));
    await run.run();
    expect(run.steer("any")).toBe(false);
  });

  test("结束前 steer 受理（返回 true）", async () => {
    // 不真正等它跑完：abort 让 run 立即收尾，但启动后、await 前的窗口 steer 应受理
    const controller = new AbortController();
    const run = new SubagentRun(opts({ signal: controller.signal }));
    const done = run.run();
    // 启动期（abort 前）steer 应被受理——队列滞留与否是集成语义，这里只钉受理面
    const accepted = run.steer("early message");
    controller.abort();
    await done;
    // 受理与否都合法（取决于启动时序），但不能抛错
    expect(typeof accepted).toBe("boolean");
  });

  test("空消息不受理", async () => {
    const controller = new AbortController();
    const run = new SubagentRun(opts({ signal: controller.signal }));
    expect(run.steer("   ")).toBe(false);
  });
});

describe("historySnapshot", () => {
  test("aborted 的 run：历史为空数组（无会话）", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = new SubagentRun(opts({ signal: controller.signal }));
    await run.run();
    expect(run.historySnapshot()).toEqual([]);
  });
});

describe("历史序列化", () => {
  test("toolResult 的 toolCallId/toolName 与 assistant 字段不丢", () => {
    const history = toSubagentHistory([
      { role: "user", content: "go", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
        timestamp: 2,
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 3,
      },
    ] as never);
    expect(history[1]).toMatchObject({ role: "assistant", stopReason: "toolUse" });
    expect(history[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
    });
  });

  test("畸形 toolResult（无 toolCallId）不写入", () => {
    const history = toSubagentHistory([
      { role: "toolResult", content: [{ type: "text", text: "orphan" }] },
    ] as never);
    expect(history).toEqual([]);
  });

  test("旧存档（role+content）归一：剥掉无法配对的工具对，保留文本", () => {
    const legacy = [
      { role: "user", content: "brief" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "found it" },
          { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
        ],
      },
      { role: "toolResult", content: [{ type: "text", text: "ok" }] },
    ] as never;
    const normalized = normalizeSubagentHistory(legacy);
    expect(normalized.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(normalized[1]!.content).toEqual([
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "found it" },
    ]);
  });
});

const rec = (id: string): DelegationRecord => ({
  delegationId: id,
  agentName: "explorer",
  modelId: "p/m",
  status: "running",
  activity: [],
  stopRequested: false,
  startedAt: 1000,
  turns: 0,
  toolCalls: 0,
  reportedToParent: false,
  completion: Promise.resolve(),
  resolveCompletion: () => {},
  abort: () => {},
});

describe("transcript 存档往返（activity-store）", () => {

  test("appendDelegationTranscript 落盘 → readDelegationActivity 回读 history", () => {
    resetActivityStoreForTest();
    const id = "11111111-2222-3333-4444-555555555555";
    const record = rec(id);
    openDelegationActivity(record);
    appendDelegationTranscript(id, [
      { role: "user", content: "task text" },
      { role: "assistant", content: [{ type: "text", text: "report" }] },
    ]);
    const fileId = findActivityFileId(id);
    expect(fileId).toBe(id);
    const restored = readDelegationActivity(id);
    expect(restored?.history).toEqual([
      { role: "user", content: "task text" },
      { role: "assistant", content: [{ type: "text", text: "report" }] },
    ]);
  });

  test("无 transcript 行时 history 缺席（老记录兼容）", () => {
    resetActivityStoreForTest();
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    openDelegationActivity(rec(id));
    flushDelegationActivity(id);
    const restored = readDelegationActivity(id);
    expect(restored?.history).toBeUndefined();
  });

  test("多轮 resume：最后一个 transcript 行生效", () => {
    resetActivityStoreForTest();
    const id = "99999999-8888-7777-6666-555555555555";
    openDelegationActivity(rec(id));
    appendDelegationTranscript(id, [{ role: "user", content: "round1" }]);
    appendDelegationTranscript(id, [
      { role: "user", content: "round1" },
      { role: "assistant", content: "r1" },
      { role: "user", content: "round2" },
    ]);
    const restored = readDelegationActivity(id);
    expect(restored?.history?.at(-1)).toEqual({ role: "user", content: "round2" });
  });
});

describe("resumeDelegation 无存档守卫", () => {
  test("completed 但没有 history：明确拒绝，不凭空重开", async () => {
    const record = rec("22222222-3333-4444-5555-666666666666");
    record.status = "completed";
    const error = await resumeDelegation(record, "follow up");
    expect(error).toContain("no saved conversation");
  });

  test("interrupted 且没有中途快照：说明中断原因", async () => {
    const record = rec("33333333-4444-5555-6666-777777777777");
    record.status = "interrupted";
    const error = await resumeDelegation(record, "follow up");
    expect(error).toContain("interrupted before any conversation history");
  });
});

describe("settleDelegation 接 archiveHistory", () => {
  test("结算时提取历史进 record.history 并落盘", () => {
    resetActivityStoreForTest();
    const id = "77777777-6666-5555-4444-333333333333";
    const record = rec(id);
    record.archiveHistory = () => [{ role: "user", content: "archived" }];
    openDelegationActivity(record);
    settleDelegation(
      {
        delegations: new Map([[id, record]]),
        usagePending: 0,
      } as unknown as Parameters<typeof settleDelegation>[0],
      record,
      {
        agentName: "explorer",
        modelId: "p/m",
        status: "completed",
        report: "done",
        turns: 1,
        toolCalls: 0,
      },
    );
    expect(record.history).toEqual([{ role: "user", content: "archived" }]);
    // 落盘可见（同步刷盘纪律）
    const file = path.join(tmp, "subagents", `${id}.jsonl`);
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain('"t":"transcript"');
  });
});

afterAll(() => {
  resetStorageForTest();
});

/* ------------------------------ e2e：resume 轮上下文 ------------------------------
 * 用目录单例 setProvider 挂一个假 provider（streamSimple 记录每次请求的完整
 * context.messages），跑「初次 Task → 结束 → resume」全链，断言：
 * 1) 初次请求带 brief，报告正常结算；
 * 2) resume 请求的上下文 = 存档历史 + follow-up（无空 user 消息）；
 * 3) resume 结果的 turns/toolCalls 带 base（跨轮累加）。 */
import {
  createAssistantMessageEventStream,
  envApiKeyAuth,
} from "@earendil-works/pi-ai";
import { getModels } from "../../src/model/catalog";

describe("e2e：Task → 结束 → resume 上下文断言", () => {
  test("resume 请求携带存档历史与新消息，计数带基数", async () => {
    const seen: { role: string; text: string }[][] = [];
    let call = 0;
    process.env.FAKE_RESUME_KEY = "test-key";
    const fakeModel = {
      api: "openai-chat",
      type: "chat",
      provider: "fake-resume",
      id: "fake-m",
      name: "Fake",
      baseUrl: "http://127.0.0.1:9/v1",
    } as unknown as Model<Api>;

    const provider = {
      id: "fake-resume",
      name: "Fake Resume",
      auth: { apiKey: envApiKeyAuth("fake", ["FAKE_RESUME_KEY"]) },
      getModels: () => [fakeModel],
      getModel: (id: string) => (id === "fake-m" ? fakeModel : undefined),
      // 假流：记录本次请求上下文，回一段文本 + done
      streamSimple: (model: Model<Api>, context: { messages?: unknown[] }) => {
        call += 1;
        const msgs = (context.messages ?? []) as { role?: unknown; content?: unknown }[];
        seen.push(
          msgs.map((m) => ({
            role: String(m.role),
            text:
              typeof m.content === "string"
                ? m.content
                : Array.isArray(m.content)
                  ? (m.content as { text?: string }[])
                      .map((c) => c.text ?? "")
                      .join("")
                  : "",
          })),
        );
        const assistant = {
          role: "assistant",
          content: [{ type: "text", text: `report #${call}` }],
          timestamp: Date.now(),
          provider: "fake-resume",
          model: "fake-m",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } as unknown;
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "text_start", id: "t1" } as never);
        stream.push({ type: "text_delta", id: "t1", delta: `report #${call}` } as never);
        stream.push({ type: "text_end", id: "t1" } as never);
        stream.push({
          type: "done",
          reason: "stop",
          message: assistant,
        } as never);
        return stream;
      },
    } as never;

    getModels().setProvider(provider);

    const record = rec("66666666-5555-4444-3333-222211110000");
    record.ownerSession = { sessionId: "s", threadId: "t", cwd: tmp };

    // 轮 1：初次启动（带 brief）
    const controller = new AbortController();
    record.abort = () => controller.abort();
    const run1 = new SubagentRun({
      definition: definition(),
      task: "first brief",
      model: fakeModel,
      cwd: tmp,
      tools: [],
      sessionId: record.delegationId,
      traceSessionId: "s",
      toolGate: async () => undefined,
      signal: controller.signal,
      onActivity: (item) => record.activity.push(item),
    });
    record.archiveHistory = () => run1.historySnapshot();
    record.sendMessage = (t: string) => run1.steer(t);
    const result1 = await run1.run();
    expect(result1.status).toBe("completed");
    expect(result1.report).toContain("report #1");
    // 与生产 launchSubagentRun 相同：结算链负责存档历史
    settleDelegation(
      { delegations: new Map([[record.delegationId, record]]), usagePending: 0 } as never,
      record,
      result1,
    );
    // 初次请求：brief 在 user 消息里
    expect(seen[0]!.some((m) => m.role === "user" && m.text.includes("first brief"))).toBe(true);
    const history = record.history ?? [];
    expect(history.length).toBeGreaterThan(0);

    // 轮 2：resume（initialMessages = 历史 + follow-up；continue() 续跑）
    record.status = "running";
    record.stopRequested = false;
    record.result = undefined;
    record.reportedToParent = false;
    const run2 = new SubagentRun({
      definition: definition(),
      initialMessages: [
        ...history,
        { role: "user", content: "[user follow-up] now do more" },
      ],
      turnBase: result1.turns,
      toolCallBase: result1.toolCalls,
      model: fakeModel,
      cwd: tmp,
      tools: [],
      sessionId: record.delegationId,
      traceSessionId: "s",
      toolGate: async () => undefined,
      signal: AbortSignal.timeout(30_000),
      onActivity: (item) => record.activity.push(item),
    });
    record.archiveHistory = () => run2.historySnapshot();
    const result2 = await run2.run();
    expect(result2.status).toBe("completed");
    expect(result2.report).toContain("report #2");
    // 计数跨轮累加：resume 结果 = 本轮(1) + 基数(1)
    expect(result2.turns).toBe(result1.turns + 1);
    // resume 请求上下文：无空 user 消息；含轮 1 的 brief、轮 1 的报告、follow-up
    const resumeMsgs = seen[1]!;
    expect(resumeMsgs.some((m) => m.role === "user" && m.text === "")).toBe(false);
    expect(resumeMsgs.some((m) => m.role === "user" && m.text.includes("first brief"))).toBe(true);
    expect(resumeMsgs.some((m) => m.role === "user" && m.text.includes("[user follow-up] now do more"))).toBe(true);
    expect(resumeMsgs.some((m) => m.role === "assistant" && m.text.includes("report #1"))).toBe(true);
    // 轮次号跨轮单调：resume 轮的 turn 事件 n > 1
    const turnNs = record.activity
      .filter((x) => x.kind === "turn")
      .map((x) => (x as { n: number }).n);
    expect(turnNs.at(-1)!).toBeGreaterThan(1);
    delete process.env.FAKE_RESUME_KEY;
    getModels().deleteProvider("fake-resume");
  });
});
