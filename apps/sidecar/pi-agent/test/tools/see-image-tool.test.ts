import { describe, test, expect, afterAll } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import {
  buildSeeImageTool,
  cleanVisionAnswer,
  defaultHelperCandidates,
  defaultResolveHelper,
  filterVisionCandidates,
  parseVisionModelOverride,
  pickVisionHelper,
  resetVisionAnswerCacheForTest,
  resetVisionHelperCacheForTest,
  SEE_IMAGE_DEFAULT_QUESTION,
  type SeeImageSessionFacts,
} from "../../src/tools/see-image-tool";
import { resetVisionToolConfigForTest } from "../../src/tools/vision-tool-config";
import { imageRefId } from "../../src/model/image-refs";

const png1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const png2x2 = png1x1 + "AAAA";

const image = (data: string) => ({ type: "image" as const, data, mimeType: "image/png" });
const text = (t: string) => ({ type: "text" as const, text: t });

const textModel = { provider: "main-p", id: "main-m", input: ["text"], cost: { input: 0.01 } } as unknown as Model<Api>;
const visionModel = { provider: "main-p", id: "main-v", input: ["text", "image"], cost: { input: 0.01 } } as unknown as Model<Api>;
const cheapForeignVision = { provider: "other-p", id: "cheap", input: ["text", "image"], cost: { input: 0.0001 } } as unknown as Model<Api>;
const priceyForeignVision = { provider: "other-p", id: "pricey", input: ["text", "image"], cost: { input: 0.5 } } as unknown as Model<Api>;

afterAll(() => {
  resetVisionToolConfigForTest();
  resetVisionHelperCacheForTest();
  resetVisionAnswerCacheForTest();
});

/** 假流：逐 delta 吐文本后结束；error 则吐一个 error 事件 */
function fakeStream(...deltas: string[]) {
  return async function* () {
    for (const d of deltas) yield { type: "text_delta", delta: d };
  };
}

function factsOf(messages: unknown[], model: Model<Api> = textModel): SeeImageSessionFacts {
  return { model, messages };
}

async function run(
  tool: AgentTool,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) {
  return (await tool.execute("call-1", params as never, options?.signal)) as {
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
    isError?: boolean;
  };
}

const answerText = (res: { content: Array<{ type: string; text?: string }> }) =>
  res.content.find((b) => b.type === "text")?.text ?? "";

describe("see_image 门控", () => {
  test("开关关闭：拒绝执行（防旧工具表残留出网）", async () => {
    resetVisionToolConfigForTest({ enabled: false });
    const tool = buildSeeImageTool({
      getFacts: () => factsOf([{ role: "user", content: [image(png1x1)], timestamp: 0 }]),
      resolveHelper: async () => visionModel,
      streamSimple: fakeStream("答案") as never,
    });
    const res = await run(tool, {});
    expect(res.isError).toBe(true);
    expect(answerText(res)).toContain("disabled");
  });

  test("会话事实缺失：报错不炸", async () => {
    resetVisionToolConfigForTest({ enabled: true });
    const tool = buildSeeImageTool({});
    const res = await run(tool, {});
    expect(res.isError).toBe(true);
  });

  test("主模型支持视觉：提示无需调用，辅助模型不被调用", async () => {
    resetVisionToolConfigForTest({ enabled: true });
    let called = 0;
    const tool = buildSeeImageTool({
      getFacts: () => factsOf([{ role: "user", content: [image(png1x1)], timestamp: 0 }], visionModel),
      resolveHelper: async () => {
        called += 1;
        return visionModel;
      },
      streamSimple: fakeStream("答案") as never,
    });
    const res = await run(tool, {});
    expect(res.isError).toBeFalsy();
    expect(answerText(res)).toContain("not needed");
    expect(called).toBe(0);
  });
});

