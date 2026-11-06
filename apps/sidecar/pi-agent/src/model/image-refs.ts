/**
 * 视觉辅助的图片引用与请求侧占位（see_image 工具的发现性基础设施）。
 *
 * 背景：纯文本输入的模型收到 image 块时，pi-ai downgradeUnsupportedImages 会
 * 把它替换成 "(image omitted…)"——模型知道有图，但既不知道有几张、也没有任何
 * 可用于指认的句柄，无从主动发起查看。本模块在请求组装阶段（streamFn）把
 * image 块换成**带稳定 imageId 的占位文本**，让模型可以主动调用 see_image
 * 查看。与拒图修复（image-rejection.ts）同哲学：只改发出去的请求上下文，
 * 转录与 UI 气泡不动——切回视觉模型后原图自动恢复可见。
 *
 * imageId = 图片内容 SHA-256 前 12 位（img_ 前缀）：同一张图跨请求、跨轮次
 * 稳定，see_image 工具按同一哈希在会话消息里反查原图，无需额外登记表。
 * 仅当视觉辅助开关打开且模型声明为纯文本输入时由调用方启用（见 resolve.ts
 * streamFn）——开关关闭时本模块完全不参与，请求与未引入该能力前逐字节一致。
 */
import { createHash } from "node:crypto";
import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";

/** 占位里的来源标记：用户随消息发送的图片（工具截图用工具名） */
export const IMAGE_SOURCE_USER = "user_attachment";

/** see_image 工具名：占位文本直接点名工具，保证模型看图路径可发现 */
export const SEE_IMAGE_TOOL_NAME = "see_image";

/** imageId 前缀 + 内容哈希长度（48bit，单会话内碰撞可忽略） */
const IMAGE_ID_HASH_CHARS = 12;

/** 内容哈希按 image 块对象记忆：同一块对象在多次请求间不重复计算 SHA-256。
 *  WeakMap 键随消息对象被 GC，无需清理；对象 identity 变了只是重算一次。 */
const imageIdMemo = new WeakMap<object, string>();

/** data URL 防御性剥离（约定传裸 base64；历史/异常来源可能整段带前缀） */
function stripDataUrl(data: string): string {
  return data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
}

/** 图片内容 → 稳定引用 ID（裸 base64 与 data URL 同值） */
export function imageRefId(data: string): string {
  const bare = stripDataUrl(data);
  return `img_${createHash("sha256").update(bare).digest("hex").slice(0, IMAGE_ID_HASH_CHARS)}`;
}

/** 带 WeakMap 记忆的 ID（请求路径用；工具反查路径直接 imageRefId） */
function imageRefIdMemoized(block: object, data: string): string {
  const hit = imageIdMemo.get(block);
  if (hit !== undefined) return hit;
  const id = imageRefId(data);
  imageIdMemo.set(block, id);
  return id;
}

/** 会话消息里的一个可查看图片（see_image 工具的反查清单项） */
export interface ImageRef {
  id: string;
  /** 裸 base64（已去 data: 前缀） */
  data: string;
  mimeType: string;
  role: "user" | "toolResult";
  /** toolResult 的产出工具名（user 图片无） */
  toolName?: string;
  messageIndex: number;
  blockIndex: number;
}

/** image 块的最小形状（Message 与 AgentMessage 的 image 块同形） */
type ImageBlock = { type: "image"; data: string; mimeType?: string };

function isImageBlock(block: unknown): block is ImageBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "image" &&
    typeof (block as { data?: unknown }).data === "string"
  );
}

/**
 * 收集会话消息里的全部可查看图片（user/toolResult 的数组 content）。
 * 宽松输入：messages 来自 agent state（AgentMessage[]），逐条探测 role/content，
 * content 为 string 或角色不符的条目跳过。顺序 = 转录顺序（旧 → 新）。
 */
