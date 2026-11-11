import { describe, expect, test } from "bun:test";
import {
  editsSummaryOf,
  renderedIndexOfLastUser,
  renderedIndexOfUserAt,
  TurnCheckpointTracker,
  type TurnCheckpointDeps,
} from "./turn-checkpoints";
import type { PiAgentMessage, PiThreadSnapshot } from "./types";
import type { TurnEdit, TurnEditStatus } from "@/lib/pi/pi-edits";

/**
 * 检查点卡观察者（缺口2）单测：全依赖注入，不碰桌面桥/git——
 * 锚点换算（投影前缀口径）、begin/settle 台账生命周期、刷新重挂桥复用、
 * settle 锚点重算（agent_start 早于 user 行落盘的错锚修复）。
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
    diffFiles?:
      | { path?: string; oldPath?: string | null; added: number; removed: number }[]
      | null;
    edits?: { files: number; added: number; removed: number } | null;
    /** 条目所有权层应答：本轮编辑 + shared（数组 = 按 settle 次数依次返回） */
    turnStatus?: TurnEditStatus | TurnEditStatus[];
    persisted?: {
      cwd: string;
      hash: string;
      anchorIndex?: number | null;
      anchorMessageId?: string | null;
    } | null;
    /** 逐次 fetch 的快照队列：begin 取第 0 个、settle 取第 1 个；缺省恒返回 snapshot */
    snapshots?: readonly (PiThreadSnapshot | undefined)[];
  } = {},
) {
  const log: string[] = [];
  /** settle 的 diff 调用参数（paths 作用域断言用） */
  const diffCalls: {
    cwd: string;
    hash: string;
    opts?: { paths?: readonly string[]; snapshot?: boolean };
  }[] = [];
  /** 落卡条目（paths/shared 断言用） */
  const pushes: { anchor: unknown; cp: Record<string, unknown> }[] = [];
  let fetchIndex = 0;
  let turnStatusIndex = 0;
  const deps: TurnCheckpointDeps = {
    now: () => 42,
    create: async (cwd, tag) => {
      // 日志在包装层记（patch.create 只决定返回值），供 create 次数断言
      log.push(`create:${cwd}:${tag}`);
      return patch.create ? patch.create(cwd, tag) : "hash-1";
    },
    diff: async (cwd, hash, opts) => {
      diffCalls.push({ cwd, hash, opts });
      log.push(`diff:${cwd}:${hash}`);
      const all =
        patch.diffFiles === undefined
          ? [{ path: "a.ts", added: 3, removed: 1 }]
          : patch.diffFiles;
      if (all === null) return null;
      // 模拟 electron 侧作用域过滤：paths 有值时只回清单内文件
      const files = opts?.paths
        ? all.filter((f) => f.path && opts.paths!.includes(f.path))
        : all;
      return { files };
    },
    refreshStatus: (cwd) => log.push(`refresh:${cwd}`),
    resolveCwd: (s) => s.metadata.workspacePath ?? null,
    fetchSnapshot: async (sid) => {
      log.push(`fetch:${sid}`);
      if (patch.snapshots) {
        const next = patch.snapshots[fetchIndex];
        fetchIndex += 1;
        return next;
      }
      return snapshot;
    },
    saveHash: (tid, v) =>
      log.push(`save:${tid}:${v === null ? "null" : JSON.stringify(v)}`),
    loadHash: (tid) => {
      log.push(`load:${tid}`);
      return patch.persisted ?? null;
    },
    push: (tid, anchor, cp) => {
      pushes.push({ anchor, cp: cp as unknown as Record<string, unknown> });
      log.push(
        `push:${tid}:${anchor.anchorMessageId ?? anchor.anchorIndex}:${cp.files}:${cp.added}:${cp.removed}`,
      );
    },
    ...(patch.turnStatus
      ? {
          turnStatus: async () => {
            const configured = patch.turnStatus!;
            if (Array.isArray(configured)) {
              return (
                configured[turnStatusIndex++] ?? {
                  edits: new Map<string, TurnEdit>(),
                  shared: true,
                }
              );
            }
            return configured;
          },
        }
      : {}),
    editsSummary: async () => {
      log.push("edits");
      return patch.edits ?? null;
    },
  };
  return { tracker: new TurnCheckpointTracker(deps), log, diffCalls, pushes };
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

describe("renderedIndexOfUserAt", () => {
  test("目标非 user 行/越界返回 null", () => {
    expect(renderedIndexOfUserAt([user("q1"), assistant()], 1)).toBe(null);
    expect(renderedIndexOfUserAt([user("q1")], 5)).toBe(null);
    expect(renderedIndexOfUserAt([user("q1"), assistant()], -1)).toBe(null);
  });

  test("前缀投影口径与 renderedIndexOfLastUser 一致", () => {
    const messages = [
      user("q1"),
      assistant(),
      toolResult("t1"),
      assistant(),
      user("q2"),
    ];
    expect(renderedIndexOfUserAt(messages, 4)).toBe(
      renderedIndexOfLastUser(messages),
    );
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
      "save:s1:null", // 结算清桥（settle 同步先做）
      "fetch:s1", // settle 重算锚点：再拉一次最新快照
      "refresh:/w",
      "diff:/w:hash-1",
      "push:s1:0:1:3:1",
    ]);
  });

  test("影子快照失败但附加根有编辑：仍落空 hash 卡（只保留逐文件回滚）", async () => {
    const { tracker, log } = makeTracker(snapshotAt([user("hi"), assistant()]), {
      create: async () => null,
      edits: { files: 1, added: 2, removed: 0 },
    });
    tracker.begin("s1");
    await tick();
    tracker.settle("s1");
    await tick();
    await tick();
    expect(log.at(-1)).toBe("push:s1:0:1:2:0");
  });

  test("cwd 无改动但附加根有编辑：仍落卡，聚合来自所有权层", async () => {
    const { tracker, log } = makeTracker(snapshotAt([user("hi"), assistant()]), {
      diffFiles: [],
      edits: { files: 2, added: 5, removed: 1 },
    });
    tracker.begin("s1");
    await tick();
    tracker.settle("s1");
    await tick();
    expect(log).toContain("edits");
    expect(log.at(-1)).toBe("push:s1:0:2:5:1");
  });

  test("cwd 无改动且无附加根编辑：不出空卡", async () => {
    const { tracker, log } = makeTracker(snapshotAt([user("hi"), assistant()]), {
      diffFiles: [],
      edits: null,
    });
    tracker.begin("s1");
    await tick();
    tracker.settle("s1");
    await tick();
    expect(log.at(-1)).toBe("edits");
    expect(log.some((l) => l.startsWith("push:"))).toBe(false);
  });

  test("无 cwd（非 git/未定工作区）：静默跳过，无 create 无 diff", async () => {    const { tracker, log } = makeTracker(snapshotAt([user("hi")], null));
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

describe("settle 锚点重算（agent_start 早于 user 行落盘）", () => {
  /** 带转录 seq 的行（sidecar 快照透传形状） */
  const userAt = (text: string, seq: number): PiAgentMessage =>
    ({ role: "user", content: text, timestamp: 1, __seq: seq }) as PiAgentMessage;
  const assistantAt = (seq: number): PiAgentMessage =>
    ({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      stopReason: "stop",
      timestamp: 2,
      __seq: seq,
    }) as PiAgentMessage;
  const compactionAt = (seq: number): PiAgentMessage =>
    ({
      role: "compactionSummary",
      summary: "s",
      tokensBefore: 1,
      timestamp: 0,
      __seq: seq,
    }) as PiAgentMessage;

  test("begin 快照缺触发行：settle 取 baseline 后第一条 user，steer 不抢锚", async () => {
    // begin（agent_start）：本轮 user 行（q2）还没落盘——旧实现这里会锚到 q1
    const beginSnap = snapshotAt([userAt("q1", 3), assistantAt(4)]);
    // settle：q2（seq 7）已落盘；steer 注入行（seq 9）晚于触发行
    const settleSnap = snapshotAt([
      userAt("q1", 3),
      assistantAt(4),
      userAt("q2", 7),
      userAt("steer", 9),
    ]);
    const { tracker, log } = makeTracker(beginSnap, {
      snapshots: [beginSnap, settleSnap],
      diffFiles: [{ added: 1, removed: 0 }],
    });
    tracker.begin("s1");
    await tick();
    tracker.settle("s1");
    await tick();
    // 重算锚到 q2（渲染下标 2），并带稳定 id；旧行为会错误地推 anchorIndex 0
    expect(log.at(-1)).toBe("push:s1:pi-msg:7:1:1:0");
  });

  test("begin 快照末条就是触发行：settle 按 seq 重定位，分隔线插入不漂移", async () => {
    // begin：触发行 q2 已落盘且是快照末条（快照晚于 persist 的常见时序）
    const beginSnap = snapshotAt([userAt("q1", 3), userAt("q2", 7)]);
    // settle：q2 之前插入了 compaction 分隔线——纯下标匹配会漂移，按 seq 重定位
    const settleSnap = snapshotAt([userAt("q1", 3), compactionAt(5), userAt("q2", 7)]);
    const { tracker, log } = makeTracker(beginSnap, {
      snapshots: [beginSnap, settleSnap],
      diffFiles: [{ added: 1, removed: 0 }],
    });
    tracker.begin("s1");
    await tick();
    tracker.settle("s1");
    await tick();
    expect(log.at(-1)).toBe("push:s1:pi-msg:7:1:1:0");
  });

  test("settle 快照拉不到：回落 begin 锚点（行为不回归）", async () => {
    const beginSnap = snapshotAt([userAt("q1", 3), assistantAt(4)]);
    const { tracker, log } = makeTracker(beginSnap, {
      snapshots: [beginSnap, undefined],
      diffFiles: [{ added: 1, removed: 0 }],
    });
    tracker.begin("s1");
    await tick();
    tracker.settle("s1");
    await tick();
    expect(log.at(-1)).toBe("push:s1:0:1:1:0");
  });
});

describe("turnBase：同渲染轮续段累计 diff", () => {
  const userAt = (text: string, seq: number): PiAgentMessage =>
    ({ role: "user", content: text, timestamp: 1, __seq: seq }) as PiAgentMessage;
  const assistantAt = (seq: number): PiAgentMessage =>
    ({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      stopReason: "stop",
      timestamp: 2,
      __seq: seq,
    }) as PiAgentMessage;
  const compactionAt = (seq: number): PiAgentMessage =>
    ({
      role: "compactionSummary",
      summary: "s",
      tokensBefore: 1,
      timestamp: 0,
      __seq: seq,
    }) as PiAgentMessage;

  test("goal 续跑：同锚续段复用首段基线（累计），分隔线插入按 id 重定位", async () => {
    let creates = 0;
    const begin1 = snapshotAt([userAt("目标P", 10), assistantAt(11)]);
    const settle1 = snapshotAt([userAt("目标P", 10), assistantAt(11), assistantAt(12)]);
    // 段间插入了 compaction 分隔线（seq 5 < 10）——纯下标匹配会把锚漂到错误位置
    const begin2 = snapshotAt([
      compactionAt(5),
      userAt("目标P", 10),
      assistantAt(11),
      assistantAt(12),
    ]);
    const settle2 = snapshotAt([
      compactionAt(5),
      userAt("目标P", 10),
      assistantAt(11),
      assistantAt(12),
      assistantAt(13),
    ]);
    const { tracker, log } = makeTracker(begin1, {
      snapshots: [begin1, settle1, begin2, settle2],
      diffFiles: [{ added: 1, removed: 0 }],
      create: async () => `hash-${++creates}`,
    });
    // 段 1：begin → settle
    tracker.begin("s1");
    await tick();
    tracker.settle("s1");
    await tick();
    // 段 2（同渲染轮续段）：begin → settle
    tracker.begin("s1");
    await tick();
    tracker.settle("s1");
    await tick();

    // 每段 begin 各打一次影子快照（begin 时无法区分续段与委派 resume，
    // 基线复用在 settle 按锚 id 比对时决策）
    expect(log.filter((l) => l.startsWith("create:"))).toHaveLength(2);
    // 两次 diff 都用段 1 的基线 hash → 卡片内容相对本轮起点累计，不丢失
    expect(log.filter((l) => l.startsWith("diff:"))).toEqual([
      "diff:/w:hash-1",
      "diff:/w:hash-1",
    ]);
    // 两次落卡同锚 id（pi-msg:10 → 同 id 替换）；段 2 的下标按 id 重定位修正
    // 分隔线插入的漂移（P 从 0 漂到 1）
    expect(log.filter((l) => l.startsWith("push:"))).toEqual([
      "push:s1:pi-msg:10:1:1:0",
      "push:s1:pi-msg:10:1:1:0",
    ]);
  });

  test("委派 resume：可见 user 行开新渲染轮 → 覆写基线，各轮各卡", async () => {
    let creates = 0;
    const begin1 = snapshotAt([userAt("q1", 10), assistantAt(11)]);
    const settle1 = snapshotAt([userAt("q1", 10), assistantAt(11)]);
    const begin2 = snapshotAt([userAt("q1", 10), assistantAt(11), assistantAt(12)]);
    const settle2 = snapshotAt([
      userAt("q1", 10),
      assistantAt(11),
      assistantAt(12),
      userAt("resume", 20),
      assistantAt(21),
    ]);
    const { tracker, log } = makeTracker(begin1, {
      snapshots: [begin1, settle1, begin2, settle2],
      diffFiles: [{ added: 1, removed: 0 }],
      create: async () => `hash-${++creates}`,
    });
    tracker.begin("s1");
    await tick();
    tracker.settle("s1");
    await tick();
    tracker.begin("s1");
    await tick();
    tracker.settle("s1");
    await tick();

    // 段 1 卡锚 q1；resume 行开新渲染轮 → 段 2 卡锚 resume 行、diff 用自己的基线
    expect(log.filter((l) => l.startsWith("diff:"))).toEqual([
      "diff:/w:hash-1",
      "diff:/w:hash-2",
    ]);
    expect(log.filter((l) => l.startsWith("push:"))).toEqual([
      "push:s1:pi-msg:10:1:1:0",
      "push:s1:pi-msg:20:1:1:0",
    ]);
  });
});

describe("settle 会话隔离（shared 工作区）", () => {
  const turnEdit = (over: Partial<TurnEdit>): TurnEdit => ({
    root: "/w",
    rel: "a.ts",
    primary: true,
    status: "modified",
    additions: 1,
    deletions: 0,
    exact: true,
    undoable: true,
    ...over,
  });

  test("shared：diff 只按本会话主根编辑路径，条目标记 shared 且禁用整轮撤销", async () => {
    const edits = new Map<string, TurnEdit>([
      ["a", turnEdit({ rel: "a.ts" })],
      // 附加根记录不进影子仓库 diff，但要保留在条目里供逐文件回滚
      ["e", turnEdit({ root: "/ext", primary: false, rel: "z.ts" })],
    ]);
    const { tracker, diffCalls, pushes } = makeTracker(
      snapshotAt([user("hi")]),
      {
        turnStatus: { edits, shared: true },
        // 全仓 diff 里同时有本会话 a.ts 和别的会话 b.ts
        diffFiles: [
          { path: "a.ts", added: 2, removed: 0 },
          { path: "b.ts", added: 9, removed: 9 },
        ],
      },
    );
    tracker.begin("s1", "turn-1");
    await tick();
    tracker.settle("s1");
    await tick();
    await tick();

    expect(diffCalls[0]?.opts).toEqual({
      paths: ["a.ts"],
    });
    const cp = pushes.at(-1)?.cp;
    expect(cp?.shared).toBe(true);
    expect(cp?.paths).toEqual(["a.ts"]);
    // 别的会话的 b.ts 不进入本轮统计
    expect(cp?.files).toBe(1);
    expect(cp?.added).toBe(2);
  });

  test("shared + 同渲染轮续段：作用域累计前序段的归属路径", async () => {
    const u = (seq: number): PiAgentMessage =>
      ({ role: "user", content: "q", timestamp: 1, __seq: seq }) as PiAgentMessage;
    const a = (seq: number): PiAgentMessage =>
      ({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stopReason: "stop",
        timestamp: 2,
        __seq: seq,
      }) as PiAgentMessage;
    let creates = 0;
    const begin1 = snapshotAt([u(10), a(11)]);
    const settle1 = snapshotAt([u(10), a(11)]);
    // 同锚（seq 10）续段：goal 续跑，不产生新的可见 user 行
    const begin2 = snapshotAt([u(10), a(11), a(12)]);
    const settle2 = snapshotAt([u(10), a(11), a(12)]);
    const { tracker, diffCalls, pushes } = makeTracker(begin1, {
      snapshots: [begin1, settle1, begin2, settle2],
      create: async () => `hash-${++creates}`,
      // 段 1 编辑 a.ts，段 2 编辑 b.ts（diff 同一累计基线）
      turnStatus: [
        {
          edits: new Map([["a", turnEdit({ rel: "a.ts" })]]),
          shared: true,
        },
        {
          edits: new Map([["b", turnEdit({ rel: "b.ts" })]]),
          shared: true,
        },
      ],
      diffFiles: [
        { path: "a.ts", added: 1, removed: 0 },
        { path: "b.ts", added: 1, removed: 0 },
      ],
    });
    tracker.begin("s1", "turn-1");
    await tick();
    tracker.settle("s1");
    await tick();
    tracker.begin("s1", "turn-2");
    await tick();
    tracker.settle("s1");
    await tick();
    await tick();

    expect(diffCalls[0]?.opts?.paths).toEqual(["a.ts"]);
    // 段 2 复用段 1 的累计基线，作用域必须带上段 1 的 a.ts，否则卡片少文件
    expect(diffCalls[1]?.opts?.paths).toEqual(["a.ts", "b.ts"]);
    expect(pushes.at(-1)?.cp.paths).toEqual(["a.ts", "b.ts"]);
    expect(pushes.at(-1)?.cp.files).toBe(2);
  });

  test("shared 且影子快照失败：只有附加根编辑也显式 paths=[]", async () => {
    const edits = new Map<string, TurnEdit>([
      ["e", turnEdit({ root: "/ext", primary: false, rel: "z.ts" })],
    ]);
    const { tracker, pushes } = makeTracker(snapshotAt([user("hi")]), {
      create: async () => null,
      turnStatus: [{ edits, shared: true }],
      edits: { files: 1, added: 2, removed: 0 },
    });
    tracker.begin("s1", "turn-1");
    await tick();
    tracker.settle("s1");
    await tick();
    await tick();

    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.cp).toMatchObject({
      hash: "",
      paths: [],
      shared: true,
      files: 1,
    });
  });

  test("非 shared：结算清单定格（含改名旧路径），供后续展开/产物过滤", async () => {
    const { tracker, pushes, diffCalls } = makeTracker(
      snapshotAt([user("hi")]),
      {
        turnStatus: { edits: new Map(), shared: false },
        diffFiles: [
          { path: "x.ts", added: 1, removed: 0 },
          { path: "new-y.ts", oldPath: "old-y.ts", added: 1, removed: 1 },
        ],
      },
    );
    tracker.begin("s1", "turn-1");
    await tick();
    tracker.settle("s1");
    await tick();
    await tick();

    // 非 shared 仍保留整仓 diff（bash/脚本兜底），但 patch 在结算刻存档
    expect(diffCalls[0]?.opts).toEqual({ snapshot: true });
    expect(pushes.at(-1)?.cp.paths).toEqual([
      "x.ts",
      "new-y.ts",
      "old-y.ts",
    ]);
    expect(pushes.at(-1)?.cp.shared).toBeUndefined();
  });

  test("shared 且没有任何编辑证据：不出卡（宁缺勿串会话）", async () => {
    const { tracker, pushes, log } = makeTracker(
      snapshotAt([user("hi")]),
      {
        turnStatus: { edits: new Map(), shared: true },
        edits: null,
      },
    );
    tracker.begin("s1", "turn-1");
    await tick();
    tracker.settle("s1");
    await tick();
    await tick();

    expect(log).toContain("edits");
    expect(pushes).toHaveLength(0);
  });

  test("shared 且只有附加根编辑：落空 hash 卡，paths=[] 不展示全仓 diff", async () => {
    const edits = new Map<string, TurnEdit>([
      ["e", turnEdit({ root: "/ext", primary: false, rel: "z.ts" })],
    ]);
    const { tracker, pushes } = makeTracker(snapshotAt([user("hi")]), {
      turnStatus: { edits, shared: true },
      edits: { files: 1, added: 2, removed: 0 },
    });
    tracker.begin("s1", "turn-1");
    await tick();
    tracker.settle("s1");
    await tick();
    await tick();

    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.cp.hash).toBe("");
    expect(pushes[0]?.cp.paths).toEqual([]);
    expect(pushes[0]?.cp.shared).toBe(true);
  });

  test("无 turnId（老链路）：不查所有权层，保持 legacy 全仓 diff", async () => {
    const { tracker, diffCalls, pushes } = makeTracker(
      snapshotAt([user("hi")]),
      {
        turnStatus: { edits: new Map(), shared: true },
        diffFiles: [{ path: "b.ts", added: 1, removed: 0 }],
      },
    );
    tracker.begin("s1"); // turnId=null
    await tick();
    tracker.settle("s1");
    await tick();
    await tick();

    expect(diffCalls[0]?.opts).toEqual({ snapshot: true });
    expect(pushes.at(-1)?.cp.paths).toEqual(["b.ts"]);
    expect(pushes.at(-1)?.cp.shared).toBeUndefined();
  });
});

describe("editsSummaryOf", () => {
  const edit = (over: Record<string, unknown>) =>
    ({ rel: "a.ts", status: "modified", additions: 1, deletions: 0, exact: true, undoable: true, ...over }) as never;

  test("主根与附加根都计入（gitignored 主根文件也能出卡）", () => {
    const edits = new Map<string, never>([
      ["p", edit({ root: "/w", primary: true, rel: "p.ts", additions: 9 })],
      ["e1", edit({ root: "/ext", primary: false, rel: "a.ts", additions: 3, deletions: 1 })],
      ["e2", edit({ root: "/ext", primary: false, rel: "b.ts", additions: 2, deletions: 4 })],
    ]);
    expect(editsSummaryOf(edits)).toEqual({
      files: 3,
      added: 14,
      removed: 5,
    });
  });

  test("旧载荷（无 primary/root）同样计入；空表返回 null", () => {
    const edits = new Map<string, never>([["a", edit({ rel: "a.ts" })]]);
    expect(editsSummaryOf(edits)).toEqual({ files: 1, added: 1, removed: 0 });
    expect(editsSummaryOf(new Map())).toBeNull();
  });
});
