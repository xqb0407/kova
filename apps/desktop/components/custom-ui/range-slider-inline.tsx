"use client";
// beui.dev/components/motion/range-slider

import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";
import {
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { SPRING_GLIDE } from "@/lib/ease";
import { type SliderOptions, snapSliderValue, useSlider } from "@/hooks/use-slider";
import { capturePointer, releasePointer, TOUCH_GESTURE_CLASS } from "@/lib/motion/touch";
import { cn } from "@/lib/utils";

const STOP_COUNT = 10;
// 「流动彗星」气泡种子：top/size/时长/负延迟错峰（对齐 ZCode 的 EFFORT_BUBBLES）
const COMET_BUBBLES = [
  { top: 3, size: 2, duration: 2.6, delay: -0.4 },
  { top: 10, size: 3, duration: 3.2, delay: -2.1 },
  { top: 6, size: 4, duration: 2.8, delay: -1.1 },
  { top: 14, size: 2, duration: 3.6, delay: -0.8 },
  { top: 2, size: 3, duration: 3.0, delay: -2.5 },
  { top: 12, size: 2, duration: 3.4, delay: -1.7 },
  { top: 8, size: 2, duration: 3.1, delay: -0.9 },
  { top: 16, size: 3, duration: 2.9, delay: -2.3 },
  { top: 5, size: 2, duration: 3.5, delay: -0.2 },
  { top: 13, size: 3, duration: 3.3, delay: -1.2 },
];
const HANDLE_START = 8;
const HANDLE_END_INSET = 12;
const TEXT_INSET = 20;
// Matches RangeSlider's bouncy grab and release feedback.
const SPRING_BOUNCY = { type: "spring", stiffness: 500, damping: 14, mass: 0.7 } as const;

type Stop = { value: number; x: number };

function mapBetweenStops(
  stops: Stop[],
  point: number,
  from: keyof Stop,
  to: keyof Stop,
) {
  const upperIndex = stops.findIndex((stop) => stop[from] >= point);
  const upper = stops[upperIndex < 0 ? stops.length - 1 : upperIndex];
  const lower = stops[Math.max(0, upperIndex - 1)];
  if (lower[from] === upper[from]) return upper[to];
  return lower[to] +
    ((point - lower[from]) / (upper[from] - lower[from])) * (upper[to] - lower[to]);
}

function nearestStop(stops: Stop[], x: number) {
  return stops.reduce((nearest, stop) =>
    Math.abs(stop.x - x) < Math.abs(nearest.x - x) ? stop : nearest,
  );
}

export interface InlineSliderProps extends SliderOptions {
  /** Rounds snap-stop values. While dragging, the readout keeps this step's decimal precision. */
  step?: number;
  /** Compact label inside the left edge of the track. Omit for a bare track. */
  label?: string;
  /** Formats the inline value without changing its precision. */
  format?: (value: number) => string;
  /** Show markers for the ten evenly spaced snap stops, except where they overlap inline text. */
  showTicks?: boolean;
  /** 纯轨道模式：不渲染内嵌的 label/读数（标题与当前值由调用方放在滑杆外）。
   *  刻度、吸附停靠点、弹簧拖动不变；aria-label 需由调用方显式给。 */
  bare?: boolean;
  /** 「流动彗星」：填充层叠加蓝→绿渐变 + 横向漂移的气泡（最高档的仪式感，
   *  对齐 ZCode 最高档的流光轨道）；渐变常驻、用透明度过渡，升降档不瞬切。 */
  comet?: boolean;
  className?: string;
}

/** An always-visible inline slider with an inset fill and a thumb that parts
 * around its labels, keeping their text readable as the handle passes them. */
export function InlineSlider({
  label,
  format = String,
  showTicks = true,
  bare = false,
  comet = false,
  className,
  ...options
}: InlineSliderProps) {
  const reduce = useReducedMotion();
  const step = options.step && options.step > 0 ? options.step : 1;
  const precision = step.toFixed(6).replace(/0+$/, "").split(".")[1]?.length ?? 0;
  const { current, min, max, commit, trackProps, sliderProps } = useSlider({
    ...options,
    step: 10 ** -precision,
    "aria-label": options["aria-label"] ?? label ?? "Slider",
    formatValueText: options.formatValueText ?? format,
  });
  const labelRef = useRef<HTMLSpanElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const [geometry, setGeometry] = useState({
    width: 292,
    labelWidth: 22,
    readoutWidth: 24,
  });
  const [dragging, setDragging] = useState(false);
  const dragFrame = useRef<number | null>(null);
  const pendingDragValue = useRef<number | null>(null);
  const gesture = useRef<{
    id: number;
    left: number;
    offset: number;
    x: number;
  } | null>(null);

  useLayoutEffect(() => {
    const track = trackProps.ref.current;
    if (!track) return;
    const labelElement = labelRef.current;
    const readout = readoutRef.current;
    const measure = () => {
      const width = track.getBoundingClientRect().width;
      if (!width) return;
      const next = {
        width,
        labelWidth: labelElement ? labelElement.getBoundingClientRect().width : 0,
        readoutWidth: readout ? readout.getBoundingClientRect().width : 0,
      };
      setGeometry((previous) =>
        previous.width === next.width && previous.labelWidth === next.labelWidth &&
        previous.readoutWidth === next.readoutWidth ? previous : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    if (labelElement) observer.observe(labelElement);
    if (readout) observer.observe(readout);
    return () => observer.disconnect();
  }, [trackProps.ref, bare]);

  // Each stop owns both a value and a physical position. As in RangeSlider,
  // the stops span the entire track at even intervals; text only affects
  // whether a marker is painted, never whether its stop remains interactive.
  // bare 模式没有右侧读数，端点与左端对称内缩，避免拇指/填充贴边不对称。
  const handleEndInset = bare ? HANDLE_START : HANDLE_END_INSET;
  const endX = Math.max(HANDLE_START, geometry.width - handleEndInset);
  const stops = useMemo(() => {
    const values = [...new Set(Array.from({ length: STOP_COUNT }, (_, index) =>
      snapSliderValue(min + (index / (STOP_COUNT - 1)) * (max - min), min, max, step),
    ))];
    return values.map((value, index) => ({
      value,
      x: values.length === 1
        ? HANDLE_START
        : HANDLE_START + (index / (values.length - 1)) * (endX - HANDLE_START),
    }));
  }, [min, max, step, endX]);
  const restingX = mapBetweenStops(stops, current, "value", "x");
  // One motion value owns the thumb for the entire gesture. Pointer movement
  // writes pixels directly; only release/click/keyboard changes use a spring.
  // Never derive dragging pixels from a rounded value or swap to a lagging spring.
  const handleX = useMotionValue(restingX);
  const restingTarget = useRef(restingX);
  const settleTo = useCallback((x: number) => {
    restingTarget.current = x;
    handleX.jump(handleX.get());
    if (reduce) handleX.jump(x);
    else animate(handleX, x, { type: "spring", ...SPRING_GLIDE });
  }, [handleX, reduce]);
  useLayoutEffect(() => {
    if (gesture.current || restingTarget.current === restingX) return;
    settleTo(restingX);
  }, [restingX, settleTo]);
  useEffect(() => () => {
    handleX.stop();
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
  }, [handleX]);
  const fillRight = useTransform(handleX, (x) =>
    Math.min(geometry.width - 2, x + (bare ? 2 : 8)),
  );
  // Slide a fixed-size fill inside the inset clipping window. The labels and
  // dots stay above it, and only transforms animate.
  const fillX = useTransform(fillRight, (right) => right - geometry.width + 2);
  // Part progressively over six pixels at each text edge instead of
  // toggling the stem on/off in a single pointer frame. The thumb uses the
  // same two-dot treatment across both the label and numeric readout.
  const split = useTransform(handleX, (x) => {
    const overlap = (start: number, end: number) => Math.max(0, Math.min(
      1,
      (x + 4 - start) / 6,
      (end - x) / 6,
    ));
    return Math.max(
      overlap(TEXT_INSET, TEXT_INSET + geometry.labelWidth),
      overlap(
        geometry.width - TEXT_INSET - geometry.readoutWidth,
        geometry.width - TEXT_INSET,
      ),
    );
  });
  const stemOpacity = useTransform(split, (amount) => 1 - amount);
  const capTop = useTransform(split, (amount) => -amount);
  const capBottom = useTransform(split, (amount) => amount);
  const labelBounds = { start: TEXT_INSET, end: TEXT_INSET + geometry.labelWidth };
  const readoutBounds = {
    start: geometry.width - TEXT_INSET - geometry.readoutWidth,
    end: geometry.width - TEXT_INSET,
  };
  const overlapsText = (x: number, bounds: { start: number; end: number }) =>
    x + 2 >= bounds.start && x - 2 <= bounds.end;
  const ticks = showTicks
    ? stops
      .map((stop) => stop.x)
      // bare 模式没有内嵌文字：零宽边界仍会误判遮挡，直接跳过文本过滤
      .filter(
        (x) =>
          bare || (!overlapsText(x, labelBounds) && !overlapsText(x, readoutBounds)),
      )
    : [];

  const queueDragCommit = (value: number) => {
    pendingDragValue.current = value;
    if (dragFrame.current !== null) return;
    dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = null;
      if (pendingDragValue.current !== null) commit(pendingDragValue.current);
      pendingDragValue.current = null;
    });
  };

  const cancelDragCommit = () => {
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null;
    pendingDragValue.current = null;
  };

  const endGesture = (event: PointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (!active || active.id !== event.pointerId) return;
    // Clear before releasing capture: its lost-capture event must not commit twice.
    gesture.current = null;
    cancelDragCommit();
    setDragging(false);
    if (!options.disabled && geometry.width > 0) {
      const x = event.type === "pointerup"
        ? event.clientX - active.left - active.offset
        : active.x;
      const stop = nearestStop(stops, x);
      commit(stop.value);
      settleTo(options.value === undefined ? stop.x : restingX);
    } else {
      settleTo(restingX);
    }
    releasePointer(event.currentTarget, event.pointerId);
  };

  return (
    <div
      {...trackProps}
      onPointerDown={(event) => {
        if (options.disabled || event.button !== 0 || gesture.current) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width) return;
        event.preventDefault();
        const pointerX = event.clientX - rect.left;
        const thumbX = handleX.get();
        // Grabbing the thumb preserves the exact grab point. A track click
        // waits for release, so it glides to a dot without an intermediate jump.
        const offset = Math.abs(pointerX - thumbX - 2) <= 12 ? pointerX - thumbX : 2;
        gesture.current = { id: event.pointerId, left: rect.left, offset, x: thumbX };
        setDragging(true);
        handleX.stop();
        cancelDragCommit();
        capturePointer(event.currentTarget, event.pointerId);
        event.currentTarget.querySelector<HTMLButtonElement>("[role=slider]")?.focus({ preventScroll: true });
      }}
      onPointerMove={(event) => {
        const active = gesture.current;
        if (!active || active.id !== event.pointerId || options.disabled) return;
        const x = Math.min(
          endX,
          Math.max(HANDLE_START, event.clientX - active.left - active.offset),
        );
        active.x = x;
        handleX.set(x);
        // Use the same piecewise map as the resting stops, so value and
        // position agree throughout the drag.
        queueDragCommit(mapBetweenStops(stops, x, "x", "value"));
      }}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onLostPointerCapture={endGesture}
      className={cn(
        "relative h-10 w-full touch-none select-none overflow-hidden rounded-lg bg-muted",
        TOUCH_GESTURE_CLASS,
        options.disabled
          ? "pointer-events-none opacity-50"
          : "cursor-grab active:cursor-grabbing",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-[2px] inset-y-0 overflow-hidden rounded-lg"
      >
        <motion.div
          className="absolute inset-0 overflow-hidden rounded-lg bg-foreground/15"
          style={{ x: fillX }}
        >
          {/* 最高档的流动渐变层：常驻元素、透明度过渡（降档不瞬切） */}
          <span
            className="absolute inset-0 rounded-[inherit] transition-opacity duration-200"
            style={{
              // 两端都取自主题 token（强调色 --primary → 其浅档 --ring）：
              // 换 accent / 深色主题自动适配，组件内不写死任何颜色
              background:
                "linear-gradient(90deg in oklch shorter hue, var(--primary), var(--ring))",
              opacity: comet ? 1 : 0,
            }}
          />
          {/* 气泡行整体从右向左漂移，单个气泡是行内的白色小点；
              减少动效时整组不渲染 */}
          {comet && !reduce ? (
            <span className="absolute inset-0">
              {COMET_BUBBLES.map((bubble, index) => (
                <span
                  key={index}
                  className="absolute inset-x-0"
                  style={{
                    top: bubble.top,
                    animation: `kova-slider-bubble-flow ${bubble.duration}s linear ${bubble.delay}s infinite`,
                  }}
                >
                  <span
                    className="block rounded-full bg-white/75"
                    style={{ width: bubble.size, height: bubble.size }}
                  />
                </span>
              ))}
            </span>
          ) : null}
        </motion.div>
      </div>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 text-foreground">
        {!bare && (
          <span
            ref={labelRef}
            className="absolute left-5 top-1/2 max-w-[40%] -translate-y-1/2 truncate text-sm font-medium leading-5"
          >
            {label}
          </span>
        )}
        {!bare && (
          <span
            ref={readoutRef}
            className="absolute right-5 top-1/2 max-w-[40%] -translate-y-1/2 truncate text-[13px] font-semibold leading-[18px] tracking-tight tabular-nums"
          >
            {format(current)}
          </span>
        )}
        {ticks.map((left) => (
          <span
            key={left}
            className="absolute top-1/2 size-1 -translate-y-1/2 rounded-full bg-foreground/25"
            style={{ left }}
          />
        ))}
      </div>
      <motion.div
        aria-hidden="true"
        animate={reduce ? undefined : { scaleY: dragging ? 1.35 : 1 }}
        transition={SPRING_BOUNCY}
        className="pointer-events-none absolute left-0 top-[calc(50%-12px)] h-6 w-1 text-foreground"
        style={{ x: handleX }}
      >
        <motion.span className="absolute top-0 size-1 rounded-full bg-current" style={{ y: reduce ? 0 : capTop }} />
        <motion.span className="absolute inset-y-0 w-1 rounded-full bg-current" style={{ opacity: stemOpacity }} />
        <motion.span className="absolute bottom-0 size-1 rounded-full bg-current" style={{ y: reduce ? 0 : capBottom }} />
      </motion.div>
      <button
        type="button"
        {...sliderProps}
        onKeyDown={(event) => {
          if (options.disabled) return;
          const next = {
            ArrowRight: stops.find((stop) => stop.value > current)?.value ?? max,
            ArrowUp: stops.find((stop) => stop.value > current)?.value ?? max,
            ArrowLeft: stops.findLast((stop) => stop.value < current)?.value ?? min,
            ArrowDown: stops.findLast((stop) => stop.value < current)?.value ?? min,
            Home: min,
            End: max,
            PageUp: max,
            PageDown: min,
          }[event.key];
          if (next !== undefined) {
            event.preventDefault();
            commit(next);
          }
        }}
        className="absolute inset-0 cursor-inherit touch-none rounded-lg border-0 outline-none"
      />
    </div>
  );
}
