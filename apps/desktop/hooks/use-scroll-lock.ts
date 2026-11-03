"use client";

import { useEffect, useRef, type RefObject } from "react";
import { suspendViewportScroll } from "@/components/agent-thread/viewport-scroll-manager";
import { recomputeTopAnchorReserve } from "@/lib/ui/top-anchor-reserve";

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
    // 只让位一个动画时长（+余量），不是整轮：思考块自动收起后管理器要能继续补钉，
    // 否则折叠把 scrollTop 夹低一次就没人复位（表现是用户消息被往下推后停住）。
    const isChatViewport = scrollContainer.matches(
      '[data-slot="aui_thread-viewport"]',
    );
    if (isChatViewport) {
      suspendViewportScroll(animationDuration + 32);
    }

    /** 视口稳定器（仅聊天视口）：
     *  折叠面板的高度变化不在框架 reserve 的观察范围内，两种阅读位置要分开处理：
     *  1) 用户消息贴顶、内容又短于一屏：scrollTop 会被夹低、整屏下移。
     *     按「锚点位置 + 一屏」补垫片，保证 scrollTop 不被夹。
     *     只在这种贴顶态补垫片——其他位置补垫片等于把内容整体往下推，
     *     收尾再撤掉就是「上下动、又被拉回去」。
     *  2) 用户已经滚进回复里读：补垫片没用，直接按内容高度变化补偿 scrollTop，
     *     让正在读的那段文字原位不动。贴底时浏览器会把 scrollTop 随高度夹住，
     *     底部本来就稳定，这里不重复补偿（否则底部会缩两次）。 */
    let stopAnchorSync: (() => void) | null = null;
    if (isChatViewport) {
      const reserve = scrollContainer.querySelector<HTMLElement>(
        "[data-aui-top-anchor-reserve]",
      );
      if (reserve) {
        // 动画期间钉住的就是这个位置；垫片按它 + 一屏高补
        const pinnedTop = scrollContainer.scrollTop;
        let prevContentHeight: number | null = null;
        const isAnchorAtTop = () => {
          const anchor = scrollContainer.querySelector<HTMLElement>(
            "[data-aui-top-anchor-user]",
          );
          if (!anchor) return false;
          const delta =
            anchor.getBoundingClientRect().top -
            scrollContainer.getBoundingClientRect().top;
          return Math.abs(delta) <= 2;
        };
        const syncReserve = () => {
          if (!reserve.isConnected) return;
          const contentHeight =
            scrollContainer.scrollHeight - reserve.offsetHeight;
          // 模式在动画开始时就锁定，不能每帧重判：收缩第一帧会把锚点夹下去，
          // 再按「非贴顶」切换到补偿模式，两种策略当场交替，就是抖动本身。
          if (startsPinned) {
            const needed = Math.max(
              0,
              pinnedTop + scrollContainer.clientHeight - contentHeight,
            );
            const next = `${Math.round(needed)}px`;
            if (reserve.style.height !== next) reserve.style.height = next;
            if (scrollContainer.scrollTop !== pinnedTop) {
              scrollContainer.scrollTo({ top: pinnedTop, behavior: "instant" });
            }
          } else if (prevContentHeight !== null) {
            const delta = contentHeight - prevContentHeight;
            const maxTop =
              scrollContainer.scrollHeight - scrollContainer.clientHeight;
            // 只有不贴底时才补偿；贴底交给浏览器的夹取，避免缩两次
            if (delta !== 0 && scrollContainer.scrollTop < maxTop - 1) {
              scrollContainer.scrollTo({
                top: scrollContainer.scrollTop + delta,
                behavior: "instant",
              });
            }
          }
          prevContentHeight = contentHeight;
        };
        // 动画开始时的阅读位置决定整段动画用哪种策略（见 syncReserve 注释）
        const startsPinned = isAnchorAtTop();
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
          // 交接前先判定当前阅读位置：贴顶才需要「拉回顶部」，读到中途的
          // scrollTop 是补偿过的，不能按起始值复位。
          const wasPinnedAtTop = startsPinned;
          // 框架内部的 reserve 状态还停在旧值：按最终布局重算一次
          recomputeTopAnchorReserve();
          syncReserve();
          if (
            wasPinnedAtTop &&
            scrollContainer.scrollTop !== pinnedTop
          ) {
            scrollContainer.scrollTo({ top: pinnedTop, behavior: "instant" });
          }
          // 等框架的 apply 落下来（两拍），贴顶态兜底重钉，吸收亚像素误差
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (!scrollContainer.isConnected || !wasPinnedAtTop) return;
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
    // 聊天视口不做无条件位置复位：折叠块在阅读位置上方时，稳定器会按内容
    // 高度差补偿 scrollTop；这个监听会把补偿再拉回起始值，两者每帧对打，
    // 表现就是收尾时上下抖一下。
    if (!isChatViewport) {
      scrollContainer.addEventListener("scroll", resetPosition);
    }
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
