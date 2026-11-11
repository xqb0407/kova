import { describe, expect, test } from "bun:test";
import { threadListEmptyState } from "./pi-thread-list-empty";

describe("侧栏空态判定", () => {
  test("没有会话也没有项目分组 → 暂无对话", () => {
    expect(threadListEmptyState({ query: "", filteredCount: 0, projectGroupCount: 0 })).toEqual("empty");
  });

  test("只有空项目分组 → 不显示空态（项目卡要能出现）", () => {
    expect(threadListEmptyState({ query: "", filteredCount: 0, projectGroupCount: 1 })).toEqual(null);
  });

  test("搜索无命中 → 搜索空态", () => {
    expect(threadListEmptyState({ query: "abc", filteredCount: 0, projectGroupCount: 0 })).toEqual("search");
  });

  test("有会话命中 → 正常渲染列表", () => {
    expect(threadListEmptyState({ query: "", filteredCount: 1, projectGroupCount: 0 })).toEqual(null);
  });
});
