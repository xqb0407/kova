/**
 * 本地测试（非 vendored）：排期预览纯函数。
 * cron 触发点依赖本地时区（croner 语义），断言只取与 tz 无关的性质：
 * 数量 / 严格递增 / 落在今后不久；interval/once 完全确定。
 */
import { describe, expect, it } from "bun:test";
import { previewSchedule } from "./preview";

const NOW = Date.UTC(2026, 8, 15, 12);

describe("previewSchedule", () => {
  it("interval：从预览时刻起每周期一格", () => {
    const r = previewSchedule({ type: "interval", schedule: "10m", count: 3 }, NOW);
    expect(r).toEqual({
      runs: [
        new Date(NOW + 10 * 60_000).toISOString(),
        new Date(NOW + 20 * 60_000).toISOString(),
        new Date(NOW + 30 * 60_000).toISOString(),
      ],
    });
  });

  it("once：未来时刻原样一个；过去时刻/非法值报 error", () => {
    // once 的前后性校验按真实时钟（resolveOnceSchedule），与 nowMs 参数无关，
    // 故未来/过去样本取绝对年份保证确定性
    const future = "2099-01-01T00:00:00.000Z";
    expect(previewSchedule({ type: "once", schedule: future }, NOW)).toEqual({ runs: [future] });
    const past = previewSchedule({ type: "once", schedule: "2020-01-01T00:00:00.000Z" }, NOW);
    expect("error" in past && past.error).toContain("past");
  });

  it("cron：取未来 count 个严格递增的 tick", () => {
    const r = previewSchedule({ type: "cron", schedule: "* * * * *", count: 2 }, NOW);
    if (!("runs" in r)) throw new Error("expected runs");
    expect(r.runs).toHaveLength(2);
    const ms = r.runs.map((s) => new Date(s).getTime());
    expect(ms[0]).toBeGreaterThan(NOW);
    expect(ms[1] - ms[0]).toBe(60_000);
  });

  it("非法表达式回 error 不抛出；count 越界夹到 1..10", () => {
    expect("error" in previewSchedule({ type: "cron", schedule: "nope" }, NOW)).toBe(true);
    expect("error" in previewSchedule({ type: undefined }, NOW)).toBe(true);
    const one = previewSchedule({ type: "interval", schedule: "1m", count: 0 }, NOW);
    expect("runs" in one && one.runs).toHaveLength(1);
    const capped = previewSchedule({ type: "interval", schedule: "1m", count: 999 }, NOW);
    expect("runs" in capped && capped.runs).toHaveLength(10);
  });
});
