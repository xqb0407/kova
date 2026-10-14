import { describe, test, expect } from "bun:test";
import { projectToolResult, IMAGE_INLINE_MAX_BYTES } from "../../src/tools/image-parts";

/** 短 base64（bytes = floor(8*3/4) = 6） */
const B64 = "iVBORw==";
const bytesOf = (b64: string) => Math.floor((b64.length * 3) / 4);

describe("projectToolResult", () => {
  test("纯文本：输出与既有拼装一致，无图片 part", () => {
    const r = projectToolResult(
      [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
      { toolCallId: "c1", toolName: "bash" },
    );
    expect(r.output).toBe("a\nb");
    expect(r.images).toEqual([]);
  });

  test("png 块投影为 data-image part（src/bytes/alt/toolName 齐备）", () => {
    const r = projectToolResult(
      [
        { type: "text", text: "已生成：cat.png\n多余行不进 alt" },
        { type: "image", data: B64, mimeType: "image/png" },
      ],
      { toolCallId: "call-9", toolName: "generate_image" },
    );
    expect(r.images.length).toBe(1);
    expect(r.images[0].id).toBe("img-call-9-0");
    expect(r.images[0].data).toEqual({
      src: `data:image/png;base64,${B64}`,
      mimeType: "image/png",
      bytes: bytesOf(B64),
      toolCallId: "call-9",
      toolName: "generate_image",
      alt: "已生成：cat.png",
    });
    // 既有拼装语义保留：image 块贡献空段（join 出尾部空行）
    expect(r.output).toBe("已生成：cat.png\n多余行不进 alt\n");
  });

  test("多图：id 序号只对图块计数递增", () => {
    const r = projectToolResult(
      [
        { type: "text", text: "h" },
        { type: "image", data: B64, mimeType: "image/png" },
        { type: "image", data: B64, mimeType: "image/webp" },
      ],
      { toolCallId: "c" },
    );
    expect(r.images.map((i) => i.id)).toEqual(["img-c-0", "img-c-1"]);
  });

  test("image/jpg 非规范拼写归一为 jpeg", () => {
    const r = projectToolResult(
      [{ type: "image", data: B64, mimeType: "image/jpg" }],
      { toolCallId: "c" },
    );
    expect(r.images[0].data.mimeType).toBe("image/jpeg");
    expect(r.images[0].data.src.startsWith("data:image/jpeg;")).toBe(true);
  });

  test("MIME 大小写/空白容忍", () => {
    const r = projectToolResult(
      [{ type: "image", data: B64, mimeType: " Image/PNG " }],
      { toolCallId: "c" },
    );
    expect(r.images.length).toBe(1);
    expect(r.images[0].data.mimeType).toBe("image/png");
  });

  test("svg 挡在白名单外并给占位行（降级可见不静默）", () => {
    const r = projectToolResult(
      [
        { type: "text", text: "ok" },
        { type: "image", data: B64, mimeType: "image/svg+xml" },
      ],
      { toolCallId: "c" },
    );
    expect(r.images).toEqual([]);
    expect(r.output).toContain("[图片未展示：不支持的类型 image/svg+xml（仅 png/jpeg/gif/webp）]");
  });

  test("超过 2MiB 上限不进线，占位行含体量", () => {
    // 3 MiB 原始 → base64 4 MiB 字符
    const big = "A".repeat(4 * 1024 * 1024);
    const r = projectToolResult(
      [
        { type: "text", text: "done" },
        { type: "image", data: big, mimeType: "image/png" },
      ],
      { toolCallId: "c" },
    );
    expect(r.images).toEqual([]);
    expect(r.output.endsWith("[图片未展示：约 3.0 MiB，超过 2.0 MiB 内联上限]")).toBe(true);
    expect(IMAGE_INLINE_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  test("数据为空的图块给占位行", () => {
    const r = projectToolResult(
      [{ type: "image", data: "   ", mimeType: "image/png" }],
      { toolCallId: "c" },
    );
    expect(r.images).toEqual([]);
    expect(r.output).toBe("[图片未展示：image/png 数据为空]");
  });

  test("无文本块时 output 即占位行（不产生前导空行）", () => {
    const r = projectToolResult(
      [{ type: "image", data: B64, mimeType: "application/pdf" }],
      { toolCallId: "c" },
    );
    expect(r.output).toBe("[图片未展示：不支持的类型 application/pdf（仅 png/jpeg/gif/webp）]");
  });

  test("alt 取首个非空文本块首行并截到 120 字符", () => {
    const long = "x".repeat(200);
    const r = projectToolResult(
      [
        { type: "text", text: "  \n" },
        { type: "text", text: `${long}\nsecond` },
        { type: "image", data: B64, mimeType: "image/png" },
      ],
      { toolCallId: "c" },
    );
    expect(r.images[0].data.alt).toBe("x".repeat(120));
  });

  test("undefined content 安全兜底", () => {
    const r = projectToolResult(undefined, { toolCallId: null });
    expect(r.output).toBe("");
    expect(r.images).toEqual([]);
  });

  test("非工具来源（toolCallId null）id 走 direct 前缀", () => {
    const r = projectToolResult([{ type: "image", data: B64, mimeType: "image/png" }], {
      toolCallId: null,
    });
    expect(r.images[0].id).toBe("img-direct-0");
    expect(r.images[0].data.toolCallId).toBeNull();
    expect(r.images[0].data.toolName).toBeUndefined();
  });
});
