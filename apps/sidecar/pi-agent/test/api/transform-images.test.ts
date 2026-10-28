import { describe, test, expect } from "bun:test";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";

/**
 * 用户消息图片的请求侧降级（回归门）。
 *
 * 既定哲学（多模态降级闭环）：信任目录元数据。model.input 不含 "image" 时，
 * pi-ai 原版 downgradeUnsupportedImages 把 user 消息里的图片替换成
 * "(image omitted…)" 占位文本——每次请求（含全部历史）在请求侧剥离，
 * 转录与 UI 气泡不动，切回视觉模型自动恢复可见。历史教训（曾因此删过补丁）：
 * 自定义端点默认 ["text"] 会误伤实际支持视觉的模型；现接受该代价，
 * 元数据可在 设置→模型 修正，误标但端点真拒图的残余由 provider-retry 的
 * 拒图修复兜底（剥图重试一次 + sticky）。补丁已不再移除 user 分支；
 * toolResult 分支一直保留（provider 兼容）。
 */

const png1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const textOnlyModel = { input: ["text"] } as unknown as Parameters<
  typeof transformMessages
>[1];
const visionModel = { input: ["text", "image"] } as unknown as Parameters<
  typeof transformMessages
>[1];

const userWithImage = {
  role: "user" as const,
  content: [
    { type: "text" as const, text: "图片内容动物" },
    { type: "image" as const, data: png1x1, mimeType: "image/png" },
  ],
  timestamp: Date.now(),
};

const toolResultWithImage = {
  role: "toolResult" as const,
  toolCallId: "call-1",
  toolName: "read",
  content: [
    { type: "text" as const, text: "screenshot" },
    { type: "image" as const, data: png1x1, mimeType: "image/png" },
  ],
  isError: false,
  timestamp: Date.now(),
};

describe("transformMessages: user 消息图片按元数据降级", () => {
  test("model.input=['text'] 时 user 图片块替换为占位文本", () => {
    const out = transformMessages([userWithImage], textOnlyModel, undefined);
    const user = out.find((m) => m.role === "user");
    expect(user).toBeDefined();
    const blocks = user!.content as Array<{ type: string; text?: string }>;
    expect(blocks.some((b) => b.type === "image")).toBe(false);
    expect(
      blocks.some((b) => b.type === "text" && b.text?.includes("image omitted")),
    ).toBe(true);
    // 正文保留：占位文本之外，原文本块仍在
    expect(blocks.some((b) => b.type === "text" && b.text === "图片内容动物")).toBe(
      true,
    );
  });

  test("model.input=['text','image'] 时行为不变", () => {
    const out = transformMessages([userWithImage], visionModel, undefined);
    const user = out.find((m) => m.role === "user");
    const blocks = user!.content as Array<{ type: string }>;
    expect(blocks.filter((b) => b.type === "image").length).toBe(1);
  });
});

describe("transformMessages: toolResult 图片降级保留（原行为不变）", () => {
  test("model.input=['text'] 时 toolResult 图片仍替换为占位文本", () => {
    const out = transformMessages([toolResultWithImage], textOnlyModel, undefined);
    const tool = out.find((m) => m.role === "toolResult");
    expect(tool).toBeDefined();
    const blocks = tool!.content as Array<{ type: string; text?: string }>;
    expect(blocks.some((b) => b.type === "image")).toBe(false);
    expect(
      blocks.some(
        (b) => b.type === "text" && b.text?.includes("tool image omitted"),
      ),
    ).toBe(true);
  });
});
