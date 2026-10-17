/**
 * 图片 MIME 口径（单点）：
 * - **inline**：提供商与前端都能直接吃内联 base64 的栅格格式
 *   （png/jpeg/gif/webp，SVG 明确挡掉——可含外链与可欺骗绘制）；
 * - **processable**：inline + 服务端能解码并转成 inline 的格式（BMP → PNG）。
 *
 * 投影闸门（image-parts）只认 inline；附件入口与归一化认 processable，
 * 两者不要混用，否则 BMP 会在进入处理器之前就被当成"不支持的类型"丢掉。
 */

/** 可直接内联给模型/前端渲染的栅格格式 */
export const INLINE_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** 服务端可解码并转成 inline 的格式（Photon 支持 BMP） */
export const PROCESSABLE_IMAGE_MIMES: ReadonlySet<string> = new Set([
  ...INLINE_IMAGE_MIMES,
  "image/bmp",
]);

/** 常见别名 → 规范 MIME（参数已剥离、小写） */
const MIME_ALIASES: Readonly<Record<string, string>> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-ms-bmp": "image/bmp",
  "image/x-bmp": "image/bmp",
};

/** MIME 归一（去参数/小写/别名）；非字符串或空返回 null */
export function normalizeImageMime(mime: unknown): string | null {
  if (typeof mime !== "string") return null;
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!base) return null;
  return MIME_ALIASES[base] ?? base;
}

/** inline 白名单判定；不合法/不在白名单返回 null */
export function normalizeInlineMime(mime: unknown): string | null {
  const canon = normalizeImageMime(mime);
  return canon && INLINE_IMAGE_MIMES.has(canon) ? canon : null;
}

/** 可处理白名单判定（inline + BMP）；不合法/不可处理返回 null */
export function normalizeProcessableMime(mime: unknown): string | null {
  const canon = normalizeImageMime(mime);
  return canon && PROCESSABLE_IMAGE_MIMES.has(canon) ? canon : null;
}
