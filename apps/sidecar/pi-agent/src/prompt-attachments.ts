/**
 * prompt 附件（用户图片，多模态输入）的解析与闸门（设计：docs/user-image-attachment-plan.md）。
 *
 * 前端经 prompt 消息的 attachments 字段下发（[{ name, mimeType, data }]，data = 裸
 * base64），这里单点裁决哪些图能进模型上下文：MIME 白名单（与工具结果图片投影
 * image-parts 同一张表，SVG 整体挡掉）、单图 ≤2MiB（同 IMAGE_INLINE_MAX_BYTES，
 * base64 后 ~2.7MiB，最坏 4 张 ≈10.7MiB/帧低于 Rust 重放缓冲 16MiB）、每条 ≤4 张、
 * 模型硬门已移除：目录真值与自定义端点默认值都可能把支持图像的模型标成
 * text-only（实测误拦），input 元数据不可靠；图片过物理闸门后一律放行，
 * 端点真不支持时 API 报错且错误对模型/用户可见，好过静默吞图。
 *
 * 拒收不抛错不静默：一律折算成一行中文说明追加到 prompt 文本尾部（模型可读、
 * 刷新后可见），与 image-parts 的降级占位哲学一致。合法图片原样组装成
 * ImageContent 交 agent.prompt(text, images)——pi-agent-core 会把图片拼进 user
 * 消息 content，随 agent 消息本体自动落转录（persist 存整条 agent JSON）。
 */
import type { ImageContent } from "@earendil-works/pi-ai";
import { IMAGE_INLINE_MAX_BYTES, normalizeMime } from "./image-parts";

/** 单条 prompt 允许携带的图片上限 */
export const PROMPT_IMAGE_MAX_COUNT = 4;

export type PreparedPromptAttachments = {
  images: ImageContent[];
  /** 拒收说明行（空数组 = 全部合法）；调用方按行拼接进 prompt 文本尾部 */
  noticeLines: string[];
};

/** 原始 prompt 文本 + 拒收说明行 → 模态文本（空行分隔，无说明时原样返回） */
export function noticeAppendedText(text: string, noticeLines: string[]): string {
  return noticeLines.length ? `${text}\n${noticeLines.join("\n")}` : text;
}

/** data URL 防御性剥离（约定传裸 base64，历史客户端可能整段粘贴 data URL） */
function stripDataUrl(data: string): string {
  return data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
}

/**
 * prompt 消息 → 可进模型的 ImageContent 列表 + 拒收说明行。
 * 顺序语义：白名单内按序收满 PROMPT_IMAGE_MAX_COUNT 张，其余与非法项各得一行说明。
 */
export function preparePromptAttachments(
  msg: Record<string, unknown>,
): PreparedPromptAttachments {
  const raw = Array.isArray(msg.attachments) ? msg.attachments : [];
  if (raw.length === 0) return { images: [], noticeLines: [] };

  const noticeLines: string[] = [];

  const images: ImageContent[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = (raw[i] ?? {}) as Record<string, unknown>;
    const name =
      typeof item.name === "string" && item.name.trim()
        ? item.name.trim().slice(0, 120)
        : `图片${i + 1}`;
    const mime = normalizeMime(item.mimeType ?? item.mediaType);
    const data = typeof item.data === "string" ? stripDataUrl(item.data.trim()) : "";
    const bytes = data ? Buffer.byteLength(data, "base64") : 0;
    if (!mime) {
      noticeLines.push(`[${name} 已省略：仅支持 PNG/JPEG/GIF/WebP 图片]`);
      continue;
    }
    if (bytes <= 0 || bytes > IMAGE_INLINE_MAX_BYTES) {
      noticeLines.push(
        `[${name} 已省略：图片超过 ${(IMAGE_INLINE_MAX_BYTES / (1024 * 1024)).toFixed(0)}MiB 上限]`,
      );
      continue;
    }
    if (images.length >= PROMPT_IMAGE_MAX_COUNT) {
      noticeLines.push(`[${name} 已省略：单条消息最多 ${PROMPT_IMAGE_MAX_COUNT} 张图片]`);
      continue;
    }
    images.push({ type: "image", data, mimeType: mime });
  }
  return { images, noticeLines };
}
