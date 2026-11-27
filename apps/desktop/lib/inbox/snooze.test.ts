import { describe, expect, test } from "bun:test";
import { snoozeUntil } from "./snooze";

describe("snoozeUntil", () => {
  test("1h / 1w 按固定偏移计算", () => {
    const now = new Date(2026, 10, 27, 15, 30, 0, 0).getTime();
    expect(snoozeUntil("1h", now)).toBe(
      new Date(2026, 10, 27, 16, 30, 0, 0).toISOString(),
    );
    expect(snoozeUntil("1w", now)).toBe(
      new Date(2026, 11, 4, 15, 30, 0, 0).toISOString(),
    );
  });

  test("tomorrow = 次日 09:00（本地时区）", () => {
    const now = new Date(2026, 10, 27, 15, 30, 0, 0).getTime();
    expect(snoozeUntil("tomorrow", now)).toBe(
      new Date(2026, 10, 28, 9, 0, 0, 0).toISOString(),
    );
  });

  test("晚上点「明天早上」也是次日 09:00，不会落回今天", () => {
    const now = new Date(2026, 10, 27, 23, 50, 0, 0).getTime();
    expect(snoozeUntil("tomorrow", now)).toBe(
      new Date(2026, 10, 28, 9, 0, 0, 0).toISOString(),
    );
  });
});
