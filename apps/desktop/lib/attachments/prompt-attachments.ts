import type { PiPromptAttachment } from "../pi/pi-channel";
import type { UIMessage } from "ai";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/tauri";

/**
 * 用户附件（多模态输入）的前端组装与前置校验（设计：docs/user-image-attachment-plan.md）。
 *
 * extractPromptAttachments：把 user UIMessage 的 file parts（composer 附件发送时
 * 由 runtime 转成 parts）还原成协议 attachments 形状（{ name, mimeType, data 裸 base64 }）。
 * data: URL 直接解析；blob:/http(s) URL fetch 回字节再转 base64（发送是异步的，可行）。
 * 白名单外附件在组装时跳过——sidecar 闸门（prompt-attachments.ts）是最终兜底。
 *
 * 附件分两类，传输通道不同：
 * - 图片：MIME 白名单 + 2MiB 单图上限，裸 base64 内联进 prompt（多模态上下文）；
 * - 文档（PDF/Word/Excel/PPT/TXT/MD/CSV）：桌面端经 Rust attachment_stage 落盘
 *   到 app_data/attachments/，attachments 里只带绝对路径（prompt 帧不带字节，
 *   请求体不随文档膨胀；sidecar 复制进 <cwd>/.kova/attachments/ 交给 agent），
 *   单文档 ≤20MiB；网页端无本地 FS 回退内联，上限 8MiB。
 * 数量（图片 >4 / 文档 >2）与内联总体积由 sidecar 拒收说明，添加时不拦。
 */

/** 与 sidecar prompt-attachments.ts 同源的单图字节上限（IMAGE_INLINE_MAX_BYTES） */
export const PROMPT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** 与 sidecar 同源的单条 prompt 图片上限（超出由 sidecar 拒收说明） */
export const PROMPT_IMAGE_MAX_COUNT = 4;

/** 单文档字节上限（桌面端落盘通道，请求体不膨胀，比内联宽） */
export const PROMPT_DOC_MAX_BYTES = 20 * 1024 * 1024;

/** 单文档字节上限（网页端内联回退，受请求体约束） */
export const PROMPT_DOC_INLINE_MAX_BYTES = 8 * 1024 * 1024;

const IMAGE_MIME_ALLOWED = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

/** 文档扩展名 → mime（与 sidecar prompt-attachments.ts 的 DOC_TYPES 同源） */
const DOC_EXT_MIME: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  rtf: "application/rtf",
};

const DOC_MIME_SET = new Set(Object.values(DOC_EXT_MIME));

export function isImageMimeOk(mime: string | undefined | null): boolean {
  const m = mime?.trim().toLowerCase();
  return !!m && IMAGE_MIME_ALLOWED.has(m === "image/jpg" ? "image/jpeg" : m);
}

/** 扩展名推断文档 mime；非文档返回 null */
export function docMimeFromName(name: string | undefined): string | null {
  const norm = (name ?? "").toLowerCase();
  const dot = norm.lastIndexOf(".");
  const ext = dot > 0 ? norm.slice(dot + 1) : "";
  return DOC_EXT_MIME[ext] ?? null;
}

/** 扩展名推断图片 mime（dialog 直选图片用）；非图片返回 null */
const IMAGE_EXT_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function imageMimeFromName(name: string | undefined): string | null {
  const norm = (name ?? "").toLowerCase();
  const dot = norm.lastIndexOf(".");
  const ext = dot > 0 ? norm.slice(dot + 1) : "";
  return IMAGE_EXT_MIME[ext] ?? null;
}

/** 本地绝对路径（或 file:// URL）判定：dialog 直选的附件 url 就是本地路径，
 *  载荷直接带路径零 fetch；blob:/http(s)/data: 均不匹配 */
const LOCAL_PATH_RE = /^(?:file:\/\/|[A-Za-z]:[\\/]|\/)/;

/** file:// URL → 本地路径（逐段解码；Windows 盘符去掉三斜杠多出的一个斜杠） */
export function fileUrlToLocalPath(url: string): string {
  if (!url.startsWith("file://")) return url;
  let p = decodeURIComponent(url.slice("file://".length));
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
  return p;
}

const basenameOf = (p: string): string =>
  p.replace(/\\/g, "/").slice(p.replace(/\\/g, "/").lastIndexOf("/") + 1) || p;

/** 附件种类：image（内联多模态）/ document（落盘给 agent）；白名单外 null */
export type PromptFileKind = "image" | "document";

export function promptFileKind(
  name: string | undefined,
  mime: string | undefined | null,
): PromptFileKind | null {
  if (isImageMimeOk(mime)) return "image";
  const m = mime?.trim().toLowerCase() ?? "";
  if ((m && DOC_MIME_SET.has(m)) || docMimeFromName(name)) return "document";
  return null;
}

/** 附件前置校验：通过返回 null，否则返回给用户的错误文案。
 *  文档上限随通道走：桌面端落盘 20MiB / 网页端内联 8MiB */
