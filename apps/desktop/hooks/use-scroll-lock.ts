"use client";

import { useEffect, useRef, type RefObject } from "react";
import { yieldViewportScroll } from "@/components/agent-thread/viewport-scroll-manager";

/**
 * 本地替换 `@assistant-ui/react` 的 `useScrollLock`：签名与激活语义一致
 * （高度动画期间钉住最近滚动祖先的 scrollTop），但不做滚动条补偿。
 *
 * 库版本在动画期间对滚动容器执行 `scrollbar-width: none` 并把实测滚动条宽度
 * 加进 `paddingRight`，假定隐藏一定生效。WKWebView（Electron）不支持
 * `scrollbar-width`：globals.css 的 `*::-webkit-scrollbar { width: 6px }`
 * 仍占着布局空间，padding 补偿却照常叠加——整个对话列右侧凭空宽 6px，
 * 动画结束还原时再弹回，即展开/收起时的 margin 闪烁。
 *
 * 这里只钉滚动位置：赋值走 `scrollTo({ behavior: "instant" })`，
 * 绕过容器的 `scroll-behavior: smooth`，保证同帧钉住而非平滑回滚。
 *
 * 钉的是聊天视口时先 `yieldViewportScroll()` 让流式跟随交权（见下方注释）：
 * 展开动画把正在流的消息撑高，管理器会把这截当流式增长补到底，与钉位对打。
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

    // 聊天视口：展开/收起折叠块是用户明确的「停在这里读」意图，先让 ViewportScrollManager
    // 的贴尾/钉顶写让位，否则高度动画期间两个写源同帧对打（锁往回钉、管理器往下补），
    // 观感即流式中点开「思考」上下闪。滚回底部由 onScroll 接管、新一轮 effect 重建复位。
    // 只认聊天视口：面板内卡片（checkpoint/artifact）的锁不越权交还对话滚动权。
    if (scrollContainer.matches('[data-slot="aui_thread-viewport"]')) {
      yieldViewportScroll();
    }

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
