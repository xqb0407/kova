"use client";

// 会话锚点定位：复用 custom-ui/preview-rail，在 ThreadPrimitive.Root 内以
// 覆盖层形式渲染左侧刻度条。悬停显示消息预览卡，点击滚动定位到对应轮次。
// 滚动容器仍是 assistant-ui 的 aui_thread-viewport，不接管其滚动行为。

import { useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  PreviewRail,
  type PreviewRailItem,
} from "@/components/custom-ui/preview-rail";
import { getMessagePreview } from "@/components/custom-ui/message-scroller";
import { pickRoundAnchors } from "@/lib/panels/message-round-anchors";

const VIEWPORT_SELECTOR = '[data-slot="aui_thread-viewport"]';
const ANCHOR_SELECTOR =
  '[data-slot="aui_user-message-root"], [data-slot="aui_assistant-message-content"]';
const USER_SURFACE_SELECTOR = ".aui-user-message-content";
// 距顶/距底小于该值时，直接把首/尾刻度视为激活项
const ACTIVE_EDGE_THRESHOLD = 56;
const MAX_ITEM_SIZE = 14;
const MIN_ITEM_SIZE = 6;
/** 消息增删的合并窗口：流式期间 markdown 新块落 DOM 会成串触发 childList，
 *  逐个重建刻度是纯浪费；预览文本已改为悬停现取，延迟重建不影响预览新鲜度 */
const SYNC_DEBOUNCE_MS = 180;

type Preview = { label: string; description?: string };

/**
 * 悬停时从实时 DOM 现取预览文本（不再随流式逐 token 预计算 + 缓存）：
 * 用户气泡 + 该轮首条可见的回复（折叠轮里中间步骤不挂载，取到的是最终回答）。
 */
function extractPreview(
  anchor: HTMLElement,
  anchors: readonly HTMLElement[],
): Preview {
  const isUser = anchor.dataset.slot === "aui_user-message-root";
  const surface = isUser
    ? (anchor.querySelector<HTMLElement>(USER_SURFACE_SELECTOR) ?? anchor)
    : anchor;
  const response = isUser
    ? anchors
        .slice(anchors.indexOf(anchor) + 1)
        .find((el) => el.dataset.slot === "aui_assistant-message-content")
    : undefined;
  return getMessagePreview(surface, response);
}

