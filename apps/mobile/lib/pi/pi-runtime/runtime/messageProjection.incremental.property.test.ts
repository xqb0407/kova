/**
 * 增量投影的随机差分测试：随机生成消息变更序列，每一步都断言
 * incremental(input, cache) 与全量 projectPiThreadMessages(input) 等价。
 *
 * 这是对"前缀复用只影响性能、不影响语义"的兜底：手写用例只覆盖已知场景，
 * 随机序列会撞出组合边界（追加/截断/原地修改/乱序工具结果/翻页/runStatus）。
 */
import { expect, test, vi } from "vitest";

vi.mock("@assistant-ui/react-native", () => ({
  ExportedMessageRepository: { fromArray: (x: unknown) => x },
}));
vi.mock("pi-protocol", () => ({
  // 走真实哨兵语义，覆盖"跳过但不 flush"的自动续跑行
  isAutoContinueMessage: (message: any) => {
    const first = message?.content?.[0];
    return (
      message?.role === "user" &&
      first?.type === "text" &&
      typeof first.text === "string" &&
      first.text.startsWith("[[auto-continue]] ")
    );
  },
  // 能力收尾提醒哨兵同款（messageProjection 已按同口径过滤）
  isCapabilityReminderMessage: (message: any) => {
    const first = message?.content?.[0];
    return (
      message?.role === "user" &&
      first?.type === "text" &&
      typeof first.text === "string" &&
      first.text.startsWith("[[capability-reminder]] ")
    );
  },
  // 子代理后台报告注入（含旧版裸导语）：messageProjection 按同口径整体隐藏
  isSubagentReportMessage: (message: any) => {
    const first = message?.content?.[0];
    return (
      message?.role === "user" &&
      first?.type === "text" &&
      typeof first.text === "string" &&
      (first.text.startsWith("[[subagent-report]] ") ||
        first.text.startsWith(
          "Background subagents you started with Task have finished",
        ))
    );
  },
  stripImGroupPrompt: (text: string) =>
    text
      .replace(/^\[\[im-group:[^\[\]\r\n]{1,140}\]\] ?/, "")
      .replace(/^\[群聊 · [^\[\]\r\n]{1,40}\] ?/, ""),
}));

import {
  projectPiThreadMessages,
  projectPiThreadMessagesIncremental,
  type PiProjectionCache,
  type PiProjectionInput,
} from "./messageProjection";

type AnyMessage = Record<string, any>;

const NO_REQUESTS: readonly never[] = [];

/** mulberry32：固定种子，失败可复现 */
const makeRng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const textPart = (text: string) => ({ type: "text", text });

const pick = <T,>(rng: () => number, items: readonly T[]): T | undefined =>
  items.length === 0 ? undefined : items[Math.floor(rng() * items.length)];

const normalize = (messages: readonly any[]) =>
  messages.map((message) =>
    message.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.length === 0 &&
    message.status?.type === "running"
      ? // 收尾占位用 new Date()，两条路径各自取当前时间：只比较结构
        { ...message, createdAt: 0 }
      : message,
  );

