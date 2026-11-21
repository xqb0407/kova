/**
 * 主 Agent steeringMode="all" 的行为测试（真实 pi-agent-core Agent，非 fake）：
 * 同一 drain 点上待处理的多条并入消息在同一次模型请求里送达——相邻两条
 * 「并入当前回复」只多跑一轮，而不是每条各跑一轮。
 */
import { describe, expect, test } from "bun:test";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";

const model = {
  id: "model",
  api: "openai-completions",
  provider: "provider",
  name: "Model",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_000,
  baseUrl: "https://provider.invalid/v1",
} as any;

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "provider",
    model: "model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: "429: too many requests",
    timestamp: Date.now(),
    ...overrides,
  };
}

function successStream(): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  const message = assistantMessage({
    content: [{ type: "text", text: "ok" }],
    stopReason: "stop",
    errorMessage: undefined,
  });
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

const user = (text: string): AgentMessage =>
  ({ role: "user", content: text, timestamp: Date.now() }) as AgentMessage;

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string" ? part : ((part as { text?: string }).text ?? ""),
      )
      .join("");
  }
  return "";
};

/** streamFn 每次调用记一条该请求上下文里的 user 文本序列 */
type Request = { userTexts: string[] };

function makeAgent(
  steeringMode: "all" | "one-at-a-time",
  /** 第一条流挂起直到 gate 放行（模拟运行中的长回复） */
  gate?: Promise<void>,
): { agent: Agent; requests: Request[] } {
  const requests: Request[] = [];
  let calls = 0;
  const agent = new Agent({
    steeringMode,
    initialState: { model },
    streamFn: async (_model, context) => {
      calls += 1;
      const current = (context.messages ?? [])
        .filter((m) => m.role === "user")
        .map((m) => textOf(m.content));
      requests.push({ userTexts: current });
      if (gate && calls === 1) await gate;
      return successStream();
    },
  });
  return { agent, requests };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("steeringMode 批量并入（真实 Agent loop）", () => {
  test("all：边界前的多条并入在同一次请求送达", async () => {
    const { agent, requests } = makeAgent("all");
    agent.steer(user("A"));
    agent.steer(user("B"));
    await agent.prompt("start");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.userTexts).toEqual(["start", "A", "B"]);
  });

  test("运行中先后并入两条：下一个边界一次送达（相邻两条只多跑一轮）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { agent, requests } = makeAgent("all", gate);
    const run = agent.prompt("start");
    await waitFor(() => requests.length >= 1);
    expect(requests[0]!.userTexts).toEqual(["start"]);
    agent.steer(user("A"));
    agent.steer(user("B"));
    release();
    await run;
    // 请求上下文是全量转录：第二次请求 = 第一次 + 两条并入，且只多这一次请求
    expect(requests).toHaveLength(2);
    expect(requests[1]!.userTexts).toEqual(["start", "A", "B"]);
  });

  test("默认 one-at-a-time：每条并入各触发一次请求（对照）", async () => {
    const { agent, requests } = makeAgent("one-at-a-time");
    agent.steer(user("A"));
    agent.steer(user("B"));
    await agent.prompt("start");
    expect(requests).toHaveLength(2);
    expect(requests[0]!.userTexts).toEqual(["start", "A"]);
    expect(requests[1]!.userTexts).toEqual(["start", "A", "B"]);
  });
});
