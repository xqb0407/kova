import { describe, test, expect } from "bun:test";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";

/**
 * 用户消息图片的请求侧降级（回归门）。
 *
 * pi-ai 原版 downgradeUnsupportedImages 会在 model.input 不含 "image" 时把
 * user 消息里的图片静默替换成 "(image omitted…)" 占位文本——元数据不可靠
 * （自定义端点默认 ["text"]，实测误拦过多模态端点，事故见
 * docs/user-image-attachment-plan.md 与 patches/ 内 Kova patch 注释），sidecar
 * 的既定哲学是「一律放行，端点不支持时报错可见，好过静默吞图」。补丁移除了
 * user 分支；toolResult 分支保留（provider 兼容）。
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
  timestamp: Date.now(),
};

describe("transformMessages: user 消息图片不降级", () => {
  test("model.input=['text'] 时 user 图片块原样保留（补丁前会被占位文本替换）", () => {
    const out = transformMessages([userWithImage], textOnlyModel, undefined);
    const user = out.find((m) => m.role === "user");
    expect(user).toBeDefined();
    const blocks = user!.content as Array<{ type: string; text?: string }>;
    expect(blocks.some((b) => b.type === "image")).toBe(true);
    expect(
      blocks.some((b) => b.type === "text" && b.text?.includes("image omitted")),
    ).toBe(false);
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
