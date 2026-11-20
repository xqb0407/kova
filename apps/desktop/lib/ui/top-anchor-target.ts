/**
 * 顶部锚点的几何口径（与 @assistant-ui/react 的 top-anchor 实现同口径）。
 *
 * 应用侧有两处要用：
 *  - thread-viewport.tsx：把 clamp 配置登记给框架（框架默认 10em/6em 会把
 *    视口放得下的长消息也裁掉）；
 *  - promote-top-anchor.tsx：「立即发送」时按同一口径计算垫片与钉位目标——
 *    目标必须与框架后续算出的完全一致，差出来的那一段会被框架再补一次
 *    平滑滚动（就是用户感知的「慢慢拉到视口」）。
 *
 * 框架源码见 @assistant-ui/react/dist/primitives/thread/topAnchor/。
 */

/** sticky composer 页脚（与 thread-preview-rail / thread-viewport 同一选择器） */
export const THREAD_FOOTER_SELECTOR = ".aui-thread-viewport-footer";
/** 超视口被裁切时至少保留的可见高度：再长的消息也能看到一段完整上下文 */
const MIN_VISIBLE_PX = 96;
/** 超视口被裁切时留给回复/状态的比例：可视区的 40% */
const ASSISTANT_RESERVE_RATIO = 0.4;
/** 视口上下留一点余量，避免消息边缘贴死 */
const EDGE_MARGIN_PX = 8;

/** 可用高度 → 框架顶部锚点的数值配置（px） */
export const clampFor = (usableHeight: number) => ({
  tallerThan: Math.max(0, usableHeight - EDGE_MARGIN_PX),
  visibleHeight: Math.min(
    usableHeight,
    Math.max(
      MIN_VISIBLE_PX,
      Math.round(usableHeight * (1 - ASSISTANT_RESERVE_RATIO)),
    ),
  ),
});

/** 视口可用高度：扣掉 sticky composer 页脚（thread-viewport 的 measure 同源） */
export const viewportUsableHeight = (viewport: HTMLElement): number =>
  Math.max(
    0,
    viewport.clientHeight -
      (viewport.querySelector<HTMLElement>(THREAD_FOOTER_SELECTOR)?.offsetHeight ??
        0),
  );

/** 元素在视口滚动内容里的纵向偏移（与框架 getLayoutOffsetTop 同口径：
 *  只累加到视口本身，视口自己的 padding/offset 不算进去） */
export const layoutOffsetTop = (
  element: HTMLElement,
  ancestor: HTMLElement,
): number => {
  let top = 0;
  let current: HTMLElement | null = element;
  while (current && current !== ancestor) {
    top += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  return top;
};

/** 与框架 computeTopAnchorTargetScrollTop 同口径：普通高度气泡钉到视口顶；
 *  超高气泡只保留底部 visibleHeight（动态 clamp 与 thread-viewport 一致）。 */
export const topAnchorScrollTop = (
  viewport: HTMLElement,
  anchor: HTMLElement,
): number => {
  const usable = viewportUsableHeight(viewport);
  const anchorTop = layoutOffsetTop(anchor, viewport);
  if (usable <= 0) return anchorTop;
  const { tallerThan, visibleHeight } = clampFor(usable);
  const anchorHeight = anchor.offsetHeight;
  return (
    anchorTop +
    Math.max(
      0,
      anchorHeight - (anchorHeight <= tallerThan ? anchorHeight : visibleHeight),
    )
  );
};
