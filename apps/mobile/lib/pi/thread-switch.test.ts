import { expect, test } from "vitest";
import { isThreadSwitchPending } from "./thread-switch";

test("切已有会话：mainThreadId 追上目标前保持切换态", () => {
  expect(isThreadSwitchPending({ thread: "b" }, "a")).toBe(true);
  expect(isThreadSwitchPending({ thread: "b" }, "b")).toBe(false);
});

test("新建对话：mainThreadId 离开切换前 id 才结束切换态", () => {
  expect(isThreadSwitchPending({ fresh: "1", from: "a" }, "a")).toBe(true);
  expect(isThreadSwitchPending({ fresh: "1", from: "a" }, "b")).toBe(false);
});

test("新建对话但已是草稿会话（调用方不传 from）：不显示切换壳", () => {
  expect(isThreadSwitchPending({ fresh: "1" }, "draft")).toBe(false);
});

test("thread 参数优先于 fresh", () => {
  expect(isThreadSwitchPending({ thread: "b", fresh: "1", from: "a" }, "a")).toBe(
    true,
  );
  expect(isThreadSwitchPending({ thread: "b", fresh: "1", from: "a" }, "b")).toBe(
    false,
  );
});
