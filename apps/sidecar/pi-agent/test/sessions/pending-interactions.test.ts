import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage, sessionPath } from "../../src/storage/storage";
import {
  beginInteraction,
  dropSessionInteractions,
  hasPendingInteractions,
  listPendingForSession,
  rememberThreadSession,
  restoreUnsettled,
  sessionForThread,
  settleInteraction,
} from "../../src/sessions/pending-interactions";
import { scanTranscript, windowTranscriptMessages } from "../../src/sessions/transcript";
import type { PendingInteraction } from "pi-protocol";

/**
 * 挂起交互台账 + 转录交互行 + 分页窗测试（设计文档 §4/§6）。
 * 落行走真实 initStorage 临时目录：行格式是持久化契约，不做内存桩。
 */

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-pending-"));
beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
});

const perm = (id: string, toolName = "bash"): PendingInteraction => ({
  interactionId: id,
  kind: "permission",
  anchorToolCallId: `tc-${id}`,
  payload: { approvalId: id, toolCallId: `tc-${id}`, toolName, input: null },
  createdAt: new Date().toISOString(),
});

const rowsOf = (sessionId: string): string[] =>
  readFileSync(sessionPath(sessionId), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).type as string);

describe("pending-interactions 台账", () => {
  test("未绑定会话的线程：降级为不落行、不登记", () => {
    beginInteraction("thread-nobind", perm("a0"));
    expect(hasPendingInteractions("thread-nobind")).toBe(false);
    expect(settleInteraction("a0", "approved")).toBe(false);
  });

  test("发起落行 → 列表可见 → 结算落行 → 列表清空", () => {
    const sid = "sess-ledger-1";
    appendFileSync(sessionPath(sid) , '{"type":"header","schema":1,"id":"sess-ledger-1"}\n');
    rememberThreadSession("thread-ledger-1", sid);
    expect(sessionForThread("thread-ledger-1")).toBe(sid);

    beginInteraction("thread-ledger-1", perm("a1"));
    beginInteraction("thread-ledger-1", {
      ...perm("tc-q1", "Question"),
      kind: "question",
      payload: { questionId: "tc-q1", anchorToolCallId: "tc-q1", questions: [{ title: "?1" }] },
    });
    expect(hasPendingInteractions(sid)).toBe(true);
    expect(listPendingForSession(sid).map((i) => i.interactionId)).toEqual(["a1", "tc-q1"]);
    expect(rowsOf(sid)).toEqual(["header", "pending_interaction", "pending_interaction"]);

    expect(settleInteraction("a1", "denied")).toBe(true);
    expect(settleInteraction("a1", "denied")).toBe(false); // 幂等：重复结算不再落行
    expect(listPendingForSession(sid).map((i) => i.interactionId)).toEqual(["tc-q1"]);
    expect(rowsOf(sid)).toEqual([
      "header",
      "pending_interaction",
      "pending_interaction",
      "interaction_resolved",
    ]);
  });

  test("scanTranscript 配对未结算交互（含重启重放与驱逐不依赖驻留）", () => {
    const sid = "sess-scan-1";
    // 手工构造混合转录：消息行/队列行/未知行/撕裂缝隙穿插交互行
    const lines = [
      { type: "header", schema: 1, id: sid },
      { type: "message", seq: 0, agent: { role: "user", content: "hi" } },
      { type: "pending_interaction", interaction: perm("s-a") },
      { type: "queue_state", snapshot: { version: 2, items: [] } },
      { type: "pending_interaction", interaction: perm("s-b") },
      { type: "message", seq: 1, agent: { role: "assistant", content: [{ type: "text", text: "yo" }] } },
      { type: "interaction_resolved", interactionId: "s-a", resolution: "approved", resolvedAt: "x" },
      { type: "future_row_kind", seq: 99 },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n");
    writeFileSync(sessionPath(sid), lines + "\n");

    const scan = scanTranscript(sid);
    expect(scan.messages.map((m) => m.seq)).toEqual([0, 1]);
    expect(scan.pending.map((i) => i.interactionId)).toEqual(["s-b"]);

    // 重启物化重放：恢复项进台账、挡驱逐；结算后解禁
    restoreUnsettled(sid, "thread-scan-1", scan.pending);
    expect(hasPendingInteractions(sid)).toBe(true);
    expect(settleInteraction("s-b", "cancelled")).toBe(true);
    expect(hasPendingInteractions(sid)).toBe(false);
    expect(rowsOf(sid).at(-1)).toBe("interaction_resolved");
  });

  test("dropSessionInteractions：条目与线程绑定同清", () => {
    const sid = "sess-drop-1";
    rememberThreadSession("thread-drop-1", sid);
    beginInteraction("thread-drop-1", perm("d1"));
    expect(listPendingForSession(sid).length).toBe(1);
    dropSessionInteractions(sid);
    expect(listPendingForSession(sid).length).toBe(0);
    expect(sessionForThread("thread-drop-1")).toBeUndefined();
    // 行仍留在转录里（删除语义由文件消失承担），但内存清单已空
    beginInteraction("thread-drop-1", perm("d2"));
    expect(listPendingForSession(sid).length).toBe(0); // 绑定没了 → 降级
  });
});

describe("windowTranscriptMessages 分页窗（§6）", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ seq: i }));

  test("缺省全量：旧端不破，hasMore=false，空表 first/last=null", () => {
    const full = windowTranscriptMessages(rows, {});
    expect(full.window.length).toBe(10);
    expect(full.meta).toEqual({ firstSeq: 0, lastSeq: 9, hasMore: false });
    const empty = windowTranscriptMessages([] as typeof rows, { tail: 5 });
    expect(empty.meta).toEqual({ firstSeq: null, lastSeq: null, hasMore: false });
  });

  test("tail：取尾窗，窗之前还有 → hasMore", () => {
    const w = windowTranscriptMessages(rows, { tail: 4 });
    expect(w.window.map((r) => r.seq)).toEqual([6, 7, 8, 9]);
    expect(w.meta).toEqual({ firstSeq: 6, lastSeq: 9, hasMore: true });
    const exact = windowTranscriptMessages(rows, { tail: 10 });
    expect(exact.meta.hasMore).toBe(false);
  });

  test("beforeSeq：游标之前全给（向更早翻）；与 tail 组合取尾", () => {
    const before = windowTranscriptMessages(rows, { beforeSeq: 3 });
    expect(before.window.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(before.meta.hasMore).toBe(false);
    const both = windowTranscriptMessages(rows, { beforeSeq: 6, tail: 2 });
    expect(both.window.map((r) => r.seq)).toEqual([4, 5]);
    expect(both.meta.hasMore).toBe(true);
  });

  test("非整数/缺省参数忽略（宽松入参）", () => {
    const w = windowTranscriptMessages(rows, { tail: 1.5, beforeSeq: undefined });
    expect(w.window.length).toBe(10);
  });
});
