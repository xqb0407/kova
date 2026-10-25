/**
 * 壁纸裁剪几何（纯函数，可单测）。
 *
 * 视图模型：预览框（viewW×viewH）里放一张等比缩放到 cover 的图片，
 * 用户再按 zoom 放大并用 offsetX/offsetY（像素，相对视图中心）平移。
 * 导出时反算源图上的矩形，保证所见即所得。
 */

export type CropTransform = {
  /** 1 = 刚好 cover 预览框 */
  zoom: number;
  /** 预览框坐标系里的位移（正 = 图片向右/下移动） */
  offsetX: number;
  offsetY: number;
};

export type SourceRect = {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
};

export function coverScale(
  imageW: number,
  imageH: number,
  viewW: number,
  viewH: number,
): number {
  if (imageW <= 0 || imageH <= 0 || viewW <= 0 || viewH <= 0) return 1;
  return Math.max(viewW / imageW, viewH / imageH);
}

export function clampZoom(zoom: number): number {
  return Math.min(3, Math.max(1, zoom));
}

/** 平移边界：图片边缘不能离开预览框（留白就露底了） */
export function clampOffsets(
  imageW: number,
  imageH: number,
  viewW: number,
  viewH: number,
  transform: CropTransform,
): { offsetX: number; offsetY: number } {
  const scale = coverScale(imageW, imageH, viewW, viewH) * clampZoom(transform.zoom);
  const renderedW = imageW * scale;
  const renderedH = imageH * scale;
  const maxX = Math.max(0, (renderedW - viewW) / 2);
  const maxY = Math.max(0, (renderedH - viewH) / 2);
  return {
    offsetX: Math.min(maxX, Math.max(-maxX, transform.offsetX)),
    offsetY: Math.min(maxY, Math.max(-maxY, transform.offsetY)),
  };
}

/** 当前视图对应源图的裁剪矩形（clamp 到图片范围内） */
export function sourceRect(
  imageW: number,
  imageH: number,
  viewW: number,
  viewH: number,
  transform: CropTransform,
): SourceRect {
  const zoom = clampZoom(transform.zoom);
  const scale = coverScale(imageW, imageH, viewW, viewH) * zoom;
  const { offsetX, offsetY } = clampOffsets(imageW, imageH, viewW, viewH, {
    ...transform,
    zoom,
  });
  // 渲染后的图片左上角（视图坐标）
  const x0 = viewW / 2 + offsetX - (imageW * scale) / 2;
  const y0 = viewH / 2 + offsetY - (imageH * scale) / 2;
  const sw = viewW / scale;
  const sh = viewH / scale;
  const sx = Math.min(Math.max(0, -x0 / scale), Math.max(0, imageW - sw));
  const sy = Math.min(Math.max(0, -y0 / scale), Math.max(0, imageH - sh));
  return { sx, sy, sw, sh };
}

/**
 * 预览框尺寸：按窗口比例，限制在 1.2–2.4，避免超宽/超窄窗口裁出怪比例。
 * maxHeight 给短窗口用：超过时按高度反推宽度，保证标题/滑杆/底部按钮
 * 能和预览一起落在弹窗可视区内（弹窗另有 92vh + overflow 兜底）。
 */
export function cropViewSize(
  windowW: number,
  windowH: number,
  maxWidth: number,
  maxHeight = Number.POSITIVE_INFINITY,
): { width: number; height: number } {
  const ratio = Math.min(
    2.4,
    Math.max(1.2, windowH > 0 ? windowW / windowH : 1.6),
  );
  let width = Math.max(280, Math.min(maxWidth, windowW - 160));
  let height = Math.round(width / ratio);
  if (height > maxHeight) {
    height = Math.max(180, Math.round(maxHeight));
    width = Math.round(height * ratio);
  }
  return { width, height };
}
