/**
 * 目标轮数上限的两层来源：会话偏好（记忆）+ 本次运行里的显式修改（覆盖层）。
 *
 * 这里钉的是「不冲掉会话记忆」这条：没显式改过时**不能**替前端补一个默认值发给
 * sidecar，否则每次建目标都会用 300 盖掉用户在这个会话里定过的数。
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_GOAL_ACCEPTANCE_MODE,
  DEFAULT_GOAL_DURATION_DRAFT,
  DEFAULT_GOAL_TURN_DRAFT,
  getGoalAcceptanceMode,
  getGoalDurationDraft,
  getGoalTurnDraft,
  goalAcceptanceModeForSend,
  goalDurationDraftForSend,
  goalTurnDraftForSend,
  normalizeGoalAcceptanceMode,
  normalizeGoalDurationDraft,
  normalizeGoalTurnDraft,
  parseSessionGoalDurationPref,
  parseSessionGoalTurnsPref,
  resetGoalTurnDraftForTest,
  setGoalAcceptanceMode,
  setGoalDurationDraft,
  setGoalTurnDraft,
} from "@/lib/pi/pi-goal-limit-draft";

afterEach(() => resetGoalTurnDraftForTest());

const T = "t-draft";

describe("normalizeGoalTurnDraft", () => {
  test("0 表示不限（原样保留 0，交给 sidecar 翻成 null）", () => {
    expect(normalizeGoalTurnDraft(0)).toBe(0);
  });

  test("脏值回落默认，绝不产生 NaN", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "300", null, undefined, {}]) {
      expect(normalizeGoalTurnDraft(bad)).toBe(DEFAULT_GOAL_TURN_DRAFT);
    }
  });

  test("负数回落默认而不是钳到 1（「跑 1 轮就停」等于把目标模式废掉）", () => {
    expect(normalizeGoalTurnDraft(-5)).toBe(DEFAULT_GOAL_TURN_DRAFT);
  });

  test("越界钳位，小数取整", () => {
    expect(normalizeGoalTurnDraft(99_999)).toBe(5_000);
    expect(normalizeGoalTurnDraft(12.6)).toBe(13);
  });
});

describe("会话偏好列的解析（三态必须分得开）", () => {
  test('"0" 是「本会话定过不限」，不是「没定过」', () => {
    expect(parseSessionGoalTurnsPref("0")).toBeNull();
  });

  test("NULL / 空串 / 脏值 = 从未定过", () => {
    for (const raw of [null, undefined, "", "  ", "abc", "-3"]) {
      expect(parseSessionGoalTurnsPref(raw)).toBeUndefined();
    }
  });

  test("数字字符串解析成数值", () => {
    expect(parseSessionGoalTurnsPref("120")).toBe(120);
  });
});

describe("显示值与发送值", () => {
  test("没改过：显示默认，但**发送值为 undefined**（不覆盖会话记忆）", () => {
    expect(getGoalTurnDraft(T)).toBe(DEFAULT_GOAL_TURN_DRAFT);
    expect(goalTurnDraftForSend(T)).toBeUndefined();
  });

  test("改过：显示与发送都是那个值", () => {
    setGoalTurnDraft(120, T);
    expect(getGoalTurnDraft(T)).toBe(120);
    expect(goalTurnDraftForSend(T)).toBe(120);
  });

  test("改成不限：发送 0（不是 undefined——那是「没改过」）", () => {
    setGoalTurnDraft(0, T);
    expect(goalTurnDraftForSend(T)).toBe(0);
    expect(getGoalTurnDraft(T)).toBe(0);
  });

  test("覆盖是按线程隔离的：A 会话改过不影响 B 会话", () => {
    setGoalTurnDraft(50, "t-a");
    expect(goalTurnDraftForSend("t-b")).toBeUndefined();
    expect(getGoalTurnDraft("t-b")).toBe(DEFAULT_GOAL_TURN_DRAFT);
  });

  test("非法写入不改变已设的值（用户填错不该把预设清掉）", () => {
    setGoalTurnDraft(120, T);
    setGoalTurnDraft(Number.NaN, T);
    expect(getGoalTurnDraft(T)).toBe(DEFAULT_GOAL_TURN_DRAFT);
  });
});

describe("v2：验收模式与时长预算", () => {
  test("默认值与脏值规整", () => {
    expect(getGoalAcceptanceMode(T)).toBe(DEFAULT_GOAL_ACCEPTANCE_MODE);
    expect(getGoalDurationDraft(T)).toBe(DEFAULT_GOAL_DURATION_DRAFT);
    expect(normalizeGoalAcceptanceMode("manual")).toBe("manual");
    expect(normalizeGoalAcceptanceMode("weird")).toBe("auto");
    expect(normalizeGoalDurationDraft(0)).toBe(0);
    expect(normalizeGoalDurationDraft(90)).toBe(90);
    expect(normalizeGoalDurationDraft(Number.NaN)).toBe(DEFAULT_GOAL_DURATION_DRAFT);
  });

  test("显式改过才发送；模式与时长互相独立", () => {
    expect(goalAcceptanceModeForSend(T)).toBeUndefined();
    expect(goalDurationDraftForSend(T)).toBeUndefined();

    setGoalAcceptanceMode("manual", T);
    expect(getGoalAcceptanceMode(T)).toBe("manual");
    expect(goalAcceptanceModeForSend(T)).toBe("manual");
    expect(goalDurationDraftForSend(T)).toBeUndefined();

    setGoalDurationDraft(0, T);
    expect(getGoalDurationDraft(T)).toBe(0);
    expect(goalDurationDraftForSend(T)).toBe(0);
    expect(goalAcceptanceModeForSend(T)).toBe("manual");
  });

  test("会话偏好列的时长解析：0 = 不限，空/脏值 = 从未定过", () => {
    expect(parseSessionGoalDurationPref("0")).toBeNull();
    expect(parseSessionGoalDurationPref("90")).toBe(90);
    expect(parseSessionGoalDurationPref(null)).toBeUndefined();
    expect(parseSessionGoalDurationPref("nope")).toBeUndefined();
  });

  test("reset 清空所有覆盖层", () => {
    setGoalAcceptanceMode("skip", T);
    setGoalDurationDraft(30, T);
    setGoalTurnDraft(10, T);
    resetGoalTurnDraftForTest();
    expect(goalAcceptanceModeForSend(T)).toBeUndefined();
    expect(goalDurationDraftForSend(T)).toBeUndefined();
    expect(goalTurnDraftForSend(T)).toBeUndefined();
  });
});
