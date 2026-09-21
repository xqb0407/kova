import { describe, test, expect } from "bun:test";
import {
  noticeAppendedText,
  preparePromptAttachments,
  PROMPT_IMAGE_MAX_COUNT,
} from "../../src/protocol/prompt-attachments";
import { IMAGE_INLINE_MAX_BYTES } from "../../src/tools/image-parts";

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

/* ------------------------------ 文档附件（落盘通道） ------------------------------ */

import { docSaveDir, PROMPT_DOC_MAX_COUNT, PROMPT_DOC_MAX_BYTES, PROMPT_ATTACH_TOTAL_MAX_BYTES } from "../../src/protocol/prompt-attachments";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const tinyDocx = Buffer.from("PK\u0003\u0004 fake docx").toString("base64");

describe("preparePromptAttachments 文档分支", () => {
  test("docx + cwd：落盘到 .xulux/attachments/，说明行带相对路径与类型", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-att-"));
    const { images, noticeLines } = preparePromptAttachments(
      { attachments: [attach(tinyDocx, docxMime, "报告.docx")] },
      { cwd },
    );
    expect(images).toEqual([]);
    expect(noticeLines).toHaveLength(1);
    expect(noticeLines[0]).toContain("报告.docx");
    expect(noticeLines[0]).toContain("Word 文档");
    expect(noticeLines[0]).toContain(".xulux/attachments/");
    expect(noticeLines[0]).toContain("请用文件工具读取");
    // 落盘文件真实存在、字节一致；说明行里的路径在目录内
    const dir = docSaveDir(cwd);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(dir, files[0]!), "utf8")).toBe("PK\u0003\u0004 fake docx");
    expect(noticeLines[0]).toContain(files[0]!);
  });

  test("扩展名兜底：mime 为空/octet-stream 时按扩展名识别；mime 兜底反推类型", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-att-"));
    const { noticeLines } = preparePromptAttachments(
      {
        attachments: [
          attach(tinyDocx, "application/octet-stream", "a.docx"),
          { name: "blobfile", mimeType: docxMime, data: tinyDocx },
        ],
      },
      { cwd },
    );
    expect(noticeLines).toHaveLength(2);
    expect(noticeLines[0]).toContain("Word 文档");
    expect(noticeLines[1]).toContain("Word 文档");
  });

  test("pdf 识别为 PDF 文档", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-att-"));
    const { noticeLines } = preparePromptAttachments(
      { attachments: [attach("JVBERi0=", "application/pdf", "doc.pdf")] },
      { cwd },
    );
    expect(noticeLines[0]).toContain("PDF 文档");
  });

  test("单条最多 2 个文档：收满后其余拒收说明", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-att-"));
    const items = Array.from({ length: PROMPT_DOC_MAX_COUNT + 1 }, (_, i) =>
      attach(tinyDocx, docxMime, `d${i}.docx`),
    );
    const { noticeLines } = preparePromptAttachments({ attachments: items }, { cwd });
    // 前两个成功落盘各得一条"已保存"说明，第三个被数量闸门拒收
    expect(noticeLines).toHaveLength(3);
    expect(noticeLines[2]).toContain("d2.docx");
    expect(noticeLines[2]).toContain("最多 2 个文档");
  });

  test("超 8MiB 文档拒收说明", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-att-"));
    const big = "A".repeat(Math.ceil(((PROMPT_DOC_MAX_BYTES + 4096) * 4) / 3));
    const { noticeLines } = preparePromptAttachments(
      { attachments: [attach(big, docxMime, "huge.docx")] },
      { cwd },
    );
    expect(noticeLines[0]).toContain("huge.docx");
    expect(noticeLines[0]).toContain("8MiB");
  });

  test("图片+文档总体积红线：合计超 11MiB 时文档拒收说明", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-att-"));
    const img = "A".repeat(Math.ceil((2 * 1024 * 1024 * 4) / 3));
    const doc = "A".repeat(Math.ceil((7.5 * 1024 * 1024 * 4) / 3));
    const { images, noticeLines } = preparePromptAttachments(
      {
        attachments: [
          attach(img, "image/png", "i1.png"),
          attach(img, "image/png", "i2.png"),
          attach(doc, docxMime, "d.docx"),
        ],
      },
      { cwd },
    );
    expect(images).toHaveLength(2);
    expect(noticeLines).toHaveLength(1);
    expect(noticeLines[0]).toContain("d.docx");
    expect(noticeLines[0]).toContain("总体积超限");
    expect(PROMPT_ATTACH_TOTAL_MAX_BYTES).toBe(11 * 1024 * 1024);
  });

  test("未提供 cwd：文档拒收说明（落盘目录不可用）", () => {
    const { images, noticeLines } = preparePromptAttachments({
      attachments: [attach(tinyDocx, docxMime, "a.docx")],
    });
    expect(images).toEqual([]);
    expect(noticeLines[0]).toContain("a.docx");
    expect(noticeLines[0]).toContain("落盘目录不可用");
  });

  test("文件名消毒：路径穿越名取 basename 落盘，不逃出附件目录", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-att-"));
    const { noticeLines } = preparePromptAttachments(
      { attachments: [attach(tinyDocx, docxMime, "..\\..\\evil.docx")] },
      { cwd },
    );
    expect(noticeLines).toHaveLength(1);
    expect(existsSync(join(docSaveDir(cwd), "..", "evil.docx"))).toBe(false);
    expect(noticeLines[0]).not.toContain("..");
  });

  test("图片与文档混装：各自走各自闸门", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-att-"));
    const { images, noticeLines } = preparePromptAttachments(
      {
        attachments: [attach(png1x1, "image/png", "shot.png"), attach(tinyDocx, docxMime, "报告.docx")],
      },
      { cwd },
    );
    expect(images).toHaveLength(1);
    expect(noticeLines).toHaveLength(1);
    expect(noticeLines[0]).toContain("报告.docx");
  });
});

