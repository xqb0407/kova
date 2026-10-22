"use client";

/**
 * 分享文档 → Markdown（「复制 Markdown」用）。
 *
 * 图片是内联 data URL，塞进剪贴板文本会变成几 MB 的乱码；这里只留占位，
 * 需要图片时用「保存图片 / 保存网页」。
 */
import type { ShareBlock, ShareDoc } from "./share-doc";
import { formatShareTime } from "./share-html";

const quoteLines = (text: string): string =>
  text
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");

const renderBlock = (block: ShareBlock): string => {
  switch (block.kind) {
    case "text":
      return block.markdown.trim();
    case "reasoning":
      return `**思考过程**\n\n${quoteLines(block.markdown.trim())}`;
    case "tool":
      return `- 工具：${block.name}${block.failed ? "（失败）" : ""}`;
    case "image":
      return `_[图片${block.alt ? `：${block.alt}` : ""}]_`;
  }
};

export function docToMarkdown(doc: ShareDoc): string {
  const chunks: string[] = [`# ${doc.title.trim() || "未命名对话"}`];
  const createdAt = formatShareTime(doc.createdAt);
  if (createdAt) chunks.push(`_${createdAt}_`);

  for (const message of doc.messages) {
    chunks.push(message.role === "user" ? "## 你" : "## 助手");
    if (message.quote) chunks.push(quoteLines(message.quote));
    const body = message.blocks
      .map(renderBlock)
      .filter((part) => part.length > 0)
      .join("\n\n");
    if (body) chunks.push(body);
    if (message.incomplete) chunks.push("> （回复未完成）");
  }

  return `${chunks.join("\n\n")}\n`;
}