describe("see_image 图片定位", () => {
  const messages = [
    { role: "user", content: [text("图一"), image(png1x1)], timestamp: 0 },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "browser_shot",
      content: [image(png2x2)],
      timestamp: 0,
    },
  ];

  test("按 imageId 精确找图，答案带 helper/imageId 包装", async () => {
    resetVisionToolConfigForTest({ enabled: true });
    let captured: Context | undefined;
    const tool = buildSeeImageTool({
      getFacts: () => factsOf(messages),
      resolveHelper: async () => visionModel,
      streamSimple: (async function* (_m: Model<Api>, ctx: Context) {
        captured = ctx;
        yield { type: "text_delta", delta: "图里是一只猫。" };
      }) as never,
    });
    const res = await run(tool, { imageId: imageRefId(png1x1), question: "图里是什么？" });
    expect(res.isError).toBeFalsy();
    const out = answerText(res);
    expect(out).toContain("[vision model answer | helper=main-p/main-v");
    expect(out).toContain(`imageId=${imageRefId(png1x1)}`);
    expect(out).toContain("图里是一只猫。");
    expect(out).toContain("[/vision model answer]");
    // 辅助请求只带提问与原图，不夹带主会话消息
    const user = captured!.messages[0] as { content: Array<{ type: string; text?: string; data?: string }> };
    expect(user.content[0]!.text).toBe("图里是什么？");
    expect(user.content[1]!.data).toBe(png1x1);
    expect(captured!.messages).toHaveLength(1);
  });

  test("缺省 imageId 取最新一张（工具截图）", async () => {
    resetVisionToolConfigForTest({ enabled: true });
    let seenData = "";
    const tool = buildSeeImageTool({
      getFacts: () => factsOf(messages),
      resolveHelper: async () => visionModel,
      streamSimple: (async function* (_m: Model<Api>, ctx: Context) {
        const user = ctx.messages[0] as { content: Array<{ data?: string }> };
        seenData = user.content[1]!.data ?? "";
        yield { type: "text_delta", delta: "ok" };
      }) as never,
    });
    const res = await run(tool, { question: "页面上有什么？" });
    expect(res.isError).toBeFalsy();
    expect(seenData).toBe(png2x2);
  });

  test("未知 imageId：报错并列出可用 ID", async () => {
    resetVisionToolConfigForTest({ enabled: true });
    const tool = buildSeeImageTool({
      getFacts: () => factsOf(messages),
      resolveHelper: async () => visionModel,
      streamSimple: fakeStream("x") as never,
    });
    const res = await run(tool, { imageId: "img_deadbeefdead" });
    expect(res.isError).toBe(true);
    expect(answerText(res)).toContain(imageRefId(png1x1));
    expect(answerText(res)).toContain(imageRefId(png2x2));
  });

  test("整段占位粘贴的 imageId 也能抽取命中", async () => {
    resetVisionToolConfigForTest({ enabled: true });
    const tool = buildSeeImageTool({
      getFacts: () => factsOf(messages),
      resolveHelper: async () => visionModel,
      streamSimple: fakeStream("ok") as never,
    });
    const res = await run(tool, {
      imageId: `[image attached | imageId=${imageRefId(png1x1)} | call see_image]`,
    });
    expect(res.isError).toBeFalsy();
    expect(answerText(res)).toContain(`imageId=${imageRefId(png1x1)}`);
  });

  test("会话无图：报错提示先截图/发图", async () => {
    resetVisionToolConfigForTest({ enabled: true });
    const tool = buildSeeImageTool({
      getFacts: () => factsOf([{ role: "user", content: [text("纯文本")], timestamp: 0 }]),
      resolveHelper: async () => visionModel,
      streamSimple: fakeStream("x") as never,
    });
    const res = await run(tool, {});
    expect(res.isError).toBe(true);
    expect(answerText(res)).toContain("No image found");
  });
});

