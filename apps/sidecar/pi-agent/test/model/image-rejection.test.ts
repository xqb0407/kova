import { describe, test, expect } from "bun:test";
import type { Context, Message } from "@earendil-works/pi-ai";
import {
  contextHasImages,
  imageModelKey,
  shouldAttemptImageRepair,
  stripImagesFromContext,
  IMAGE_REJECTION_PLACEHOLDER,
} from "../../src/model/image-rejection";
import type { ClassifiedAgentError } from "../../src/agent/agent-errors";

const png1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const image = () => ({ type: "image" as const, data: png1x1, mimeType: "image/png" });
const text = (t: string) => ({ type: "text" as const, text: t });

const userWithImages: Message = {
  role: "user",
  content: [text("看这两张图"), image(), image()],
  timestamp: Date.now(),
};

const userTextOnly: Message = {
  role: "user",
  content: [text("纯文本")],
  timestamp: Date.now(),
};

const toolResultWithImage: Message = {
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "screenshot",
  content: [text("截图"), image()],
  isError: false,
  timestamp: Date.now(),
};

const assistantPlain: Message = {
  role: "assistant",
  content: [text("回复")],
  api: "openai-completions",
  provider: "p",
  model: "m",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
};

const makeError = (overrides: Partial<ClassifiedAgentError>): ClassifiedAgentError => ({
  code: "PROVIDER_ERROR",
  message: "400 Bad Request",
  retriable: false,
  source: "provider",
  ...overrides,
});

describe("contextHasImages", () => {
  test("user/toolResult 图片命中，纯文本与 assistant 不命中", () => {
    expect(contextHasImages({ messages: [userWithImages, assistantPlain] })).toBe(true);
    expect(contextHasImages({ messages: [toolResultWithImage] })).toBe(true);
    expect(contextHasImages({ messages: [userTextOnly, assistantPlain] })).toBe(false);
    // content 为 string 的历史 user 消息不炸
    expect(
      contextHasImages({ messages: [{ role: "user", content: "文本", timestamp: 0 }] }),
    ).toBe(false);
  });
});

describe("stripImagesFromContext", () => {
  test("连续多图合并为一条占位文本，正文保留", () => {
    const out = stripImagesFromContext({ messages: [userWithImages] });
    const user = out.messages[0] as { content: Array<{ type: string; text?: string }> };
    expect(user.content.some((b) => b.type === "image")).toBe(false);
    const placeholders = user.content.filter(
      (b) => b.type === "text" && b.text === IMAGE_REJECTION_PLACEHOLDER,
    );
    expect(placeholders.length).toBe(1);
    expect(user.content.some((b) => b.type === "text" && b.text === "看这两张图")).toBe(true);
  });

  test("toolResult 图片同样剥离", () => {
    const out = stripImagesFromContext({ messages: [toolResultWithImage] });
    const tool = out.messages[0] as { content: Array<{ type: string; text?: string }> };
    expect(tool.content.some((b) => b.type === "image")).toBe(false);
    expect(
      tool.content.some((b) => b.type === "text" && b.text === IMAGE_REJECTION_PLACEHOLDER),
    ).toBe(true);
  });

  test("无图消息保持原引用，context 其余字段不动", () => {
    const context: Context = {
      systemPrompt: "sys",
      messages: [userTextOnly, assistantPlain, userWithImages],
      tools: [],
    };
    const out = stripImagesFromContext(context);
    expect(out.systemPrompt).toBe("sys");
    expect(out.tools).toBe(context.tools);
    expect(out.messages[0]).toBe(userTextOnly);
    expect(out.messages[1]).toBe(assistantPlain);
    expect(out.messages[2]).not.toBe(userWithImages);
  });
});

describe("shouldAttemptImageRepair", () => {
  const withImages: Context = { messages: [userWithImages] };
  const noImages: Context = { messages: [userTextOnly] };

  test("终态 400/422 且带图 → 修复", () => {
    expect(
      shouldAttemptImageRepair(makeError({ details: { providerStatus: 400 } }), withImages),
    ).toBe(true);
    expect(
      shouldAttemptImageRepair(makeError({ details: { providerStatus: 422 } }), withImages),
    ).toBe(true);
  });

  test("429 限流不修复（status 与话术都不命中，归既有重试路径）", () => {
    expect(
      shouldAttemptImageRepair(
        makeError({ retriable: true, code: "PROVIDER_RATE_LIMITED", details: { providerStatus: 429 } }),
        withImages,
      ),
    ).toBe(false);
    expect(
      shouldAttemptImageRepair(
        makeError({
          retriable: true,
          code: "NETWORK_ERROR",
          details: undefined,
          message: "fetch failed",
        }),
        withImages,
      ),
    ).toBe(false);
  });

  test("分类器泛化成 retriable 的 400 也修复（retriable 不做硬闸）", () => {
    expect(
      shouldAttemptImageRepair(
        makeError({ retriable: true, details: { providerStatus: 400 } }),
        withImages,
      ),
    ).toBe(true);
  });

  test("无图请求不修复（400 由别的原因引起，剥了也白剥）", () => {
    expect(
      shouldAttemptImageRepair(makeError({ details: { providerStatus: 400 } }), noImages),
    ).toBe(false);
  });

  test("status 未知时按话术兜底：提图/多模态措辞修复，无关措辞不修复", () => {
    expect(
      shouldAttemptImageRepair(
        makeError({ message: "invalid content: image input is not supported", details: undefined }),
        withImages,
      ),
    ).toBe(true);
    expect(
      shouldAttemptImageRepair(
        makeError({ message: "invalid model specification", details: undefined }),
        withImages,
      ).valueOf(),
    ).toBe(false);
  });

  test("details 无 status 时退回 fetch 捕获的 capturedStatus（无前缀 body 的网关）", () => {
    expect(
      shouldAttemptImageRepair(
        makeError({ message: 'invalid request: {"error":{"message":"bad content"}}', details: undefined }),
        withImages,
        400,
      ),
    ).toBe(true);
    // 话术兜底只在捕获 status 也缺失时才生效
    expect(
      shouldAttemptImageRepair(
        makeError({ message: "upstream said no", details: undefined }),
        withImages,
        403,
      ),
    ).toBe(false);
  });

  test("500/503 等其它终态 status 不走修复（归瞬时/上游路径）", () => {
    expect(
      shouldAttemptImageRepair(makeError({ details: { providerStatus: 500 } }), withImages),
    ).toBe(false);
  });
});

describe("imageModelKey", () => {
  test("provider/id 键格式", () => {
    expect(imageModelKey({ provider: "custom", id: "gpt-x" } as never)).toBe("custom/gpt-x");
  });
});
