/**
 * 增量投影回归：复用前缀只重算受影响的组，结果必须与全量投影一致。
 *
 * 覆盖的失效场景：
 * - 流式消息原地修改（引用不变，只能靠 streamingMessageIndex 识别）
 * - message_end 用新对象送同内容（尾部仍应复用引用）
 * - 追加乐观用户消息（前一组 isLast 翻转 + 收尾占位）
 * - 并行工具结果乱序落盘（配对到更早的组）
 * - 分页 prepend（下标整体平移）
 * - runStatus / toolExecutions 变化
 */
import { expect, test, vi } from "vitest";

vi.mock("@assistant-ui/react-native", () => ({
  ExportedMessageRepository: { fromArray: (x: unknown) => x },
}));
vi.mock("pi-protocol", () => ({
  isAutoContinueMessage: () => false,
  // 真实哨兵语义：正向用例（提醒行不进气泡）要靠它判定
  isCapabilityReminderMessage: (message: any) => {
    const first = message?.content?.[0];
    return (
      message?.role === "user" &&
      first?.type === "text" &&
      typeof first.text === "string" &&
      first.text.startsWith("[[capability-reminder]] ")
    );
  },
}));

import {
  projectPiThreadMessages,
  projectPiThreadMessagesIncremental,
  type PiProjectionCache,
  type PiProjectionInput,
} from "./messageProjection";

type AnyMessage = Record<string, any>;

const textPart = (text: string) => ({ type: "text", text });

const user = (seq: number, text: string): AnyMessage => ({
  role: "user",
  content: [textPart(text)],
  timestamp: seq,
  __seq: seq,
});

const assistant = (seq: number, content: AnyMessage[]): AnyMessage => ({
  role: "assistant",
  content,
  timestamp: seq,
  __seq: seq,
  stopReason: "stop",
});

const toolCall = (id: string) => ({
  type: "toolCall",
  id,
  name: "bash",
  arguments: { command: "ls" },
});

const toolResult = (
  seq: number,
  toolCallId: string,
  result: string,
): AnyMessage => ({
  role: "toolResult",
  toolCallId,
  content: [textPart(result)],
  isError: false,
  timestamp: seq,
  __seq: seq,
});

// 未变化的上下文必须复用同一引用——增量投影按引用判断是否失效。
const NO_REQUESTS: readonly never[] = [];
const NO_TOOLS: Record<string, never> = {};

const inputOf = (
  messages: AnyMessage[],
  extra: Partial<PiProjectionInput> = {},
): PiProjectionInput =>
  ({
    messages,
    toolExecutions: NO_TOOLS,
    runStatus: "idle",
    hostUiRequests: NO_REQUESTS,
    ...extra,
  }) as PiProjectionInput;

const full = (input: PiProjectionInput) => projectPiThreadMessages(input);

test("能力收尾提醒哨兵不产生用户气泡，增量与全量等价", () => {
  const messages: AnyMessage[] = [
    user(1, "继续修"),
    assistant(2, [textPart("改到一半")]),
    user(
      3,
      "[[capability-reminder]] <system-reminder>\nstop repeating\n</system-reminder>",
    ),
    assistant(4, [textPart("换了个思路")]),
  ];

  const fullOut = full(inputOf(messages));
  // 唯一的 user 气泡是真实输入；提醒行整行隐藏
  const users = fullOut.filter((m: any) => m.role === "user");
  expect(users).toHaveLength(1);
  expect(JSON.stringify(fullOut)).not.toContain("[[capability-reminder]]");

  // 同一份输入走增量：与全量逐字等价（提醒行跳过不破坏组边界/前缀复用；
  // 两侧 createdAt 同源相等，无需抹除）
  const inc = incremental(inputOf(messages), null);
  expect(inc.output).toEqual(fullOut);
});

const incremental = (
  input: PiProjectionInput,
  cache: PiProjectionCache | null,
) => projectPiThreadMessagesIncremental(input, cache);

/** 占位消息的 createdAt 取当前时间，比较时忽略它。 */
const withoutDates = (messages: readonly any[]) =>
  messages.map((message) => ({ ...message, createdAt: undefined }));

const toolPart = (message: any, id: string) =>
  message.content.find(
    (part: any) => part.type === "tool-call" && part.toolCallId === id,
  );

test("流式消息原地修改：只重建尾组，前缀引用不变", () => {
  const messages: AnyMessage[] = [
    user(1, "q1"),
    assistant(2, [textPart("a1"), toolCall("call-1")]),
    toolResult(3, "call-1", "ok"),
    user(4, "q2"),
    assistant(5, [textPart("part")]),
  ];

  const first = incremental(
    inputOf(messages, { runStatus: "running", streamingMessageIndex: 4 }),
    null,
  );
  expect(first.output).toHaveLength(4);

  // client accumulator 原地追加文本：对象引用不变
  messages[4]!.content[0].text += "ial";

  const second = incremental(
    inputOf(messages, { runStatus: "running", streamingMessageIndex: 4 }),
    first.cache,
  );

  expect(second.output).toEqual(full(inputOf(messages, { runStatus: "running" })));
  // 前缀（用户 + 第一组 + 用户）原样复用
  expect(second.output[0]).toBe(first.output[0]);
  expect(second.output[1]).toBe(first.output[1]);
  expect(second.output[2]).toBe(first.output[2]);
  // 尾组重建
  expect(second.output[3]).not.toBe(first.output[3]);
  expect((second.output[3] as any).content[0].text).toBe("partial");
});

