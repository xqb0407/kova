import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
  docMimeFromName,
  extractPromptAttachments,
  promptFileKind,
  validatePromptFile,
  PROMPT_DOC_INLINE_MAX_BYTES,
  PROMPT_DOC_MAX_BYTES,
  PROMPT_IMAGE_MAX_BYTES,
} from "@/lib/prompt-attachments";

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