describe("see_image 辅助模型与输出", () => {
  test("同图同问命中应答缓存：第二次不调辅助流；换问句重新调用", async () => {
    resetVisionToolConfigForTest({ enabled: true });
    resetVisionAnswerCacheForTest();
    let calls = 0;
    const tool = buildSeeImageTool({
      getFacts: () => factsOf([{ role: "user", content: [image(png1x1)], timestamp: 0 }]),
      resolveHelper: async () => visionModel,
      streamSimple: (async function* () {
        calls += 1;
        yield { type: "text_delta", delta: "答案" };
      }) as never,
    });
    const first = await run(tool, { question: "什么内容？" });
    const second = await run(tool, { question: "什么内容？" });
    expect(calls).toBe(1);
    expect(answerText(second)).toBe(answerText(first));
    expect(answerText(second)).toContain(`imageId=${imageRefId(png1x1)}`);
    await run(tool, { question: "换个问题" });
    expect(calls).toBe(2);
    resetVisionAnswerCacheForTest();
  });

  test("首选辅助调用失败 → 回落下一候选成功", async () => {
    resetVisionToolConfigForTest({ enabled: true });
    resetVisionAnswerCacheForTest();
    const attempts: string[] = [];
    const badModel = { provider: "bad-p", id: "bad-m", input: ["text", "image"] } as unknown as Model<Api>;
    const tool = buildSeeImageTool({
      getFacts: () => factsOf([{ role: "user", content: [image(png1x1)], timestamp: 0 }]),
      resolveHelpers: async () => [badModel, visionModel],
      streamSimple: (async function* (m: Model<Api>) {
        attempts.push(m.id);
        if (m.id === "bad-m") yield { type: "error", error: new Error("401 unauthorized") };
        else yield { type: "text_delta", delta: "备用成功" };
      }) as never,
    });
    const res = await run(tool, { question: "什么内容？" });
    expect(res.isError).toBeFalsy();
    expect(attempts).toEqual(["bad-m", "main-v"]);
    expect(answerText(res)).toContain("helper=main-p/main-v");
    expect(answerText(res)).toContain("备用成功");
    resetVisionAnswerCacheForTest();
  });

  test("候选链全部失败 → isError 且带最后一次错误", async () => {
    resetVisionToolConfigForTest({ enabled: true });
    resetVisionAnswerCacheForTest();
    let calls = 0;
    const badModel = { provider: "bad-p", id: "bad-m", input: ["text", "image"] } as unknown as Model<Api>;
    const tool = buildSeeImageTool({
      getFacts: () => factsOf([{ role: "user", content: [image(png1x1)], timestamp: 0 }]),
      resolveHelpers: async () => [badModel, visionModel],
      streamSimple: (async function* () {
        calls += 1;
        yield { type: "error", error: new Error("boom") };
      }) as never,
    });
    const res = await run(tool, { question: "什么内容？" });
    expect(res.isError).toBe(true);
    expect(calls).toBe(2);
    expect(answerText(res)).toContain("boom");
    resetVisionAnswerCacheForTest();
  });

  test("空文本也回落下一候选", async () => {
    resetVisionToolConfigForTest({ enabled: true });
    resetVisionAnswerCacheForTest();
    const badModel = { provider: "bad-p", id: "bad-m", input: ["text", "image"] } as unknown as Model<Api>;
    const tool = buildSeeImageTool({
      getFacts: () => factsOf([{ role: "user", content: [image(png1x1)], timestamp: 0 }]),
      resolveHelpers: async () => [badModel, visionModel],
      streamSimple: (async function* (m: Model<Api>) {
        if (m.id === "bad-m") return; // 空回答
        yield { type: "text_delta", delta: "有内容" };
      }) as never,
    });
    const res = await run(tool, { question: "q" });
    expect(res.isError).toBeFalsy();
    expect(answerText(res)).toContain("有内容");
    resetVisionAnswerCacheForTest();
  });

  test("defaultHelperCandidates：裸环境候选链为空，defaultResolveHelper 返回 undefined", async () => {
    resetVisionToolConfigForTest();
    const candidates = await defaultHelperCandidates(textModel);
    expect(candidates).toEqual([]);
    expect(await defaultResolveHelper(textModel)).toBeUndefined();
  });

  test("首选候选超时 → 回落下一候选（PI_VISION_TIMEOUT_MS 驱动）", async () => {
    resetVisionToolConfigForTest({ enabled: true });
    resetVisionAnswerCacheForTest();
    process.env.PI_VISION_TIMEOUT_MS = "1000";
    const attempts: string[] = [];
    const slowModel = { provider: "slow-p", id: "slow-m", input: ["text", "image"] } as unknown as Model<Api>;
    const tool = buildSeeImageTool({
      getFacts: () => factsOf([{ role: "user", content: [image(png1x1)], timestamp: 0 }]),
      resolveHelpers: async () => [slowModel, visionModel],
      streamSimple: (async function* (
        m: Model<Api>,
        _ctx: Context,
        options?: { signal?: AbortSignal },
      ) {
        attempts.push(m.id);
        if (m.id === "slow-m") {
          // 挂起直到该候选的独立超时触发，然后正常结束（无输出）
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) return resolve();
            options?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }
        yield { type: "text_delta", delta: "备用成功" };
      }) as never,
    });
    const res = await run(tool, { question: "q" });
    expect(res.isError).toBeFalsy();
    expect(attempts).toEqual(["slow-m", "main-v"]);
    expect(answerText(res)).toContain("备用成功");
    delete process.env.PI_VISION_TIMEOUT_MS;
    resetVisionAnswerCacheForTest();
  }, 10_000);

  test("全部候选超时 → isError 超时提示", async () => {
    resetVisionToolConfigForTest({ enabled: true });
    resetVisionAnswerCacheForTest();
    process.env.PI_VISION_TIMEOUT_MS = "1000";
    const slowModel = { provider: "slow-p", id: "slow-m", input: ["text", "image"] } as unknown as Model<Api>;
    const tool = buildSeeImageTool({
      getFacts: () => factsOf([{ role: "user", content: [image(png1x1)], timestamp: 0 }]),
      resolveHelpers: async () => [slowModel, visionModel],
      streamSimple: (async function* (
        _m: Model<Api>,
        _ctx: Context,
        options?: { signal?: AbortSignal },
      ) {
        // 两个候选都挂起到各自超时
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) return resolve();
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return;
      }) as never,
    });
    const res = await run(tool, { question: "q" });
    expect(res.isError).toBe(true);
    expect(answerText(res)).toContain("timed out");
    delete process.env.PI_VISION_TIMEOUT_MS;
    resetVisionAnswerCacheForTest();
  }, 15_000);

  test("无可用视觉模型：返回可行动错误", async () => {
    resetVisionToolConfigForTest({ enabled: true });
    const tool = buildSeeImageTool({
      getFacts: () => factsOf([{ role: "user", content: [image(png1x1)], timestamp: 0 }]),
      resolveHelper: async () => undefined,
      streamSimple: fakeStream("x") as never,
    });
    const res = await run(tool, {});
    expect(res.isError).toBe(true);
    expect(answerText(res)).toContain("No vision-capable model");
  });

  test("辅助流 error 事件：isError 上浮", async () => {
    resetVisionToolConfigForTest({ enabled: true });
    const tool = buildSeeImageTool({
      getFacts: () => factsOf([{ role: "user", content: [image(png1x1)], timestamp: 0 }]),
      resolveHelper: async () => visionModel,
      streamSimple: (async function* () {
        yield { type: "error", error: new Error("401 unauthorized") };
      }) as never,
    });
    const res = await run(tool, {});
    expect(res.isError).toBe(true);
    expect(answerText(res)).toContain("401");
  });

  test("辅助流抛异常：isError 上浮且不崩", async () => {
    resetVisionToolConfigForTest({ enabled: true });
    const tool = buildSeeImageTool({
      getFacts: () => factsOf([{ role: "user", content: [image(png1x1)], timestamp: 0 }]),
      resolveHelper: async () => visionModel,
      streamSimple: (async function* () {
        throw new Error("network down");
      }) as never,
    });
    const res = await run(tool, {});
    expect(res.isError).toBe(true);
    expect(answerText(res)).toContain("network down");
  });

  test("空回答：报错不空转", async () => {
    resetVisionToolConfigForTest({ enabled: true });
    const tool = buildSeeImageTool({
      getFacts: () => factsOf([{ role: "user", content: [image(png1x1)], timestamp: 0 }]),
      resolveHelper: async () => visionModel,
      streamSimple: fakeStream() as never,
    });
    const res = await run(tool, {});
    expect(res.isError).toBe(true);
    expect(answerText(res)).toContain("no text");
  });

  test("缺省 question 使用默认识别指令", async () => {
    resetVisionToolConfigForTest({ enabled: true });
    let asked = "";
    const tool = buildSeeImageTool({
      getFacts: () => factsOf([{ role: "user", content: [image(png1x1)], timestamp: 0 }]),
      resolveHelper: async () => visionModel,
      streamSimple: (async function* (_m: Model<Api>, ctx: Context) {
        const user = ctx.messages[0] as { content: Array<{ text?: string }> };
        asked = user.content[0]!.text ?? "";
        yield { type: "text_delta", delta: "ok" };
      }) as never,
    });
    await run(tool, {});
    expect(asked).toBe(SEE_IMAGE_DEFAULT_QUESTION);
  });

  test("中止信号：isError 且不吐半截答案", async () => {
    resetVisionToolConfigForTest({ enabled: true });
    const controller = new AbortController();
    controller.abort();
    const tool = buildSeeImageTool({
      getFacts: () => factsOf([{ role: "user", content: [image(png1x1)], timestamp: 0 }]),
      resolveHelper: async () => visionModel,
      streamSimple: fakeStream("半截") as never,
    });
    const res = await run(tool, {}, { signal: controller.signal });
    expect(res.isError).toBe(true);
    expect(answerText(res)).not.toContain("半截");
  });
});

