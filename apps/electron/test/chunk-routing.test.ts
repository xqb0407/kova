/// <reference path="./bun-test.d.ts" />
import { describe, expect, test } from "bun:test";
import {
  normalizeWatchedIds,
  routeChunkLines,
  type ChunkBatchLine,
} from "../main/chunk-routing";

/**
 * 主进程按窗口裁剪的回归保护：这是 pi-chunk-batch 定向投递的唯一规则，
 * 裁错会丢事件、裁漏会让后台会话的逐 token 增量继续跨进程。
 */

const heavy = (sid: string | null, l = `update:${sid}`): ChunkBatchLine => ({
  l,
  sid,
  heavy: true,
});
const light = (l: string): ChunkBatchLine => ({ l });

describe("routeChunkLines", () => {
  test("未登记观看集合的窗口保持全量广播", () => {
    const lines = [heavy("a"), heavy("b"), light("agent_start")];
    expect(routeChunkLines(lines, undefined).map((x) => x.l)).toEqual([
      "update:a",
      "update:b",
      "agent_start",
    ]);
  });

  test("登记后只裁掉其他会话的逐 token 增量，状态行全部保留", () => {
    const lines = [
      light("agent_start"),
      heavy("a"),
      heavy("b"),
      heavy(null), // legacy 行无会话键：一律保留
      light("agent_end"),
    ];
    expect(routeChunkLines(lines, new Set(["a"])).map((x) => x.l)).toEqual([
      "agent_start",
      "update:a",
      "update:null",
      "agent_end",
    ]);
  });

  test("空观看集合（资源窗口）保留非重行、裁掉全部逐 token 增量", () => {
    const lines = [light("agent_start"), heavy("a"), light("data-plugin")];
    expect(routeChunkLines(lines, new Set()).map((x) => x.l)).toEqual([
      "agent_start",
      "data-plugin",
    ]);
  });

  test("输出只保留行文本，不带 sid/heavy 元数据", () => {
    expect(routeChunkLines([{ l: "x", sid: "a", heavy: true }], new Set(["a"]))).toEqual([
      { l: "x" },
    ]);
  });

  test("normalizeWatchedIds 丢弃非数组、非字符串与空串", () => {
    expect([...normalizeWatchedIds(["a", "", 1, null, "b"])]).toEqual(["a", "b"]);
    expect(normalizeWatchedIds("a").size).toBe(0);
    expect(normalizeWatchedIds(undefined).size).toBe(0);
  });
});
