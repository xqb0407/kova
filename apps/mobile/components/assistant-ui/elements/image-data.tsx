import type { FC } from "react";
import { makeAssistantDataUI } from "@assistant-ui/react-native";
import type { PiImagePartData } from "@/lib/pi/pi-bridge";
import {
  ImageFilename,
  ImagePreview,
  ImageRoot,
  ImageZoom,
} from "./image";

/**
 * 工具产出图片的 data part 渲染（对齐桌面 ImageDataUI）：
 * sidecar 把工具结果的 image 块投影为 data-image part（直播 chunk / get_history
 * 同构，闸门单点在 sidecar image-parts.ts）；这里按名认领渲染，图片全屏可缩放。
 *
 * 展示侧护栏（双保险，与桌面 ImageDataUI 同款）：投影侧已过滤，但历史脏数据不
 * 经过新代码，这里再挡一道——只放行 data: 内联 + 栅格白名单，一切非预期形状
 * （脏 src/白名单外类型）降级为不渲染，绝不静默吞掉整条消息。
 */

const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const ImagePartCard: FC<{ data?: PiImagePartData }> = ({ data }) => {
  const src = typeof data?.src === "string" ? data.src : "";
  const mime = data?.mimeType ?? "";
  if (!src.startsWith("data:") || !ALLOWED_MIME.has(mime)) return null;
  const label = data?.alt?.trim() || data?.toolName || "图片";

  return (
    <ImageRoot className="my-1">
      <ImageZoom src={src} alt={label}>
        <ImagePreview src={src} alt={label} />
      </ImageZoom>
      <ImageFilename>{label}</ImageFilename>
    </ImageRoot>
  );
};

/** 与 Compaction 等 data UI 同法挂载（Thread 根节），自身不占渲染位 */
export const ImageDataUI = makeAssistantDataUI<PiImagePartData>({
  name: "image",
  render: ImagePartCard,
});
