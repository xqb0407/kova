import { describe, expect, test } from "bun:test";
import { greetingKeyAt, welcomeGreeting } from "./welcome-greeting";
import { translateWith } from "./i18n";

/** 固定日期只取小时：避免测试随本机时区/当前时间漂移 */
const at = (hour: number): Date => new Date(2026, 0, 1, hour, 0, 0);

describe("greetingKeyAt", () => {
  test("时段边界", () => {
    expect(greetingKeyAt(at(4))).toBe("chat.greeting.lateNight");
    expect(greetingKeyAt(at(5))).toBe("chat.greeting.morning");
    expect(greetingKeyAt(at(10))).toBe("chat.greeting.morning");
    expect(greetingKeyAt(at(11))).toBe("chat.greeting.noon");
    expect(greetingKeyAt(at(12))).toBe("chat.greeting.noon");
    expect(greetingKeyAt(at(13))).toBe("chat.greeting.afternoon");
    expect(greetingKeyAt(at(17))).toBe("chat.greeting.afternoon");
    expect(greetingKeyAt(at(18))).toBe("chat.greeting.evening");
    expect(greetingKeyAt(at(21))).toBe("chat.greeting.evening");
    expect(greetingKeyAt(at(22))).toBe("chat.greeting.lateNight");
  });
});

describe("welcomeGreeting（中文）", () => {
  test("称呼 + AI 名称都来自设置", () => {
    expect(welcomeGreeting(at(23), "Herther", "扣瓦", "zh")).toBe(
      "夜深了，Herther。我是扣瓦",
    );
  });

  test("称呼为空不点名", () => {
    expect(welcomeGreeting(at(9), "", "扣瓦", "zh")).toBe("早上好，我是扣瓦");
  });

  test("AI 名称为空回落 Kova", () => {
    expect(welcomeGreeting(at(14), "Herther", "  ", "zh")).toBe(
      "下午好，Herther。我是 Kova",
    );
  });

  test("都没填回落原有默认欢迎语", () => {
    expect(welcomeGreeting(at(20), "", "", "zh")).toBe("晚上好，我是 Kova");
  });

  test("两端空白被裁掉", () => {
    expect(welcomeGreeting(at(8), "  Herther  ", "  扣瓦  ", "zh")).toBe(
      "早上好，Herther。我是扣瓦",
    );
  });

  test("中文名紧排、拉丁名留空格", () => {
    expect(welcomeGreeting(at(12), "", "扣瓦", "zh")).toBe("中午好，我是扣瓦");
    expect(welcomeGreeting(at(12), "", "Kova", "zh")).toBe("中午好，我是 Kova");
  });
});

describe("welcomeGreeting（英文）", () => {
  test("称呼 + AI 名称", () => {
    expect(welcomeGreeting(at(23), "Herther", "Kova", "en")).toBe(
      "Working late, Herther. I'm Kova",
    );
  });

  test("称呼为空不点名", () => {
    expect(welcomeGreeting(at(9), "", "Kova", "en")).toBe(
      "Good morning, I'm Kova",
    );
  });

  test("时段词走英文词典", () => {
    expect(welcomeGreeting(at(14), "", "", "en").startsWith("Good afternoon")).toBe(
      true,
    );
  });

  test("词典 key 均可解析（两语言无缺 key）", () => {
    for (const key of [
      "chat.greeting.morning",
      "chat.greeting.noon",
      "chat.greeting.afternoon",
      "chat.greeting.evening",
      "chat.greeting.lateNight",
    ]) {
      expect(translateWith("zh", key)).not.toBe(key);
      expect(translateWith("en", key)).not.toBe(key);
    }
  });
});
