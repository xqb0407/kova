import { describe, test, expect } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { microcompactMessages } from "../../src/agent/context";

/**
 * 轻清理（microcompact）场景测试。
 *
 * 触发口径：fakeModel(4_000, 1_000) → hardLimit = 4000 − max(reserve 2000,
 * output 1000, 5% 200) = 2000，触发线 = 0.9 × 2000 = 1800 估算 token
 * （chars/4 启发式，测试消息不带 usage 即走该路径）。
 */

const fakeModel = (contextWindow = 4_000, maxTokens = 1_000) =>
  ({
    id: "m",
    name: "m",
    api: "openai-completions",
    provider: "test",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  }) as unknown as Model<Api>;

const userMsg = (text: string): AgentMessage =>
  ({ role: "user", content: text, timestamp: 1 }) as unknown as AgentMessage;
const assistantMsg = (text: string): AgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 2,
  }) as unknown as AgentMessage;
const toolCallAssistant = (id: string, name: string): AgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: {} }],
    timestamp: 2,
  }) as unknown as AgentMessage;
const toolResult = (
  id: string,
  text: string,
  opts?: { isError?: boolean },
): AgentMessage =>
  ({
    role: "toolResult",
    toolCallId: id,
    content: [{ type: "text", text }],
    isError: opts?.isError ?? false,
    timestamp: 3,
  }) as unknown as AgentMessage;

const textOf = (msg: AgentMessage): string => {
  const m = msg as { content?: unknown };
  if (typeof m.content === "string") return m.content;
  return Array.isArray(m.content)
    ? m.content.map((b) => (b as { text?: string }).text ?? "").join("")
    : "";
};

describe("microcompactMessages", () => {
  test("未过触发线：no-op，上下文零改动", () => {
    const messages = [
      userMsg("hi"),
      assistantMsg("hello"),
      toolCallAssistant("c1", "read"),
      toolResult("c1", "y".repeat(2_000)), // ~500 token，总占用低于 1800
    ];
    const outcome = microcompactMessages(messages, fakeModel());
    expect(outcome.cleared).toBe(0);
    expect(textOf(messages[3])).toBe("y".repeat(2_000));
  });

  test("触发：清最旧的白名单结果，保留最近 5 条与全部叙事，条数不变", () => {
    const messages: AgentMessage[] = [userMsg("任务"), assistantMsg("开始")];
    for (let i = 0; i < 8; i++) {
      messages.push(toolCallAssistant(`c${i}`, "read"));
      messages.push(toolResult(`c${i}`, "y".repeat(3_000)));
    }
    const before = messages.length;
    const outcome = microcompactMessages(messages, fakeModel());
    // 8 条结果清最旧 3 条（保留最近 5 条）
    expect(outcome.cleared).toBe(3);
    expect(outcome.tokensSaved).toBeGreaterThan(256);
    expect(messages.length).toBe(before); // 条数不变，toolCall/toolResult 配对完整
    // 最旧 3 条换成占位符
    for (const idx of [3, 5, 7]) {
      expect(textOf(messages[idx])).toBe("[Old tool result content cleared]");
    }
    // 最近 5 条原文保留
    for (const idx of [9, 11, 13, 15, 17]) {
      expect(textOf(messages[idx])).toBe("y".repeat(3_000));
    }
    // 叙事（user/assistant 文本轮）原样
    expect(textOf(messages[0])).toBe("任务");
    expect(textOf(messages[1])).toBe("开始");
  });

  test("error 结果与白名单外工具一律保留", () => {
    const messages: AgentMessage[] = [userMsg("x".repeat(8_000))]; // ~2000 token 越触发线
    messages.push(toolCallAssistant("e1", "read"));
    messages.push(toolResult("e1", "y".repeat(3_000), { isError: true }));
    messages.push(toolCallAssistant("q1", "Question"));
    messages.push(toolResult("q1", "y".repeat(3_000)));
    messages.push(toolCallAssistant("k1", "kb_search"));
    messages.push(toolResult("k1", "y".repeat(3_000)));
    const outcome = microcompactMessages(messages, fakeModel());
    // kb_search 在白名单且只有 1 条（≤ 保留数）→ 实际无可清
    expect(outcome.cleared).toBe(0);
    expect(textOf(messages[2])).toBe("y".repeat(3_000)); // error 保留
    expect(textOf(messages[4])).toBe("y".repeat(3_000)); // Question 保留
    expect(textOf(messages[6])).toBe("y".repeat(3_000)); // kb_search 在保留窗内
  });

  test("收益低于 256 token：整体放弃（占用越线但可清内容太小）", () => {
    const messages: AgentMessage[] = [
      userMsg("x".repeat(8_000)), // 占用越线的主力
      assistantMsg("ok"),
    ];
    for (let i = 0; i < 6; i++) {
      messages.push(toolCallAssistant(`c${i}`, "read"));
      messages.push(toolResult(`c${i}`, "ok")); // 清最旧 1 条只省几个 token
    }
    const outcome = microcompactMessages(messages, fakeModel());
    expect(outcome.cleared).toBe(0);
    expect(textOf(messages[3])).toBe("ok"); // 最旧一条 toolResult 原样保留
  });

  test("幂等：已清过的结果二次调用跳过", () => {
    const messages: AgentMessage[] = [userMsg("任务")];
    for (let i = 0; i < 8; i++) {
      messages.push(toolCallAssistant(`c${i}`, "bash"));
      messages.push(toolResult(`c${i}`, "y".repeat(3_000)));
    }
    const first = microcompactMessages(messages, fakeModel());
    expect(first.cleared).toBe(3);
    const second = microcompactMessages(messages, fakeModel());
    expect(second.cleared).toBe(0);
  });

  test("无 model：no-op（只读投影/测试早期）", () => {
    const messages = [userMsg("x".repeat(8_000))];
    const outcome = microcompactMessages(messages, null);
    expect(outcome.cleared).toBe(0);
  });

  test("消息条数与角色序列不变（provider 配对约束）", () => {
    const messages: AgentMessage[] = [userMsg("任务")];
    for (let i = 0; i < 7; i++) {
      messages.push(toolCallAssistant(`c${i}`, "grep"));
      messages.push(toolResult(`c${i}`, "y".repeat(3_000)));
    }
    const rolesBefore = messages.map((m) => (m as { role?: string }).role ?? "");
    microcompactMessages(messages, fakeModel());
    const rolesAfter = messages.map((m) => (m as { role?: string }).role ?? "");
    expect(rolesAfter).toEqual(rolesBefore);
  });
});
