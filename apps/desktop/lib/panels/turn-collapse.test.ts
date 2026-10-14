import { beforeEach, describe, expect, test } from "bun:test";

import {
  __resetTurnStoresForTests,
  computeTurnDurationMs,
  noteTurnEnd,
  resolveTurnTimingWrite,
  restartTurnTiming,
  getTurnCollapseOverride,
  getTurnTiming,
  noteTurnStart,
  scopedTurnKey,
  seedTurnTiming,
  setTurnCollapsed,
} from "./turn-collapse";

describe("scopedTurnKey", () => {
  test("带会话维度：同一消息 id 在不同会话下不串键", () => {
    expect(scopedTurnKey("t1", "msg-5")).not.toBe(scopedTurnKey("t2", "msg-5"));
  });

  test("threadId 缺失时退化为消息 id", () => {
    expect(scopedTurnKey(undefined, "msg-5")).toBe(":msg-5");
  });
});

describe("折叠覆盖", () => {
  beforeEach(() => __resetTurnStoresForTests());

  test("点开/点收都记成显式覆盖，自动策略不再翻回去", () => {
    const key = scopedTurnKey("t1", "u1");
    expect(getTurnCollapseOverride(key)).toBeUndefined();
    setTurnCollapsed(key, false);
    expect(getTurnCollapseOverride(key)).toBe(false);
    setTurnCollapsed(key, true);
    expect(getTurnCollapseOverride(key)).toBe(true);
  });
});

describe("耗时台账", () => {
  beforeEach(() => __resetTurnStoresForTests());

  test("历史播种优先于直播打点（先写下的时间戳不被观测值覆盖）", () => {
    const key = scopedTurnKey("t1", "u1");
    seedTurnTiming(key, { start: 1000, end: 5000 });
    noteTurnStart(key, 999_999);
    expect(getTurnTiming(key)).toEqual({ start: 1000, end: 5000 });
  });

  test("补记结束：只对直播轮生效，历史播种轮不编造 end", () => {
    // 直播轮：记开始（标记 live）后可以补结束
    const live = scopedTurnKey("t1", "u1");
    noteTurnStart(live, 1_000);
    noteTurnEnd(live, 6_000);
    expect(getTurnTiming(live)).toEqual({ start: 1_000, end: 6_000, live: true });
    // 已有 end 不覆盖
    noteTurnEnd(live, 9_999);
    expect(getTurnTiming(live)?.end).toBe(6_000);

    // 历史播种轮（没有 live 标记）：补结束被忽略，避免造出假时长
    const seeded = scopedTurnKey("t1", "u2");
    seedTurnTiming(seeded, { start: 1_000 });
    noteTurnEnd(seeded, 6_000);
    expect(getTurnTiming(seeded)).toEqual({ start: 1_000 });
  });

  test("直播打点只在没有开始时写一次", () => {
    const key = scopedTurnKey("t1", "u2");
    noteTurnStart(key, 100);
    noteTurnStart(key, 200);
    expect(getTurnTiming(key)?.start).toBe(100);
  });
});

describe("重新生成（Reload）后的计时", () => {
  beforeEach(() => __resetTurnStoresForTests());

  test("决策：进行中且两端都齐 ⇒ 重开计时（不累积上一次的等待）", () => {
    expect(resolveTurnTimingWrite(undefined, true)).toBe("start");
    expect(resolveTurnTimingWrite({ start: 1_000 }, true)).toBe("start");
    expect(resolveTurnTimingWrite({ start: 1_000, end: 6_000 }, true)).toBe("restart");
    expect(resolveTurnTimingWrite({ start: 1_000, line: undefined } as never, false)).toBe("end");
    expect(resolveTurnTimingWrite(undefined, false)).toBe("end");
  });

  test("重开后耗时只算这一次：旧开始/旧结束都作废", () => {
    const key = scopedTurnKey("t1", "u1");
    // 第一次尝试：1s → 6s
    noteTurnStart(key, 1_000);
    noteTurnEnd(key, 6_000);
    expect(computeTurnDurationMs(getTurnTiming(key), null, false)).toBe(5_000);

    // 用户在 60s 时点了重新生成（Reload）→ 重开计时
    restartTurnTiming(key, 60_000);
    expect(getTurnTiming(key)).toEqual({ start: 60_000, live: true });
    // 这一次 60s → 63s ⇒ 3s（而不是把 1s→63s 的 62s 全算上）
    noteTurnEnd(key, 63_000);
    expect(computeTurnDurationMs(getTurnTiming(key), null, false)).toBe(3_000);
  });
});

describe("computeTurnDurationMs", () => {
  test("直播轮：开始取自台账，结束优先取流结束时刻", () => {
    expect(computeTurnDurationMs({ start: 1000 }, 6000, false)).toBe(5000);
  });

  test("历史轮：两端都来自台账", () => {
    expect(computeTurnDurationMs({ start: 1000, end: 9000 }, null, false)).toBe(8000);
  });

  test("运行中不显示；任一缺端不显示；非正值不显示", () => {
    expect(computeTurnDurationMs({ start: 1000 }, 6000, true)).toBeUndefined();
    expect(computeTurnDurationMs(undefined, 6000, false)).toBeUndefined();
    expect(computeTurnDurationMs({ start: 1000 }, null, false)).toBeUndefined();
    expect(computeTurnDurationMs({ start: 6000, end: 1000 }, null, false)).toBeUndefined();
  });

  test("亚秒级不显示（定时任务转录同批落盘 ⇒ 差值为 0，显示「0 秒」是噪音）", () => {
    expect(computeTurnDurationMs({ start: 1000, end: 1002 }, null, false)).toBeUndefined();
    expect(computeTurnDurationMs({ start: 1000, end: 2000 }, null, false)).toBe(1000);
  });
});