describe("pickVisionHelper 选型", () => {
  test("同 provider 优先；同池内按输入单价升序；id 兜底确定性", () => {
    const candidates = [priceyForeignVision, cheapForeignVision, visionModel];
    expect(pickVisionHelper(candidates, textModel)?.id).toBe("main-v");
    expect(pickVisionHelper(candidates, undefined)?.id).toBe("cheap");
    expect(
      pickVisionHelper([priceyForeignVision, cheapForeignVision], undefined)?.id,
    ).toBe("cheap");
  });

  test("空候选返回 undefined", () => {
    expect(pickVisionHelper([], textModel)).toBeUndefined();
  });
});

describe("cleanVisionAnswer", () => {
  test("剥代码围栏、折叠空行", () => {
    expect(cleanVisionAnswer("```\n答案\n```")).toBe("答案");
    expect(cleanVisionAnswer("a\n\n\n\nb")).toBe("a\n\nb");
  });

  test("超长截断并标注", () => {
    const out = cleanVisionAnswer("x".repeat(5000));
    expect(out.length).toBeLessThan(5000);
    expect(out.endsWith("…（已截断）")).toBe(true);
  });
});

describe("parseVisionModelOverride（PI_VISION_MODEL 解析）", () => {
  test("provider/modelId 正常解析；modelId 可含 /", () => {
    expect(parseVisionModelOverride(" openai/gpt-4o ")).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
    });
    expect(parseVisionModelOverride("p/a/b")).toEqual({
      provider: "p",
      modelId: "a/b",
    });
  });

  test("空/无斜杠/空段 → null（回落自动挑选）", () => {
    expect(parseVisionModelOverride(undefined)).toBeNull();
    expect(parseVisionModelOverride("  ")).toBeNull();
    expect(parseVisionModelOverride("no-slash")).toBeNull();
    expect(parseVisionModelOverride("/model")).toBeNull();
    expect(parseVisionModelOverride("provider/")).toBeNull();
  });
});

