/**
 * 图片块能否渲染（守卫纯逻辑，可单测）。
 *
 * 两道来源两种口径：
 * - **自己落盘的**（`materialized`，src 是 file:// 或以后隧道阶段的远端 URL）：
 *   信任，不再卡 scheme——uri 由 expo-image-manipulator 的 `saveAsync` 给出
 *   （iOS 侧是 `url.absoluteString`，形如 `file:///…/Caches/ImageManipulator/xx.png`），
 *   卡 scheme 只会把好图误判成脏数据、静默白屏；
 * - **内联的**：只放行 data: / file: 两种常见形态，其余（http 脏值等）拒绝。
 * 两种口径都过 mime 白名单。
 */
const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export type RenderableImagePart = {
  src?: unknown;
  mimeType?: unknown;
  /** 投影打的标记：src 来自本端落盘（或隧道的引用下载） */
  materialized?: unknown;
};

export const isRenderableImagePart = (data: RenderableImagePart | undefined): boolean => {
  const src = typeof data?.src === "string" ? data.src : "";
  const mime = typeof data?.mimeType === "string" ? data.mimeType : "";
  if (!ALLOWED_MIME.has(mime)) return false;
  if (data?.materialized === true) return src.length > 0;
  return src.startsWith("data:") || src.startsWith("file:");
};
