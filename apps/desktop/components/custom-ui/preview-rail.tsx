"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { EASE_OUT, SPRING_LAYOUT } from "@/lib/motion/ease";
import { useDismiss } from "@/hooks/use-dismiss";
import { useHoverGesture } from "@/hooks/use-hover-gesture";
import { useTapGesture } from "@/hooks/use-tap-gesture";
import { cn } from "@/lib/utils";

export interface PreviewRailItem {
  id: string;
  label: string;
  ariaLabel?: string;
  description?: ReactNode;
  href?: string;
  target?: "_blank" | "_self" | "_parent" | "_top";
  rel?: string;
}

export interface PreviewRailProps {
  items: PreviewRailItem[];
  label?: string;
  orientation?: "vertical" | "horizontal";
  activeId?: string;
  defaultActiveId?: string;
  onActiveChange?: (id: string) => void;
  onItemSelect?: (item: PreviewRailItem) => void;
  renderPreview?: (item: PreviewRailItem) => ReactNode;
  showPreview?: boolean;
  previewSide?: "before" | "after";
  highlightActive?: boolean;
  itemSize?: number;
  children?: ReactNode;
  className?: string;
  railClassName?: string;
  previewClassName?: string;
  /**
   * 滚动宿主（可选）：刻度放进这个盒子内滚动。
   * 预览卡**不在这里**——它经 portal 渲染到 body 并按刻度实时 rect 定位，
   * 避免被滚动盒/外层 overflow 裁掉。传了就按 className/style 自建盒子
   * （调用方给 max-height/overflow），不传只是多一层静态包裹。
   */
  scrollContainerClassName?: string;
  scrollContainerStyle?: CSSProperties;
  /** 滚动内容盒的尺寸（高度=刻度总高+留白）；缺省按 items × itemSize 计算 */
  contentStyle?: CSSProperties;
}

function DefaultPreview({ item }: { item: PreviewRailItem }) {
  return (
    <div
      data-slot="preview-rail-card"
      className="rounded-2xl border border-border bg-card p-4 shadow-sm"
    >
      <p
        data-slot="preview-rail-title"
        className="font-medium text-card-foreground"
      >
        {item.label}
      </p>
      {item.description ? (
        <div
          data-slot="preview-rail-description"
          className="mt-1 text-sm leading-6 text-muted-foreground"
        >
          {item.description}
        </div>
      ) : null}
    </div>
  );
}

/** 预览卡与刻度的间距 */
const PREVIEW_GAP = 12;
const PREVIEW_VIEWPORT_MARGIN = 8;
/** 卡片高度按调用方的 h-20/h-28 取个上界，用于判断向下/向上展开是否放得下 */
const PREVIEW_ESTIMATED_HEIGHT = 120;

/** fixed 定位的预览卡位置（left/right 二选一，视展开方向） */
type PreviewAnchor = {
  top: number;
  left?: number;
  right?: number;
  transform?: string;
  maxWidth: number;
};

