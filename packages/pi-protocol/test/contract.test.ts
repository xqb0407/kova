/**
 * 契约包基础测试：schema 接受/拒绝形状 + checkFrame 边界策略。
 * 设计文档 plans/session-context-design.md §9：dev/test 严格抛、prod 记报放行。
 */
import { describe, expect, test } from "bun:test";
import {
  queueSnapshotSchema,
  turnChangedFrameSchema,
  sessionsChangedFrameSchema,
  subagentActivityFrameSchema,
  errorResponseFrameSchema,
  sessionStateFrameSchema,
  readSeqStamp,
  checkFrame,
  pendingInteractionSchema,
  pendingInteractionFileRowSchema,
  interactionResolvedFileRowSchema,
  listPendingRequestSchema,
  pendingResponseFrameSchema,
  historyWindowMetaSchema,
  contextChangedFrameSchema,
  errorPayloadSchema,
  transcriptHeaderSchema,
  modelChangeRowSchema,
  thinkingLevelChangeRowSchema,
  sessionInfoRowSchema,
} from "../src/index";

describe("queueSnapshotSchema", () => {
  const good = {
    version: 2,
    threadId: "t1",
    items: [{ id: 1, reqId: "r1", text: "hi", createdAt: "2026-09-22T00:00:00Z" }],
    nextId: 2,
  };
  test("接受合法快照", () => {
    expect(queueSnapshotSchema.safeParse(good).success).toBe(true);
  });
  test("loose：未知字段透传保留（协议只增不改）", () => {
    const parsed = queueSnapshotSchema.parse({ ...good, pausedReason: "manual" });
    expect((parsed as Record<string, unknown>).pausedReason).toBe("manual");
  });
  test("拒绝：version 漂移 / items 非数组 / 条目缺字段", () => {
    expect(queueSnapshotSchema.safeParse({ ...good, version: 3 }).success).toBe(false);
    expect(queueSnapshotSchema.safeParse({ ...good, items: {} }).success).toBe(false);
    expect(
      queueSnapshotSchema.safeParse({ ...good, items: [{ id: 1 }] }).success,
    ).toBe(false);
  });
  test("条目附件 = prompt 帧同形（name/mimeType/data|path，无 type 字段）", () => {
    const withAttachments = {
      ...good,
      items: [
        {
          ...good.items[0],
          attachments: [
            { name: "image-1.png", mimeType: "image/png", data: "AAAA" },
            { mimeType: "image/jpeg", path: "/tmp/shot.jpg" },
          ],
        },
      ],
    };
    expect(queueSnapshotSchema.safeParse(withAttachments).success).toBe(true);
    // mimeType 缺省即拒（附件种类判定单源在 mimeType，没有 data/path 也拒）
    expect(
      queueSnapshotSchema.safeParse({
        ...good,
        items: [{ ...good.items[0], attachments: [{ data: "AAAA" }] }],
      }).success,
    ).toBe(false);
  });
});

describe("通知帧 schema", () => {
  test("turn_changed 带未知新字段仍可解析（加性演进）", () => {
    const parsed = turnChangedFrameSchema.parse({
      type: "turn_changed",
      sessionId: "s1",
      active: true,
      eventSeq: 7,
    });
    expect((parsed as Record<string, unknown>).eventSeq).toBe(7);
  });
  test("sessions_changed：三档 op 可解析、缺 op/非法 op 拒收、未知字段透传", () => {
    const parsed = sessionsChangedFrameSchema.parse({
      type: "sessions_changed",
      op: "created",
      sessionId: "s1",
      origin: "mobile", // 未知字段 loose 透传
    });
    expect((parsed as Record<string, unknown>).origin).toBe("mobile");
    for (const op of ["created", "updated", "deleted"]) {
      expect(
        sessionsChangedFrameSchema.safeParse({
          type: "sessions_changed",
          op,
          sessionId: "s1",
        }).success,
      ).toBe(true);
    }
    expect(
      sessionsChangedFrameSchema.safeParse({
        type: "sessions_changed",
        sessionId: "s1",
      }).success,
    ).toBe(false);
    expect(
      sessionsChangedFrameSchema.safeParse({
        type: "sessions_changed",
        op: "moved",
        sessionId: "s1",
      }).success,
    ).toBe(false);
  });
  test("subagent_activity 按 kind 分流；未知 kind 拒收", () => {
    expect(
      subagentActivityFrameSchema.safeParse({
        type: "subagent_activity",
        delegationId: "d1",
        item: { kind: "text", op: "delta", id: "c1", delta: "x", at: 1 },
      }).success,
    ).toBe(true);
    expect(
      subagentActivityFrameSchema.safeParse({
        type: "subagent_activity",
        delegationId: "d1",
        item: { kind: "bogus", at: 1 },
      }).success,
    ).toBe(false);
  });
});

