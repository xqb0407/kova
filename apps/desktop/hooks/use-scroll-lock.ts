"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * 本地替换 `@assistant-ui/react` 的 `useScrollLock`：签名与激活语义一致
 * （高度动画期间钉住最近滚动祖先的 scrollTop），但不做滚动条补偿。
 *
 * 库版本在动画期间对滚动容器执行 `scrollbar-width: none` 并把实测滚动条宽度
 * 加进 `paddingRight`，假定隐藏一定生效。WKWebView（Tauri）不支持
 * `scrollbar-width`：globals.css 的 `*::-webkit-scrollbar { width: 6px }`
 * 仍占着布局空间，padding 补偿却照常叠加——整个对话列右侧凭空宽 6px，
 * 动画结束还原时再弹回，即展开/收起时的 margin 闪烁。
 *
 * 这里只钉滚动位置：赋值走 `scrollTo({ behavior: "instant" })`，
 * 绕过容器的 `scroll-behavior: smooth`，保证同帧钉住而非平滑回滚。
 */
export const useScrollLock = <T extends HTMLElement = HTMLElement>(
  animatedElementRef: RefObject<T | null>,
  animationDuration: number,
): (() => void) => {
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      cleanupRef.current?.();
    },
    [],
  );

  return () => {
    cleanupRef.current?.();

    if (!scrollContainerRef.current && animatedElementRef.current) {
      let el: HTMLElement | null = animatedElementRef.current;
      while (el) {
        const { overflowY } = getComputedStyle(el);
        if (overflowY === "scroll" || overflowY === "auto") {
          scrollContainerRef.current = el;
          break;
        }
        el = el.parentElement;
      }
    }
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    const scrollPosition = scrollContainer.scrollTop;
    const resetPosition = () => {
      if (scrollContainer.scrollTop !== scrollPosition) {
        scrollContainer.scrollTo({ top: scrollPosition, behavior: "instant" });
      }
    };
    scrollContainer.addEventListener("scroll", resetPosition);
    const timeoutId = setTimeout(() => {
      scrollContainer.removeEventListener("scroll", resetPosition);
      cleanupRef.current = null;
    }, animationDuration);
    cleanupRef.current = () => {
      clearTimeout(timeoutId);
      scrollContainer.removeEventListener("scroll", resetPosition);
    };
  };
};
