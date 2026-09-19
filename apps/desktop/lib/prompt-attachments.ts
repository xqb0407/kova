import type { PiPromptAttachment } from "./pi-channel";
import type { UIMessage } from "ai";

/**
 * 用户图片附件（多模态输入）的前端组装与前置校验（设计：docs/user-image-attachment-plan.md）。
 *
 * extractPromptAttachments：把 user UIMessage 的 file parts（composer 附件发送时
 * 由 runtime 转成 parts）还原成协议 attachments 形状（{ name, mimeType, data 裸 base64 }）。
 * data: URL 直接解析；blob:/http(s) URL fetch 回字节再转 base64（发送是异步的，可行）。
 * 非白名单图片在组装时跳过——sidecar 闸门（prompt-attachments.ts）是最终兜底。
 *
 * validateImageFile：addAttachment 前置校验（粘贴路径与附件按钮共用），同款
 * MIME 白名单 + 2MiB 单图上限；返回错误文案（null = 通过）。超量（>4 张）由
 * sidecar 拒收说明，添加时不拦（草稿里可预览删除）。
 */

/** 与 sidecar prompt-attachments.ts 同源的单图字节上限（IMAGE_INLINE_MAX_BYTES） */
export const PROMPT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** 与 sidecar 同源的单条 prompt 图片上限（超出由 sidecar 拒收说明） */
export const PROMPT_IMAGE_MAX_COUNT = 4;

const IMAGE_MIME_ALLOWED = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

export function isImageMimeOk(mime: string | undefined | null): boolean {
  const m = mime?.trim().toLowerCase();
  return !!m && IMAGE_MIME_ALLOWED.has(m === "image/jpg" ? "image/jpeg" : m);
}

/** 附件前置校验：通过返回 null，否则返回给用户的错误文案 */
export function validateImageFile(file: {
  type?: string;
  size: number;
  name?: string;
}): string | null {
  if (!isImageMimeOk(file.type)) {
    return `「${file.name || "文件"}」不是支持的图片（PNG/JPEG/GIF/WebP）`;
  }
  if (file.size > PROMPT_IMAGE_MAX_BYTES) {
    return `「${file.name || "图片"}」超过 ${(PROMPT_IMAGE_MAX_BYTES / (1024 * 1024)).toFixed(0)}MiB 上限`;
  }
  return null;
}

/** Uint8Array → base64（分段 btoa，避免大文件展开超调用栈） */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

type FilePart = Extract<UIMessage["parts"][number], { type: "file" }>;

/** file part → 协议附件；data: URL 直解，其余 fetch 后转 base64；无法处理返回 null */
async function filePartToAttachment(part: FilePart): Promise<PiPromptAttachment | null> {
  const url = part.url ?? "";
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma < 0) return null;
    const headerMime = url.slice(5, url.indexOf(";")) || undefined;
    const mimeType = part.mediaType || headerMime || "image/png";
    if (!isImageMimeOk(mimeType)) return null;
    return {
      name: part.filename || "image",
      mimeType: mimeType === "image/jpg" ? "image/jpeg" : mimeType,
      data: url.slice(comma + 1),
    };
  }
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const mimeType = part.mediaType || blob.type || "";
    if (!isImageMimeOk(mimeType)) return null;
    return {
      name: part.filename || "image",
      mimeType: mimeType === "image/jpg" ? "image/jpeg" : mimeType,
      data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
    };
  } catch {
    return null;
  }
}

/**
 * 最后一条用户消息的 file parts → 协议 attachments。
 * 无 file parts 返回 null（prompt 不带 attachments 字段）；部分失败跳过该图。
 */
export async function extractPromptAttachments(
  lastUser: UIMessage | undefined,
): Promise<PiPromptAttachment[] | null> {
  const fileParts = lastUser?.parts.filter(
    (p): p is FilePart => p.type === "file",
  );
  if (!fileParts || fileParts.length === 0) return null;
  const out: PiPromptAttachment[] = [];
  for (const part of fileParts) {
    const att = await filePartToAttachment(part);
    if (att) out.push(att);
  }
  return out.length ? out : null;
}
