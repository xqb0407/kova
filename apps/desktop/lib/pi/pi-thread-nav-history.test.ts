/**
 * 主区导航历史 store 测试：启动占位替换、合并窗口入栈、后退/前进的栈流转、
 * applying 期间的静默更新与失败复位、历史上限。ephemeral store，无持久化。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  finishNavApply,
  flushNavBurst,
  getThreadNavState,
  requestNavBack,
  requestNavForward,
  resetNavHistory,
  syncNavCurrent,
} from "./pi-thread-nav-history";

const entry = (threadId: string, menu = "") => ({ threadId, menu });

beforeEach(() => resetNavHistory());

describe("pi-thread-nav-history", () => {
  test("首个快照只初始化 current，不产生可后退历史", () => {
    syncNavCurrent(entry("a"));
    expect(getThreadNavState().current).toEqual(entry("a"));
    expect(getThreadNavState().back).toHaveLength(0);
    expect(requestNavBack()).toBe(false);
  });

  test("启动占位被真实落地替换，不入栈（刷新无幻影「新对话」）", () => {
    syncNavCurrent(entry("placeholder"));
    expect(getThreadNavState().provisional).toBe(true);
    syncNavCurrent(entry("restored"));
    flushNavBurst();
    expect(getThreadNavState().current).toEqual(entry("restored"));
    expect(getThreadNavState().back).toHaveLength(0);
    expect(requestNavBack()).toBe(false);
  });

  test("用户切换：合并窗口起点入栈、forward 清空", () => {
    syncNavCurrent(entry("a")); // 启动占位
    syncNavCurrent(entry("b")); // 真实落地，替换占位
    syncNavCurrent(entry("c")); // 一次用户切换
    flushNavBurst();
    expect(getThreadNavState().back).toEqual([entry("b")]);
    expect(getThreadNavState().current).toEqual(entry("c"));
    syncNavCurrent(entry("d"));
    flushNavBurst();
    expect(getThreadNavState().back).toEqual([entry("b"), entry("c")]);
  });

  test("合并窗口：清菜单 + 切线程的两次上报只入栈一次", () => {
    syncNavCurrent(entry("a"));
    syncNavCurrent(entry("b"));
    // 模拟「从页面点会话行」：菜单先同步落（b, page），线程后异步落（c, ""）
    syncNavCurrent(entry("b", "page"));
    syncNavCurrent(entry("c"));
    flushNavBurst();
    expect(getThreadNavState().back).toEqual([entry("b")]);
    expect(getThreadNavState().current).toEqual(entry("c"));
    // 一次后退直接回到「页面 + 原会话」，不再有中间条目
    expect(requestNavBack()).toBe(true);
    syncNavCurrent(entry("b", "page"));
    expect(getThreadNavState().current).toEqual(entry("b", "page"));
    expect(getThreadNavState().applying).toBe(false);
  });

  test("后退/前进流转：栈对称搬运，current 落到目标", () => {
    syncNavCurrent(entry("a")); // 占位
    syncNavCurrent(entry("b"));
    flushNavBurst();
    syncNavCurrent(entry("c"));
    flushNavBurst();
    syncNavCurrent(entry("d"));
    flushNavBurst();
    expect(getThreadNavState().back).toEqual([entry("b"), entry("c")]);

    expect(requestNavBack()).toBe(true);
    // applying 中：请求已记账，current 待 tracker 追平后落地
    expect(getThreadNavState().pending).toEqual(entry("c"));
    syncNavCurrent(entry("c"));
    expect(getThreadNavState().current).toEqual(entry("c"));
    expect(getThreadNavState().applying).toBe(false);
    expect(getThreadNavState().forward).toEqual([entry("d")]);

    expect(requestNavBack()).toBe(true);
    syncNavCurrent(entry("b"));
    expect(getThreadNavState().back).toHaveLength(0);
    expect(getThreadNavState().forward).toEqual([entry("d"), entry("c")]);

    expect(requestNavForward()).toBe(true);
    syncNavCurrent(entry("c"));
    expect(requestNavForward()).toBe(true);
    syncNavCurrent(entry("d"));
    expect(getThreadNavState().back).toEqual([entry("b"), entry("c")]);
    expect(getThreadNavState().forward).toHaveLength(0);
  });

  test("applying 期间的新导航请求被拒绝", () => {
    syncNavCurrent(entry("a"));
    syncNavCurrent(entry("b"));
    syncNavCurrent(entry("c"));
    flushNavBurst();
    expect(requestNavBack()).toBe(true);
    expect(requestNavBack()).toBe(false);
    expect(requestNavForward()).toBe(false);
    syncNavCurrent(entry("b"));
  });

  test("applying 期间的 tracker 上报只更新 current，不动栈", () => {
    syncNavCurrent(entry("a")); // 占位
    syncNavCurrent(entry("b"));
    syncNavCurrent(entry("c"));
    flushNavBurst();
    requestNavBack();
    const backBefore = getThreadNavState().back;
    syncNavCurrent(entry("intermediate"));
    expect(getThreadNavState().current).toEqual(entry("intermediate"));
    expect(getThreadNavState().back).toBe(backBefore);
    expect(getThreadNavState().forward).toEqual([entry("c")]);
    syncNavCurrent(entry("b"));
  });

  test("切换失败：finishNavApply 复位 applying，目标条目放弃", () => {
    syncNavCurrent(entry("a")); // 占位
    syncNavCurrent(entry("b"));
    syncNavCurrent(entry("c"));
    flushNavBurst();
    requestNavBack();
    finishNavApply();
    expect(getThreadNavState().applying).toBe(false);
    expect(getThreadNavState().pending).toBeNull();
    // current 停留在 applying 期间的最后上报；失败的目标不再可退
    expect(requestNavBack()).toBe(false);
    expect(requestNavForward()).toBe(true);
    syncNavCurrent(entry("c"));
  });

  test("同快照重复上报不压栈", () => {
    syncNavCurrent(entry("a")); // 占位
    syncNavCurrent(entry("b"));
    syncNavCurrent(entry("c"));
    flushNavBurst();
    expect(getThreadNavState().back).toEqual([entry("b")]);
    syncNavCurrent(entry("c"));
    flushNavBurst();
    expect(getThreadNavState().back).toEqual([entry("b")]);
  });

  test("历史上限截断（50）", () => {
    syncNavCurrent(entry("t0")); // 占位
    for (let i = 1; i < 60; i++) {
      syncNavCurrent(entry(`t${i}`));
      flushNavBurst();
    }
    const { back } = getThreadNavState();
    expect(back).toHaveLength(50);
    expect(back[0]).toEqual(entry("t9"));
    expect(back[back.length - 1]).toEqual(entry("t58"));
  });
});
