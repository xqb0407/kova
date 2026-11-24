import type { PiModelSummary } from "@/lib/pi/pi-bridge";

/**
 * 视觉辅助的模型口径。
 *
 * 发图能力不在这里做 UI 拦截：当前模型明确不支持图片输入时，请求侧会把图片
 * 替换成占位文本（视觉辅助就绪时换成带 imageId 的占位，模型可主动调 see_image
 * 查看），模型自己知道看不到图，不需要再向用户弹提醒。未声明输入能力的模型
 * 保持未知，请求侧不预剥图。
 */

/** 图片能力三态；字段缺失时从 input 推导，兼容旧 sidecar / 内置目录模型。 */
function imageSupportOf(m: PiModelSummary | null | undefined): boolean | undefined {
  if (!m) return undefined;
  if (m.supportsImage === null) return undefined;
  if (typeof m.supportsImage === "boolean") return m.supportsImage;
  return Array.isArray(m.input) ? m.input.includes("image") : undefined;
}

/**
 * 「可用视觉模型」的单条判定（设置页视觉模型清单过滤与 sidecar 自动挑选
 * 共用一份口径，防两处漂移）：已配凭据、未被过滤隐藏、明确支持图像、非文生图。
 * 未声明能力的模型不参与自动挑选。
 */
export function isUsableVisionModel(m: PiModelSummary): boolean {
  return (
    m.authed &&
    m.enabled !== false &&
    m.t2i !== true &&
    imageSupportOf(m) === true
  );
}

/** 模型是否明确声明为纯文本输入；未知能力不算。 */
export function isTextOnlyModel(
  m: PiModelSummary | null | undefined,
): boolean {
  return imageSupportOf(m) === false;
}

/** 模型图片输入能力是否未声明（三态里的 null）。 */
export function isImageInputUnknown(
  m: PiModelSummary | null | undefined,
): boolean {
  return Boolean(m && m.supportsImage === null);
}