describe("checkFrame 边界策略", () => {
  const bad = { version: 99, threadId: "t", items: "no", nextId: 1 };
  test("strict 模式契约漂移即抛", () => {
    expect(() =>
      checkFrame(queueSnapshotSchema, bad, {
        strict: true,
        where: "test",
        report: () => {},
      }),
    ).toThrow(/contract violation/);
  });
  test("宽松模式记上报并原样放行（旧行为兜底）", () => {
    let reported = 0;
    const out = checkFrame(queueSnapshotSchema, bad, {
      strict: false,
      where: "test",
      report: () => (reported += 1),
    });
    expect(reported).toBe(1);
    // 宽松模式原样放行同一引用（畸形帧的最终拒收由消费端守卫负责）
    expect((out as unknown) === bad).toBe(true);
  });
  test("错误帧：errorText 兜底 + error 对象加性扩展", () => {
    const parsed = errorResponseFrameSchema.parse({
      id: "x",
      type: "error",
      errorText: "429: rate limited",
      error: { code: "rate_limit", source: "provider", retryable: true, statusCode: 429 },
    });
    expect(parsed.error?.retryable).toBe(true);
    expect(errorResponseFrameSchema.safeParse({ type: "error" }).success).toBe(false);
  });
});

describe("session_state 与水印观察（§2/§3）", () => {
  test("session_state 帧：相位枚举 + loose 透传", () => {
    expect(
      sessionStateFrameSchema.safeParse({
        type: "session_state",
        sessionId: "s1",
        phase: "evicted",
        eventSeq: 7,
      }).success,
    ).toBe(true);
    expect(
      sessionStateFrameSchema.safeParse({
        type: "session_state",
        sessionId: "s1",
        phase: "bogus",
      }).success,
    ).toBe(false);
    const parsed = sessionStateFrameSchema.parse({
      type: "session_state",
      sessionId: "s1",
      phase: "idle",
      futureField: 1,
    });
    expect((parsed as Record<string, unknown>).futureField).toBe(1);
  });

  test("readSeqStamp 认出四类回拉帧并路由修复类别", () => {
    expect(
      readSeqStamp({ type: "session_state", sessionId: "s1", phase: "running", eventSeq: 3 }),
    ).toEqual({ sessionId: "s1", eventSeq: 3, kind: "running" });
    expect(
      readSeqStamp({
        id: "pi-r",
        chunk: { type: "data-queue-state", data: { threadId: "t1" } },
        sessionId: "s1",
        eventSeq: 4,
      }),
    ).toEqual({ sessionId: "s1", eventSeq: 4, kind: "queue" });
    expect(
      readSeqStamp({
        id: "pi-r",
        chunk: { type: "data-planningState", data: {} },
        sessionId: "s1",
        eventSeq: 5,
      }),
    ).toEqual({ sessionId: "s1", eventSeq: 5, kind: "planning" });
    // M2：挂起交互发起帧纳入水印（漏收 → 回拉 list_pending）
    expect(
      readSeqStamp({
        id: "pi-r",
        chunk: { type: "data-toolApproval", data: { approvalId: "a1" } },
        sessionId: "s1",
        eventSeq: 6,
      }),
    ).toEqual({ sessionId: "s1", eventSeq: 6, kind: "pending" });
    expect(
      readSeqStamp({
        id: "pi-r",
        chunk: { type: "data-question", data: { questionId: "tc-1" } },
        sessionId: "s1",
        eventSeq: 7,
      }),
    ).toEqual({ sessionId: "s1", eventSeq: 7, kind: "pending" });
  });

  test("readSeqStamp 忽略：未盖章/缺 sessionId/非水印 chunk/坏号", () => {
    expect(readSeqStamp({ type: "turn_changed", sessionId: "s1", active: true })).toBeNull();
    expect(readSeqStamp({ chunk: { type: "text-delta" }, eventSeq: 2 })).toBeNull();
    expect(readSeqStamp({ id: "x", chunk: { type: "text-delta" }, eventSeq: 2 })).toBeNull();
    expect(
      readSeqStamp({ type: "session_state", sessionId: "s1", phase: "idle", eventSeq: -1 }),
    ).toBeNull();
    expect(readSeqStamp(null)).toBeNull();
  });
});

