import { describe, expect, test } from "bun:test";
import {
  renderedIndexOfLastUser,
  TurnCheckpointTracker,
  type TurnCheckpointDeps,
} from "./turn-checkpoints";
import type { PiAgentMessage, PiThreadSnapshot } from "./types";

/**
 * 检查点卡观察者（缺口2）单测：全依赖注入，不碰 tauri/git——
 * 锚点换算（投影前缀口径）、begin/settle 台账生命周期、刷新重挂桥复用。
 */

const tick = () => new Promise((r) => setTimeout(r, 0));

const user = (text: string): PiAgentMessage =>
  ({ role: "user", content: text, timestamp: 1 }) as PiAgentMessage;
const assistant = (): PiAgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    stopReason: "stop",
    timestamp: 2,
  }) as PiAgentMessage;
const toolResult = (id: string): PiAgentMessage =>
  ({
    role: "toolResult",
    toolCallId: id,
    content: [{ type: "text", text: "r" }],
    isError: false,
    timestamp: 3,
  }) as PiAgentMessage;

const snapshotAt = (
  messages: readonly PiAgentMessage[],
  cwd: string | null = "/w",
): PiThreadSnapshot =>
  ({
    metadata: {
      id: "s1",
      status: "idle",
      ...(cwd ? { workspacePath: cwd } : {}),
    },
    messages,
  }) as unknown as PiThreadSnapshot;

/** 记录型假依赖：log 按调用顺序记行，供时序断言 */
function makeTracker(
  snapshot: PiThreadSnapshot | undefined,
  patch: {
    create?: (cwd: string, tag: string) => Promise<string | null>;
    diffFiles?: { added: number; removed: number }[] | null;
    persisted?: { cwd: string; hash: string; anchorIndex?: number | null } | null;
  } = {},
) {
  const log: string[] = [];
  const deps: TurnCheckpointDeps = {
    now: () => 42,
    create:
      patch.create ??
      (async (cwd, tag) => {
        log.push(`create:${cwd}:${tag}`);
        return "hash-1";
      }),
    diff: async (cwd, hash) => {
      log.push(`diff:${cwd}:${hash}`);
      return patch.diffFiles === undefined
        ? { files: [{ added: 3, removed: 1 }] }
        : patch.diffFiles === null
          ? null
          : { files: patch.diffFiles };
    },
    refreshStatus: (cwd) => log.push(`refresh:${cwd}`),
    resolveCwd: (s) => s.metadata.workspacePath ?? null,
    fetchSnapshot: async (sid) => {
      log.push(`fetch:${sid}`);
      return snapshot;
    },
    saveHash: (tid, v) =>
      log.push(`save:${tid}:${v === null ? "null" : JSON.stringify(v)}`),
    loadHash: (tid) => {
      log.push(`load:${tid}`);
      return patch.persisted ?? null;
    },
    push: (tid, anchor, cp) =>
      log.push(`push:${tid}:${anchor}:${cp.files}:${cp.added}:${cp.removed}`),
  };
  return { tracker: new TurnCheckpointTracker(deps), log };
}

describe("renderedIndexOfLastUser", () => {
  test("简单两消息：锚 0", () => {
    expect(renderedIndexOfLastUser([user("hi"), assistant()])).toBe(0);
  });

  test("assistant+toolResult 合并压缩下标", () => {
    // 转录 [u0, a1, tr, a2, u3] → 渲染 [u0, 合并组, u3] → u3 锚 2
    expect(
      renderedIndexOfLastUser([
        user("q1"),
        assistant(),
        toolResult("t1"),
        assistant(),
        user("q2"),
      ]),
    ).toBe(2);
  });

  test("压缩分隔线占一个渲染位", () => {
    expect(
      renderedIndexOfLastUser([
        { role: "compactionSummary", summary: "s", tokensBefore: 10, timestamp: 0 } as PiAgentMessage,
        user("q"),
        assistant(),
      ]),
    ).toBe(1);
  });

  test("隐藏 custom 不占渲染位", () => {
    expect(
      renderedIndexOfLastUser([
        user("q1"),
        { role: "custom", display: false, customType: "x", content: "", details: null } as PiAgentMessage,
        user("q2"),
      ]),
    ).toBe(1);
  });

  test("无 user 消息 → null（列表末尾兜底）", () => {
    expect(renderedIndexOfLastUser([assistant(), assistant()])).toBe(null);
    expect(renderedIndexOfLastUser([])).toBe(null);
  });
});