test("随机变更序列下增量投影与全量投影始终等价", () => {
  // 默认 40 个种子够日常回归；排查时可用 PI_PROPERTY_SEEDS=300 放大。
  const seedCount = Number(process.env.PI_PROPERTY_SEEDS ?? 40) || 40;
  const seeds = Array.from({ length: seedCount }, (_, index) => index * 7919 + 1);
  for (const seed of seeds) {
    const rng = makeRng(seed);
    let seq = 1;
    let messages: AnyMessage[] = [];
    let toolExecutions: Readonly<Record<string, any>> = {};
    let runStatus: PiProjectionInput["runStatus"] = "idle";
    let streamingMessageIndex: number | undefined;
    let cache: PiProjectionCache | null = null;

    const nextSeq = () => seq++;
    const newUser = (auto = false) => ({
      role: "user",
      content: [textPart(auto ? `[[auto-continue]] q${nextSeq()}` : `q${seq++}`)],
      timestamp: seq,
      __seq: seq,
    });
    const newAssistant = () => ({
      role: "assistant",
      content:
        rng() < 0.5
          ? [textPart(`a${seq++}`)]
          : [
              textPart(`a${seq++}`),
              {
                type: "toolCall",
                id: `call-${seq++}`,
                name: "bash",
                arguments: {},
              },
            ],
      timestamp: seq,
      __seq: seq,
      stopReason: "stop",
    });
    const newToolResult = (toolCallId: string) => ({
      role: "toolResult",
      toolCallId,
      content: [textPart(`result-${seq++}`)],
      isError: false,
      timestamp: seq,
      __seq: seq,
    });

    const allToolCallIds = () =>
      messages.flatMap((message) =>
        message.role === "assistant"
          ? message.content
              .filter((part: any) => part.type === "toolCall")
              .map((part: any) => part.id)
          : [],
      );

    // 初始一段对话
    messages.push(newUser(), newAssistant());

    for (let step = 0; step < 80; step++) {
      const roll = rng();
      if (roll < 0.08) {
        // 无变化
      } else if (roll < 0.2) {
        messages.push(newUser(rng() < 0.2));
      } else if (roll < 0.31) {
        messages.push(newAssistant());
      } else if (roll < 0.4) {
        const id = pick(rng, allToolCallIds());
        if (id) messages.push(newToolResult(id));
      } else if (roll < 0.52) {
        // 原地追加流式文本（引用不变）
        const assistantIndexes = messages
          .map((message, index) => (message.role === "assistant" ? index : -1))
          .filter((index) => index >= 0);
        const index = pick(rng, assistantIndexes);
        if (index !== undefined) {
          const message = messages[index]!;
          const first = message.content[0];
          if (first?.type === "text") first.text += "x";
          else message.content.unshift(textPart("x"));
          streamingMessageIndex = index;
        }
      } else if (roll < 0.57) {
        // 流式结束：只清标记，内容不再变
        streamingMessageIndex = undefined;
      } else if (roll < 0.65) {
        // 整条替换（新对象，内容变化，角色不变）
        const index = Math.floor(rng() * messages.length);
        const message = messages[index];
        if (message) {
          messages[index] = {
            ...message,
            content:
              message.role === "assistant"
                ? [textPart(`replaced-${seq++}`)]
                : [{ type: "text", text: `replaced-${seq++}` }],
            __seq: seq++,
          };
        }
      } else if (roll < 0.72) {
        // 中间插入（转录正常只在尾部增长，这里刻意覆盖下标边界）
        const index = Math.floor(rng() * (messages.length + 1));
        messages.splice(index, 0, rng() < 0.5 ? newUser() : newAssistant());
        if (streamingMessageIndex !== undefined && index <= streamingMessageIndex) {
          streamingMessageIndex += 1;
        }
      } else if (roll < 0.78) {
        // 角色替换：可能把 assistant/toolResult 换成 user，覆盖"移除配对组"的路径
        const index = Math.floor(rng() * messages.length);
        messages[index] = {
          role: "user",
          content: [textPart(`role-swap-${seq++}`)],
          timestamp: seq,
          __seq: seq++,
        };
      } else if (roll < 0.85) {
        // 截断尾部
        const keep = Math.floor(rng() * Math.max(1, messages.length));
        messages = messages.slice(0, keep);
        if (streamingMessageIndex !== undefined && streamingMessageIndex >= messages.length) {
          streamingMessageIndex = undefined;
        }
      } else if (roll < 0.9) {
        // 分页 prepend
        const older = [newUser(), newAssistant()];
        messages = [...older, ...messages];
        if (streamingMessageIndex !== undefined) {
          streamingMessageIndex += older.length;
        }
      } else if (roll < 0.95) {
        runStatus =
          runStatus === "running" ? "idle" : runStatus === "idle" ? "running" : "failed";
      } else {
        // 工具直播态更新/移除
        const id = pick(rng, allToolCallIds());
        if (id) {
          const next = { ...toolExecutions };
          if (next[id] && rng() < 0.4) delete next[id];
          else {
            next[id] = {
              toolCallId: id,
              status: rng() < 0.5 ? "running" : "complete",
              partialResult: { content: [textPart(`partial-${seq++}`)] },
            };
          }
          toolExecutions = next;
        }
      }

      const input: PiProjectionInput = {
        messages: [...messages] as unknown as PiProjectionInput["messages"],
        toolExecutions,
        runStatus,
        hostUiRequests: NO_REQUESTS,
        streamingMessageIndex,
      };
      const actual = projectPiThreadMessagesIncremental(input, cache);
      cache = actual.cache;
      const expected = projectPiThreadMessages(input);

      const actualOut = normalize(actual.output);
      const expectedOut = normalize(expected);
      for (let i = 0; i < Math.max(actualOut.length, expectedOut.length); i++) {
        try {
          expect(actualOut[i]).toEqual(expectedOut[i]);
        } catch (error) {
          throw new Error(
            `seed=${seed} step=${step} first diff at output[${i}] ` +
              `(actual ${actualOut.length} / expected ${expectedOut.length})\n` +
              `actual=${JSON.stringify(actualOut[i])}\n` +
              `expected=${JSON.stringify(expectedOut[i])}\n` +
              `messages=${JSON.stringify(messages)}\n` +
              `runStatus=${runStatus} streaming=${streamingMessageIndex}\n` +
              String(error),
          );
        }
      }
    }
  }
});