describe("挂起交互契约（§4/§6 M2）", () => {
  const permissionInteraction = {
    interactionId: "ap-1",
    kind: "permission",
    anchorToolCallId: "tc-1",
    payload: { approvalId: "ap-1", toolCallId: "tc-1", toolName: "bash", input: { command: "ls" } },
    createdAt: "2026-09-22T00:00:00.000Z",
  };
  const questionInteraction = {
    interactionId: "tc-2",
    kind: "question",
    anchorToolCallId: "tc-2",
    payload: { questionId: "tc-2", anchorToolCallId: "tc-2", questions: [{ title: "选哪个" }] },
    createdAt: "2026-09-22T00:00:00.000Z",
  };

  test("pendingInteraction：两类载荷 + expiresAt 预留位 + loose 透传", () => {
    expect(pendingInteractionSchema.safeParse(permissionInteraction).success).toBe(true);
    expect(pendingInteractionSchema.safeParse(questionInteraction).success).toBe(true);
    expect(
      pendingInteractionSchema.safeParse({ ...permissionInteraction, expiresAt: "later" }).success,
    ).toBe(true);
    expect(pendingInteractionSchema.safeParse({ ...permissionInteraction, kind: "bogus" }).success).toBe(false);
  });

  test("转录行 schema：发起/结算行按 interactionId 配对，未知字段透传", () => {
    const issueRow = pendingInteractionFileRowSchema.parse({
      type: "pending_interaction",
      ts: "2026-09-22T00:00:00.000Z",
      interaction: permissionInteraction,
      futureColumn: 1,
    });
    expect((issueRow.interaction.payload as { approvalId: string }).approvalId).toBe("ap-1");
    expect(
      interactionResolvedFileRowSchema.safeParse({
        type: "interaction_resolved",
        interactionId: "ap-1",
        resolution: "approved",
        resolvedAt: "2026-09-22T00:01:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      interactionResolvedFileRowSchema.safeParse({
        type: "interaction_resolved",
        interactionId: "ap-1",
        resolution: "bogus",
        resolvedAt: "x",
      }).success,
    ).toBe(false);
  });

  test("list_pending 请求/应答帧：sessionId 与 threadId 皆可，items 全量", () => {
    expect(listPendingRequestSchema.safeParse({ type: "list_pending", sessionId: "s1" }).success).toBe(true);
    expect(listPendingRequestSchema.safeParse({ type: "list_pending", threadId: "t1" }).success).toBe(true);
    expect(pendingResponseFrameSchema.safeParse({ id: "r1", type: "pending", items: [permissionInteraction, questionInteraction] }).success).toBe(true);
    expect(pendingResponseFrameSchema.safeParse({ id: "r1", type: "pending" }).success).toBe(false);
  });

  test("history 窗口元数据：空窗 null + hasMore 布尔", () => {
    expect(historyWindowMetaSchema.safeParse({ firstSeq: 3, lastSeq: 98, hasMore: true }).success).toBe(true);
    expect(historyWindowMetaSchema.safeParse({ firstSeq: null, lastSeq: null, hasMore: false }).success).toBe(true);
    expect(historyWindowMetaSchema.safeParse({ firstSeq: 3, lastSeq: 98 }).success).toBe(false);
  });
});