test("message_end 用新对象送同内容：尾部引用仍复用", () => {
  const messages: AnyMessage[] = [
    user(1, "q"),
    assistant(2, [textPart("answer")]),
  ];
  const first = incremental(
    inputOf(messages, { runStatus: "running", streamingMessageIndex: 1 }),
    null,
  );

  const finalized: AnyMessage[] = [
    messages[0]!,
    { ...assistant(2, [textPart("answer")]) },
  ];
  const second = incremental(
    inputOf(finalized, { runStatus: "running" }),
    first.cache,
  );

  expect(second.output).toEqual(full(inputOf(finalized, { runStatus: "running" })));
  expect(second.output[1]).toBe(first.output[1]);
});

test("追加乐观用户消息：前一组 isLast 翻转，收尾占位出现", () => {
  const messages: AnyMessage[] = [user(1, "q"), assistant(2, [textPart("a")])];
  const first = incremental(
    inputOf(messages, { runStatus: "running", streamingMessageIndex: 1 }),
    null,
  );
  expect((first.output[1] as any).status).toMatchObject({ type: "running" });

  const withOptimistic = [...messages, user(3, "next")];
  const second = incremental(
    inputOf(withOptimistic, { runStatus: "running" }),
    first.cache,
  );

  const expected = full(inputOf(withOptimistic, { runStatus: "running" }));
  expect(withoutDates(second.output)).toEqual(withoutDates(expected));
  // 前一组不再是最后一组，状态从 running 收敛为 complete
  expect((second.output[1] as any).status).toMatchObject({ type: "complete" });
  expect(second.output.at(-1)).toMatchObject({
    role: "assistant",
    content: [],
    status: { type: "running" },
  });
});

test("并行工具结果乱序落盘：回溯到更早的配对组", () => {
  const messages: AnyMessage[] = [
    user(1, "q"),
    assistant(2, [toolCall("call-A")]),
    assistant(3, [toolCall("call-B")]),
    user(4, "next"),
    assistant(5, [textPart("done")]),
  ];
  // 先投影时两个工具都还没有结果
  const first = incremental(inputOf(messages), null);
  expect(toolPart(first.output[1], "call-A").result).toBeUndefined();
  expect(toolPart(first.output[1], "call-B").result).toBeUndefined();

  // call-B 先回，随后才回 call-A（乱序且跨组间隔一条 user）
  const withB = [...messages, toolResult(6, "call-B", "B-ok")];
  const second = incremental(inputOf(withB), first.cache);
  const withA = [...withB, toolResult(7, "call-A", "A-ok")];
  const third = incremental(inputOf(withA), second.cache);

  expect(third.output).toEqual(full(inputOf(withA)));
  expect(toolPart(third.output[1], "call-A").result).toBe("A-ok");
  expect(toolPart(third.output[1], "call-B").result).toBe("B-ok");
  // 输出顺序：user / 第一组 / user("next") / 第二组
  expect((third.output[3] as any).content[0].text).toBe("done");
});

test("截断尾部消息：新的尾组按 isLast 重算", () => {
  const messages: AnyMessage[] = [
    user(1, "q1"),
    assistant(2, [textPart("a1")]),
    user(3, "q2"),
    assistant(4, [textPart("a2")]),
  ];
  const first = incremental(
    inputOf(messages, { runStatus: "running", streamingMessageIndex: 3 }),
    null,
  );
  // 非尾组是 complete
  expect((first.output[1] as any).status).toMatchObject({ type: "complete" });

  const truncated = messages.slice(0, 2);
  const second = incremental(
    inputOf(truncated, { runStatus: "running" }),
    first.cache,
  );

  expect(second.output).toEqual(full(inputOf(truncated, { runStatus: "running" })));
  expect(second.output).toHaveLength(2);
  // 原来的非尾组变成最后一组：状态要跟着 runStatus 重新结算
  expect((second.output[1] as any).status).toMatchObject({ type: "running" });
});

test("分页 prepend：下标平移后退化为全量重建，结果仍一致", () => {
  const tail: AnyMessage[] = [user(10, "q"), assistant(11, [textPart("a")])];
  const first = incremental(inputOf(tail), null);

  const prepended: AnyMessage[] = [
    user(1, "older q"),
    assistant(2, [textPart("older a")]),
    ...tail,
  ];
  const second = incremental(inputOf(prepended), first.cache);

  expect(second.output).toEqual(full(inputOf(prepended)));
  expect(second.output).toHaveLength(4);
});

test("runStatus 变化：只重算尾组状态", () => {
  const messages: AnyMessage[] = [user(1, "q"), assistant(2, [textPart("a")])];
  const first = incremental(
    inputOf(messages, { runStatus: "running", streamingMessageIndex: 1 }),
    null,
  );

  const second = incremental(inputOf(messages, { runStatus: "idle" }), first.cache);

  expect(second.output).toEqual(full(inputOf(messages, { runStatus: "idle" })));
  expect((second.output[1] as any).status).toMatchObject({ type: "complete" });
  expect(second.output[0]).toBe(first.output[0]);
});

test("toolExecutions 更新：重建当前组并带上 partial 结果", () => {
  const messages: AnyMessage[] = [
    user(1, "q"),
    assistant(2, [toolCall("call-1")]),
  ];
  const first = incremental(inputOf(messages, { runStatus: "running" }), null);
  expect(toolPart(first.output[1], "call-1").result).toBeUndefined();

  const toolExecutions = {
    "call-1": {
      toolCallId: "call-1",
      status: "running" as const,
      partialResult: { content: [textPart("partial output")] },
    },
  };
  const second = incremental(
    inputOf(messages, { runStatus: "running", toolExecutions }),
    first.cache,
  );

  expect(second.output).toEqual(
    full(inputOf(messages, { runStatus: "running", toolExecutions })),
  );
  expect(toolPart(second.output[1], "call-1")).toMatchObject({
    result: "partial output",
    isPreliminary: true,
  });
});