describe("filterVisionCandidates（辅助候选可见性口径）", () => {
  const filter = {
    t2i: new Set(["p/t2i-model"]),
    hasRows: new Set(["p", "other-p"]),
    enabledRows: new Set(["p/vision", "other-p/enabled"]),
  };

  test("图像输入 + 非文生图 + 可见 才入选；无行 provider 全可见", () => {
    const candidates = filterVisionCandidates(
      [
        { ...visionModel, provider: "p", id: "main-v" }, // p 有行但行里没有 → 隐藏
        { ...visionModel, provider: "p", id: "vision" }, // p/vision：行 enabled → 入选
        { ...visionModel, provider: "p", id: "t2i-model" }, // 文生图 → 排除
        { ...visionModel, provider: "other-p", id: "enabled" }, // 行 enabled → 入选
        { ...visionModel, provider: "other-p", id: "hidden-row" }, // 行表无 enabled 行 → 排除
        { ...visionModel, provider: "free-p" }, // 无行 provider → 全可见
        { ...visionModel, provider: "free-p", input: ["text"] }, // 纯文本 → 排除
        { ...visionModel, provider: "free-p", input: undefined }, // input 缺失 → 排除
      ] as Model<Api>[],
      filter,
    );
    expect(candidates.map((m) => `${m.provider}/${m.id}`)).toEqual([
      "p/vision",
      "other-p/enabled",
      "free-p/main-v",
    ]);
  });
});
