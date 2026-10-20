import { beforeEach, describe, expect, test } from "bun:test";

import {
  __resetTurnStoresForTests,
  computeTurnDurationMs,
  noteTurnEnd,
  resolveObservedTurnTimingWrite,
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

describe("直播打点动作过滤（排队接棒 / 播种条目）", () => {
  beforeEach(() => __resetTurnStoresForTests());

  test("排队项接棒不重开上一轮：内容条数没涨就不是重跑", () => {
    const ended = { start: 1_000, end: 6_000, live: true, endContentCount: 2 };
    // 上一轮中止/结束后队列立刻派发下一轮：agent_end 已补记结束，agent_start
    // 又把线程拉回 running，而末轮还是上一条——这里必须是 none，不能 restart
    expect(resolveObservedTurnTimingWrite(ended, true, 2)).toBe("none");
    // 末轮真的长出新内容（重试/续跑）才是重开
    expect(resolveObservedTurnTimingWrite(ended, true, 3)).toBe("restart");
  });

  test("排队接棒窗口不毁掉上一轮耗时（端到端回放）", () => {
    const key = scopedTurnKey("t1", "u1");
    noteTurnStart(key, 1_000);
    // 中止 → agent_end → 线程空闲：补记结束（此时本轮有 2 条实质 assistant）
    expect(resolveObservedTurnTimingWrite(getTurnTiming(key), false, 2)).toBe("end");
    noteTurnEnd(key, 6_000, 2);
    // 立即发送：下一轮 agent_start 把线程拉回 running，末轮仍是上一条
    expect(resolveObservedTurnTimingWrite(getTurnTiming(key), true, 2)).toBe("none");
    // 下一轮用户消息落位，录制器给上一轮补结束（已有 end 不再覆盖）
    noteTurnEnd(key, 6_000 + 30, 2);
    expect(computeTurnDurationMs(getTurnTiming(key), null, false)).toBe(5_000);
  });

  test("纯 data 分隔线在轮末追加不算重跑", () => {
    // 手动压缩/模型切换会在轮末追加分隔线消息：内容条数不变
    const ended = { start: 1_000, end: 6_000, live: true, endContentCount: 2 };
    expect(resolveObservedTurnTimingWrite(ended, true, 2)).toBe("none");
  });

  test("补记结束只写一次结束时刻，内容条数可跟随最新提交", () => {
    const key = scopedTurnKey("t1", "u1");
    noteTurnStart(key, 1_000);
    noteTurnEnd(key, 6_000, 1);
    noteTurnEnd(key, 9_999, 2);
    expect(getTurnTiming(key)).toEqual({
      start: 1_000,
      end: 6_000,
      live: true,
      endContentCount: 2,
    });
  });

  test("历史播种条目在轮内是权威：两端齐了也不 restart", () => {
    // 乐观 id 落盘换 pi-msg:seq 时同一轮以新键重见；播种条目没有 live 标记
    const seeded = { start: 1_000, end: 6_000 };
    expect(resolveObservedTurnTimingWrite(seeded, true, 9)).toBe("none");
    // 直播打点的条目仍按原语义重开
    expect(
      resolveObservedTurnTimingWrite(
        { start: 1_000, end: 6_000, live: true, endContentCount: 1 },
        true,
        2,
      ),
    ).toBe("restart");
  });

  test("其余动作原样透传", () => {
    expect(resolveObservedTurnTimingWrite(undefined, true, 0)).toBe("start");
    expect(resolveObservedTurnTimingWrite({ start: 1_000 }, true, 1)).toBe("start");
    expect(resolveObservedTurnTimingWrite({ start: 1_000, live: true }, false, 1)).toBe("end");
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
