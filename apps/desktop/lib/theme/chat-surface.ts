/**
 * 聊天窗口尺寸记录：壁纸只作用于会话卡片，裁剪构图按卡片比例来。
 * 设置页打开时聊天卡片已卸载，所以由 chat 视图在挂载期间把尺寸记在模块里，
 * 内存级即可（刷新后若直接进设置页则回落到窗口比例）。
 */
export type ChatSurfaceSize = { width: number; height: number };

let size: ChatSurfaceSize | null = null;

export function recordChatSurfaceSize(width: number, height: number): void {
  if (width > 0 && height > 0) size = { width, height };
}

export function getChatSurfaceSize(): ChatSurfaceSize | null {
  return size;
}

/** 聊天卡片的宽高比（限制在 1.2–2.4，极端窗口也不裁出怪比例） */
export function chatSurfaceAspect(
  fallbackWidth = 1440,
  fallbackHeight = 900,
): number {
  const width = size?.width ?? fallbackWidth;
  const height = size?.height ?? fallbackHeight;
  return Math.min(2.4, Math.max(1.2, height > 0 ? width / height : 1.6));
}
