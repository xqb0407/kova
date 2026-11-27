"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** SSR 阶段没有 layout effect，用同构别名避免 React 的 useLayoutEffect 警告 */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/** 两套代码渲染引擎各自的横向滚动视口 */
const SCROLLPORT_SELECTOR = ".pierre-diff-host, .cm-scroller";

/**
 * 评论编辑器/卡片会挂进代码渲染引擎的视口里。diff 的行注解容器宽度等于
 * 「最长代码行宽」（即横向滚动宽度），CodeMirror 的 block widget 也跟
 * `.cm-content` 一起被长行撑宽——两者都能远宽于面板可见区域。若直接用
 * `w-full`，长行不换行时评论框会被拉成整条 x 轴那么宽。
 *
 * 这里量出元素左缘到滚动视口右缘的可见宽度，作为评论框的最大宽度；面板
 * 缩放时靠 ResizeObserver 跟随。宽度变化只写 state、不改元素位置，不会
 * 触发 ResizeObserver 反复回调。
 */
export function useCodeCommentMaxWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [maxWidth, setMaxWidth] = useState<number>();

  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scrollport = el.closest(SCROLLPORT_SELECTOR);
    if (!scrollport) return;

    const measure = () => {
      const elRect = el.getBoundingClientRect();
      const portRect = scrollport.getBoundingClientRect();
      // 横向滚动后左缘可能落在视口外：可用宽度别超过视口自身
      const available = Math.min(
        portRect.right - elRect.left,
        scrollport.clientWidth,
      );
      if (available <= 0) return;
      setMaxWidth(Math.max(240, Math.floor(available) - 8));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scrollport);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, maxWidth };
}
