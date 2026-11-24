import { describe, test, expect } from "bun:test";
import {
	MEDIA_OMITTED_NOTE,
	transformMessages,
} from "@earendil-works/pi-ai/api/transform-messages";

/**
 * 图片请求侧降级（回归门）。
 *
 * 能力三态：supportsImage 为 false 才剥图；null（未声明）保持原样，交给端点
 * 与 400/422 拒图修复兜底；缺省字段回退 input，兼容内置目录模型。
 * 剥图只改 provider-visible request，转录与 UI 气泡不动；视觉辅助就绪时
 * streamFn 会先换成带 imageId 的占位，本门对这些请求是 no-op。
 */

const png1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type TestModel = Parameters<typeof transformMessages>[1];
const model = (over: Record<string, unknown>): TestModel =>
  ({ input: ["text"], ...over }) as unknown as TestModel;

const explicitText = model({ input: ["text"], supportsImage: false });
const unknownCapability = model({ input: ["text"], supportsImage: null });
const vision = model({ input: ["text", "image"], supportsImage: true });
const legacyTextOnly = model({ input: ["text"] });

const userWithImage = {
  role: "user" as const,
  content: [
    { type: "text" as const, text: "图片内容动物" },
    { type: "image" as const, data: png1x1, mimeType: "image/png" },
  ],
  timestamp: Date.now(),
};

const userWithTwoImages = {
  role: "user" as const,
  content: [
    { type: "image" as const, data: png1x1, mimeType: "image/png" },
    { type: "text" as const, text: "两张图" },
    { type: "image" as const, data: png1x1, mimeType: "image/jpeg" },
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

const blocksOf = (out: ReturnType<typeof transformMessages>, role: string) => {
  const msg = out.find((m) => m.role === role);
  return msg!.content as Array<{ type: string; text?: string }>;
};

describe("transformMessages: user 图片按三态能力降级", () => {
  test("supportsImage:false 时替换为带附件标识的中性占位", () => {
    const out = transformMessages([userWithImage], explicitText, undefined);
    const blocks = blocksOf(out, "user");
    expect(blocks.some((b) => b.type === "image")).toBe(false);
    expect(
      blocks.some(
        (b) =>
          b.type === "text" &&
          b.text ===
            `[Attached image/png: [image #1]]\n${MEDIA_OMITTED_NOTE}`,
      ),
    ).toBe(true);
    expect(blocks.some((b) => b.type === "text" && b.text === "图片内容动物")).toBe(
      true,
    );
  });

  test("supportsImage:null（未声明）时保留图片", () => {
    const out = transformMessages([userWithImage], unknownCapability, undefined);
    const blocks = blocksOf(out, "user");
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
    expect(JSON.stringify(blocks)).not.toContain(MEDIA_OMITTED_NOTE);
  });

  test("supportsImage:true 时保留图片", () => {
    const out = transformMessages([userWithImage], vision, undefined);
    const blocks = blocksOf(out, "user");
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
  });

  test("缺省 supportsImage 时回退 input（兼容旧模型对象）", () => {
    const out = transformMessages([userWithImage], legacyTextOnly, undefined);
    const blocks = blocksOf(out, "user");
    expect(blocks.some((b) => b.type === "image")).toBe(false);
    expect(JSON.stringify(blocks)).toContain(MEDIA_OMITTED_NOTE);
  });

  test("多图按单条消息内序号稳定替换", () => {
    const out = transformMessages([userWithTwoImages], explicitText, undefined);
    const blocks = blocksOf(out, "user");
    expect(
      blocks.some((b) => b.text === `[Attached image/png: [image #1]]\n${MEDIA_OMITTED_NOTE}`),
    ).toBe(true);
    expect(
      blocks.some((b) => b.text === `[Attached image/jpeg: [image #2]]\n${MEDIA_OMITTED_NOTE}`),
    ).toBe(true);
    expect(blocks.some((b) => b.text === "两张图")).toBe(true);
  });

  test("无图消息不产生新对象", () => {
    const textOnly = {
      role: "user" as const,
      content: "只有文字",
      timestamp: Date.now(),
    };
    const out = transformMessages([textOnly], explicitText, undefined);
    expect(out[0]).toBe(textOnly);
  });
});

describe("transformMessages: toolResult 图片按三态能力降级", () => {
  test("supportsImage:false 时用工具名做标签", () => {
    const out = transformMessages([toolResultWithImage], explicitText, undefined);
    const blocks = blocksOf(out, "toolResult");
    expect(blocks.some((b) => b.type === "image")).toBe(false);
    expect(
      blocks.some(
        (b) =>
          b.type === "text" &&
          b.text === `[Attached image/png: read]\n${MEDIA_OMITTED_NOTE}`,
      ),
    ).toBe(true);
  });

  test("supportsImage:null 时保留 toolResult 图片", () => {
    const out = transformMessages([toolResultWithImage], unknownCapability, undefined);
    const blocks = blocksOf(out, "toolResult");
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
  });
});
