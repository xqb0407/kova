"use client";

/**
 * 分享文档模型：把会话投影（ThreadMessageLike[]）压成与 UI 无关的纯数据，
 * 供 HTML / Markdown / 图片三条输出共用。
 *
 * 只保留「可读正文」：用户气泡、助手正文、思考过程（可选）、工具名（可选）、
 * 图片（内联 data URL）。压缩分隔线、检查点、停止标记等 data part 属于内部
 * 状态，不进分享产物。
 */
import type { ThreadMessageLike } from "@assistant-ui/react";
import { splitPromptNotices } from "@/lib/pi/prompt-notices";

export type ShareBlock =
  | { kind: "text"; markdown: string }
  | { kind: "reasoning"; markdown: string }
  | { kind: "tool"; name: string; failed: boolean }
  | { kind: "image"; src: string; alt?: string };

export type ShareMessage = {
  id: string;
  role: "user" | "assistant";
  blocks: ShareBlock[];
  /** 用户消息引用的上下文（metadata.custom.quote） */
  quote?: string;
  /** 中断/报错/长度截断的回复：正文可能不完整，分享页要标注 */
  incomplete?: boolean;
};

export type ShareDoc = {
  title: string;
  createdAt: number;
  messages: ShareMessage[];
};

export type ShareDocOptions = {
  title: string;
  createdAt?: number;
  /** 默认不导出思考过程 */
  includeReasoning?: boolean;
  /** 默认不导出工具调用记录 */
  includeTools?: boolean;
};

const IMAGE_PART_NAME = "image";

const asImageSrc = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined;
  // 只接受内联图片：分享产物必须自包含，外链图在离线/断网时是空框
  return value.startsWith("data:") ? value : undefined;
};

const imageFromDataPart = (
  data: unknown,
): { src: string; alt?: string } | undefined => {
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as { src?: unknown; alt?: unknown };
  const src = asImageSrc(record.src);
  if (!src) return undefined;
  return {
    src,
    ...(typeof record.alt === "string" && record.alt.trim()
      ? { alt: record.alt.trim() }
      : {}),
  };
};

/** 相邻正文合并：关掉工具/思考后，text → tool → text 会变成两段相邻正文，
 *  分开渲染会多出段落间距 */
const mergeAdjacentText = (blocks: ShareBlock[]): ShareBlock[] => {
  const out: ShareBlock[] = [];
  for (const block of blocks) {
    const prev = out[out.length - 1];
    if (block.kind === "text" && prev?.kind === "text") {
      out[out.length - 1] = {
        kind: "text",
        markdown: `${prev.markdown}\n\n${block.markdown}`,
      };
      continue;
    }
    out.push(block);
  }
  return out;
};

const contentParts = (
  content: ThreadMessageLike["content"],
): readonly Exclude<ThreadMessageLike["content"], string>[number][] =>
  typeof content === "string" ? [{ type: "text", text: content }] : content;

const buildUserMessage = (
  message: ThreadMessageLike,
  id: string,
): ShareMessage | null => {
  const blocks: ShareBlock[] = [];
  for (const part of contentParts(message.content)) {
    if (part.type === "text") {
      // sidecar 拼在 prompt 末尾的「给模型看的注记」对读者是噪音
      const text = splitPromptNotices(part.text).text.trim();
      if (text) blocks.push({ kind: "text", markdown: text });
      continue;
    }
    if (part.type === "image") {
      const src = asImageSrc(part.image);
      if (src) {
        blocks.push({
          kind: "image",
          src,
          ...(part.filename ? { alt: part.filename } : {}),
        });
      }
      continue;
    }
    if (part.type === "data" && part.name === IMAGE_PART_NAME) {
      const image = imageFromDataPart(part.data);
      if (image) blocks.push({ kind: "image", ...image });
    }
  }
  // 用户附件在气泡外渲染；分享时接在正文后（图片顺序 = 发送顺序）
  for (const attachment of message.attachments ?? []) {
    let addedImage = false;
    for (const part of attachment.content) {
      if (part.type !== "image") continue;
      const src = asImageSrc(part.image);
      if (!src) continue;
      blocks.push({
        kind: "image",
        src,
        ...(attachment.name ? { alt: attachment.name } : {}),
      });
      addedImage = true;
    }
    // 非图片附件（文档/普通文件）至少留一个名字，别让分享页看起来像没发过
    if (!addedImage && attachment.name) {
      blocks.push({ kind: "text", markdown: `_[附件：${attachment.name}]_` });
    }
  }

  const quoteValue = (
    message.metadata?.custom as { quote?: { text?: unknown } } | undefined
  )?.quote?.text;
  const quote =
    typeof quoteValue === "string" && quoteValue.trim()
      ? quoteValue.trim()
      : undefined;

  const merged = mergeAdjacentText(blocks);
  if (merged.length === 0 && !quote) return null;
  return { id, role: "user", blocks: merged, ...(quote ? { quote } : {}) };
};

const buildAssistantMessage = (
  message: ThreadMessageLike,
  id: string,
  opts: Required<Pick<ShareDocOptions, "includeReasoning" | "includeTools">>,
): ShareMessage | null => {
  const blocks: ShareBlock[] = [];
  for (const part of contentParts(message.content)) {
    if (part.type === "text") {
      const text = part.text.trim();
      if (text) blocks.push({ kind: "text", markdown: text });
      continue;
    }
    if (part.type === "reasoning") {
      if (!opts.includeReasoning) continue;
      const text = part.text.trim();
      if (text) blocks.push({ kind: "reasoning", markdown: text });
      continue;
    }
    if (part.type === "tool-call") {
      if (!opts.includeTools) continue;
      blocks.push({
        kind: "tool",
        name: part.toolName || "工具",
        failed: Boolean(part.isError),
      });
      continue;
    }
    if (part.type === "image") {
      const src = asImageSrc(part.image);
      if (src) {
        blocks.push({
          kind: "image",
          src,
          ...(part.filename ? { alt: part.filename } : {}),
        });
      }
      continue;
    }
    if (part.type === "data" && part.name === IMAGE_PART_NAME) {
      const image = imageFromDataPart(part.data);
      if (image) blocks.push({ kind: "image", ...image });
    }
  }

  const merged = mergeAdjacentText(blocks);
  if (merged.length === 0) return null;
  return {
    id,
    role: "assistant",
    blocks: merged,
    ...(message.status?.type === "incomplete" ? { incomplete: true } : {}),
  };
};

/**
 * @param messages 当前会话的完整消息数组（顺序即分享顺序）
 * @param selectedIds 选中的消息 id；空集合 = 什么都不分享
 */
export function buildShareDoc(
  messages: readonly ThreadMessageLike[],
  selectedIds: ReadonlySet<string>,
  opts: ShareDocOptions,
): ShareDoc {
  const normalized = {
    includeReasoning: opts.includeReasoning ?? false,
    includeTools: opts.includeTools ?? false,
  };
  const out: ShareMessage[] = [];
  messages.forEach((message, index) => {
    if (message.role === "system") return;
    const id = message.id ?? `share-msg-${index}`;
    if (!selectedIds.has(id)) return;
    const built =
      message.role === "user"
        ? buildUserMessage(message, id)
        : buildAssistantMessage(message, id, normalized);
    if (built) out.push(built);
  });
  return {
    title: opts.title,
    createdAt: opts.createdAt ?? Date.now(),
    messages: out,
  };
}
