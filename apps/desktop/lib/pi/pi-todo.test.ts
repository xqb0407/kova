import { afterAll, describe, expect, test } from "bun:test";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

/**
 * 任务清单 store 的键归一（回归）：data-todo chunk 只带 sessionId，面板侧拿的
 * 是 mainThreadId——本会话新建的线程恒为 __LOCALID_ 草稿 id，不归一就会出现
 * 「chunk 写会话键、面板读草稿键」，新建会话里清单永远空着。
 * 关停态（dismissed）同理：关草稿键、chunk 按会话键重开，两边对不上。
 */

type Req = Record<string, unknown>;

let responder: (req: Req) => unknown = () => ({
  type: "todo_state",
  tasks: [],
  nextId: 1,
});
let calls: Req[] = [];

mockModule("@/lib/pi/pi-bridge", () => ({
  piRequest: (payload: Req) => {
    calls.push(payload);
    const res = responder(payload);
    if (res instanceof Error) return Promise.reject(res);
    return Promise.resolve(res);
  },
}));

const registry = new Map<string, string>();
const { isLocalDraftThreadId } = await import("@/lib/pi/pi-thread-identity");
const sessionIdFor = (threadId: string) =>
  registry.get(threadId) ?? (isLocalDraftThreadId(threadId) ? undefined : threadId);
mockModule("@/lib/pi/pi-thread-adapter", () => ({
  piSessionRegistry: registry,
  piSessionPrefsMap: new Map(),
  piSessionIdForThread: sessionIdFor,
  piStoreKeyForThread: (threadId: string) => sessionIdFor(threadId) ?? threadId,
}));

afterAll(() => {
  restoreAllMocks();
});

const {
  applyTodoChunk,
  fetchTodoState,
  dismissTodos,
  todoSnapshotForTest,
  todosDismissedForTest,
} = await import("@/lib/pi/pi-todo");

const DRAFT = "__LOCALID_draft-todo";
const SESSION = "sess-todo";
const TASKS = [{ id: 1, subject: "改键空间", status: "in_progress" }];

function reset() {
  calls = [];
  responder = () => ({ type: "todo_state", tasks: [], nextId: 1 });
  registry.clear();
  applyTodoChunk(SESSION, { tasks: [], nextId: 1 });
}

describe("任务清单的键归一", () => {
  test("chunk 落会话键，按 mainThreadId（草稿 id）读得到", () => {
    reset();
    registry.set(DRAFT, SESSION);
    applyTodoChunk(SESSION, { tasks: TASKS, nextId: 2 });
    expect(todoSnapshotForTest(DRAFT).tasks).toHaveLength(1);
    expect(todoSnapshotForTest(DRAFT).tasks[0]?.subject).toBe("改键空间");
  });

  test("水合应答也落会话键：草稿 id 读得到，请求带 sessionId 定靶", async () => {
    reset();
    registry.set(DRAFT, SESSION);
    responder = () => ({ type: "todo_state", tasks: TASKS, nextId: 2 });
    fetchTodoState(DRAFT);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls[0]?.sessionId).toBe(SESSION);
    expect(todoSnapshotForTest(DRAFT).tasks).toHaveLength(1);
  });

  test("未发送草稿（无会话）不发请求（threadId-only 会懒建空白会话）", () => {
    reset();
    fetchTodoState(DRAFT);
    expect(calls).toHaveLength(0);
  });

  test("关停态归一：按草稿 id 关掉后，按会话键来的实时活动能重新打开", () => {
    reset();
    registry.set(DRAFT, SESSION);
    applyTodoChunk(SESSION, { tasks: TASKS, nextId: 2 });
    dismissTodos(DRAFT);
    expect(todosDismissedForTest(DRAFT)).toBe(true);
    // data-todo 到达 = AI 有新活动：重开面板
    applyTodoChunk(SESSION, { tasks: TASKS, nextId: 3 });
    expect(todosDismissedForTest(DRAFT)).toBe(false);
  });
});