describe("preparePromptAttachments 文档 path 模式（桌面端）", () => {
  test("path 模式原位引用：说明行带绝对路径，不往 cwd 复制", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-att-"));
    const staged = join(cwd, "staging-src.docx");
    writeFileSync(staged, "PK staged bytes");
    const { images, noticeLines } = preparePromptAttachments(
      {
        attachments: [
          { name: "报告.docx", mimeType: docxMime, path: staged },
        ],
      },
      { cwd },
    );
    expect(images).toEqual([]);
    expect(noticeLines).toHaveLength(1);
    expect(noticeLines[0]).toContain("报告.docx");
    expect(noticeLines[0]).toContain("Word 文档");
    expect(noticeLines[0]).toContain(staged);
    expect(noticeLines[0]).toContain("请用文件工具读取");
    // 原位引用：不往 cwd 落任何副本
    expect(existsSync(docSaveDir(cwd))).toBe(false);
  });

  test("dialog 直选图片（path 无 data）：读盘内联进 ImageContent", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-att-"));
    const imgPath = join(cwd, "shot.png");
    writeFileSync(imgPath, Buffer.from(png1x1, "base64"));
    const { images, noticeLines } = preparePromptAttachments(
      {
        attachments: [
          { name: "shot.png", mimeType: "image/png", path: imgPath },
        ],
      },
      { cwd },
    );
    expect(noticeLines).toEqual([]);
    expect(images).toEqual([
      { type: "image", data: png1x1, mimeType: "image/png" },
    ]);
  });

  test("dialog 图片 path 不可读：专用说明行", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-att-"));
    const { images, noticeLines } = preparePromptAttachments(
      {
        attachments: [
          { name: "gone.png", mimeType: "image/png", path: join(cwd, "nope.png") },
        ],
      },
      { cwd },
    );
    expect(images).toEqual([]);
    expect(noticeLines).toHaveLength(1);
    expect(noticeLines[0]).toContain("gone.png");
    expect(noticeLines[0]).toContain("不可读");
  });

  test("path 文件不存在：拒收说明，不落盘", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-att-"));
    const { noticeLines } = preparePromptAttachments(
      { attachments: [{ name: "ghost.docx", mimeType: docxMime, path: join(cwd, "nope.docx") }] },
      { cwd },
    );
    expect(noticeLines[0]).toContain("ghost.docx");
    expect(noticeLines[0]).toContain("不存在或不可读");
    expect(existsSync(docSaveDir(cwd))).toBe(false);
  });

  test("path 模式超 20MiB 拒收说明", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-att-"));
    const staged = join(cwd, "big.docx");
    writeFileSync(staged, Buffer.alloc(PROMPT_DOC_MAX_BYTES + 1, 7));
    const { noticeLines } = preparePromptAttachments(
      { attachments: [{ name: "big.docx", mimeType: docxMime, path: staged }] },
      { cwd },
    );
    expect(noticeLines[0]).toContain("big.docx");
    expect(noticeLines[0]).toContain("20MiB");
  });

  test("path 模式不计入内联总体积红线（帧只带路径）", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-att-"));
    const img = "A".repeat(Math.ceil((2 * 1024 * 1024 * 4) / 3));
    const staged = join(cwd, "big.docx");
    writeFileSync(staged, Buffer.alloc(15 * 1024 * 1024, 7));
    const { images, noticeLines } = preparePromptAttachments(
      {
        attachments: [
          attach(img, "image/png", "i1.png"),
          attach(img, "image/png", "i2.png"),
          attach(img, "image/png", "i3.png"),
          attach(img, "image/png", "i4.png"),
          { name: "big.docx", mimeType: docxMime, path: staged },
        ],
      },
      { cwd },
    );
    // 4 张图贴满内联上限（8MiB < 11MiB 红线），path 文档仍照常落盘
    expect(images).toHaveLength(4);
    expect(noticeLines).toHaveLength(1);
    expect(noticeLines[0]).toContain("big.docx");
  });
});