export function ThreadPreviewRail() {
  const reduce = useReducedMotion() ?? false;
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const syncFrameRef = useRef<number | undefined>(undefined);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeFrameRef = useRef<number | undefined>(undefined);
  // 元素 → 稳定刻度 id（跨同步保持不变，避免流式输出时预览卡跳动）
  const idMapRef = useRef(new WeakMap<HTMLElement, string>());
  const idCounterRef = useRef(0);
  const targetsRef = useRef(new Map<string, HTMLElement>());
  // 最近一次同步的锚点数组（悬停提取「该轮回复」时按文档序找下一条）
  const anchorsRef = useRef<HTMLElement[]>([]);
  const [items, setItems] = useState<PreviewRailItem[]>([]);
  const [activeId, setActiveId] = useState("");
  const [overflowing, setOverflowing] = useState(false);
  const [railHeight, setRailHeight] = useState(0);

  const findViewport = useCallback(() => {
    const viewport =
      rootRef.current?.parentElement?.querySelector<HTMLElement>(
        VIEWPORT_SELECTOR,
      ) ?? null;
    viewportRef.current = viewport;
    return viewport;
  }, []);

  const updateActiveItem = useCallback(() => {
    const viewport = viewportRef.current;
    const targets = [...targetsRef.current.entries()];
    if (!viewport || targets.length === 0) return;

    if (viewport.scrollTop <= ACTIVE_EDGE_THRESHOLD) {
      const firstId = targets[0][0];
      setActiveId((current) => (current === firstId ? current : firstId));
      return;
    }
    const distanceFromEnd =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distanceFromEnd <= ACTIVE_EDGE_THRESHOLD) {
      const lastId = targets.at(-1)![0];
      setActiveId((current) => (current === lastId ? current : lastId));
      return;
    }

    const viewportRect = viewport.getBoundingClientRect();
    const viewportCenter = viewportRect.top + viewportRect.height / 2;
    let nearestId = targets[0][0];
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const [id, element] of targets) {
      const rect = element.getBoundingClientRect();
      const distance = Math.abs(rect.top + rect.height / 2 - viewportCenter);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestId = id;
      }
    }
    setActiveId((current) => (current === nearestId ? current : nearestId));
  }, []);

  /** 重建刻度列表；返回锚点集合是否发生变化（新增/移除/换位） */
  const syncItems = useCallback((): boolean => {
    const viewport = viewportRef.current;
    if (!viewport) return false;

    const anchors = Array.from(
      viewport.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR),
    );
    // 一轮对话一个刻度，选取规则见 pickRoundAnchors
    const kept = pickRoundAnchors(anchors);
    anchorsRef.current = anchors;
    const targets = new Map<string, HTMLElement>();
    const nextItems = kept.map((anchor, keptIndex) => {
      let id = idMapRef.current.get(anchor);
      if (!id) {
        idCounterRef.current += 1;
        id = `thread-anchor-${idCounterRef.current}`;
        idMapRef.current.set(anchor, id);
      }
      targets.set(id, anchor);

      return {
        id,
        label: `第 ${keptIndex + 1} 轮`,
        ariaLabel: `Go to conversation round ${keptIndex + 1} of ${kept.length}`,
      };
    });

    // 锚点集合是否变化：流式文本变更不换元素，借此把 updateActiveItem 的
    // 全量 getBoundingClientRect 从每帧降到仅在变化时
    const prev = targetsRef.current;
    let changed = prev.size !== targets.size;
    if (!changed) {
      for (const [id, element] of targets) {
        if (prev.get(id) !== element) {
          changed = true;
          break;
        }
      }
    }
    targetsRef.current = targets;
    setItems((current) => {
      const unchanged =
        current.length === nextItems.length &&
        current.every(
          (item, index) =>
            item.id === nextItems[index]?.id &&
            item.label === nextItems[index]?.label &&
            item.ariaLabel === nextItems[index]?.ariaLabel,
        );
      return unchanged ? current : nextItems;
    });
    setOverflowing(viewport.scrollHeight > viewport.clientHeight + 1);
    return changed;
  }, []);

  const scheduleSync = useCallback(() => {
    if (syncFrameRef.current) cancelAnimationFrame(syncFrameRef.current);
    syncFrameRef.current = requestAnimationFrame(() => {
      // 锚点集合没变（纯流式文本）⇒ 跳过全量几何测量
      if (syncItems()) updateActiveItem();
    });
  }, [syncItems, updateActiveItem]);

  /** 消息增删抖动的合并入口：流式期间 markdown 落块成串触发，攒一拍再重建 */
  const scheduleSyncDebounced = useCallback(() => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      scheduleSync();
    }, SYNC_DEBOUNCE_MS);
  }, [scheduleSync]);

  const scheduleActive = useCallback(() => {
    if (activeFrameRef.current) cancelAnimationFrame(activeFrameRef.current);
    activeFrameRef.current = requestAnimationFrame(updateActiveItem);
  }, [updateActiveItem]);

  // 视口监听：消息增删 → 重建刻度；滚动/尺寸变化 → 更新激活项。
  // 只监听 childList（消息元素增删），不监听 characterData：流式文本逐 token
  // 变更曾让每次变更都跑一遍全 viewport 的 querySelectorAll + pickRoundAnchors，
  // DOM 越大越卡；现在预览文本悬停现取，流式文本变化不再需要任何重算。
  useEffect(() => {
    const viewport = findViewport();
    if (!viewport) return;

    scheduleSync();

    const mutationObserver = new MutationObserver(() => {
      scheduleSyncDebounced();
    });
    mutationObserver.observe(viewport, {
      childList: true,
      subtree: true,
    });

    // 尺寸变化不改锚点集合，但几何全变 ⇒ 需要显式重测激活项
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            scheduleSync();
            scheduleActive();
          });
    resizeObserver?.observe(viewport);

    const handleScroll = () => scheduleActive();
    viewport.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      viewport.removeEventListener("scroll", handleScroll);
      if (syncFrameRef.current) cancelAnimationFrame(syncFrameRef.current);
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      if (activeFrameRef.current) cancelAnimationFrame(activeFrameRef.current);
    };
  }, [findViewport, scheduleSync, scheduleSyncDebounced, scheduleActive]);

  // 量测覆盖层高度，刻度过多时自动压缩间距（min 6px），避免被裁切
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const height = entries.at(-1)?.contentRect.height ?? 0;
      setRailHeight((current) => (current === height ? current : height));
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const scrollToItem = useCallback(
    (item: PreviewRailItem) => {
      const viewport = viewportRef.current;
      const target = targetsRef.current.get(item.id);
      if (!viewport || !target) return;

      setActiveId(item.id);
      const behavior: ScrollBehavior = reduce ? "instant" : "smooth";

      // 尾项直达底部：让 sticky 输入框上方的最后一条消息完整可见
      if (items.at(-1)?.id === item.id) {
        viewport.scrollTo({ top: viewport.scrollHeight, behavior });
        return;
      }
      const viewportRect = viewport.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const top =
        viewport.scrollTop +
        targetRect.top -
        viewportRect.top -
        (viewport.clientHeight - targetRect.height) / 2;
      viewport.scrollTo({ top: Math.max(0, top), behavior });
    },
    [items, reduce],
  );

  // 单轮对话只有一个刻度也显示：内容溢出时仍可悬停预览/点击跳底
  const showRail = overflowing && items.length > 0;
  const itemSize = showRail
    ? Math.max(
        MIN_ITEM_SIZE,
        Math.min(
          MAX_ITEM_SIZE,
          Math.floor((railHeight - 24) / Math.max(items.length, 1)),
        ),
      )
    : MAX_ITEM_SIZE;

  // 预览卡与 DefaultPreview 同结构（data-slot 对齐 previewClassName 的样式钩子），
  // 文本取自悬停当下的实时 DOM
  const renderPreview = (item: PreviewRailItem) => {
    const anchor = targetsRef.current.get(item.id);
    const preview: Preview = anchor
      ? extractPreview(anchor, anchorsRef.current)
      : { label: item.label };
    return (
      <div
        data-slot="preview-rail-card"
        className="rounded-2xl border border-border bg-card p-4 shadow-sm"
      >
        <p
          data-slot="preview-rail-title"
          className="font-medium text-card-foreground"
        >
          {preview.label}
        </p>
        {preview.description ? (
          <div
            data-slot="preview-rail-description"
            className="mt-1 text-sm leading-6 text-muted-foreground"
          >
            {preview.description}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      data-slot="thread-preview-rail"
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
    >
      {showRail ? (
        <PreviewRail
          items={items}
          label="Message navigation"
          activeId={activeId}
          onItemSelect={scrollToItem}
          renderPreview={renderPreview}
          previewSide="after"
          highlightActive
          itemSize={itemSize}
          className="h-full min-h-0"
          previewContainerClassName="inset-y-0 left-9 right-3"
          previewClassName="ml-2 w-64 max-w-full [&_[data-slot=preview-rail-card]]:h-20 [&_[data-slot=preview-rail-card]]:overflow-hidden [&_[data-slot=preview-rail-card]]:p-3 [&_[data-slot=preview-rail-title]]:line-clamp-1 [&_[data-slot=preview-rail-title]]:text-xs [&_[data-slot=preview-rail-title]]:leading-4 [&_[data-slot=preview-rail-description]]:line-clamp-2 [&_[data-slot=preview-rail-description]]:text-xs [&_[data-slot=preview-rail-description]]:leading-4"
          railClassName="absolute inset-y-3 left-2 w-5 content-center py-1 [&_[data-slot=preview-rail-item]]:pointer-events-auto [&_[data-slot=preview-rail-item]]:w-5 [&_[data-slot=preview-rail-item]]:justify-start [&_[data-slot=preview-rail-tick]]:w-2.5 [&_[data-slot=preview-rail-tick]]:origin-left"
        />
      ) : null}
    </div>
  );
}
