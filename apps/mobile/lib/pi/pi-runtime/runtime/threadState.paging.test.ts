/**
 * 分页窗（§6）在 reducer 侧的行为：
 * - 带 firstSeq 的尾窗快照不冲掉已上翻的旧页（olderMessages 保留）；
 * - 转录增长后新窗首右移，旧窗里落在新窗首之前的行被捡回（不留空档）；
 * - 全量快照（无 firstSeq）清掉旧页（行已在本窗里，留着会重复）；
 * - prependOlderHistory 按 seq 去重、升序、更新 hasMore。
 */
import { describe, expect, it } from "vitest";
import type { PiAgentMessage, PiThreadSnapshot } from "../types";
import {
  createPiThreadState,
  prependOlderHistory,
  reducePiThreadState,
} from "./threadState";

const userRow = (seq: number): PiAgentMessage =>
  ({ role: "user", content: `u${seq}`, timestamp: seq, __seq: seq }) as PiAgentMessage;

const snapshot = (
  messages: PiAgentMessage[],
  meta: { firstSeq?: number; hasMore?: boolean } = {},
): PiThreadSnapshot => ({
  metadata: { id: "t", status: "idle" },
  messages,
  ...(meta.firstSeq !== undefined ? { firstSeq: meta.firstSeq } : {}),
  ...(meta.hasMore !== undefined ? { hasMore: meta.hasMore } : {}),
});

const apply = (
  state: ReturnType<typeof createPiThreadState>,
  snap: PiThreadSnapshot,
) =>
  reducePiThreadState(state, {
    type: "snapshot",
    snapshot: snap,
    threadId: "t",
    seq: 0,
  });

const seqs = (rows: readonly PiAgentMessage[]) =>
  rows.map((r) => (r as { __seq?: number }).__seq);

describe("分页窗 reducer", () => {
  it("尾窗快照保留已上翻的旧页", () => {
    let state = createPiThreadState("t");
    state = apply(state, snapshot([userRow(101), userRow(102)], { firstSeq: 101, hasMore: true }));
    state = prependOlderHistory(state, [userRow(40), userRow(41)], true);
    expect(seqs(state.olderMessages)).toEqual([40, 41]);

    // 一次后台刷新（仍是尾窗）：旧页必须还在
    state = apply(state, snapshot([userRow(101), userRow(102), userRow(103)], { firstSeq: 101, hasMore: true }));
    expect(seqs(state.olderMessages)).toEqual([40, 41]);
    expect(seqs(state.messages)).toEqual([101, 102, 103]);
    expect(state.historyHasMore).toBe(true);
  });

  it("转录增长后新窗首右移：旧窗里被挤出的行捡回旧页（不留空档）", () => {
    let state = createPiThreadState("t");
    state = apply(state, snapshot([userRow(61), userRow(62)], { firstSeq: 61, hasMore: true }));
    state = prependOlderHistory(state, [userRow(50), userRow(51)], false);

    // 会话又长了：新尾窗从 71 起，61/62 落在窗外——不能丢
    state = apply(state, snapshot([userRow(71), userRow(72)], { firstSeq: 71, hasMore: true }));
    expect(seqs(state.olderMessages)).toEqual([50, 51, 61, 62]);
    expect(state.historyHasMore).toBe(true);
  });

  it("全量快照（无 firstSeq）清掉旧页：行已在本窗里，留着会重复", () => {
    let state = createPiThreadState("t");
    state = apply(state, snapshot([userRow(101)], { firstSeq: 101, hasMore: true }));
    state = prependOlderHistory(state, [userRow(40)], true);
    state = apply(state, snapshot([userRow(40), userRow(101)], { hasMore: false }));
    expect(state.olderMessages).toEqual([]);
    expect(state.historyHasMore).toBe(false);
  });

  it("prependOlderHistory 去重、升序、幂等更新 hasMore", () => {
    let state = createPiThreadState("t");
    state = apply(state, snapshot([userRow(100)], { firstSeq: 100, hasMore: true }));
    state = prependOlderHistory(state, [userRow(70), userRow(60), userRow(70)], true);
    expect(seqs(state.olderMessages)).toEqual([60, 70]);
    // 重放同一页（重复触发）：行不变即引用不变，只翻 hasMore
    const before = state.olderMessages;
    state = prependOlderHistory(state, [userRow(70), userRow(60)], false);
    expect(state.olderMessages).toBe(before);
    expect(state.historyHasMore).toBe(false);
  });
});
