/**
 * 窗口拖拽的纯计算（与 Electron/IPC 解耦，便于单测）。
 */

export type Rect = { x: number; y: number; width: number; height: number };

/**
 * 最大化窗口开始拖拽时的还原落点（对齐 Windows 原生 drag-to-restore）：
 * 横向把光标在最大化窗口里的比例映射到还原后的宽度（抓着标题栏右侧，
 * 还原后也仍在右侧），纵向保持按下时光标距窗口顶缘的距离。
 */
export function restoreDragPosition(args: {
  cursorX: number;
  cursorY: number;
  grabOffsetY: number;
  maximized: Rect;
  normalWidth: number;
}): { x: number; y: number } {
  const ratio =
    args.maximized.width > 0
      ? Math.min(
          1,
          Math.max(0, (args.cursorX - args.maximized.x) / args.maximized.width),
        )
      : 0.5;
  return {
    x: Math.round(args.cursorX - ratio * args.normalWidth),
    y: Math.round(args.cursorY - args.grabOffsetY),
  };
}

/** 还原逻辑只依赖这几个窗口能力，测试可用假窗口替代 Electron 的 BrowserWindow */
export type DragWindow = {
  isFullScreen(): boolean;
  isMaximized(): boolean;
  getBounds(): Rect;
  getNormalBounds(): Rect;
  unmaximize(): void;
  setBounds(bounds: Rect): void;
};

/**
 * 最大化窗口在指定光标位置还原并落位。返回还原后的实际位置；全屏或还原
 * 没有生效（窗口仍最大化）时返回 null，让调用方停手，避免按错误起点继续拖。
 * 非最大化时只回当前位置，供「状态快照之后窗口已被别处还原」的竞态续拖。
 */
export function restoreMaximizedWindowAt(
  win: DragWindow,
  args: { cursorX?: number; cursorY?: number; grabOffsetY?: number },
): { x: number; y: number } | null {
  if (win.isFullScreen()) return null;
  if (!win.isMaximized()) {
    const b = win.getBounds();
    return { x: b.x, y: b.y };
  }
  const maximized = win.getBounds();
  const normal = win.getNormalBounds();
  const pos = restoreDragPosition({
    cursorX: Number(args.cursorX ?? maximized.x + maximized.width / 2),
    cursorY: Number(args.cursorY ?? maximized.y),
    grabOffsetY: Number(args.grabOffsetY ?? 0),
    maximized,
    normalWidth: normal.width,
  });
  win.unmaximize();
  // unmaximize 没生效就别在最大化态上 setBounds（可能把最大化窗口挪出屏幕）
  if (win.isMaximized()) return null;
  win.setBounds({
    x: pos.x,
    y: pos.y,
    width: normal.width,
    height: normal.height,
  });
  const b = win.getBounds();
  return { x: b.x, y: b.y };
}
