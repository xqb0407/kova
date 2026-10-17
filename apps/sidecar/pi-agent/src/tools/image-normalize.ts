/**
 * 图片"处理到合规"（取代超限即丢）：
 *
 * 模型侧的限制不再是闸门，而是处理器参数。每张图先按 pi 的口径
 * （@earendil-works/pi-durable 1.3.0，见 src/vendor/pi-images/）解码 →
 * 按 EXIF orientation 摆正 → 缩到模型 inputLimits.images.resize 内 →
 * 逐档降 JPEG 质量/尺寸直到 base64 放得下；BMP 转 PNG。放不下/解不开才降级
 * 成一行说明，绝不静默吞图。
 *
 * 为什么放在 sidecar：Photon 的 WASM 解码会占住整张图的 RGBA 内存且不回收，
 * 手机端不能加这层（expo-image-manipulator 只负责本端展示/压缩）。sidecar 是
 * 桌面/服务端进程，按用户要求把这一层收在这里，前端只剩渲染守卫。
 *
 * 两个上限取严：
 * - 模型 inputLimits.images.resize（缺省 2000x2000 / 4.5MiB base64）；
 * - 内联通道闸门 IMAGE_INLINE_MAX_BYTES（2MiB 原始字节，护住前端渲染与 Rust
 *   重放缓冲）。因此默认实际目标是 2000 长边 + ≤2MiB。
 */
import { readFileSync } from "node:fs";
import wasmPath from "@silvia-odwyer/photon/photon_rs_bg.wasm" with { type: "file" };
import { createPhotonImages } from "../vendor/pi-images";
import {
  base64Length,
  DEFAULT_IMAGE_LIMITS,
  INLINE_IMAGE_TYPES,
  type ImageLimits,
  type ImageProcessor,
  type PreparedImage,
} from "../vendor/pi-images/processor";
import { logErr } from "../log";
import { IMAGE_INLINE_MAX_BYTES } from "./image-parts";
import { normalizeProcessableMime } from "./image-mime";

/**
 * 内联闸门换算成 base64 字符数（模型限制的 maxBytes 与 pi 同口径：base64 长度）。
 * 扣 2 字节：投影层用 `floor(base64Length * 3 / 4)` 估算原始字节，带 padding 时
 * 会高估 1–2 字节；不扣的话"刚好合规"的图会被投影闸门误杀。
 */
export const IMAGE_INLINE_MAX_BASE64 = base64Length(IMAGE_INLINE_MAX_BYTES - 2);

/** 允许进入处理器的原始字节上限：再大就不解码了（RGBA 解码是像素量级，防 OOM） */
export const IMAGE_INPUT_MAX_BYTES = 24 * 1024 * 1024;

/**
 * 取模型图片限制的结构子集（避免把 pi-ai 的完整 Model 泛型拖进来）：
 * 只读 inputLimits.images.resize，缺省回落到 pi 的 2000x2000/4.5MiB。
 */
export type ImageLimitModel = {
  inputLimits?: {
    images?: {
      resize?: {
        maxWidth?: number;
        maxHeight?: number;
        maxBytes?: number;
      };
    };
  };
};

const positiveInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

/** 当前模型实际生效的图片限制（模型值 ∩ 内联闸门） */
export function imageLimitsForModel(model?: ImageLimitModel): ImageLimits {
  const resize = model?.inputLimits?.images?.resize;
  return {
    maxWidth: positiveInt(resize?.maxWidth) ?? DEFAULT_IMAGE_LIMITS.maxWidth,
    maxHeight: positiveInt(resize?.maxHeight) ?? DEFAULT_IMAGE_LIMITS.maxHeight,
    maxBytes: Math.min(
      positiveInt(resize?.maxBytes) ?? DEFAULT_IMAGE_LIMITS.maxBytes,
      IMAGE_INLINE_MAX_BASE64,
    ),
  };
}

let defaultProcessor: ImageProcessor | null | undefined;

/**
 * 默认 Photon 处理器（进程内单例）。wasm 以 `with { type: "file" }` 嵌入
 * 单文件二进制，运行时 readFileSync 即可；加载失败只降级、不让 sidecar 崩。
 */
export function getDefaultImageProcessor(): ImageProcessor | null {
  if (defaultProcessor !== undefined) return defaultProcessor;
  try {
    defaultProcessor = createPhotonImages(readFileSync(wasmPath));
  } catch (err) {
    defaultProcessor = null;
    logErr("image normalize: Photon wasm unavailable, falling back to inline gate:", err);
  }
  return defaultProcessor;
}

/** base64 → 处理器；处理器缺失/解码失败/运行时异常都返回 undefined（调用方降级） */
export async function prepareImageBase64(
  dataBase64: string,
  mimeType: string,
  limits: ImageLimits,
  processor: ImageProcessor | null,
): Promise<PreparedImage | undefined> {
  if (!processor) return undefined;
  try {
    return await processor.prepare(Buffer.from(dataBase64, "base64"), mimeType, limits);
  } catch (err) {
    // Photon 的解码错误在 vendor 里已吃掉；这里兜 WASM 分配失败等运行时异常，
    // 绝不因为一张图把整个工具结果/回合打挂
    logErr("image normalize: processor failed:", err);
    return undefined;
  }
}

