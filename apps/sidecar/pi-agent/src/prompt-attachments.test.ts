import { describe, test, expect } from "bun:test";
import {
  noticeAppendedText,
  preparePromptAttachments,
  PROMPT_IMAGE_MAX_COUNT,
} from "./prompt-attachments";
import { IMAGE_INLINE_MAX_BYTES } from "./image-parts";

const png1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const attach = (data: string, mimeType = "image/png", name = "shot.png") => ({
  name,
  mimeType,
  data,
});

describe("preparePromptAttachments", () => {
  test("无 attachments 字段/空数组：零图片零说明", () => {
    expect(preparePromptAttachments({})).toEqual({
      images: [],
      noticeLines: [],
    });
    expect(preparePromptAttachments({ attachments: [] })).toEqual({
      images: [],
      noticeLines: [],
    });
  });

  test("合法图片组装 ImageContent（data 归一为裸 base64）", () => {
    const { images, noticeLines } = preparePromptAttachments({
      attachments: [attach(png1x1)],
    });
    expect(noticeLines).toEqual([]);
    expect(images).toEqual([
      { type: "image", data: png1x1, mimeType: "image/png" },
    ]);
  });

  test("data URL 前缀防御性剥离", () => {
    const { images, noticeLines } = preparePromptAttachments({
      attachments: [attach(`data:image/png;base64,${png1x1}`)],
    });
    expect(noticeLines).toEqual([]);
    expect(images[0]!.data).toBe(png1x1);
  });

  test("坏 MIME（svg/非图片）拒收并说明，不抛错", () => {
    const { images, noticeLines } = preparePromptAttachments({
      attachments: [
        attach(png1x1, "image/svg+xml", "vector.svg"),
        attach(png1x1, "application/pdf", "doc.pdf"),
      ],
    });
    expect(images).toEqual([]);
    expect(noticeLines).toHaveLength(2);
    expect(noticeLines[0]).toContain("vector.svg");
    expect(noticeLines[0]).toContain("PNG/JPEG/GIF/WebP");
  });

  test("超过 2MiB 上限拒收并说明", () => {
    // base64 4 字符编码 3 字节：要解码后 >2MiB，字符串需 >2MiB×4/3
    const big = "A".repeat(Math.ceil(((IMAGE_INLINE_MAX_BYTES + 4096) * 4) / 3));
    const { images, noticeLines } = preparePromptAttachments({
      attachments: [attach(big, "image/png", "huge.png")],
    });
    expect(images).toEqual([]);
    expect(noticeLines[0]).toContain("huge.png");
    expect(noticeLines[0]).toContain("2MiB");
  });

  test("每条 prompt 最多 4 张：收满后其余拒收说明", () => {
    const items = Array.from({ length: PROMPT_IMAGE_MAX_COUNT + 2 }, (_, i) =>
      attach(png1x1, "image/png", `p${i}.png`),
    );
    const { images, noticeLines } = preparePromptAttachments({
      attachments: items,
    });
    expect(images).toHaveLength(PROMPT_IMAGE_MAX_COUNT);
    expect(noticeLines).toHaveLength(2);
    expect(noticeLines[0]).toContain("p4.png");
    expect(noticeLines[1]).toContain("p5.png");
  });

  test("model 元数据不参与闸门：附件只看物理约束", () => {
    // 模型硬门已移除（input 元数据不可靠，实测误拦支持图像的模型）——
    // preparePromptAttachments 不接收 model 参数，纯文本模型发图由 API 报错暴露
    const { images, noticeLines } = preparePromptAttachments({
      attachments: [attach(png1x1)],
    });
    expect(noticeLines).toEqual([]);
    expect(images).toHaveLength(1);
  });
});

describe("noticeAppendedText", () => {
  test("有说明行时以换行追加，无说明时原样返回", () => {
    expect(noticeAppendedText("看看这张图", ["[a.png 已省略]"])).toBe(
      "看看这张图\n[a.png 已省略]",
    );
    expect(noticeAppendedText("纯文本", [])).toBe("纯文本");
  });
});