export function validatePromptFile(file: {
  name?: string;
  type?: string;
  size: number;
}): string | null {
  const kind = promptFileKind(file.name, file.type);
  if (kind === "image") {
    if (file.size > PROMPT_IMAGE_MAX_BYTES) {
      return `「${file.name || "图片"}」超过 ${(PROMPT_IMAGE_MAX_BYTES / (1024 * 1024)).toFixed(0)}MiB 上限`;
    }
    return null;
  }
  if (kind === "document") {
    const cap = isTauri() ? PROMPT_DOC_MAX_BYTES : PROMPT_DOC_INLINE_MAX_BYTES;
    if (file.size > cap) {
      return `「${file.name || "文档"}」超过 ${(cap / (1024 * 1024)).toFixed(0)}MiB 上限`;
    }
    return null;
  }
  return `「${file.name || "文件"}」不是支持的附件（图片 PNG/JPEG/GIF/WebP，或文档 PDF/Word/Excel/PPT/TXT/MD/CSV）`;
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

/** 字节 → SHA-256 hex（中转文件名用，同内容去重；subtle 不可用回退 null） */
async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

type FilePart = Extract<UIMessage["parts"][number], { type: "file" }>;

/**
 * file part → 协议附件；data: URL 直解，其余 fetch 后转 base64；白名单外返回 null。
 * 文档在桌面端走落盘中转（Rust attachment_stage）：字节进 app_data/attachments/，
 * 附件载荷只带绝对路径——请求体不随文档膨胀；网页端回退内联 base64。
 */
async function filePartToAttachment(
  part: FilePart,
  threadId: string | undefined,
): Promise<PiPromptAttachment | null> {
  const url = part.url ?? "";
  const kind = promptFileKind(part.filename, part.mediaType);
  if (!kind) return null;
  const docMime = kind === "document" ? docMimeFromName(part.filename) : null;

  // dialog 直选：url 就是本地绝对路径（或 file:// URL）→ 载荷直接带原路径，
  // 零落盘零 fetch（图片与文档都适用；sidecar 对图片读盘内联、文档原位引用）
  if (url && LOCAL_PATH_RE.test(url)) {
    const localPath = fileUrlToLocalPath(url);
    const mimeType =
      part.mediaType ||
      (kind === "image" ? imageMimeFromName(part.filename) : null) ||
      docMime ||
      (kind === "image" ? "image/png" : "application/octet-stream");
    return {
      name: part.filename || basenameOf(localPath),
      mimeType: mimeType === "image/jpg" ? "image/jpeg" : mimeType,
      path: localPath,
    };
  }

  if (kind === "document" && isTauri()) {
    let bytes: Uint8Array | null;
    if (url.startsWith("data:")) {
      const base64 = url.slice(url.indexOf(",") + 1);
      bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    } else {
      try {
        const res = await fetch(url);
        bytes = new Uint8Array(await (await res.blob()).arrayBuffer());
      } catch {
        bytes = null;
      }
    }
    if (!bytes) return null;
    try {
      const { path } = await invoke<{ path: string }>("attachment_stage", {
        name: part.filename || "attachment",
        dataBase64: bytesToBase64(bytes),
        threadId: threadId ?? null,
        hash: await sha256Hex(bytes),
      });
      if (!path) return null;
      return {
        name: part.filename || "attachment",
        mimeType: part.mediaType || docMime || "application/octet-stream",
        path,
      };
    } catch {
      return null;
    }
  }

  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma < 0) return null;
    const headerMime = url.slice(5, url.indexOf(";")) || undefined;
    const mimeType =
      part.mediaType ||
      headerMime ||
      docMime ||
      (kind === "image" ? "image/png" : "application/octet-stream");
    return {
      name: part.filename || (kind === "image" ? "image" : "attachment"),
      mimeType: mimeType === "image/jpg" ? "image/jpeg" : mimeType,
      data: url.slice(comma + 1),
    };
  }
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const mimeType =
      part.mediaType ||
      blob.type ||
      docMime ||
      (kind === "image" ? "image/png" : "application/octet-stream");
    return {
      name: part.filename || (kind === "image" ? "image" : "attachment"),
      mimeType: mimeType === "image/jpg" ? "image/jpeg" : mimeType,
      data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
    };
  } catch {
    return null;
  }
}

/**
 * 最后一条用户消息的 file parts → 协议 attachments（图片 + 文档混装，种类判定
 * 与闸门裁决在 sidecar）。无 file parts 返回 null（prompt 不带 attachments 字段）；
 * 部分失败跳过该项。
 */
export async function extractPromptAttachments(
  lastUser: UIMessage | undefined,
  /** 当前线程 id：中转文件按线程分目录（清会话可整目录带走） */
  threadId?: string,
): Promise<PiPromptAttachment[] | null> {
  const fileParts = lastUser?.parts.filter(
    (p): p is FilePart => p.type === "file",
  );
  if (!fileParts || fileParts.length === 0) return null;
  const out: PiPromptAttachment[] = [];
  for (const part of fileParts) {
    const att = await filePartToAttachment(part, threadId);
    if (att) out.push(att);
  }
  return out.length ? out : null;
}
