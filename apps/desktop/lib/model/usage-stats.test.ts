import { describe, expect, test } from "bun:test";
import { formatChatDuration } from "@/lib/model/usage-stats";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatChatDuration（指标卡时长）", () => {
  test("0 / 负数 → —", () => {
    expect(formatChatDuration(0)).toBe("—");
    expect(formatChatDuration(-1)).toBe("—");
  });

  test("秒 / 分钟档", () => {
    expect(formatChatDuration(499)).toBe("1 秒");
    expect(formatChatDuration(45 * SEC)).toBe("45 秒");
    // 59.6 秒进位成 1 分钟，不能出现「60 秒」
    expect(formatChatDuration(59.6 * SEC)).toBe("1 分钟");
    expect(formatChatDuration(59 * MIN)).toBe("59 分钟");
  });

  test("小时档保留分钟；59.6 分钟进位成 1 小时", () => {
    expect(formatChatDuration(59.6 * MIN)).toBe("1 小时");
    expect(formatChatDuration(HOUR)).toBe("1 小时");
    expect(formatChatDuration(1.5 * HOUR)).toBe("1 小时 30 分钟");
    expect(formatChatDuration(23 * HOUR + 59 * MIN)).toBe("23 小时 59 分钟");
  });

  test("天档保留小时，不出现「24 小时」", () => {
    expect(formatChatDuration(DAY - 1)).toBe("1 天");
    expect(formatChatDuration(DAY)).toBe("1 天");
    expect(formatChatDuration(DAY + HOUR)).toBe("1 天 1 小时");
    expect(formatChatDuration(29 * DAY + 23 * HOUR)).toBe("29 天 23 小时");
  });

  test("月 / 年档按 30 天近似，四舍五入进位", () => {
    expect(formatChatDuration(30 * DAY)).toBe("1 个月");
    expect(formatChatDuration(44 * DAY)).toBe("1 个月");
    expect(formatChatDuration(45 * DAY)).toBe("2 个月");
    expect(formatChatDuration(330 * DAY)).toBe("11 个月");
    expect(formatChatDuration(345 * DAY)).toBe("1 年");
    expect(formatChatDuration(365 * DAY)).toBe("1 年");
    expect(formatChatDuration(400 * DAY)).toBe("1 年 1 个月");
    expect(formatChatDuration(760 * DAY)).toBe("2 年 1 个月");
  });

  test("200+ 小时转成天（长会话卡片溢出回归）", () => {
    expect(formatChatDuration(200 * HOUR)).toBe("8 天 8 小时");
    // 「234 小时 31 分钟」→ 9 天 18 小时
    expect(formatChatDuration(234.5 * HOUR)).toBe("9 天 18 小时");
  });
});
