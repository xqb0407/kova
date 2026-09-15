import { describe, expect, it } from "bun:test";
import {
  cronToPreset,
  describeCron,
  describeIntervalSeconds,
  describeTemplateSchedule,
  nextRunLabel,
  parseIntervalSeconds,
  presetToCron,
  relativePast,
} from "./automation-format";

describe("describeIntervalSeconds", () => {
  it("整单位优先", () => {
    expect(describeIntervalSeconds(3600)).toBe("每 1 小时");
    expect(describeIntervalSeconds(1800)).toBe("每 30 分钟");
    expect(describeIntervalSeconds(86400 * 2)).toBe("每 2 天");
    expect(describeIntervalSeconds(90)).toBe("每 90 秒");
  });
});

describe("describeCron", () => {
  it("常见整点形态翻人话", () => {
    expect(describeCron("0 9 * * *")).toBe("每天 09:00");
    expect(describeCron("30 8 * * 1-5")).toBe("工作日 08:30");
    expect(describeCron("0 10 * * 1,3,5")).toBe("每周一、三、五 10:00");
    expect(describeCron("15 12 1 * *")).toBe("每月 1 日 12:15");
    expect(describeCron("*/10 * * * *")).toBe("每 10 分钟");
    expect(describeCron("* * * * *")).toBe("每分钟");
  });
  it("不认识的形态保留原始表达式", () => {
    expect(describeCron("0 0 1 1 *")).toContain("Cron:");
    expect(describeCron("garbage")).toBe("Cron: garbage");
  });
});

describe("presetToCron / cronToPreset 往返", () => {
  it("daily 往返", () => {
    expect(presetToCron({ mode: "daily", hour: 9, minute: 0 })).toBe("0 9 * * *");
    expect(cronToPreset("0 9 * * *")).toEqual({ mode: "daily", hour: 9, minute: 0 });
  });
  it("weekly 往返（1-5 折叠为 days 列表）", () => {
    expect(
      presetToCron({ mode: "weekly", hour: 8, minute: 30, days: [1, 3, 5] }),
    ).toBe("30 8 * * 1,3,5");
    expect(cronToPreset("30 8 * * 1,3,5")).toEqual({
      mode: "weekly",
      hour: 8,
      minute: 30,
      days: [1, 3, 5],
    });
    expect(cronToPreset("30 8 * * 1-5").mode).toBe("weekly");
  });
  it("monthly 往返", () => {
    expect(presetToCron({ mode: "monthly", hour: 12, minute: 15, day: 1 })).toBe(
      "15 12 1 * *",
    );
    expect(cronToPreset("15 12 1 * *")).toEqual({
      mode: "monthly",
      hour: 12,
      minute: 15,
      day: 1,
    });
  });
  it("奇异表达式落 raw 且可回写", () => {
    const p = cronToPreset("0 9 * * 1#2");
    expect(p.mode).toBe("raw");
    expect(presetToCron(p)).toBe("0 9 * * 1#2");
  });
});

describe("时间标签", () => {
  const NOW = Date.UTC(2026, 8, 15, 12); // 只用作差分锚点
  it("nextRunLabel 粗粒度阶梯", () => {
    expect(nextRunLabel(new Date(NOW + 30_000).toISOString(), NOW)).toContain("秒");
    expect(nextRunLabel(new Date(NOW + 5 * 60_000).toISOString(), NOW)).toBe("5 分钟后");
    expect(nextRunLabel(new Date(NOW + 90 * 60_000).toISOString(), NOW)).toContain("小时");
    expect(nextRunLabel(new Date(NOW - 1000).toISOString(), NOW)).toBe("即将触发");
    expect(nextRunLabel(undefined, NOW)).toBe("");
  });
  it("nextRunLabel 天级标签（今天/明天/后天，本地日期构造与时区无关）", () => {
    const nowLocal = new Date(2026, 8, 15, 0, 30).getTime(); // 凌晨 00:30
    // 8.5h 间隔跨过小时档位进入天级分支：同日排期必须显示"今天"而非"0 天后"
    expect(nextRunLabel(new Date(2026, 8, 15, 9, 0).toISOString(), nowLocal)).toBe(
      "今天 09:00",
    );
    expect(nextRunLabel(new Date(2026, 8, 16, 9, 0).toISOString(), nowLocal)).toBe(
      "明天 09:00",
    );
    expect(nextRunLabel(new Date(2026, 8, 17, 9, 0).toISOString(), nowLocal)).toBe(
      "后天 09:00",
    );
    expect(
      nextRunLabel(new Date(2026, 8, 20, 9, 0).toISOString(), nowLocal),
    ).toContain("5 天后");
  });
  it("relativePast 粗粒度", () => {
    expect(relativePast(new Date(NOW - 10_000).toISOString(), NOW)).toBe("刚刚");
    expect(relativePast(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5 分钟前");
    expect(relativePast(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("3 小时前");
  });
});

describe("模板排期摘要", () => {
  it("parseIntervalSeconds 与非法输入", () => {
    expect(parseIntervalSeconds("6h")).toBe(21600);
    expect(parseIntervalSeconds("30m")).toBe(1800);
    expect(parseIntervalSeconds("bad")).toBeUndefined();
  });
  it("interval 文本翻成人话", () => {
    expect(describeTemplateSchedule({ type: "interval", schedule: "6h" })).toBe("每 6 小时");
    expect(describeTemplateSchedule({ type: "interval", schedule: "9x" })).toBe("间隔 9x");
  });
  it("once 相对形态按单位翻译，绝对 ISO 走通用格式", () => {
    expect(describeTemplateSchedule({ type: "once", schedule: "+1d" })).toBe("一次性 · 1 天后");
    expect(describeTemplateSchedule({ type: "once", schedule: "+30m" })).toBe("一次性 · 30 分钟后");
    expect(describeTemplateSchedule({ type: "once", schedule: "2026-09-20T09:00:00.000Z" })).toContain("一次性 ·");
  });
  it("cron 交回 describeCron", () => {
    expect(describeTemplateSchedule({ type: "cron", schedule: "30 8 * * *" })).toBe("每天 08:30");
  });
});
