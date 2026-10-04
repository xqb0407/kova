import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
  docMimeFromName,
  extractDataUriImageFiles,
  extractPromptAttachments,
  promptFileKind,
  promptFileKindFromName,
  validatePromptFile,
  PROMPT_DOC_INLINE_MAX_BYTES,
  PROMPT_DOC_MAX_BYTES,
  PROMPT_IMAGE_MAX_BYTES,
} from "@/lib/attachments/prompt-attachments";

const png1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const filePart = (p: Partial<{ url: string; mediaType: string; filename: string }>) =>
  ({ type: "file", ...p }) as unknown as UIMessage["parts"][number];

const userMsg = (parts: UIMessage["parts"][number][]): UIMessage =>
  ({ id: "m1", role: "user", parts }) as unknown as UIMessage;

describe("promptFileKind / validatePromptFile", () => {
  test("种类判定：mime 优先、扩展名兜底", () => {
    expect(promptFileKind("a.png", "image/png")).toBe("image");
    expect(promptFileKind("报告.docx", undefined)).toBe("document");
    expect(promptFileKind(undefined, docxMime)).toBe("document");
    expect(promptFileKind("virus.exe", "application/octet-stream")).toBeNull();
    expect(promptFileKind(undefined, undefined)).toBeNull();
  });

  test("FromName：只有路径（dialog 直选）时图片也认扩展名", () => {
    // 曾经的写法是 promptFileKind(name, undefined)：mime 白名单那条路走不到，
    // 扩展名兜底又只管文档，于是 png 被当「不支持的附件」丢弃、文档却正常
    expect(promptFileKindFromName("a.png")).toBe("image");
    expect(promptFileKindFromName("照片 1.JPG")).toBe("image");
    expect(promptFileKindFromName("x.webp")).toBe("image");
    expect(promptFileKindFromName("报告.docx")).toBe("document");
    expect(promptFileKindFromName("notes.md")).toBe("document");
    expect(promptFileKindFromName("virus.exe")).toBeNull();
    expect(promptFileKindFromName("noext")).toBeNull();
  });

  test("docMimeFromName 推断", () => {
    expect(docMimeFromName("x.pdf")).toBe("application/pdf");
    expect(docMimeFromName("x.DOCX")).toBe(docxMime);
    expect(docMimeFromName("x.exe")).toBeNull();
    expect(docMimeFromName(undefined)).toBeNull();
  });

  test("校验：图片 2MiB / 文档上限随通道 / 白名单外", () => {
    expect(validatePromptFile({ name: "a.png", type: "image/png", size: 1024 })).toBeNull();
    expect(
      validatePromptFile({ name: "a.png", type: "image/png", size: PROMPT_IMAGE_MAX_BYTES + 1 }),
    ).toContain("2MiB");
    // 测试环境非 Tauri → 网页端内联回退上限 8MiB；桌面端（isTauri）走 20MiB 落盘
    expect(PROMPT_DOC_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(validatePromptFile({ name: "a.docx", size: PROMPT_DOC_INLINE_MAX_BYTES })).toBeNull();
    expect(
      validatePromptFile({ name: "a.docx", size: PROMPT_DOC_INLINE_MAX_BYTES + 1 }),
    ).toContain("8MiB");
    // 系统粘贴板 mime 为空时按扩展名放行
    expect(validatePromptFile({ name: "b.docx", size: 1 })).toBeNull();
    const err = validatePromptFile({ name: "c.exe", size: 1 });
    expect(err).toContain("不是支持的附件");
    expect(err).toContain("PDF/Word/Excel/PPT");
  });
});

describe("extractPromptAttachments", () => {
  test("图片与文档混装：data: URL 直解，顺序保持", async () => {
    const msg = userMsg([
      { type: "text", text: "看看" } as UIMessage["parts"][number],
      filePart({ url: `data:image/png;base64,${png1x1}`, mediaType: "image/png", filename: "shot.png" }),
      filePart({ url: `data:${docxMime};base64,${png1x1}`, mediaType: docxMime, filename: "报告.docx" }),
    ]);
    const atts = await extractPromptAttachments(msg);
    expect(atts).toHaveLength(2);
    expect(atts![0]).toEqual({ name: "shot.png", mimeType: "image/png", data: png1x1 });
    expect(atts![1]).toEqual({ name: "报告.docx", mimeType: docxMime, data: png1x1 });
  });

  test("白名单外 file part 组装时跳过", async () => {
    const msg = userMsg([
      filePart({ url: "data:application/x-msdownload;base64,AAAA", mediaType: "application/x-msdownload", filename: "v.exe" }),
    ]);
    expect(await extractPromptAttachments(msg)).toBeNull();
  });

  test("url 为本地绝对路径 / file:// URL：path 载荷原位引用，不 fetch", async () => {
    const msg = userMsg([
      filePart({ url: "/Users/u/Downloads/报告.docx", mediaType: docxMime, filename: "报告.docx" }),
      filePart({ url: "file:///Users/u/pics/shot.png", mediaType: "image/png", filename: "shot.png" }),
      filePart({ url: "file:///Users/u/my%20docs/a.pdf", filename: "a.pdf" }),
    ]);
    const atts = await extractPromptAttachments(msg);
    expect(atts).toHaveLength(3);
    expect(atts![0]).toEqual({
      name: "报告.docx",
      mimeType: docxMime,
      path: "/Users/u/Downloads/报告.docx",
    });
    expect(atts![1]).toEqual({ name: "shot.png", mimeType: "image/png", path: "/Users/u/pics/shot.png" });
    // file:// URL 解码 + 无 mediaType 时按扩展名推断 mime
    expect(atts![2]).toEqual({
      name: "a.pdf",
      mimeType: "application/pdf",
      path: "/Users/u/my docs/a.pdf",
    });
  });

  test("无 file parts 返回 null", async () => {
    expect(await extractPromptAttachments(undefined)).toBeNull();
    expect(await extractPromptAttachments(userMsg([{ type: "text", text: "hi" } as UIMessage["parts"][number]]))).toBeNull();
  });

  test("mediaType 缺失时按文件名扩展名识别种类与 mime", async () => {
    const msg = userMsg([
      filePart({ url: `data:;base64,${png1x1}`, filename: "doc.pdf" }),
    ]);
    const atts = await extractPromptAttachments(msg);
    expect(atts).toHaveLength(1);
    expect(atts![0]?.mimeType).toBe("application/pdf");
  });
});

describe("extractDataUriImageFiles（粘贴 data URI 转附件，不进草稿文本）", () => {
  test("整段就是一张图：转 File，rest 为空", () => {
    const { files, rest } = extractDataUriImageFiles(`data:image/png;base64,${png1x1}`);
    expect(files).toHaveLength(1);
    expect(files[0].type).toBe("image/png");
    expect(files[0].name).toBe("pasted-image-1.png");
    expect(rest).toBe("");
  });

  test("整段 + base64 被折行：仍转附件", () => {
    const wrapped = png1x1.replace(/(.{20})/g, "$1\n");
    const { files, rest } = extractDataUriImageFiles(`data:image/png;base64,${wrapped}`);
    expect(files).toHaveLength(1);
    expect(files[0].size).toBeGreaterThan(0);
    expect(rest).toBe("");
  });

  test("内联在文字里：剥 URI 出附件，剩余文本回填", () => {
    const { files, rest } = extractDataUriImageFiles(
      `看看这个 data:image/png;base64,${png1x1} 是什么`,
    );
    expect(files).toHaveLength(1);
    expect(rest).toContain("看看这个");
    expect(rest).toContain("是什么");
    expect(rest).not.toContain("base64");
  });

  test("image/jpg 归一 jpeg，文件名用 .jpg", () => {
    const { files } = extractDataUriImageFiles(`data:image/jpg;base64,${png1x1}`);
    expect(files[0].type).toBe("image/jpeg");
    expect(files[0].name).toBe("pasted-image-1.jpg");
  });

  test("不误伤：短占位符 / 白名单外 mime / 非法 base64 / 普通文本", () => {
    const cases = [
      "data:image/png;base64,AAAA", // 调试占位（<64 字符）
      "data:image/svg+xml;base64," + png1x1, // 白名单外
      "data:image/png;base64," + "A".repeat(65), // 长度非法，atob 抛错
      "帮我看看这张图", // 普通文本
    ];
    for (const text of cases) {
      const { files, rest } = extractDataUriImageFiles(text);
      expect(files, text).toHaveLength(0);
      expect(rest, text).toBe(text);
    }
  });
});
