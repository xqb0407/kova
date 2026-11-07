import { describe, expect, test } from "bun:test";
import { greetingAt, welcomeGreeting } from "./welcome-greeting";

/** 固定日期只取小时：避免测试随本机时区/当前时间漂移 */
const at = (hour: number): Date => new Date(2026, 0, 1, hour, 0, 0);

describe("greetingAt", () => {
  test("时段边界", () => {
    expect(greetingAt(at(4))).toBe("夜深了");
    expect(greetingAt(at(5))).toBe("早上好");
    expect(greetingAt(at(10))).toBe("早上好");
    expect(greetingAt(at(11))).toBe("中午好");
    expect(greetingAt(at(12))).toBe("中午好");
    expect(greetingAt(at(13))).toBe("下午好");
    expect(greetingAt(at(17))).toBe("下午好");
    expect(greetingAt(at(18))).toBe("晚上好");
    expect(greetingAt(at(21))).toBe("晚上好");
    expect(greetingAt(at(22))).toBe("夜深了");
  });
});

describe("welcomeGreeting", () => {
  test("称呼 + AI 名称都来自设置", () => {
    expect(welcomeGreeting(at(23), "Herther", "扣瓦")).toBe(
      "夜深了，Herther。我是扣瓦",
    );
  });

  test("称呼为空不点名", () => {
    expect(welcomeGreeting(at(9), "", "扣瓦")).toBe("早上好，我是扣瓦");
  });

  test("AI 名称为空回落 Kova", () => {
    expect(welcomeGreeting(at(14), "Herther", "  ")).toBe(
      "下午好，Herther。我是 Kova",
    );
  });

  test("都没填回落原有默认欢迎语", () => {
    expect(welcomeGreeting(at(20), "", "")).toBe("晚上好，我是 Kova");
  });

  test("两端空白被裁掉", () => {
    expect(welcomeGreeting(at(8), "  Herther  ", "  扣瓦  ")).toBe(
      "早上好，Herther。我是扣瓦",
    );
  });

  test("中文名紧排、拉丁名留空格", () => {
    expect(welcomeGreeting(at(12), "", "扣瓦")).toBe("中午好，我是扣瓦");
    expect(welcomeGreeting(at(12), "", "Kova")).toBe("中午好，我是 Kova");
  });
});
