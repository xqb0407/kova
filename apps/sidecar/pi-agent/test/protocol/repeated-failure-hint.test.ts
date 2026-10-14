import { describe, test, expect } from "bun:test";
import { augmentRepeatedFailureCalls } from "../../src/protocol/prompt-pipeline";

/** assistant 消息里发起一次 toolCall（签名来源：name + arguments） */
const call = (id: string, name: string, args: unknown) => ({
  role: "assistant" as const,
  content: [{ type: "toolCall" as const, id, name, arguments: args }],
  timestamp: 0,
});

/** 结果消息（isError 默认 true） */
const result = (id: string, name: string, text: string, isError = true) => ({
  role: "toolResult" as const,
  toolCallId: id,
  toolName: name,
  content: [{ type: "text" as const, text }],
  isError,
  timestamp: 0,
});

const textOf = (m: unknown) =>
  (m as { content: { text: string }[] }).content[0].text;

const ARGS = { file_path: "a.txt", content: "hello" };
const MARKER = "has failed 3 consecutive times";

describe("augmentRepeatedFailureCalls", () => {
  test("同一调用连续失败 3 次：只有第 3 条被追加终止性指引", () => {
    const msgs = [
      call("c1", "write", ARGS),
      result("c1", "write", "host_query timeout"),
      call("c2", "write", ARGS),
      result("c2", "write", "host_query timeout"),
      call("c3", "write", ARGS),
      result("c3", "write", "host_query timeout"),
    ];
    augmentRepeatedFailureCalls(msgs);
    expect(textOf(msgs[1])).toBe("host_query timeout");
    expect(textOf(msgs[3])).toBe("host_query timeout");
    expect(textOf(msgs[5])).toContain(MARKER);
    expect(textOf(msgs[5])).toContain("Do NOT retry it unchanged");
    // 原文案保真：追加是纯 suffix
    expect(textOf(msgs[5]).startsWith("host_query timeout")).toBe(true);
  });

  test("参数每次都不同：不算打转，不追加", () => {
    const msgs = [
      call("c1", "write", { file_path: "a.txt" }),
      result("c1", "write", "boom"),
      call("c2", "write", { file_path: "b.txt" }),
      result("c2", "write", "boom"),
      call("c3", "write", { file_path: "c.txt" }),
      result("c3", "write", "boom"),
    ];
    augmentRepeatedFailureCalls(msgs);
    for (const m of [msgs[1], msgs[3], msgs[5]]) expect(textOf(m)).toBe("boom");
  });

  test("中途成功即清零：后面再失败两次也不够 3 次", () => {
    const msgs = [
      call("c1", "write", ARGS),
      result("c1", "write", "boom"),
      call("c2", "write", ARGS),
      result("c2", "write", "boom", false), // 成功：链断
      call("c3", "write", ARGS),
      result("c3", "write", "boom"),
      call("c4", "write", ARGS),
      result("c4", "write", "boom"),
    ];
    augmentRepeatedFailureCalls(msgs);
    expect(textOf(msgs[7])).toBe("boom");
  });

  test("交错不同签名（含其它工具的错误）：链断，不追加", () => {
    const msgs = [
      call("c1", "write", ARGS),
      result("c1", "write", "boom"),
      call("c2", "read", { file_path: "a.txt" }),
      result("c2", "read", "no such file"),
      call("c3", "write", ARGS),
      result("c3", "write", "boom"),
      call("c4", "write", ARGS),
      result("c4", "write", "boom"),
    ];
    augmentRepeatedFailureCalls(msgs);
    for (const m of [msgs[1], msgs[5], msgs[7]]) expect(textOf(m)).not.toContain(MARKER);
  });

  test("幂等：重复调用不重复追加", () => {
    const msgs = [
      call("c1", "bash", { command: "make test" }),
      result("c1", "bash", "exit 2"),
      call("c2", "bash", { command: "make test" }),
      result("c2", "bash", "exit 2"),
      call("c3", "bash", { command: "make test" }),
      result("c3", "bash", "exit 2"),
    ];
    augmentRepeatedFailureCalls(msgs);
    const once = textOf(msgs[5]);
    augmentRepeatedFailureCalls(msgs);
    augmentRepeatedFailureCalls(msgs);
    expect(textOf(msgs[5])).toBe(once);
  });

  test("toolCall 已出窗口（签名不可判）：链断，保守不追加", () => {
    const msgs = [
      call("c1", "write", ARGS),
      result("c1", "write", "boom"),
      result("orphan", "write", "boom"),
      result("orphan2", "write", "boom"),
    ];
    augmentRepeatedFailureCalls(msgs);
    expect(textOf(msgs[3])).not.toContain(MARKER);
  });

  test("畸形条目 / 非 toolResult 一律不动、不抛错", () => {
    const msgs = [
      { role: "user", content: "hi" },
      null,
      { role: "toolResult" },
      { role: "assistant", content: "not-an-array" },
      { role: "assistant", content: [{ type: "toolCall" }] }, // 无 id
    ] as unknown[];
    const before = JSON.stringify(msgs);
    expect(() => augmentRepeatedFailureCalls(msgs)).not.toThrow();
    expect(JSON.stringify(msgs)).toBe(before);
  });
});