export function PreviewRail({
  items,
  label = "Section navigation",
  orientation = "vertical",
  activeId,
  defaultActiveId,
  onActiveChange,
  onItemSelect,
  renderPreview,
  showPreview = true,
  previewSide = "after",
  highlightActive = false,
  itemSize = 24,
  children,
  className,
  railClassName,
  previewClassName,
  scrollContainerClassName,
  scrollContainerStyle,
  contentStyle,
}: PreviewRailProps) {
  const uid = useId();
  const reduce = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const [internalActiveId, setInternalActiveId] = useState(
    defaultActiveId ?? items[0]?.id ?? "",
  );
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // A finger cannot hover, so a tap lights the tick instead. Kept apart from
  // the hovered one: they end in different ways, and a stray mouse move must
  // not clear a tick the keyboard or a tap chose.
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // A click carries no pointerType, so the pointerdown before it is what says
  // whether the activation was a tap. Keyboard activation has none at all.
  const tap = useTapGesture<boolean>();
  const hover = useHoverGesture();

  const clearPinned = useCallback(() => setPinnedId(null), []);

  // The next tap outside the rail stands in for the pointer leaving it. The
  // card is a preview, so that tap passes through to whatever it landed on.
  useDismiss(pinnedId !== null, clearPinned, rootRef);

  const requestedActiveId = activeId ?? internalActiveId;
  const selectedId = items.some((item) => item.id === requestedActiveId)
    ? requestedActiveId
    : (items[0]?.id ?? "");
  const displayedId = hoveredId ?? pinnedId ?? focusedId ?? "";
  const highlightedId = displayedId || (highlightActive ? selectedId : "");
  const displayedIndex = items.findIndex((item) => item.id === highlightedId);
  const rowTemplate = items.length
    ? `repeat(${items.length}, ${itemSize}px)`
    : undefined;
  const isHorizontal = orientation === "horizontal";
  const displayedItem = items.find((item) => item.id === displayedId) ?? null;
  /** 预览卡走 portal + fixed：位置由当前刻度实时 rect 算出，滚动/缩放时跟随 */
  const [previewAnchor, setPreviewAnchor] = useState<PreviewAnchor | null>(
    null,
  );

  useLayoutEffect(() => {
    if (!showPreview || !displayedId) {
      setPreviewAnchor(null);
      return;
    }
    let frame = 0;
    const measure = () => {
      const root = rootRef.current;
      const host = root?.querySelector<HTMLElement>(
        '[data-slot="preview-rail-scroll"]',
      );
      // 只在刻度盒里找：不扫 children（那里可能挂着消费方的页面内容）
      const item = host?.querySelector<HTMLElement>(
        `[data-item-id="${CSS.escape(displayedId)}"]`,
      );
      if (!item) {
        setPreviewAnchor(null);
        return;
      }
      const hostRect = host?.getBoundingClientRect();
      const rect = item.getBoundingClientRect();
      // 盒内滚动把刻度带出可视区：先收卡；滚回来时 scroll 监听会重新量
      if (
        hostRect &&
        (rect.bottom < hostRect.top || rect.top > hostRect.bottom)
      ) {
        setPreviewAnchor(null);
        return;
      }
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // 展开方向以刻度盒（滚动视口）为界：盒子底边在输入框之上，
      // 卡片不会为了避让底边而盖住 composer
      const topBound = hostRect
        ? hostRect.top + PREVIEW_VIEWPORT_MARGIN
        : PREVIEW_VIEWPORT_MARGIN;
      const bottomBound = hostRect
        ? hostRect.bottom - PREVIEW_VIEWPORT_MARGIN
        : vh - PREVIEW_VIEWPORT_MARGIN;
      let next: PreviewAnchor;
      if (isHorizontal) {
        const above =
          rect.top - PREVIEW_GAP - PREVIEW_ESTIMATED_HEIGHT >= topBound;
        next = {
          left: rect.left + rect.width / 2,
          top: above ? rect.top - PREVIEW_GAP : rect.bottom + PREVIEW_GAP,
          transform: above
            ? "translate(-50%, -100%)"
            : "translateX(-50%)",
          maxWidth: Math.max(160, vw - PREVIEW_VIEWPORT_MARGIN * 2),
        };
      } else {
        const centerY = rect.top + rect.height / 2;
        // 空间够就向下展开；下半区放不下再向上翻（卡片高度按上界估）
        const below =
          centerY + PREVIEW_GAP + PREVIEW_ESTIMATED_HEIGHT <= bottomBound;
        const top = below ? centerY + PREVIEW_GAP : centerY - PREVIEW_GAP;
        if (previewSide === "before") {
          next = {
            right: vw - rect.left + PREVIEW_GAP,
            top,
            ...(below ? {} : { transform: "translateY(-100%)" }),
            maxWidth: Math.max(
              160,
              rect.left - PREVIEW_GAP - PREVIEW_VIEWPORT_MARGIN,
            ),
          };
        } else {
          const left = rect.right + PREVIEW_GAP;
          next = {
            left,
            top,
            ...(below ? {} : { transform: "translateY(-100%)" }),
            maxWidth: Math.max(160, vw - left - PREVIEW_VIEWPORT_MARGIN),
          };
        }
      }
      setPreviewAnchor((prev) =>
        prev &&
        prev.top === next.top &&
        prev.left === next.left &&
        prev.right === next.right &&
        prev.transform === next.transform &&
        prev.maxWidth === next.maxWidth
          ? prev
          : next,
      );
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    measure();
    const host = rootRef.current?.querySelector<HTMLElement>(
      '[data-slot="preview-rail-scroll"]',
    );
    host?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      host?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [displayedId, isHorizontal, itemSize, items, previewSide, showPreview]);

  const selectItem = (id: string) => {
    if (activeId === undefined) setInternalActiveId(id);
    onActiveChange?.(id);
  };

  return (
    <motion.div
      layoutRoot
      ref={rootRef}
      onBlur={(event) => {
        // Both tick sources leave with the focus: a tap does not always land
        // focus, but when it does, tabbing away must not strand the card.
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocusedId(null);
          setPinnedId(null);
        }
      }}
      className={cn(
        "isolate relative flex w-full overflow-visible",
        isHorizontal
          ? "min-h-64 flex-col items-center justify-center"
          : "min-h-80",
        className,
      )}
    >
      {/* 滚动宿主：刻度与预览卡两套平行网格必须同滚，否则卡片与刻度错位。
          调用方给 max-height/overflow（自行隐藏滚动条）；不传时只是静态包裹。 */}
      <div
        data-slot="preview-rail-scroll"
        className={cn("relative flex min-h-0 w-full", scrollContainerClassName)}
        style={scrollContainerStyle}
      >
        <div
          className="relative w-full min-h-full"
          style={
            contentStyle ??
            (items.length ? { height: items.length * itemSize } : undefined)
          }
        >
          <nav
            aria-label={label}
            onPointerLeave={(event) => {
              // A touch pointer leaves on lift, which would clear the tick the tap
              // just chose — that one is cleared by the outside tap instead.
              if (hover.leave(event)) setHoveredId(null);
            }}
            style={
              isHorizontal
                ? { gridTemplateColumns: rowTemplate }
                : { gridTemplateRows: rowTemplate }
            }
            className={cn(
              "relative z-10 grid shrink-0",
              isHorizontal
                ? "h-12 w-fit max-w-full self-center justify-center"
                : "w-12 content-center",
              railClassName,
            )}
          >
            {items.map((item, index) => {
              const selected = item.id === selectedId;
              const highlighted = item.id === highlightedId;
              const distance =
                displayedIndex < 0 ? Number.POSITIVE_INFINITY : Math.abs(index - displayedIndex);
              // 圆点刻度：远近只改大小与透明度（横向短线时代是改长度），
              // 尺寸下限比旧条高一些，否则 0.25 缩到 1px 就看不见了
              const scale = highlighted
                ? 1
                : distance === 1
                  ? 0.75
                  : distance === 2
                    ? 0.6
                    : 0.5;
              const opacity = highlighted
                ? 1
                : distance === 1
                  ? 0.7
                  : distance === 2
                    ? 0.5
                    : 0.35;

              const itemContent = (
                <motion.span
                  data-slot="preview-rail-tick"
                  aria-hidden="true"
                  animate={{ scale, opacity }}
                  transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
                  className={cn(
                    "block h-2 w-2 rounded-full bg-current",
                    highlighted ? "text-foreground" : undefined,
                  )}
                />
              );

              const sharedClassName = cn(
                "relative flex text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                isHorizontal
                  ? "h-12 w-6 items-center justify-center"
                  : "h-6 w-12 items-center",
              );
              const sharedStyle = isHorizontal
                ? { width: itemSize }
                : { height: itemSize };
              const handlePointerEnter = (event: PointerEvent<HTMLElement>) => {
                if (hover.enter(event)) setHoveredId(item.id);
              };
              const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
                tap.start(event, pinnedId === item.id);
                setFocusedId(null);
              };
              // A gesture the platform takes away sends no click, and a key press
              // starts an activation that never had a pointer behind it: either
              // one leaves a record the next click would read as a tap of its own.
              const dropGesture = () => tap.drop();
              const handleFocus = (currentTarget: HTMLElement) => {
                if (currentTarget.matches(":focus-visible")) {
                  setFocusedId(item.id);
                }
              };
              const handleSelect = (event: MouseEvent<HTMLElement>) => {
                const gesture = tap.take();
                const tapped =
                  gesture !== null && gesture.pointerType !== "mouse";

                if (tapped) {
                  // A link would otherwise show its preview and leave the page in
                  // the same tap, so the card is never read: the first tap lights
                  // the tick, the second follows the link.
                  if (item.href && !gesture.state) {
                    event.preventDefault();
                    setPinnedId(item.id);
                    return;
                  }
                  setPinnedId(item.id);
                }

                selectItem(item.id);
                onItemSelect?.(item);
              };

              return item.href ? (
                <a
                  key={item.id}
                  data-slot="preview-rail-item"
                  data-item-id={item.id}
                  href={item.href}
                  target={item.target}
                  rel={
                    item.rel ??
                    (item.target === "_blank" ? "noreferrer noopener" : undefined)
                  }
                  aria-label={item.ariaLabel ?? item.label}
                  aria-current={selected ? "page" : undefined}
                  onPointerEnter={handlePointerEnter}
                  onPointerDown={handlePointerDown}
                  onPointerCancel={dropGesture}
                  onKeyDown={dropGesture}
                  onFocus={(event) => handleFocus(event.currentTarget)}
                  onClick={handleSelect}
                  style={sharedStyle}
                  className={sharedClassName}
                >
                  {itemContent}
                </a>
              ) : (
                <button
                  key={item.id}
                  data-slot="preview-rail-item"
                  data-item-id={item.id}
                  type="button"
                  aria-label={item.ariaLabel ?? item.label}
                  aria-current={selected ? "location" : undefined}
                  onPointerEnter={handlePointerEnter}
                  onPointerDown={handlePointerDown}
                  onPointerCancel={dropGesture}
                  onKeyDown={dropGesture}
                  onFocus={(event) => handleFocus(event.currentTarget)}
                  onClick={handleSelect}
                  style={sharedStyle}
                  className={sharedClassName}
                >
                  {itemContent}
                </button>
              );
            })}
          </nav>

        </div>
      </div>

      {/* 预览卡挂到 body：卡片比刻度行高得多，留在滚动盒里会被 overflow 裁掉
          （长会话滚动后，靠近盒上/下边缘的轮次卡片只露半截）。portal 后按刻度
          实时 rect 做 fixed 定位，滚动/缩放跟随，不再受任何祖先裁剪。
          AnimatePresence 必须常驻在条件渲染之外：挂在卡片条件内部时退出动画
          永远不会跑，卡片会一帧消失并把阴影留在屏幕上。 */}
      {showPreview && typeof document !== "undefined"
        ? createPortal(
            <div aria-hidden="true" className="pointer-events-none fixed z-50">
              <AnimatePresence initial={false}>
                {displayedItem && previewAnchor ? (
                  <div
                    key={displayedItem.id}
                    style={{
                      position: "fixed",
                      top: previewAnchor.top,
                      left: previewAnchor.left,
                      right: previewAnchor.right,
                      transform: previewAnchor.transform,
                      maxWidth: previewAnchor.maxWidth,
                    }}
                    className={cn(
                      "pointer-events-none",
                      !previewClassName && (isHorizontal ? "w-72" : "w-80"),
                      previewClassName,
                    )}
                  >
                    <motion.div
                      layoutId={`preview-rail-card-${uid}`}
                      layoutCrossfade={false}
                      transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
                    >
                      {/* Opacity/y only: an animated filter keeps the card on
                          its own compositor layer, and dropping that layer
                          mid-stream is what leaves the shadow trails behind.
                          initial={false} enters instantly — a fade-in over
                          nothing reads as lag; only the exit matters. */}
                      <motion.div
                        initial={false}
                        animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
                        exit={
                          reduce
                            ? { opacity: 0 }
                            : {
                                opacity: 0,
                                y: -2,
                                transition: {
                                  duration: 0.12,
                                  ease: EASE_OUT,
                                },
                              }
                        }
                        transition={{
                          duration: reduce ? 0 : 0.18,
                          ease: EASE_OUT,
                        }}
                      >
                        {renderPreview ? (
                          renderPreview(displayedItem)
                        ) : (
                          <DefaultPreview item={displayedItem} />
                        )}
                      </motion.div>
                    </motion.div>
                  </div>
                ) : null}
              </AnimatePresence>
            </div>,
            document.body,
          )
        : null}

      {children ? (
        <div className="min-h-0 min-w-0 flex-1">{children}</div>
      ) : null}
    </motion.div>
  );
}
