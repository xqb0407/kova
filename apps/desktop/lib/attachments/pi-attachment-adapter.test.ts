import { describe, expect, test } from "bun:test";
import type { AppendMessage } from "@assistant-ui/react";
import { piPromptAttachmentAdapter } from "@/lib/attachments/pi-attachment-adapter";
import { PROMPT_ATTACHMENT_ACCEPT } from "@/lib/attachments/prompt-attachments";
import { buildPiSendInput } from "@/lib/pi/pi-runtime/runtime/ThreadController";

type Pending = Awaited<ReturnType<typeof piPromptAttachmentAdapter.add>>;

/** add 刻意越过 PendingAttachment 契约返回 complete（见 adapter 头注）：
 *  运行时形状按 complete 的宽类型断言，测试才看得到 content/status */
type AdapterAttachment = {
  id: string;
  type: string;
  name: string;
  contentType?: string;
  file?: File;
  status: { type: string; reason?: string };
  content?: readonly {
    type: string;
    image?: string;
    data?: string;
    mimeType?: string;
    filename?: string;
  }[];
};

const pngBytes = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

/** adapter.add 契约上是 Promise | AsyncGenerator；本实现恒走 Promise 分支 */
const addAttachment = async (file: File): Promise<AdapterAttachment> => {
  const result = await piPromptAttachmentAdapter.add({ file });
  if ("next" in result) throw new Error("generator form not used by this adapter");
  return result as unknown as AdapterAttachment;
};

const completeOf = async (file: File) => {
  const attachment = await addAttachment(file);
  // 关键契约（2026-10-05「排队消息多一条已发送气泡」根因）：add 就返回
  // complete（带 content），发送走同步 _dispatch 而不是异步准备提交——
  // 异步提交会被框架登记进 composer 的 in-transit，而 store 层把它当线程
  // 消息渲染；排队发送永远等不到回显，气泡就永久挂在那
  expect(attachment.status).toEqual({ type: "complete" });
  expect(attachment.content?.length ?? 0).toBeGreaterThan(0);
  return attachment;
};

describe("piPromptAttachmentAdapter.add", () => {
  test("剪贴板图片（有 MIME）→ image 类且已 complete（含内联 dataURL）", async () => {
    const file = new File([pngBytes], "image.png", { type: "image/png" });
    const pending = await addAttachment(file);
    expect(pending.type).toBe("image");
    expect(pending.contentType).toBe("image/png");
    expect(pending.status).toEqual({ type: "complete" });
    expect(pending.content).toEqual([
      {
        type: "image",
        image: expect.stringContaining("data:image/png;base64,"),
      },
    ]);
  });

  test("MIME 缺失按扩展名推断，image/jpg 变体归一为 jpeg", async () => {
    const untyped = new File([pngBytes], "photo.webp");
    const pending = await addAttachment(untyped);
    expect(pending.contentType).toBe("image/webp");

    const jpg = new File([pngBytes], "shot.jpg", { type: "image/jpg" });
    const jpgPending = await addAttachment(jpg);
    expect(jpgPending.contentType).toBe("image/jpeg");
  });

  test("白名单外文件拒绝", async () => {
    const file = new File(["x"], "run.sh", { type: "application/x-sh" });
    expect(piPromptAttachmentAdapter.add({ file })).rejects.toThrow(
      /不是支持的附件/,
    );
  });

  test("兜底 send 对 complete 附件幂等（幂等返回同一 content，不重读文件）", async () => {
    const file = new File([pngBytes], "image.png", { type: "image/png" });
    const attachment = await addAttachment(file);
    const sent = (await piPromptAttachmentAdapter.send(
      attachment as unknown as Parameters<typeof piPromptAttachmentAdapter.send>[0],
    )) as unknown as AdapterAttachment;
    expect(sent.status).toEqual({ type: "complete" });
    expect(sent.content).toEqual(attachment.content);
  });
});

describe("piPromptAttachmentAdapter.send → 发送链路契约", () => {
  test("图片 dataURL part 经 buildPiSendInput 还原为内联 base64", async () => {
    const file = new File([pngBytes], "image.png", { type: "image/png" });
    const complete = await completeOf(file);
    expect(complete.content).toEqual([
      {
        type: "image",
        image: expect.stringContaining("data:image/png;base64,"),
      },
    ]);
    const message = {
      role: "user",
      content: [],
      attachments: [complete],
    } as unknown as AppendMessage;
    const input = buildPiSendInput(message, undefined);
    expect(input.attachments).toHaveLength(1);
    expect(input.attachments?.[0]?.mimeType).toBe("image/png");
    // data: 信封剥除后的裸 base64 与源字节一致
    const decoded = Uint8Array.from(
      atob(input.attachments![0]!.data),
      (c) => c.charCodeAt(0),
    );
    expect(decoded).toEqual(pngBytes);
  });

  test("文档 file part 带 data URL 进 files 载荷（下游据 data: 走落盘/内联裁决）", async () => {
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    const complete = await completeOf(file);
    expect(complete.content).toEqual([
      {
        type: "file",
        data: "data:text/plain;base64,aGVsbG8=",
        mimeType: "text/plain",
        filename: "note.txt",
      },
    ]);
    const message = {
      role: "user",
      content: [],
      attachments: [complete],
    } as unknown as AppendMessage;
    const input = buildPiSendInput(message, undefined);
    expect(input.files?.[0]).toEqual({
      data: "data:text/plain;base64,aGVsbG8=",
      mimeType: "text/plain",
      filename: "note.txt",
    });
  });

  test("accept 串与白名单同源（图片/文档扩展名与 MIME 双覆盖，dialog 对象路径同闸）", () => {
    expect(PROMPT_ATTACHMENT_ACCEPT).toContain(".png");
    expect(PROMPT_ATTACHMENT_ACCEPT).toContain(".pptx");
    expect(PROMPT_ATTACHMENT_ACCEPT).toContain("image/webp");
    expect(PROMPT_ATTACHMENT_ACCEPT).toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });
});
