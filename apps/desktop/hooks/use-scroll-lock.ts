"use client";

import { useEffect, useRef, type RefObject } from "react";
import { yieldViewportScroll } from "@/components/agent-thread/viewport-scroll-manager";
import { recomputeTopAnchorReserve } from "@/lib/ui/top-anchor-reserve";

/** 锚点顶部与视口顶部的容差：只有「用户消息正贴顶」时才接管垫片 */
const ANCHOR_TOP_TOLERANCE_PX = 2;
/** 重钉的亚像素余量 */
const REPIN_TOLERANCE_PX = 2;

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
    const isChatViewport = scrollContainer.matches(
      '[data-slot="aui_thread-viewport"]',
    );
    if (isChatViewport) {
      yieldViewportScroll();
    }

    /** 顶锚点稳定器（仅聊天视口 + 用户消息正贴视口顶部）：
     *  折叠面板的高度变化不在框架 reserve 的观察范围内。面板一收缩，
     *  scrollHeight 变小、maxScrollTop 跟着变小，浏览器会把 scrollTop 夹低
     *  ——用户消息被顶下视口，而且轮结束后管理器不会再来补。这里在动画期间
     *  按框架同口径实时补垫片：垫片 = max(0, 锚点位置 + 视口高 - 内容高)，
     *  让总高度始终够放下「锚点 + 一屏」，scrollTop 不会被夹；动画结束后
     *  交给框架按最终布局重算，再兜底把锚点顶回视口顶部。 */
    let stopAnchorSync: (() => void) | null = null;
    if (isChatViewport) {
      const anchor = scrollContainer.querySelector<HTMLElement>(
        "[data-aui-top-anchor-user]",
      );
      const reserve = scrollContainer.querySelector<HTMLElement>(
        "[data-aui-top-anchor-reserve]",
      );
      const anchorDelta = anchor
        ? anchor.getBoundingClientRect().top -
          scrollContainer.getBoundingClientRect().top
        : Number.POSITIVE_INFINITY;
      if (
        anchor &&
        reserve &&
        Math.abs(anchorDelta) <= ANCHOR_TOP_TOLERANCE_PX
      ) {
        // 贴顶状态下 scrollTop 就是锚点的文档位置；垫片按它 + 一屏高补
        const pinnedTop = scrollContainer.scrollTop;
        const syncReserve = () => {
          if (!reserve.isConnected) return;
          const contentHeight =
            scrollContainer.scrollHeight - reserve.offsetHeight;
          const needed = Math.max(
            0,
            pinnedTop + scrollContainer.clientHeight - contentHeight,
          );
          const next = `${Math.round(needed)}px`;
          if (reserve.style.height !== next) reserve.style.height = next;
        };
        syncReserve();
        const group = scrollContainer.querySelector<HTMLElement>(
          '[data-slot="aui_message-group"]',
        );
        const observer =
          typeof ResizeObserver === "undefined"
            ? null
            : new ResizeObserver(syncReserve);
        const observed = group ?? animatedElementRef.current;
        if (observer && observed) observer.observe(observed);
        let stopped = false;
        stopAnchorSync = () => {
          if (stopped) return;
          stopped = true;
          observer?.disconnect();
          // 框架内部的 reserve 状态还停在旧值：按最终布局重算一次
          recomputeTopAnchorReserve();
          // 等框架的 apply 落下来（两拍），兜底重钉，吸收取整/亚像素误差
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (!scrollContainer.isConnected) return;
              const liveAnchor = scrollContainer.querySelector<HTMLElement>(
                "[data-aui-top-anchor-user]",
              );
              if (!liveAnchor) return;
              const delta =
                liveAnchor.getBoundingClientRect().top -
                scrollContainer.getBoundingClientRect().top;
              if (delta > REPIN_TOLERANCE_PX) {
                scrollContainer.scrollTop += delta;
              }
            });
          });
        };
      }
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
      stopAnchorSync?.();
      stopAnchorSync = null;
    }, animationDuration);
    cleanupRef.current = () => {
      clearTimeout(timeoutId);
      scrollContainer.removeEventListener("scroll", resetPosition);
      stopAnchorSync?.();
      stopAnchorSync = null;
    };
  };
};
