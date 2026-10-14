import type { FC } from "react";
import { makeAssistantDataUI } from "@assistant-ui/react-native";
import type { PiImagePartData } from "@/lib/pi/pi-bridge";
import { isRenderableImagePart } from "@/lib/pi/image-part-guard";
import {
  markMaterializedImageFailed,
  requestImageRematerialize,
} from "@/lib/pi/image-materialize";
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
 * 展示源两种：内联 data URL（未落盘）与本端落盘后的 file://（内存优化，见
 * lib/pi/image-materialize）——守卫口径在 lib/pi/image-part-guard（纯逻辑、有单测）。
 * 落盘图加载失败（缓存被系统清了等）会就地报给 image-materialize：下次快照带来
 * base64 时重新落盘成新文件，行里随之换成好图（自愈，不白屏、不静默）。
 */

const ImagePartCard: FC<{ data?: PiImagePartData }> = ({ data }) => {
  const src = typeof data?.src === "string" ? data.src : "";
  if (!isRenderableImagePart(data)) return null;
  const label = data?.alt?.trim() || data?.toolName || "图片";
  const materialized = data?.materialized === true;

  return (
    <ImageRoot className="my-1">
      <ImageZoom src={src} alt={label}>
        <ImagePreview
          src={src}
          alt={label}
          {...(materialized
            ? {
                onError: () => {
                  // 记下这个坏文件（不再复用）并请上层重落盘：后台拉快照拿回 base64，
                  // 下一次落盘生成新文件，行里随之换成好图
                  markMaterializedImageFailed(src);
                  requestImageRematerialize();
                },
              }
            : {})}
        />
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
