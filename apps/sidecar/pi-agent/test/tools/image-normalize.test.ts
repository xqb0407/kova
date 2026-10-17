import { describe, test, expect } from "bun:test";
import {
  IMAGE_INLINE_MAX_BASE64,
  imageLimitsForModel,
  normalizeToolResultImages,
} from "../../src/tools/image-normalize";
import type { ImageProcessor } from "../../src/vendor/pi-images/processor";

const png1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const png4x4 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4z8DwHxkzkC4AADxAH+HggXe0AAAAAElFTkSuQmCC";

const imageBlock = (data: string, mimeType = "image/png", extra: Record<string, unknown> = {}) => ({
  type: "image",
  data,
  mimeType,
  ...extra,
});

const passThrough: ImageProcessor = {
  async prepare(bytes, mimeType) {
    return { data: Buffer.from(bytes).toString("base64"), mimeType };
  },
};

describe("imageLimitsForModel", () => {
  test("缺省 2000x2000 / 4.5MiB，但被 2MiB 内联闸门夹住", () => {
    expect(imageLimitsForModel(undefined)).toEqual({
      maxWidth: 2000,
      maxHeight: 2000,
      maxBytes: IMAGE_INLINE_MAX_BASE64,
    });
    expect(IMAGE_INLINE_MAX_BASE64).toBe(Math.ceil((2 * 1024 * 1024 - 2) / 3) * 4);
  });

  test("模型 inputLimits.images.resize 覆盖宽高，maxBytes 取严", () => {
    expect(
      imageLimitsForModel({
        inputLimits: { images: { resize: { maxWidth: 1568, maxHeight: 1024, maxBytes: 1000 } } },
      }),
    ).toEqual({ maxWidth: 1568, maxHeight: 1024, maxBytes: 1000 });
    // 模型允许 8MiB，但内联闸门更小 → 取闸门
    expect(
      imageLimitsForModel({ inputLimits: { images: { resize: { maxBytes: 8 * 1024 * 1024 } } } })
        .maxBytes,
    ).toBe(IMAGE_INLINE_MAX_BASE64);
  });

  test("非法值回落缺省（0/负数/NaN 不算限制）", () => {
    expect(
      imageLimitsForModel({
        inputLimits: { images: { resize: { maxWidth: 0, maxHeight: -1, maxBytes: Number.NaN } } },
      }),
    ).toEqual({ maxWidth: 2000, maxHeight: 2000, maxBytes: IMAGE_INLINE_MAX_BASE64 });
  });
});

describe("normalizeToolResultImages", () => {
  test("合规图片原样通过：返回 null（不制造无意义的新 content）", async () => {
    const content = [imageBlock(png1x1)];
    expect(await normalizeToolResultImages(content, undefined)).toBeNull();
  });

  test("真实处理器：超模型尺寸的图缩放后替换，并在图后追加映射说明", async () => {
    const content = [imageBlock(png4x4, "image/png", { alt: "grid" })];
    const out = await normalizeToolResultImages(content, {
      inputLimits: { images: { resize: { maxWidth: 2, maxHeight: 2 } } },
    });
    expect(out).not.toBeNull();
    expect(out!).toHaveLength(2);
    expect(out![0]).toMatchObject({ type: "image", mimeType: "image/png", alt: "grid" });
    expect((out![0] as { data: string }).data).not.toBe(png4x4);
    expect(out![1]!.type).toBe("text");
    expect(String(out![1]!.text)).toContain("缩放");
    expect(String(out![1]!.text)).toContain("4x4");
    expect(String(out![1]!.text)).toContain("2x2");
  });

  test("不支持的 MIME（SVG）改成一行说明，不把脏图塞给 provider", async () => {
    const out = await normalizeToolResultImages(
      [imageBlock(png1x1, "image/svg+xml")],
      undefined,
    );
    expect(out).toHaveLength(1);
    expect(out![0]!.type).toBe("text");
    expect(String(out![0]!.text)).toContain("不支持的类型");
    expect(String(out![0]!.text)).toContain("svg");
  });

  test("空数据 → 说明行", async () => {
    const out = await normalizeToolResultImages([imageBlock("", "image/png")], undefined);
    expect(out).toHaveLength(1);
    expect(out![0]!.type).toBe("text");
    expect(String(out![0]!.text)).toContain("数据为空");
  });

  test("data URL 输入也能处理（防御历史数据）", async () => {
    const out = await normalizeToolResultImages(
      [imageBlock(`data:image/png;base64,${png4x4}`)],
      { inputLimits: { images: { resize: { maxWidth: 2, maxHeight: 2 } } } },
    );
    expect(out).not.toBeNull();
    expect(out![0]!.type).toBe("image");
    expect((out![0] as { data: string }).data).not.toContain("data:");
  });

  test("处理器不可用时维持旧闸门：合规内联图放行、超限图降级", async () => {
    const small = await normalizeToolResultImages([imageBlock(png1x1)], undefined, null);
    expect(small).toBeNull();

    const big = "A".repeat(IMAGE_INLINE_MAX_BASE64 + 8);
    const out = await normalizeToolResultImages([imageBlock(big)], undefined, null);
    expect(out).toHaveLength(1);
    expect(out![0]!.type).toBe("text");
    expect(String(out![0]!.text)).toContain("无法解码或压缩到内联上限");
  });

  test("非图片块原样保留、顺序不变", async () => {
    const content = [
      { type: "text", text: "before" },
      imageBlock(png1x1),
      { type: "text", text: "after" },
    ];
    const out = await normalizeToolResultImages(content, undefined, passThrough);
    // passThrough 不改字节、无 hint → 与原文等价，函数返回 null
    expect(out).toBeNull();
  });

  test("无图片块直接返回 null", async () => {
    expect(await normalizeToolResultImages([{ type: "text", text: "hi" }], undefined)).toBeNull();
  });
});
