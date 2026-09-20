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
import { pickRoundAnchors } from "@/lib/message-round-anchors";

const VIEWPORT_SELECTOR = '[data-slot="aui_thread-viewport"]';
const ANCHOR_SELECTOR =
  '[data-slot="aui_user-message-root"], [data-slot="aui_assistant-message-content"]';
const USER_SURFACE_SELECTOR = ".aui-user-message-content";
// 距顶/距底小于该值时，直接把首/尾刻度视为激活项
const ACTIVE_EDGE_THRESHOLD = 56;
const MAX_ITEM_SIZE = 14;
const MIN_ITEM_SIZE = 6;

type CachedPreview = { label: string; description?: string };

export function ThreadPreviewRail() {
  const reduce = useReducedMotion() ?? false;
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const syncFrameRef = useRef<number | undefined>(undefined);
  const activeFrameRef = useRef<number | undefined>(undefined);
  // 元素 → 稳定刻度 id（跨同步保持不变，避免流式输出时预览卡跳动）
  const idMapRef = useRef(new WeakMap<HTMLElement, string>());
  const idCounterRef = useRef(0);
  const targetsRef = useRef(new Map<string, HTMLElement>());
  // 元素 → 预览文本缓存；流式输出时仅重算发生变动的消息，避免整列表重提取
  const previewCacheRef = useRef(new WeakMap<HTMLElement, CachedPreview>());
  const dirtyAnchorsRef = useRef(new Set<HTMLElement>());
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
    const dirty = dirtyAnchorsRef.current;
    dirtyAnchorsRef.current = new Set();

    const anchors = Array.from(
      viewport.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR),
    );
    // 一轮对话一个刻度，选取规则见 pickRoundAnchors
    const kept = pickRoundAnchors(anchors);
    const targets = new Map<string, HTMLElement>();
    const nextItems = kept.map((anchor, keptIndex) => {
      const index = anchors.indexOf(anchor);
      let id = idMapRef.current.get(anchor);
      if (!id) {
        idCounterRef.current += 1;
        id = `thread-anchor-${idCounterRef.current}`;
        idMapRef.current.set(anchor, id);
      }
      targets.set(id, anchor);

      const isUser = anchor.dataset.slot === "aui_user-message-root";
      let preview = previewCacheRef.current.get(anchor);
      if (!preview || dirty.has(anchor)) {
        const surface = isUser
          ? (anchor.querySelector<HTMLElement>(USER_SURFACE_SELECTOR) ?? anchor)
          : anchor;
        const response = isUser
          ? anchors
              .slice(index + 1)
              .find((el) => el.dataset.slot === "aui_assistant-message-content")
          : undefined;
        preview = getMessagePreview(surface, response);
        previewCacheRef.current.set(anchor, preview);
      }

      return {
        id,
        label: preview.label,
        description: preview.description,
        ariaLabel: `Go to conversation round ${keptIndex + 1} of ${kept.length}`,
      };
    });

    // 锚点集合是否变化：流式文本变更（characterData）不动集合，
    // 借此把 updateActiveItem 的全量 getBoundingClientRect 从每帧降到仅在变化时
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
            item.description === nextItems[index]?.description &&
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

  const scheduleActive = useCallback(() => {
    if (activeFrameRef.current) cancelAnimationFrame(activeFrameRef.current);
    activeFrameRef.current = requestAnimationFrame(updateActiveItem);
  }, [updateActiveItem]);

  // 视口监听：消息增删/流式文本变化 → 重建刻度；滚动/尺寸变化 → 更新激活项
  useEffect(() => {
    const viewport = findViewport();
    if (!viewport) return;

    scheduleSync();

    const markDirty = (node: Node) => {
      const element =
        node.nodeType === Node.ELEMENT_NODE
          ? (node as Element)
          : node.parentElement;
      const anchor = element?.closest<HTMLElement>(ANCHOR_SELECTOR);
      if (anchor) dirtyAnchorsRef.current.add(anchor);
    };

    const mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "childList") {
          for (const node of record.addedNodes) markDirty(node);
          for (const node of record.removedNodes) markDirty(node);
        } else {
          markDirty(record.target);
        }
      }
      scheduleSync();
    });
    mutationObserver.observe(viewport, {
      childList: true,
      characterData: true,
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
      if (activeFrameRef.current) cancelAnimationFrame(activeFrameRef.current);
    };
  }, [findViewport, scheduleSync, scheduleActive]);

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
