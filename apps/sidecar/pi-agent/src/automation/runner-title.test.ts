import { describe, expect, test } from "bun:test";
import { automationRunTitle } from "./runner";

/**
 * 定时运行会话标题：同任务多次运行必须可区分（任务名 + 触发时刻）。
 * 用无时区后缀的本地时刻串构造，测试不依赖运行机器时区
 * （沿用 automation-format.test.ts 的本地 Date 写法）。
 */

describe("automationRunTitle", () => {
  test("带任务名：追加 MM-DD HH:mm 本地时刻", () => {
    expect(
      automationRunTitle({ name: "每日晨报", prompt: "p" }, "2026-09-16T08:05:00"),
    ).toBe("每日晨报 09-16 08:05");
  });

  test("无名任务回落 prompt 首行截断", () => {
    const t = automationRunTitle(
      { name: "  ", prompt: "汇总 今天的\n行业新闻并写入文件" },
      "2026-09-16T23:59:00",
    );
    expect(t).toBe("汇总 今天的 行业新闻并写入文件 09-16 23:59");
  });

  test("非法时刻只留任务名；全空回落「定时任务」", () => {
    expect(automationRunTitle({ name: "x", prompt: "p" }, "not-a-date")).toBe("x");
    expect(automationRunTitle({ name: "", prompt: "   " }, "2026-09-16T08:05:00")).toBe(
      "定时任务 09-16 08:05",
    );
  });
});
