import { describe, expect, test } from "bun:test";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { buildShareDoc } from "./share-doc";

const asMessages = (value: unknown): readonly ThreadMessageLike[] =>
  value as readonly ThreadMessageLike[];

const userMessage = {
  id: "u1",
  role: "user" as const,
  content: [
    { type: "text", text: "帮我看看这个\n[图片已缩放：坐标乘以 2]" },
  ],
  metadata: {
    custom: { quote: { text: "被引用的上文", messageId: "" } },
  },
  attachments: [
    {
      id: "att-1",
      type: "image",
      name: "image-1.png",
      contentType: "image/png",
      status: { type: "complete" },
      content: [{ type: "image", image: "data:image/png;base64,USERIMG" }],
    },
  ],
};

const assistantMessage = {
  id: "a1",
  role: "assistant" as const,
  content: [
    { type: "reasoning", text: "先分析一下" },
    { type: "text", text: "答案第一段" },
    { type: "tool-call", toolName: "bash", isError: false },
    { type: "text", text: "答案第二段" },
    {
      type: "data",
      name: "image",
      data: { src: "data:image/png;base64,TOOLIMG", alt: "运行截图" },
    },
  ],
  status: { type: "incomplete", reason: "cancelled" },
};

describe("buildShareDoc", () => {
  test("默认只导出正文与图片，去掉思考/工具，并合并被工具隔开的正文", () => {
    const doc = buildShareDoc(asMessages([assistantMessage]), new Set(["a1"]), {
      title: "测试对话",
      createdAt: 1_700_000_000_000,
    });
    expect(doc.messages).toHaveLength(1);
    const blocks = doc.messages[0].blocks;
    expect(blocks.map((block) => block.kind)).toEqual(["text", "image"]);
    expect(blocks[0]).toEqual({
      kind: "text",
      markdown: "答案第一段\n\n答案第二段",
    });
    expect(blocks[1]).toEqual({
      kind: "image",
      src: "data:image/png;base64,TOOLIMG",
      alt: "运行截图",
    });
    expect(doc.messages[0].incomplete).toBe(true);
  });

  test("勾选思考/工具后保持原始交错顺序", () => {
    const doc = buildShareDoc(asMessages([assistantMessage]), new Set(["a1"]), {
      title: "测试对话",
      includeReasoning: true,
      includeTools: true,
    });
    expect(doc.messages[0].blocks.map((block) => block.kind)).toEqual([
      "reasoning",
      "text",
      "tool",
      "text",
      "image",
    ]);
    const tool = doc.messages[0].blocks.find((block) => block.kind === "tool");
    expect(tool).toEqual({ kind: "tool", name: "bash", failed: false });
  });

  test("用户消息：剥离模型注记、保留引用与附件图片", () => {
    const doc = buildShareDoc(asMessages([userMessage]), new Set(["u1"]), {
      title: "测试对话",
    });
    const message = doc.messages[0];
    expect(message.quote).toBe("被引用的上文");
    expect(message.blocks.map((block) => block.kind)).toEqual(["text", "image"]);
    expect(message.blocks[0]).toEqual({
      kind: "text",
      markdown: "帮我看看这个",
    });
    expect(message.blocks[1]).toEqual({
      kind: "image",
      src: "data:image/png;base64,USERIMG",
      alt: "image-1.png",
    });
  });

  test("按会话顺序输出选中消息；未选中的消息不出现", () => {
    const doc = buildShareDoc(
      asMessages([userMessage, assistantMessage]),
      new Set(["a1", "u1"]),
      { title: "测试对话" },
    );
    expect(doc.messages.map((message) => message.id)).toEqual(["u1", "a1"]);

    const onlyAssistant = buildShareDoc(
      asMessages([userMessage, assistantMessage]),
      new Set(["a1"]),
      { title: "测试对话" },
    );
    expect(onlyAssistant.messages.map((message) => message.id)).toEqual(["a1"]);
  });

  test("空选择产出空文档", () => {
    const doc = buildShareDoc(asMessages([userMessage]), new Set(), {
      title: "空",
    });
    expect(doc.messages).toEqual([]);
    expect(doc.title).toBe("空");
  });

  test("只有 data part 的分隔线消息不进入分享", () => {
    const divider = {
      id: "d1",
      role: "assistant",
      content: [
        { type: "data", name: "model-change", data: { modelId: "x" } },
      ],
    };
    const doc = buildShareDoc(asMessages([divider]), new Set(["d1"]), {
      title: "t",
    });
    expect(doc.messages).toEqual([]);
  });
});