describe("上下文推送与错误归因（§7/§8 M3）", () => {
  test("context_changed：四类读数 + cacheHitRatio 可 null + loose 透传", () => {
    expect(
      contextChangedFrameSchema.safeParse({
        type: "context_changed",
        sessionId: "s1",
        usedTokens: 51234,
        threshold: 160000,
        contextWindow: 200000,
        cacheHitRatio: 0.62,
        eventSeq: 12,
      }).success,
    ).toBe(true);
    expect(
      contextChangedFrameSchema.safeParse({
        type: "context_changed",
        sessionId: "s1",
        usedTokens: 0,
        threshold: 0,
        contextWindow: 0,
        cacheHitRatio: null,
      }).success,
    ).toBe(true);
    // 越界/缺字段拒收；未知字段透传
    expect(
      contextChangedFrameSchema.safeParse({
        type: "context_changed",
        sessionId: "s1",
        usedTokens: -1,
        threshold: 0,
        contextWindow: 0,
        cacheHitRatio: 1.5,
      }).success,
    ).toBe(false);
    expect(
      contextChangedFrameSchema.safeParse({ type: "context_changed", sessionId: "s1" }).success,
    ).toBe(false);
    const parsed = contextChangedFrameSchema.parse({
      type: "context_changed",
      sessionId: "s1",
      usedTokens: 1,
      threshold: 2,
      contextWindow: 3,
      cacheHitRatio: null,
      futureField: true,
    });
    expect((parsed as Record<string, unknown>).futureField).toBe(true);
  });

  test("readSeqStamp 认出 context_changed（缺口回拉 context_info）", () => {
    expect(
      readSeqStamp({
        type: "context_changed",
        sessionId: "s1",
        usedTokens: 10,
        threshold: 100,
        contextWindow: 128,
        cacheHitRatio: null,
        eventSeq: 9,
      }),
    ).toEqual({ sessionId: "s1", eventSeq: 9, kind: "context" });
    // 未盖章的 context_changed 不参与水印观察
    expect(
      readSeqStamp({
        type: "context_changed",
        sessionId: "s1",
        usedTokens: 10,
        threshold: 100,
        contextWindow: 128,
        cacheHitRatio: null,
      }),
    ).toBeNull();
  });

  test("error 归因载荷：source 四类枚举 + statusCode 边界", () => {
    expect(
      errorPayloadSchema.safeParse({ code: "NETWORK_ERROR", source: "network", retryable: true }).success,
    ).toBe(true);
    expect(
      errorPayloadSchema.safeParse({
        code: "PROVIDER_RATE_LIMITED",
        source: "provider",
        retryable: true,
        statusCode: 429,
      }).success,
    ).toBe(true);
    expect(
      errorPayloadSchema.safeParse({ code: "X", source: "bogus", retryable: false }).success,
    ).toBe(false);
    expect(
      errorPayloadSchema.safeParse({
        code: "X",
        source: "runtime",
        retryable: false,
        statusCode: 99,
      }).success,
    ).toBe(false);
  });
});

describe("转录上下文设定行（§6 M4 上游对齐）", () => {
  test("header：parentSession 可选溯源；未知字段透传；缺 schema 拒收", () => {
    expect(
      transcriptHeaderSchema.safeParse({
        type: "header",
        schema: 1,
        id: "s1",
        cwd: "/tmp",
        created_at: "2026-09-22T00:00:00.000Z",
        parentSession: "s0",
      }).success,
    ).toBe(true);
    expect(
      transcriptHeaderSchema.safeParse({ type: "header", schema: 1, id: "s1", cwd: "/tmp" })
        .success,
    ).toBe(true);
    expect(
      transcriptHeaderSchema.safeParse({ type: "header", id: "s1", cwd: "/tmp" }).success,
    ).toBe(false);
  });

  test("model_change：上游树位行（带 id/parentId）loose 透传可收；缺字段拒收", () => {
    // 上游 session-format.md §ModelChangeEntry 原样一行（含我们不用的树位字段）
    expect(
      modelChangeRowSchema.safeParse({
        type: "model_change",
        id: "d4e5f6g7",
        parentId: "c3d4e5f6",
        timestamp: "2024-12-03T14:05:00.000Z",
        provider: "openai",
        modelId: "gpt-4o",
      }).success,
    ).toBe(true);
    // 本项目线性写法：无 id/parentId、timestamp 可选
    expect(
      modelChangeRowSchema.safeParse({
        type: "model_change",
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
      }).success,
    ).toBe(true);
    expect(
      modelChangeRowSchema.safeParse({ type: "model_change", provider: "openai" }).success,
    ).toBe(false);
  });

  test("thinking_level_change：档位 string 不锁枚举（读端校验保向前兼容）", () => {
    expect(
      thinkingLevelChangeRowSchema.safeParse({
        type: "thinking_level_change",
        id: "e5f6g7h8",
        parentId: "d4e5f6g7",
        timestamp: "2024-12-03T14:06:00.000Z",
        thinkingLevel: "high",
      }).success,
    ).toBe(true);
    // 上游未来新增档位值照收——校验在消费端做
    expect(
      thinkingLevelChangeRowSchema.safeParse({
        type: "thinking_level_change",
        thinkingLevel: "ultra",
      }).success,
    ).toBe(true);
    expect(
      thinkingLevelChangeRowSchema.safeParse({ type: "thinking_level_change" }).success,
    ).toBe(false);
  });

  test("session_info：name 必填 string", () => {
    expect(
      sessionInfoRowSchema.safeParse({
        type: "session_info",
        id: "k1l2m3n4",
        parentId: "j0k1l2m3",
        timestamp: "2024-12-03T14:35:00.000Z",
        name: "Refactor auth module",
      }).success,
    ).toBe(true);
    expect(sessionInfoRowSchema.safeParse({ type: "session_info" }).success).toBe(false);
  });
});
