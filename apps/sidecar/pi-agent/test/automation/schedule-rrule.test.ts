import { describe, expect, it } from "bun:test";
import { Cron } from "croner";
import { scheduleExpressionForCroner } from "automation-core";

/**
 * RRULE → cron 归一化（packages/automation-core/src/schedule.ts）。
 * 策略：能忠实表达的语义（多值 BYHOUR/BYMINUTE、BYDAY 列表）正确展开；
 * 无法表达的语义（INTERVAL>1、WEEKLY 缺 BYDAY、序数修饰符）显式抛错，
 * 由调度器落成任务级「调度错误」——绝不静默降级成"每天跑"的错语义。
 */
describe("scheduleExpressionForCroner 的 RRULE 归一化", () => {
  it("普通 cron 表达式原样透传（不回归）", () => {
    expect(scheduleExpressionForCroner("30 8 * * 1-5")).toBe("30 8 * * 1-5");
  });

  it("DAILY 缺省 BYHOUR/BYMINUTE 回落 9:00（既有默认不回归）", () => {
    expect(scheduleExpressionForCroner("RRULE:FREQ=DAILY")).toBe("0 9 * * *");
  });

  it("多值 BYHOUR/BYMINUTE 展开为 cron 列表", () => {
    expect(scheduleExpressionForCroner("RRULE:FREQ=DAILY;BYHOUR=9,18;BYMINUTE=0,30")).toBe(
      "0,30 9,18 * * *",
    );
  });

  it("多值展开产物 croner 可直接消费（每日 4 个触发点）", () => {
    const expr = scheduleExpressionForCroner("RRULE:FREQ=DAILY;BYHOUR=9,18;BYMINUTE=0,30");
    const cron = new Cron(expr, { paused: true });
    const runs = cron.nextRuns(8, new Date("2026-01-05T00:00:00"));
    cron.stop();
    expect(runs.length).toBe(8);
    // 同一表达式连续取点严格递增（列表语义生效，而非回落单值）
    for (let i = 1; i < runs.length; i += 1) {
      expect(runs[i]!.getTime()).toBeGreaterThan(runs[i - 1]!.getTime());
    }
  });

  it("HOURLY 只带 BYMINUTE", () => {
    expect(scheduleExpressionForCroner("RRULE:FREQ=HOURLY;BYMINUTE=15")).toBe("15 * * * *");
  });

  it("WEEKLY 多日 BYDAY 映射", () => {
    expect(scheduleExpressionForCroner("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR")).toBe("0 9 * * 1,3,5");
  });

  it("INTERVAL>1 显式抛错（不静默当每天跑）", () => {
    expect(() => scheduleExpressionForCroner("RRULE:FREQ=DAILY;INTERVAL=2")).toThrow(
      /INTERVAL=2.*only INTERVAL=1 is supported/,
    );
  });

  it("INTERVAL 非法值同样抛错", () => {
    expect(() => scheduleExpressionForCroner("RRULE:FREQ=DAILY;INTERVAL=abc")).toThrow(
      /Unsupported RRULE: INTERVAL/,
    );
  });

  it("WEEKLY 缺 BYDAY 显式抛错（不落成每天跑）", () => {
    expect(() => scheduleExpressionForCroner("RRULE:FREQ=WEEKLY")).toThrow(
      /FREQ=WEEKLY requires BYDAY/,
    );
  });

  it("BYDAY 序数修饰符显式抛错", () => {
    expect(() => scheduleExpressionForCroner("RRULE:FREQ=WEEKLY;BYDAY=-1SU")).toThrow(
      /Unsupported RRULE BYDAY value: -1SU/,
    );
  });

  it("MONTHLY 维持既有抛错", () => {
    expect(() => scheduleExpressionForCroner("RRULE:FREQ=MONTHLY")).toThrow(/Unsupported RRULE frequency/);
  });

  it("BYHOUR 含越界项：整段回落默认单值（不部分保留触发时间）", () => {
    expect(scheduleExpressionForCroner("RRULE:FREQ=DAILY;BYHOUR=9,25")).toBe("0 9 * * *");
  });
});
