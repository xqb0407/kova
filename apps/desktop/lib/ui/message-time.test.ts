import { describe, expect, test } from "bun:test";
import {
  formatMessageTime,
  formatMessageTimeFull,
  messageTimeMs,
} from "./message-time";

/** 本地时区固定造时间：避免用例受运行机器时区影响 */
const at = (
  y: number,
  m: number,
  d: number,
  hh = 0,
  mm = 0,
): number => new Date(y, m - 1, d, hh, mm, 0, 0).getTime();

const NOW = at(2026, 11, 7, 15, 30);

describe("formatMessageTime", () => {
  test("当天只给时刻", () => {
    expect(formatMessageTime(at(2026, 11, 7, 9, 5), NOW)).toBe("09:05");
    expect(formatMessageTime(at(2026, 11, 7, 0, 0), NOW)).toBe("00:00");
  });

  test("昨天带前缀（自然日边界，不是 24h 差）", () => {
    // 今天 00:10，消息是 23:50：相差 20 分钟，但读作「昨天」
    expect(
      formatMessageTime(at(2026, 11, 6, 23, 50), at(2026, 11, 7, 0, 10)),
    ).toBe("昨天 23:50");
  });

  test("同年跨天给月日", () => {
    expect(formatMessageTime(at(2026, 1, 5, 9, 30), NOW)).toBe("1月5日 09:30");
  });

  test("跨年带年份", () => {
    expect(formatMessageTime(at(2025, 12, 31, 9, 30), NOW)).toBe(
      "2025年12月31日 09:30",
    );
  });

  test("未来时间（时钟偏差）按今天处理，不显示明天的日期", () => {
    expect(formatMessageTime(at(2026, 11, 8, 9, 30), NOW)).toBe("09:30");
  });

  test("非法/缺失返回 null", () => {
    expect(formatMessageTime(0, NOW)).toBeNull();
    expect(formatMessageTime(Number.NaN, NOW)).toBeNull();
    expect(formatMessageTime(-1, NOW)).toBeNull();
  });
});

describe("formatMessageTimeFull", () => {
  test("完整年月日 + 时刻", () => {
    expect(formatMessageTimeFull(at(2026, 3, 2, 8, 7))).toBe(
      "2026年3月2日 08:07",
    );
  });

  test("非法返回 null", () => {
    expect(formatMessageTimeFull(0)).toBeNull();
    expect(formatMessageTimeFull(Number.NaN)).toBeNull();
  });
});

describe("messageTimeMs", () => {
  test("Date / number / 缺失", () => {
    const ms = at(2026, 11, 7, 12, 0);
    expect(messageTimeMs(new Date(ms))).toBe(ms);
    expect(messageTimeMs(ms)).toBe(ms);
    expect(messageTimeMs(undefined)).toBe(0);
    expect(messageTimeMs(new Date(Number.NaN))).toBe(0);
    expect(messageTimeMs(-1)).toBe(0);
  });
});
