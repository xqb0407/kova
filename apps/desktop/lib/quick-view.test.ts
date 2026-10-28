/**
 * 快速查看开合 store 的单测：开态按 threadId 记录（切会话自动收起）、
 * 打开另一会话会顶掉原会话、close 只关自己（旧回调不误关新会话）。
 */
import { describe, expect, test } from "bun:test";
import { closeQuickView, quickViewOpenForTest, toggleQuickView } from "./quick-view";

describe("quick-view store", () => {
  test("toggle 按会话记录开合", () => {
    expect(quickViewOpenForTest("t1")).toBe(false);
    toggleQuickView("t1");
    expect(quickViewOpenForTest("t1")).toBe(true);
    // 另一个会话不受影响（切会话自动收起语义）
    expect(quickViewOpenForTest("t2")).toBe(false);
    toggleQuickView("t1");
    expect(quickViewOpenForTest("t1")).toBe(false);
  });

  test("打开一条会话会顶掉另一条，close 只关自己", () => {
    toggleQuickView("t1");
    expect(quickViewOpenForTest("t1")).toBe(true);
    // 切到 t2 打开：t1 的开态自然失效
    toggleQuickView("t2");
    expect(quickViewOpenForTest("t1")).toBe(false);
    expect(quickViewOpenForTest("t2")).toBe(true);
    // 旧会话的回调误触 close 不能关掉当前会话
    closeQuickView("t1");
    expect(quickViewOpenForTest("t2")).toBe(true);
    closeQuickView("t2");
    expect(quickViewOpenForTest("t2")).toBe(false);
  });
});
