"use client";

import {
  useEffect,
  useRef,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Separator,
  type SeparatorProps,
} from "react-resizable-panels";
import { cn } from "@/lib/utils";

/**
 * Visual separator for the right Agent panel.
 *
 * The layout side of resizing stays with react-resizable-panels: the Group's
 * resizeTargetMinimumSize provides a 16px hit target while this Separator
 * itself is 0px wide, so the chat card and panel card touch (no gutter). This
 * component only paints the same thin capsule language as the sidebar handle,
 * reacts to pointer velocity with the bend/offset shape, and manages
 * hover/focus/450ms hide. Width, constraints, keyboard and persistence remain
 * owned by Base + react-resizable-panels.
 */

const HIDE_DELAY = 450;
const REST_LENGTH = 69;
const REST_STROKE = 6;
const MAX_BEND = 4.5;
const MAX_SHIFT = 9;
const BEND_STIFFNESS = 680;
const BEND_DAMPING = 34;
const SHAPE_RATE = 32;
const SUBSTEPS = 4;
const MAX_FRAME_DT = 1 / 30;
const MAX_POINTER_SPEED = 2200;
const POINTER_SPEED_DT = 0.008;
const IDLE_POINTER_MS = 70;
const DRAGGING_KEEPALIVE_MS = 80;
const REST_COLOR = 198;
const DARK_COLOR = 39;
const HIT_HALF = 8;

interface VisualState {
  reveal: number;
  stroke: number;
  length: number;
  bend: number;
  bendVelocity: number;
  shift: number;
  shiftVelocity: number;
  color: number;
  hovered: boolean;
  focused: boolean;
  linger: boolean;
  dragging: boolean;
  pointerId: number;
  pointerVelocity: number;
  lastX: number;
  lastClientX: number;
  lastClientY: number;
  lastMoveAt: number;
  raf: number;
  lastFrame: number;
  hideTimer: number;
  destroyed: boolean;
  windowMove: ((event: PointerEvent) => void) | null;
  windowUp: ((event: PointerEvent) => void) | null;
  windowCancel: ((event: PointerEvent) => void) | null;
  windowBlur: (() => void) | null;
}

