import { beforeEach, describe, expect, it } from "bun:test";
import {
  clearPendingThreadSelection,
  markPendingThreadSelection,
  pendingThreadSelection,
  resetPendingThreadSelectionForTest,
} from "./pending-selection";

describe("乐观选中（切会话点击即刻高亮）", () => {
  beforeEach(() => {
    resetPendingThreadSelectionForTest();
  });

  it("标记后立即可读；清除后归空", () => {
    markPendingThreadSelection("t-1");
    expect(pendingThreadSelection()).toBe("t-1");
    clearPendingThreadSelection();
    expect(pendingThreadSelection()).toBe(null);
  });

  it("点另一行即覆盖上一行（高亮只跟最近一次点击）", () => {
    markPendingThreadSelection("t-1");
    markPendingThreadSelection("t-2");
    expect(pendingThreadSelection()).toBe("t-2");
  });

  it("追平前重复点同一行保持原值（看门狗不被打断重开）", () => {
    markPendingThreadSelection("t-1");
    markPendingThreadSelection("t-1");
    expect(pendingThreadSelection()).toBe("t-1");
    clearPendingThreadSelection();
    expect(pendingThreadSelection()).toBe(null);
  });

  it("未标记时清除是空操作", () => {
    clearPendingThreadSelection();
    expect(pendingThreadSelection()).toBe(null);
  });
});