/** 缩放/转码说明行（模型据此把坐标映射回原图；与 pi-main 的 hint 语义一致） */
export function imageHints(prepared: PreparedImage, sourceMime: string): string[] {
  const hints: string[] = [];
  const convertedFrom = prepared.convertedFrom ?? sourceMime;
  if (convertedFrom !== prepared.mimeType) {
    hints.push(`[图片已从 ${convertedFrom} 转为 ${prepared.mimeType}]`);
  }
  if (prepared.resized) {
    const { from, to } = prepared.resized;
    const scale = to.width > 0 ? from.width / to.width : 1;
    hints.push(
      `[图片已缩放：原 ${from.width}x${from.height}，现 ${to.width}x${to.height}；` +
        `坐标乘以 ${scale.toFixed(2)} 可映射回原图]`,
    );
  }
  return hints;
}

/** 工具结果 content 里的图片块（形状按需放宽，其余字段透传） */
export type NormalizableImageBlock = Record<string, unknown> & {
  type?: string;
  text?: string;
  data?: unknown;
  mimeType?: unknown;
};

const fmtMiB = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

/** data URL 防御性剥离（约定传裸 base64，兼容历史数据） */
function stripDataUrl(data: string): string {
  return data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
}

/** 块里的 mime：优先 mimeType，data URL 头兜底 */
function blockMime(block: NormalizableImageBlock): string {
  if (typeof block.mimeType === "string" && block.mimeType.trim()) return block.mimeType.trim();
  const raw = typeof block.data === "string" ? block.data.trim() : "";
  if (raw.startsWith("data:")) {
    const semi = raw.indexOf(";");
    return semi > 5 ? raw.slice(5, semi) : "";
  }
  return "";
}

/**
 * 工具结果图片归一化（原地语义由调用方决定）：返回新 content 数组，未变化返回
 * null。解不开/超处理上限/格式不支持的图改成一行 text 说明（模型与 UI 都可见），
 * 不再把畸形图片塞给 provider。缩放/转码图后面追加一行说明。
 *
 * 注意：该函数会解码图片（Photon 同步执行，12MP 约 1-2 秒），在 tool_execution_end
 * 里 await 是刻意的——先处理再落盘/投影，直播与刷新后看到的是同一份内容。
 */
export async function normalizeToolResultImages(
  content: readonly NormalizableImageBlock[],
  model: ImageLimitModel | undefined,
  processor?: ImageProcessor | null,
): Promise<NormalizableImageBlock[] | null> {
  if (!Array.isArray(content) || !content.some((block) => block?.type === "image")) {
    return null;
  }
  // 只有真的出现图片才初始化 Photon（纯文本工具结果不碰 WASM）
  const activeProcessor =
    processor === undefined ? getDefaultImageProcessor() : processor;
  const limits = imageLimitsForModel(model);
  const out: NormalizableImageBlock[] = [];
  let changed = false;
  for (const block of content) {
    if (block?.type !== "image") {
      out.push(block);
      continue;
    }
    const label = blockMime(block) || "未知类型";
    const raw = typeof block.data === "string" ? block.data.trim() : "";
    const b64 = stripDataUrl(raw);
    const mime = normalizeProcessableMime(label);
    if (!b64) {
      out.push({ type: "text", text: `[图片未能展示：${label} 数据为空]` });
      changed = true;
      continue;
    }
    if (!mime) {
      out.push({
        type: "text",
        text: `[图片未能展示：不支持的类型 ${label}（仅 png/jpeg/gif/webp/bmp）]`,
      });
      changed = true;
      continue;
    }
    const rawBytes = Math.floor((b64.length * 3) / 4);
    if (rawBytes > IMAGE_INPUT_MAX_BYTES) {
      out.push({
        type: "text",
        text: `[图片未能展示：约 ${fmtMiB(rawBytes)}，超过 ${fmtMiB(IMAGE_INPUT_MAX_BYTES)} 处理上限]`,
      });
      changed = true;
      continue;
    }
    const prepared = await prepareImageBase64(b64, mime, limits, activeProcessor);
    if (!prepared) {
      // 处理器不可用（wasm 加载失败）时维持旧闸门：已经合规的内联图原样放行
      if (
        activeProcessor === null &&
        INLINE_IMAGE_TYPES.has(mime) &&
        b64.length <= limits.maxBytes
      ) {
        // 顺带把 data URL 剥成裸 base64（投影会自己拼前缀）
        out.push({ ...block, data: b64, mimeType: mime });
        if (b64 !== raw || mime !== label) changed = true;
        continue;
      }
      out.push({
        type: "text",
        text: `[图片未能展示：${label} 无法解码或压缩到内联上限]`,
      });
      changed = true;
      continue;
    }
    out.push({ ...block, data: prepared.data, mimeType: prepared.mimeType });
    if (prepared.data !== b64 || prepared.mimeType !== mime) changed = true;
    for (const hint of imageHints(prepared, mime)) {
      out.push({ type: "text", text: hint });
      changed = true;
    }
  }
  return changed ? out : null;
}
