"use client";

/**
 * 把元素滚进「最近的纵向滚动容器」视野。
 *
 * 不要用 element.scrollIntoView()：它会把祖先链上所有滚动容器逐个滚一遍，
 * 而 overflow:hidden 的壳（main、CloneThreadShell 根）同样是滚动容器、可被
 * 程序滚动——从消息工具行定位面板 diff 时，整页被抬起、底部露出窗底色。
 * 这里只改目标容器自身的 scrollTop，外层纹丝不动。
 */
export function scrollIntoScroller(
  el: HTMLElement | null | undefined,
  block: "start" | "center" = "start",
): void {
  if (!el) return;
  let scroller: HTMLElement | null = el.parentElement;
  while (scroller) {
    const oy = getComputedStyle(scroller).overflowY;
    if (oy === "auto" || oy === "scroll") break;
    scroller = scroller.parentElement;
  }
  if (!scroller) return;
  const top =
    el.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top +
    scroller.scrollTop;
  const target =
    block === "center"
      ? top - (scroller.clientHeight - el.clientHeight) / 2
      : top;
  scroller.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
}
