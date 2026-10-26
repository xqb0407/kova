/**
 * 壁纸铺满整个应用窗口（会话卡片与左侧栏共用同一张 fixed 定位的图），
 * 裁剪构图按窗口内容区比例来——与 CSS `background-size: cover` 的视口区域
 * 一致，预览里看到的构图就是窗口里实际铺出来的构图。
 *
 * 设置页打开时会话卡片已卸载，窗口尺寸仍然直接可读，因此不再需要记录
 * 聊天卡尺寸。
 */
export type WindowSurfaceSize = { width: number; height: number };

const FALLBACK_WIDTH = 1440;
const FALLBACK_HEIGHT = 900;

export function windowSurfaceSize(): WindowSurfaceSize {
  if (typeof window === "undefined") {
    return { width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT };
  }
  return {
    width: window.innerWidth || FALLBACK_WIDTH,
    height: window.innerHeight || FALLBACK_HEIGHT,
  };
}

/** 窗口宽高比（限制在 1.2–2.4，极端窗口也不裁出怪比例） */
export function windowSurfaceAspect(): number {
  const { width, height } = windowSurfaceSize();
  return Math.min(2.4, Math.max(1.2, height > 0 ? width / height : 1.6));
}