describe("TurnCheckpointTracker", () => {
  test("begin→settle 主路径：打快照→落桥→diff→按锚点落卡", async () => {
    const { tracker, log } = makeTracker(snapshotAt([user("hi"), assistant()]));
    tracker.begin("s1");
    await tick();
    expect(log).toEqual([
      "fetch:s1",
      "save:s1:null", // 先作废桥上残留
      "create:/w:agent:s1:42",
      'save:s1:{"cwd":"/w","hash":"hash-1","anchorIndex":0}',
    ]);
    tracker.settle("s1");
    await tick();
    expect(log.slice(4)).toEqual([
      "save:s1:null", // 结算清桥
      "refresh:/w",
      "diff:/w:hash-1",
      "push:s1:0:1:3:1",
    ]);
  });

  test("无 cwd（非 git/未定工作区）：静默跳过，无 create 无 diff", async () => {
    const { tracker, log } = makeTracker(snapshotAt([user("hi")], null));
    tracker.begin("s1");
    await tick();
    expect(log).toEqual(["fetch:s1"]);
    tracker.settle("s1");
    await tick();
    // settle：begin 打不出快照（null）→ 台账已摘除 → 走复用路径 load（无残留）
    expect(log).toEqual(["fetch:s1", "load:s1", "save:s1:null"]);
  });

  test("同 run 重复 agent_start 只打一次快照", async () => {
    let gate: ((v: string | null) => void) | undefined;
    let creates = 0;
    const { tracker } = makeTracker(snapshotAt([user("hi")]), {
      create: () =>
        new Promise<string | null>((res) => {
          creates += 1;
          gate = res;
        }),
    });
    tracker.begin("s1");
    tracker.begin("s1"); // 重试重放/合帧重复帧
    await tick();
    expect(creates).toBe(1);
    gate?.("hash-1");
    await tick();
  });

  test("create 失败：不落桥、settle 无 push、台账摘除可再 begin", async () => {
    let calls = 0;
    const { tracker, log } = makeTracker(snapshotAt([user("hi")]), {
      create: async () => {
        calls += 1;
        throw new Error("no git");
      },
    });
    tracker.begin("s1");
    await tick();
    expect(calls).toBe(1);
    expect(log.some((l) => l.startsWith("save:s1:{"))).toBe(false);
    tracker.settle("s1");
    await tick();
    expect(log.some((l) => l.startsWith("push:"))).toBe(false);
    tracker.begin("s1"); // 台账已摘除，下一轮正常重打
    await tick();
    expect(calls).toBe(2);
  });

  test("刷新重挂：settle 无台账条目时从桥上复用 hash+锚点补结算", async () => {
    const { tracker, log } = makeTracker(undefined, {
      persisted: { cwd: "/w", hash: "persisted", anchorIndex: 7 },
    });
    tracker.settle("s1");
    await tick();
    expect(log).toEqual([
      "load:s1",
      "save:s1:null",
      "refresh:/w",
      "diff:/w:persisted",
      "push:s1:7:1:3:1",
    ]);
  });

  test("刷新重挂且桥上无残留：仅清桥，无 diff", async () => {
    const { tracker, log } = makeTracker(undefined, { persisted: null });
    tracker.settle("s1");
    await tick();
    expect(log).toEqual(["load:s1", "save:s1:null"]);
  });

  test("diff 无文件变更：不落卡（改动为零的轮不渲染）", async () => {
    const { tracker, log } = makeTracker(snapshotAt([user("hi")]), {
      diffFiles: [],
    });
    tracker.begin("s1");
    await tick();
    tracker.settle("s1");
    await tick();
    expect(log.some((l) => l.startsWith("push:"))).toBe(false);
    expect(log.some((l) => l.startsWith("diff:"))).toBe(true);
  });
});