export function collectImageRefs(messages: readonly unknown[]): ImageRef[] {
  const refs: ImageRef[] = [];
  if (!Array.isArray(messages)) return refs;
  for (let mi = 0; mi < messages.length; mi += 1) {
    const message = messages[mi] as
      | { role?: unknown; content?: unknown; toolName?: unknown }
      | null
      | undefined;
    if (!message || typeof message !== "object") continue;
    const role = message.role;
    if (role !== "user" && role !== "toolResult") continue;
    if (!Array.isArray(message.content)) continue;
    for (let bi = 0; bi < message.content.length; bi += 1) {
      const block = message.content[bi];
      if (!isImageBlock(block)) continue;
      const data = stripDataUrl(block.data);
      if (!data) continue;
      refs.push({
        id: imageRefIdMemoized(block as object, data),
        data,
        mimeType:
          typeof block.mimeType === "string" && block.mimeType
            ? block.mimeType
            : "image/png",
        role,
        ...(role === "toolResult" && typeof message.toolName === "string"
          ? { toolName: message.toolName }
          : {}),
        messageIndex: mi,
        blockIndex: bi,
      });
    }
  }
  return refs;
}

/** 占位文本：说明「看不到图」+ 给出工具调用句柄（模型可读；UI 不展示） */
export function imagePlaceholderText(source: string, id: string): string {
  return (
    `[image attached | source=${source} | imageId=${id} | ` +
    `the current model cannot see image pixels. Call ${SEE_IMAGE_TOOL_NAME}` +
    `(imageId="${id}", question="...") to inspect it.]`
  );
}

/** 目录元数据是否声明图像输入；input 缺失按纯文本处理（与 pi-ai 同口径） */
export function modelAcceptsImages(
  model: Pick<Model<Api>, "input"> | null | undefined,
): boolean {
  return Array.isArray(model?.input) && model.input.includes("image");
}

type PlaceholderContentBlock =
  | { type: "text"; text: string }
  | ImageBlock;

/**
 * 纯文本模型的请求侧图片占位：user/toolResult 里每个 image 块原位替换为一条
 * 带 imageId 的 text 块（不合并相邻占位——每张图一个独立句柄，模型可逐张查看）。
 * 先零分配预扫描：无图 context（纯文本编码会话的常态）与支持图像的模型一样
 * 返回原 context 引用（cacheWarmer 前缀身份检查不受扰动）。泛型返回保留
 * 调用方的 context 品牌类型。
 */
export function placeholderImagesForTextModel<C extends Context>(
  model: Pick<Model<Api>, "input">,
  context: C,
): C {
  if (modelAcceptsImages(model)) return context;
  // 零分配预扫描：无图 context（纯文本编码会话的常态）直接原引用返回
  let hasImage = false;
  for (const message of context.messages) {
    if (
      (message.role === "user" || message.role === "toolResult") &&
      Array.isArray(message.content) &&
      (message.content as unknown[]).some(isImageBlock)
    ) {
      hasImage = true;
      break;
    }
  }
  if (!hasImage) return context;
  let changed = false;
  const messages: Message[] = context.messages.map((message) => {
    if (message.role !== "user" && message.role !== "toolResult") return message;
    if (!Array.isArray(message.content)) return message;
    const content = message.content as unknown[];
    let messageChanged = false;
    const next: PlaceholderContentBlock[] = content.map((block) => {
      if (!isImageBlock(block)) return block as PlaceholderContentBlock;
      const data = stripDataUrl(block.data);
      if (!data) return block as PlaceholderContentBlock;
      messageChanged = true;
      const source =
        message.role === "toolResult" &&
        typeof (message as { toolName?: unknown }).toolName === "string" &&
        (message as { toolName: string }).toolName
          ? (message as { toolName: string }).toolName
          : IMAGE_SOURCE_USER;
      return {
        type: "text" as const,
        text: imagePlaceholderText(source, imageRefIdMemoized(block as object, data)),
      };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content: next } as Message;
  });
  if (!changed) return context;
  return { ...context, messages } as C;
}
