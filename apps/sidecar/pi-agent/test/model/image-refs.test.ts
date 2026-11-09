import { describe, test, expect } from "bun:test";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import {
  collectImageRefs,
  IMAGE_SOURCE_USER,
  imagePlaceholderText,
  imageRefId,
  modelAcceptsImages,
  placeholderImagesForTextModel,
  SEE_IMAGE_TOOL_NAME,
} from "../../src/model/image-refs";

const png1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const png2x2 = png1x1 + "AAAA";

const image = (data = png1x1) => ({ type: "image" as const, data, mimeType: "image/png" });
const text = (t: string) => ({ type: "text" as const, text: t });

const textOnlyModel = { input: ["text"] } as unknown as Model<Api>;
const visionModel = { input: ["text", "image"] } as unknown as Model<Api>;

const contextOf = (messages: unknown[]): Context =>
  ({ messages }) as unknown as Context;

describe("imageRefId", () => {
  test("同内容同 ID，不同内容不同 ID", () => {
    expect(imageRefId(png1x1)).toBe(imageRefId(png1x1));
    expect(imageRefId(png1x1)).not.toBe(imageRefId(png2x2));
  });

  test("data URL 与裸 base64 同值（防御性剥离）", () => {
    expect(imageRefId(`data:image/png;base64,${png1x1}`)).toBe(imageRefId(png1x1));
  });

  test("固定形状 img_ + 12 位十六进制", () => {
    expect(imageRefId(png1x1)).toMatch(/^img_[0-9a-f]{12}$/);
  });
});

describe("modelAcceptsImages", () => {
  test("input 含 image → true；纯文本/缺失 → false", () => {
    expect(modelAcceptsImages({ input: ["text", "image"] } as Model<Api>)).toBe(true);
    expect(modelAcceptsImages({ input: ["text"] } as Model<Api>)).toBe(false);
    expect(modelAcceptsImages({ input: undefined } as unknown as Model<Api>)).toBe(false);
    expect(modelAcceptsImages(null)).toBe(false);
  });
});

describe("collectImageRefs", () => {
  test("收集 user/toolResult 的 image 块，带角色与工具名；其余跳过", () => {
    const messages = [
      {
        role: "user",
        content: [text("看图"), image(png1x1)],
        timestamp: 0,
      },
      { role: "assistant", content: [text("回复")], timestamp: 0 },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "browser_shot",
        content: [image(png2x2)],
        timestamp: 0,
      },
      { role: "user", content: "字符串内容不炸", timestamp: 0 },
      null,
    ];
    const refs = collectImageRefs(messages);
    expect(refs).toHaveLength(2);
    expect(refs[0]!.role).toBe("user");
    expect(refs[0]!.data).toBe(png1x1);
    expect(refs[0]!.messageIndex).toBe(0);
    expect(refs[0]!.blockIndex).toBe(1);
    expect(refs[1]!.role).toBe("toolResult");
    expect(refs[1]!.toolName).toBe("browser_shot");
    expect(refs[1]!.id).toBe(imageRefId(png2x2));
  });

  test("空入参/非数组安全", () => {
    expect(collectImageRefs([])).toEqual([]);
    expect(collectImageRefs(undefined as unknown as unknown[])).toEqual([]);
  });
});

describe("placeholderImagesForTextModel", () => {
  test("纯文本模型：user 图片原位换成带 imageId 的占位，正文保留", () => {
    const ctx = contextOf([
      { role: "user", content: [text("看这两张图"), image(png1x1)], timestamp: 0 },
    ]);
    const out = placeholderImagesForTextModel(textOnlyModel, ctx);
    expect(out).not.toBe(ctx);
    expect(out.messages).toHaveLength(1);
    const blocks = out.messages[0]!.content as Array<{ type: string; text?: string }>;
    expect(blocks.some((b) => b.type === "image")).toBe(false);
    const placeholder = blocks.find((b) => b.type === "text" && b.text?.includes("imageId="));
    expect(placeholder?.text).toContain(imageRefId(png1x1));
    expect(placeholder?.text).toContain(SEE_IMAGE_TOOL_NAME);
    expect(placeholder?.text).toContain(IMAGE_SOURCE_USER);
    expect(blocks.some((b) => b.type === "text" && b.text === "看这两张图")).toBe(true);
  });

  test("纯文本模型：toolResult 图片占位带工具名来源", () => {
    const ctx = contextOf([
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "screenshot",
        content: [text("截图"), image(png1x1)],
        timestamp: 0,
      },
    ]);
    const out = placeholderImagesForTextModel(textOnlyModel, ctx);
    const blocks = out.messages[0]!.content as Array<{ type: string; text?: string }>;
    const placeholder = blocks.find((b) => b.text?.includes("imageId="));
    expect(placeholder?.text).toContain("source=screenshot");
  });

  test("同消息多图：每张独立占位、ID 互不相同", () => {
    const ctx = contextOf([
      { role: "user", content: [image(png1x1), image(png2x2)], timestamp: 0 },
    ]);
    const out = placeholderImagesForTextModel(textOnlyModel, ctx);
    const blocks = out.messages[0]!.content as Array<{ type: string; text?: string }>;
    const ids = blocks.map((b) => b.text?.match(/imageId=(img_[0-9a-f]{12})/)?.[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  test("data URL 图片同样替换且 ID 与裸 base64 一致", () => {
    const ctx = contextOf([
      { role: "user", content: [image(`data:image/png;base64,${png1x1}`)], timestamp: 0 },
    ]);
    const out = placeholderImagesForTextModel(textOnlyModel, ctx);
    const blocks = out.messages[0]!.content as Array<{ type: string; text?: string }>;
    expect(blocks[0]!.text).toContain(imageRefId(png1x1));
  });

  test("视觉模型：原引用返回（缓存前缀不扰动）", () => {
    const ctx = contextOf([
      { role: "user", content: [text("看图"), image(png1x1)], timestamp: 0 },
    ]);
    expect(placeholderImagesForTextModel(visionModel, ctx)).toBe(ctx);
  });

  test("无图 context：原引用返回", () => {
    const ctx = contextOf([
      { role: "user", content: [text("纯文本")], timestamp: 0 },
      { role: "assistant", content: [text("回复")], timestamp: 0 },
    ]);
    expect(placeholderImagesForTextModel(textOnlyModel, ctx)).toBe(ctx);
  });

  test("string content 的历史消息不炸、不替换", () => {
    const ctx = contextOf([{ role: "user", content: "旧格式文本", timestamp: 0 }]);
    const out = placeholderImagesForTextModel(textOnlyModel, ctx);
    expect(out).toBe(ctx);
  });

  test("占位文本工具句柄可直接被 imageRefId 复核", () => {
    const id = imageRefId(png1x1);
    expect(imagePlaceholderText(IMAGE_SOURCE_USER, id)).toContain(id);
  });
});

describe("与 pi-ai transformMessages 串联（回归门）", () => {
  test("占位替换后，纯文本模型请求里不再出现 image omitted", () => {
    const ctx = contextOf([
      { role: "user", content: [text("这是什么"), image(png1x1)], timestamp: 0 },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "browser_shot",
        content: [image(png2x2)],
        timestamp: 0,
      },
    ]);
    const bridged = placeholderImagesForTextModel(textOnlyModel, ctx);
    const out = transformMessages(bridged.messages, textOnlyModel as never, undefined);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("image omitted");
    expect(serialized).toContain(imageRefId(png1x1));
    expect(serialized).toContain(imageRefId(png2x2));
  });
});