function createVisualState(): VisualState {
  return {
    reveal: 0,
    stroke: 0,
    length: REST_LENGTH,
    bend: 0,
    bendVelocity: 0,
    shift: 0,
    shiftVelocity: 0,
    color: REST_COLOR,
    hovered: false,
    focused: false,
    linger: false,
    dragging: false,
    pointerId: -1,
    pointerVelocity: 0,
    lastX: 0,
    lastClientX: 0,
    lastClientY: 0,
    lastMoveAt: 0,
    raf: 0,
    lastFrame: 0,
    hideTimer: 0,
    destroyed: false,
    windowMove: null,
    windowUp: null,
    windowCancel: null,
    windowBlur: null,
  };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export type ElasticPanelHandleProps = SeparatorProps & {
  /** panelGone/fullscreen: hide both the visual and the hit target */
  hidden?: boolean;
};

export function ElasticPanelHandle({
  hidden = false,
  disabled = false,
  className,
  onPointerDownCapture,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  elementRef,
  ...separatorProps
}: ElasticPanelHandleProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const outerPathRef = useRef<SVGPathElement | null>(null);
  const innerPathRef = useRef<SVGPathElement | null>(null);
  const rtRef = useRef<VisualState | null>(null);
  if (rtRef.current === null) rtRef.current = createVisualState();
  const rt = rtRef.current;
  const reducedRef = useRef(false);

  const setRootRef = (node: HTMLDivElement | null): void => {
    rootRef.current = node;
    if (typeof elementRef === "function") {
      elementRef(node);
    } else if (elementRef) {
      elementRef.current = node;
    }
  };

  function showTarget(): boolean {
    return rt.dragging || rt.hovered || rt.focused || rt.linger;
  }

  function render(): void {
    const svg = svgRef.current;
    const outer = outerPathRef.current;
    const inner = innerPathRef.current;
    if (!svg || !outer || !inner) return;

    const centerX = 40 + rt.shift;
    const top = 80 - rt.length / 2;
    const bottom = 80 + rt.length / 2;
    const controlX = 40 + rt.shift + 2 * rt.bend;
    const path = `M ${centerX} ${top} Q ${controlX} 80 ${centerX} ${bottom}`;

    outer.setAttribute("d", path);
    inner.setAttribute("d", path);
    outer.setAttribute(
      "stroke-width",
      String(Math.max(0, rt.stroke + 2 * rt.reveal)),
    );
    inner.setAttribute("stroke-width", String(Math.max(0, rt.stroke)));

    const channel = clamp(Math.round(rt.color), 0, 255);
    inner.setAttribute("stroke", `rgb(${channel}, ${channel}, ${channel})`);
    svg.style.opacity = String(clamp01(rt.reveal));
  }

  function cancelFrame(): void {
    if (!rt.raf) return;
    cancelAnimationFrame(rt.raf);
    rt.raf = 0;
  }

  function clearHideTimer(): void {
    if (!rt.hideTimer) return;
    window.clearTimeout(rt.hideTimer);
    rt.hideTimer = 0;
  }

  function cancelHide(): void {
    clearHideTimer();
    rt.linger = false;
  }

  function removeWindowListeners(): void {
    if (rt.windowMove) {
      window.removeEventListener("pointermove", rt.windowMove);
      rt.windowMove = null;
    }
    if (rt.windowUp) {
      window.removeEventListener("pointerup", rt.windowUp);
      rt.windowUp = null;
    }
    if (rt.windowCancel) {
      window.removeEventListener("pointercancel", rt.windowCancel);
      rt.windowCancel = null;
    }
    if (rt.windowBlur) {
      window.removeEventListener("blur", rt.windowBlur);
      rt.windowBlur = null;
    }
  }

  function settleShape(): void {
    if (rt.dragging) return;
    rt.bend = 0;
    rt.shift = 0;
    rt.bendVelocity = 0;
    rt.shiftVelocity = 0;
    rt.length = REST_LENGTH;
    const show = showTarget() ? 1 : 0;
    rt.reveal = show;
    rt.stroke = REST_STROKE * show;
    rt.color = REST_COLOR;
    render();
  }

  function snapReduced(): void {
    cancelFrame();
    rt.bend = 0;
    rt.shift = 0;
    rt.bendVelocity = 0;
    rt.shiftVelocity = 0;
    rt.length = REST_LENGTH;
    const show = showTarget() ? 1 : 0;
    rt.reveal = show;
    rt.stroke = REST_STROKE * show;
    rt.color = REST_COLOR;
    render();
  }

  function needsFrame(): boolean {
    if (rt.destroyed) return false;
    if (rt.dragging && now() - rt.lastMoveAt <= DRAGGING_KEEPALIVE_MS) {
      return true;
    }

    const direction = clamp(
      rt.dragging && now() - rt.lastMoveAt <= IDLE_POINTER_MS
        ? rt.pointerVelocity / 60
        : 0,
      -1,
      1,
    );
    const show = showTarget() ? 1 : 0;
    const bendTarget = MAX_BEND * direction;
    const shiftTarget = MAX_SHIFT * direction;
    const lengthTarget = REST_LENGTH + 21 * Math.abs(direction);
    const strokeTarget = (REST_STROKE - 3 * Math.abs(direction)) * show;

    if (
      Math.abs(bendTarget - rt.bend) >= 0.01 ||
      Math.abs(rt.bendVelocity) >= 0.03
    ) {
      return true;
    }
    if (
      Math.abs(shiftTarget - rt.shift) >= 0.01 ||
      Math.abs(rt.shiftVelocity) >= 0.03
    ) {
      return true;
    }
    if (
      Math.abs(lengthTarget - rt.length) >= 0.01 ||
      Math.abs(strokeTarget - rt.stroke) >= 0.01 ||
      Math.abs(show - rt.reveal) >= 0.001
    ) {
      return true;
    }
    return false;
  }

  function start(): void {
    if (rt.destroyed || hidden || disabled) return;
    if (reducedRef.current) {
      snapReduced();
      return;
    }
    if (rt.raf) return;
    rt.lastFrame = now();
    rt.raf = requestAnimationFrame(onFrame);
  }

  function onFrame(timestamp: number): void {
    rt.raf = 0;
    if (rt.destroyed || hidden || disabled) return;

    const frameTime = Number.isFinite(timestamp) ? timestamp : now();
    const dt = clamp((frameTime - rt.lastFrame) / 1000, 0, MAX_FRAME_DT);
    rt.lastFrame = frameTime;

    if (reducedRef.current) {
      snapReduced();
      return;
    }

    if (!rt.dragging || now() - rt.lastMoveAt > IDLE_POINTER_MS) {
      rt.pointerVelocity = 0;
    }

    const direction = clamp(rt.pointerVelocity / 60, -1, 1);
    const motion = Math.abs(direction);
    const show = showTarget() ? 1 : 0;
    const bendTarget = MAX_BEND * direction;
    const shiftTarget = MAX_SHIFT * direction;
    const lengthTarget = REST_LENGTH + 21 * motion;
    const strokeTarget = (REST_STROKE - 3 * motion) * show;

    const shapeStep = dt / SUBSTEPS;
    for (let step = 0; step < SUBSTEPS; step += 1) {
      rt.bendVelocity +=
        (bendTarget - rt.bend) * BEND_STIFFNESS * shapeStep -
        rt.bendVelocity * BEND_DAMPING * shapeStep;
      rt.bend += rt.bendVelocity * shapeStep;

      rt.shiftVelocity +=
        (shiftTarget - rt.shift) * BEND_STIFFNESS * shapeStep -
        rt.shiftVelocity * BEND_DAMPING * shapeStep;
      rt.shift += rt.shiftVelocity * shapeStep;
    }

    const shapeFactor = 1 - Math.exp(-SHAPE_RATE * dt);
    rt.stroke += (strokeTarget - rt.stroke) * shapeFactor;
    rt.length += (lengthTarget - rt.length) * shapeFactor;
    rt.reveal += (show - rt.reveal) * shapeFactor;
    rt.color = REST_COLOR - DARK_COLOR * motion;

    render();

    if (needsFrame()) {
      rt.raf = requestAnimationFrame(onFrame);
    } else {
      settleShape();
    }
  }

  function scheduleHide(force = false): void {
    if (rt.destroyed || hidden || disabled || rt.dragging || rt.hovered || rt.focused) {
      return;
    }
    if (!force && rt.reveal <= 0.001 && rt.stroke <= 0.001) {
      rt.linger = false;
      return;
    }

    rt.linger = true;
    clearHideTimer();
    rt.hideTimer = window.setTimeout(() => {
      rt.hideTimer = 0;
      if (rt.destroyed || rt.dragging || rt.hovered || rt.focused) {
        rt.linger = false;
        return;
      }
      rt.linger = false;
      if (reducedRef.current) {
        rt.reveal = 0;
        rt.stroke = 0;
        rt.length = REST_LENGTH;
        rt.bend = 0;
        rt.shift = 0;
        rt.bendVelocity = 0;
        rt.shiftVelocity = 0;
        render();
      } else {
        start();
      }
    }, HIDE_DELAY);
  }

  function finishDrag(
    pointerType: string,
    clientX: number,
    clientY: number,
  ): void {
    if (!rt.dragging) return;
    rt.dragging = false;
    removeWindowListeners();
    rt.pointerVelocity = 0;

    const boundary = rootRef.current?.getBoundingClientRect().left ?? clientX;
    const inside =
      pointerType !== "touch" &&
      Math.abs(clientX - boundary) <= HIT_HALF;
    rt.hovered = inside;
    if (inside) {
      cancelHide();
    } else {
      scheduleHide(true);
    }
    start();
  }

  function addWindowListeners(pointerId: number): void {
    removeWindowListeners();
    rt.windowMove = (event: PointerEvent) => {
      if (!rt.dragging || event.pointerId !== pointerId) return;
      const eventNow = now();
      const elapsed = Math.max(
        (eventNow - rt.lastMoveAt) / 1000,
        POINTER_SPEED_DT,
      );
      rt.pointerVelocity = clamp(
        (event.clientX - rt.lastX) / elapsed,
        -MAX_POINTER_SPEED,
        MAX_POINTER_SPEED,
      );
      rt.lastX = event.clientX;
      rt.lastClientX = event.clientX;
      rt.lastClientY = event.clientY;
      rt.lastMoveAt = eventNow;
      start();
    };
    rt.windowUp = (event: PointerEvent) => {
      if (!rt.dragging || event.pointerId !== pointerId) return;
      rt.lastClientX = event.clientX;
      rt.lastClientY = event.clientY;
      finishDrag(
        event.pointerType || "mouse",
        event.clientX,
        event.clientY,
      );
    };
    rt.windowCancel = (event: PointerEvent) => {
      if (!rt.dragging || event.pointerId !== pointerId) return;
      finishDrag(
        event.pointerType || "mouse",
        rt.lastClientX,
        rt.lastClientY,
      );
    };
    rt.windowBlur = () => {
      if (!rt.dragging) return;
      finishDrag("mouse", rt.lastClientX, rt.lastClientY);
    };

    window.addEventListener("pointermove", rt.windowMove, { passive: true });
    window.addEventListener("pointerup", rt.windowUp);
    window.addEventListener("pointercancel", rt.windowCancel);
    window.addEventListener("blur", rt.windowBlur);
  }

  function handlePointerDownCapture(
    event: ReactPointerEvent<HTMLDivElement>,
  ): void {
    onPointerDownCapture?.(event);
    if (hidden || disabled || rt.dragging) return;
    if (event.button !== 0) return;
    if (event.pointerType === "touch" && event.isPrimary === false) return;

    rt.dragging = true;
    rt.pointerId = event.pointerId;
    rt.lastX = event.clientX;
    rt.lastClientX = event.clientX;
    rt.lastClientY = event.clientY;
    rt.lastMoveAt = now();
    rt.pointerVelocity = 0;
    if (event.pointerType !== "touch") rt.hovered = true;
    cancelHide();
    addWindowListeners(event.pointerId);
    start();
  }

  function handlePointerEnter(
    event: ReactPointerEvent<HTMLDivElement>,
  ): void {
    onPointerEnter?.(event);
    if (hidden || disabled || event.pointerType === "touch") return;
    rt.hovered = true;
    cancelHide();
    start();
  }

  function handlePointerLeave(
    event: ReactPointerEvent<HTMLDivElement>,
  ): void {
    onPointerLeave?.(event);
    if (event.pointerType === "touch") return;
    rt.hovered = false;
    if (!rt.dragging) scheduleHide(false);
  }

  function handleFocus(event: ReactFocusEvent<HTMLDivElement>): void {
    onFocus?.(event);
    if (hidden || disabled) return;
    rt.focused = true;
    cancelHide();
    start();
  }

  function handleBlur(event: ReactFocusEvent<HTMLDivElement>): void {
    onBlur?.(event);
    rt.focused = false;
    if (!rt.dragging && !rt.hovered) scheduleHide(false);
  }

  useEffect(() => {
    rt.destroyed = false;
    render();

    const motionMedia =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    const onMotionPreferenceChange = (event: MediaQueryListEvent): void => {
      reducedRef.current = event.matches;
      if (event.matches) snapReduced();
    };
    if (motionMedia) {
      reducedRef.current = motionMedia.matches;
      if (motionMedia.matches) snapReduced();
      if (typeof motionMedia.addEventListener === "function") {
        motionMedia.addEventListener("change", onMotionPreferenceChange);
      } else {
        motionMedia.addListener(onMotionPreferenceChange);
      }
    }

    return () => {
      rt.destroyed = true;
      cancelFrame();
      clearHideTimer();
      removeWindowListeners();
      if (motionMedia) {
        if (typeof motionMedia.removeEventListener === "function") {
          motionMedia.removeEventListener("change", onMotionPreferenceChange);
        } else {
          motionMedia.removeListener(onMotionPreferenceChange);
        }
      }
    };
    // The visual runtime is stable for the life of the separator.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hidden) {
      // 面板从收起态被拖开时，pointerdown 发生在 hidden=true；视觉层现在
      // 才挂载。按指针/焦点的真实位置补一次显示，避免松手后胶囊不出现。
      const root = rootRef.current;
      rt.hovered = !!root?.matches(":hover");
      rt.focused = root === document.activeElement;
      if (rt.hovered || rt.focused) start();
      return;
    }
    rt.dragging = false;
    removeWindowListeners();
    cancelFrame();
    clearHideTimer();
    rt.hovered = false;
    rt.focused = false;
    rt.linger = false;
    rt.reveal = 0;
    rt.stroke = 0;
    rt.length = REST_LENGTH;
    rt.bend = 0;
    rt.shift = 0;
    rt.bendVelocity = 0;
    rt.shiftVelocity = 0;
    render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden]);

  return (
    <Separator
      {...separatorProps}
      data-slot="resizable-handle"
      elementRef={setRootRef}
      disabled={disabled}
      onPointerDownCapture={handlePointerDownCapture}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      // 库自己在冒泡阶段处理 separator 的 focus/keyboard；用 capture 保证
      // 视觉层的 focus 状态不被覆盖（胶囊在 Tab 聚焦时也要出现）。
      onFocusCapture={handleFocus}
      onBlurCapture={handleBlur}
      className={cn(
        "group/handle relative z-30 flex w-0 shrink-0 items-center justify-center outline-none",
        // 命中区始终保留（面板收起时还能从右缘拖开），只有 disabled 才整体失效；
        // hidden 仅隐藏视觉胶囊。
        disabled && "pointer-events-none",
        className,
      )}
    >
      {/* 真实 DOM 命中区：库的 resizeTargetMinimumSize 是 Group 级虚拟命中，
          0 宽 Separator 本身不在命中路径上；这层 16px 透明条负责把
          pointerdown/enter 冒泡到 Separator，Base 的 beginPanelHandleDrag
          和本组件视觉才能收到事件。 */}
      <div
        aria-hidden="true"
        className="absolute inset-y-0 left-1/2 w-4 -translate-x-1/2 cursor-col-resize touch-none"
      />
      {!hidden ? (
        <div className="pointer-events-none absolute top-1/2 left-1/2 h-40 w-20 -translate-x-1/2 -translate-y-1/2">
          <svg
            ref={svgRef}
            viewBox="0 0 80 160"
            width={80}
            height={160}
            aria-hidden="true"
            focusable="false"
            className="h-full w-full overflow-visible"
          >
            <path ref={outerPathRef} fill="none" stroke="#ffffff" strokeLinecap="round" />
            <path ref={innerPathRef} fill="none" stroke="#c6c6c6" strokeLinecap="round" />
          </svg>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-1/2 h-[132px] w-[48px] -translate-x-1/2 -translate-y-1/2 rounded-[18px] border-2 border-[#666] opacity-0 group-focus-visible/handle:opacity-100 dark:border-[#aaa]"
          />
        </div>
      ) : null}
    </Separator>
  );
}

export default ElasticPanelHandle;
