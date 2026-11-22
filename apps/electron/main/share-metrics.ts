/**
 * 分享截图的像素换算。
 *
 * Page.captureScreenshot 的输出像素 = CSS px × clip.scale × devicePixelRatio：
 * clip 的 width/height 是 CSS 像素，但 surface 本身按窗口的 device scale 渲染，
 * 所以 Retina 上 clip.scale=2 实际会得到 4 倍像素。调用方说的 scale 是
 * 「相对 CSS px 的输出倍率」，传给 CDP 前必须除掉 dpr。
 */
export function normalizeDevicePixelRatio(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(4, n) : 1;
}

/** 把「输出倍率」换算成 CDP clip.scale（已扣除 devicePixelRatio）。 */
export function clipScaleForDevicePixels(scale: number, dpr: number): number {
  return Math.max(0.01, scale / normalizeDevicePixelRatio(dpr));
}

/** capturePage 的输出是设备像素（Retina 上 CSS px × dpr），内容像素按同一口径换算。 */
export function capturePageContentPixels(contentPx: number, dpr: number): number {
  return Math.round(contentPx * normalizeDevicePixelRatio(dpr));
}

/** 兜底路径请求的窗口高度（CSS px）：保证 capturePage 的设备像素不超过纹理上限。 */
export function fallbackCaptureCssHeight(
  contentHeight: number,
  dpr: number,
  maxDevicePx: number,
): number {
  return Math.min(
    contentHeight,
    Math.floor(maxDevicePx / normalizeDevicePixelRatio(dpr)),
  );
}
