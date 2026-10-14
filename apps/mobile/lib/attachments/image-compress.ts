import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type { ImagePickerAsset } from "expo-image-picker";
import { PROMPT_IMAGE_MAX_BYTES } from "./prompt-attachments";

/**
 * 图片压缩：相机/相册原图动辄 3–12MP、好几 MiB，直接内联进 prompt 会撞
 * 2MiB 单图闸门（协议侧 PROMPT_IMAGE_MAX_BYTES，与 sidecar 同源），手机流量
 * 也吃不消。这里统一「先按长边缩、再按质量压」：
 *
 *   长边 ≤ 1600、JPEG q0.8 → 还超预算就逐档退（1280/q0.7 → 1024/q0.6 → 800/q0.5）
 *
 * 1600 长边对「给模型看图」足够（模型侧还会再降采样），而 q0.8 的 JPEG 在
 * 手机屏上看不出差别。预算取闸门的 3/4（base64 比原字节大 1/3，留出余量）。
 */
const TARGET_BYTES = Math.floor(PROMPT_IMAGE_MAX_BYTES * 0.75);
const STEPS: readonly { maxEdge: number; quality: number }[] = [
  { maxEdge: 1600, quality: 0.8 },
  { maxEdge: 1280, quality: 0.7 },
  { maxEdge: 1024, quality: 0.6 },
  { maxEdge: 800, quality: 0.5 },
];

export type CompressedImage = {
  /** 裸 base64（不带 data: 前缀） */
  base64: string;
  /** 压缩后字节数（由 base64 长度反推） */
  bytes: number;
  width: number;
  height: number;
};

/** base64 字符数 → 原始字节数 */
export const bytesOfBase64 = (base64: string): number =>
  Math.floor((base64.length * 3) / 4);

/**
 * 压缩一张图到预算内；全部档位都压不进（几乎不可能：800px/q0.5 的 JPEG 通常
 * 几十 KB）时返回最后一档结果，由调用方按闸门报错。
 */
export async function compressImage(
  asset: Pick<ImagePickerAsset, "uri" | "width" | "height">,
  targetBytes: number = TARGET_BYTES,
): Promise<CompressedImage> {
  let last: CompressedImage | null = null;
  for (const step of STEPS) {
    const longEdge = Math.max(asset.width ?? 0, asset.height ?? 0);
    const context = ImageManipulator.manipulate(asset.uri);
    try {
      if (longEdge > step.maxEdge) {
        context.resize(
          (asset.width ?? 0) >= (asset.height ?? 0)
            ? { width: step.maxEdge }
            : { height: step.maxEdge },
        );
      }
      const rendered = await context.renderAsync();
      try {
        const { base64, width, height } = await rendered.saveAsync({
          format: SaveFormat.JPEG,
          compress: step.quality,
          base64: true,
        });
        if (!base64) continue;
        last = { base64, bytes: bytesOfBase64(base64), width, height };
        if (last.bytes <= targetBytes) return last;
      } finally {
        rendered.release();
      }
    } finally {
      context.release();
    }
  }
  if (!last) throw new Error("图片压缩失败");
  return last;
}
