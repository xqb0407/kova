"use client";

// 会话锚点定位：复用 custom-ui/preview-rail，在 ThreadPrimitive.Root 内以
// 覆盖层形式渲染左侧刻度条。悬停显示消息预览卡，点击滚动定位到对应轮次。
// 滚动容器仍是 assistant-ui 的 aui_thread-viewport，不接管其滚动行为。

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  PreviewRail,
  type PreviewRailItem,
} from "@/components/custom-ui/preview-rail";
import { getMessagePreview } from "@/components/custom-ui/message-scroller";
import { EASE_OUT } from "@/lib/motion/ease";
import { pickRoundAnchors } from "@/lib/panels/message-round-anchors";
import { noteRender } from "@/components/debug/perf-store";

/** 计时探针：这段几何测量是候选卡顿源（对每个锚点 getBoundingClientRect，
 *  content-visibility 下会强制逐个布局）。只在开发构建计时，生产零开销。 */
const span = <T,>(label: string, fn: () => T): T => {
  if (process.env.NODE_ENV === "production") return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    noteRender(label, performance.now() - t0);
  }
};

const VIEWPORT_SELECTOR = '[data-slot="aui_thread-viewport"]';
const ANCHOR_SELECTOR =
  '[data-slot="aui_user-message-root"], [data-slot="aui_assistant-message-content"]';
const USER_SURFACE_SELECTOR = ".aui-user-message-content";
// 距顶/距底小于该值时，直接把首/尾刻度视为激活项
const ACTIVE_EDGE_THRESHOLD = 56;
const MAX_ITEM_SIZE = 18;
const MIN_ITEM_SIZE = 8;
/** 消息列窄于此宽度（px）就不画刻度条：预览卡从左缘伸到 ~300px，列宽不够宽时
 *  卡片右侧剩下的正文比被它盖住的还少，悬停预览反而挡住正在读的那条消息。
 *  只在面板拖到很宽、把聊天列挤到接近其下限（CHAT_MIN_WIDTH = 380）时才命中 */
const MIN_MESSAGE_WIDTH = 900;
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
  const [messageWidth, setMessageWidth] = useState(0);
  // 进出场动画的宿主：淡出期间据此断掉刻度命中
  const railMotionRef = useRef<HTMLDivElement>(null);

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
      if (span("刻度条-重建", syncItems)) span("刻度条-测激活", updateActiveItem);
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
    activeFrameRef.current = requestAnimationFrame(() =>
      span("刻度条-测激活", updateActiveItem),
    );
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

  // 量测覆盖层高度，刻度过多时自动压缩间距（min 6px），避免被裁切；
  // 同一个观察顺带量宽度：面板拖宽把聊天列挤窄时用它整条隐藏刻度
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries.at(-1)?.contentRect;
      if (!rect) return;
      setRailHeight((current) => (current === rect.height ? current : rect.height));
      setMessageWidth((current) =>
        current === rect.width ? current : rect.width,
      );
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

  // 单轮对话只有一个刻度也显示：内容溢出时仍可悬停预览/点击跳底。
  // 宽度未量到（首帧 ResizeObserver 还没回调）时先不画，避免宽列也闪一下
  const showRail = overflowing && items.length > 0 && messageWidth >= MIN_MESSAGE_WIDTH;
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
      {/* AnimatePresence 必须待在条件渲染之外：挂在条件内部的这次
          showRail 翻 false 时它和子树一起卸载，exit 永不执行，刻度条
          是一帧消失的（同一坑见 preview-rail.tsx 预览卡处的注释）。
          收窄触发的是连续拖拽，动画要短：淡出 0.12s、位移 8px，
          退出期间不可点（刻度条此刻正压着正文）。 */}
      <AnimatePresence initial={false}>
        {showRail ? (
          <motion.div
            key="thread-preview-rail-inner"
            initial={reduce ? { opacity: 1 } : { opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, x: -8 }}
            transition={
              reduce
                ? { duration: 0 }
                : { duration: 0.18, ease: EASE_OUT }
            }
            ref={railMotionRef}
            // 退出动画期间刻度条正压在正文上：淡出未完时断掉命中，
            // 免得半透明的一瞬还能点。根节点本身是 pointer-events-none，
            // 真正可点的是刻度 item（railClassName 里开的 auto）
            onUpdate={(latest) => {
              const el = railMotionRef.current;
              if (!el) return;
              const clickable = latest.opacity === 1;
              if (el.dataset.clickable !== String(clickable)) {
                el.dataset.clickable = String(clickable);
                el.style.pointerEvents = clickable ? "" : "none";
              }
            }}
            className="h-full min-h-0"
          >
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
              previewClassName="ml-2 w-80 max-w-full [&_[data-slot=preview-rail-card]]:h-28 [&_[data-slot=preview-rail-card]]:overflow-hidden [&_[data-slot=preview-rail-card]]:p-4 [&_[data-slot=preview-rail-title]]:line-clamp-1 [&_[data-slot=preview-rail-title]]:text-sm [&_[data-slot=preview-rail-title]]:leading-5 [&_[data-slot=preview-rail-description]]:line-clamp-3 [&_[data-slot=preview-rail-description]]:text-sm [&_[data-slot=preview-rail-description]]:leading-5"
              railClassName="absolute inset-y-3 left-2 w-6 content-center py-1 [&_[data-slot=preview-rail-item]]:pointer-events-auto [&_[data-slot=preview-rail-item]]:w-6 [&_[data-slot=preview-rail-item]]:justify-start [&_[data-slot=preview-rail-tick]]:w-3 [&_[data-slot=preview-rail-tick]]:origin-left"
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
