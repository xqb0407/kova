"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";
import { beginResizeSession, endResizeSession } from "@/lib/ui/resize-session";

/**
 * Elastic sidebar handle.
 *
 * The sidebar is the left column; this handle lives at the left edge of the
 * main column, so its 16px hit strip straddles the sidebar border instead of
 * being clipped by the aside's overflow-hidden. It keeps the existing sidebar
 * content, collapse animation and width persistence untouched, and replaces
 * the old 1px rail line with the same capsule / rubber-band language as
 * ElasticPanelResize.
 *
 * Width is committed (React state + localStorage) only after the release
 * spring settles. During the gesture the aside width and the inner content
 * column are written imperatively every frame, so the content follows the
 * hand. Row-level ResizeObservers stay quiet while html.is-resizing is set;
 * endResizeSession triggers one settled measurement afterwards.
 */

const HANDLE_WIDTH = 80;
const HANDLE_HEIGHT = 160;
const HIDE_DELAY = 450;

const RUBBER_DISTANCE = 15;
const RUBBER_DECAY = 35;

const POSITION_STIFFNESS = 400;
const POSITION_DAMPING = 26;
const BEND_STIFFNESS = 680;
const BEND_DAMPING = 34;
const SHAPE_RATE = 32;

const SUBSTEPS = 4;
const MAX_FRAME_DT = 1 / 30;
const MAX_POINTER_SPEED = 2200;
const POINTER_SPEED_DT = 0.008;
const IDLE_POINTER_MS = 70;
const DRAGGING_KEEPALIVE_MS = 80;

const REST_LENGTH = 69;
const REST_STROKE = 6;
const MAX_BEND = 4.5;
const MAX_SHIFT = 9;
const OVER_SHIFT = 6;

const REST_COLOR = 198;
const DARK_COLOR = 39;

const ARROW_STEP = 20;
const SHIFT_ARROW_STEP = 60;

type Mode = "idle" | "drag" | "spring";

interface DragState {
  pointerId: number;
  pointerType: string;
  startX: number;
  startWidth: number;
  lastRaw: number;
  lastMoveAt: number;
  lastClientX: number;
  lastClientY: number;
  pressTarget: number;
  fromSpring: boolean;
}

interface RuntimeState {
  mode: Mode;
  drag: DragState | null;
  visible: number;
  target: number;
  widthVelocity: number;
  pointerVelocity: number;
  over: number;
  bend: number;
  bendVelocity: number;
  shift: number;
  shiftVelocity: number;
  stroke: number;
  length: number;
  reveal: number;
  color: number;
  hovered: boolean;
  focused: boolean;
  linger: boolean;
  raf: number;
  lastFrame: number;
  lastMoveAt: number;
  hideTimer: number;
  announceTimer: number;
  liveTimer: number;
  clearFrame: number;
  session: boolean;
  commitOnSettle: boolean;
  windowKeyHandler: ((event: KeyboardEvent) => void) | null;
  windowBlurHandler: (() => void) | null;
  destroyed: boolean;
}

export interface ElasticRailHandleProps {
  asideRef: RefObject<HTMLElement | null>;
  innerRef: RefObject<HTMLDivElement | null>;
  minWidth: number;
  maxWidth: number;
  controlsId: string;
  onCommit: (width: number) => void;
  onReset: () => void;
  className?: string;
}

function createRuntime(): RuntimeState {
  return {
    mode: "idle",
    drag: null,
    visible: 0,
    target: 0,
    widthVelocity: 0,
    pointerVelocity: 0,
    over: 0,
    bend: 0,
    bendVelocity: 0,
    shift: 0,
    shiftVelocity: 0,
    stroke: 0,
    length: REST_LENGTH,
    reveal: 0,
    color: REST_COLOR,
    hovered: false,
    focused: false,
    linger: false,
    raf: 0,
    lastFrame: 0,
    lastMoveAt: 0,
    hideTimer: 0,
    announceTimer: 0,
    liveTimer: 0,
    clearFrame: 0,
    session: false,
    commitOnSettle: true,
    windowKeyHandler: null,
    windowBlurHandler: null,
    destroyed: false,
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

export function ElasticRailHandle({
  asideRef,
  innerRef,
  minWidth,
  maxWidth,
  controlsId,
  onCommit,
  onReset,
  className,
}: ElasticRailHandleProps) {
  const hitRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const outerPathRef = useRef<SVGPathElement | null>(null);
  const innerPathRef = useRef<SVGPathElement | null>(null);
  const [live, setLive] = useState("");

  const reducedRef = useRef(false);

  const rtRef = useRef<RuntimeState | null>(null);
  if (rtRef.current === null) rtRef.current = createRuntime();
  const rt = rtRef.current;

  const propsRef = useRef({ minWidth, maxWidth, onCommit, onReset });
  propsRef.current = { minWidth, maxWidth, onCommit, onReset };

  function clampWidth(value: number): number {
    const props = propsRef.current;
    return clamp(value, props.minWidth, props.maxWidth);
  }

  function showTarget(): boolean {
    return Boolean(rt.drag) || rt.hovered || rt.focused || rt.linger;
  }

  function syncAria(width: number): void {
    const rounded = Math.round(width);
    const hit = hitRef.current;
    if (!hit) return;
    hit.setAttribute("aria-valuenow", String(rounded));
    hit.setAttribute("aria-valuetext", `${rounded} 像素`);
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

  function applyWidth(width: number): void {
    rt.visible = width;
    const aside = asideRef.current;
    if (aside) aside.style.width = `${width}px`;
    // The content column follows the hand too. The row-level ResizeObservers
    // stay quiet while html.is-resizing is set and get one settled measurement
    // from endResizeSession, so following does not turn into per-row setState.
    const inner = innerRef.current;
    if (inner) inner.style.width = `${width}px`;
  }

  function beginSession(): void {
    if (rt.session) return;
    beginResizeSession();
    rt.session = true;
  }

  function endSession(): void {
    if (!rt.session) return;
    endResizeSession();
    rt.session = false;
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

  function pushLive(text: string): void {
    if (rt.destroyed) return;
    if (rt.liveTimer) {
      window.clearTimeout(rt.liveTimer);
      rt.liveTimer = 0;
    }
    setLive("");
    rt.liveTimer = window.setTimeout(() => {
      rt.liveTimer = 0;
      if (!rt.destroyed) setLive(text);
    }, 24);
  }

  function announce(text: string, delay = 0): void {
    if (rt.destroyed) return;
    if (rt.announceTimer) {
      window.clearTimeout(rt.announceTimer);
      rt.announceTimer = 0;
    }
    if (delay > 0) {
      rt.announceTimer = window.setTimeout(() => {
        rt.announceTimer = 0;
        pushLive(text);
      }, delay);
      return;
    }
    pushLive(text);
  }

  function geometryTargets() {
    if (!rt.drag || now() - rt.lastMoveAt > IDLE_POINTER_MS) {
      rt.pointerVelocity = 0;
    }

    const direction = clamp(rt.pointerVelocity / 60, -1, 1);
    const overRatio = clamp01(Math.abs(rt.over) / 80);
    const motion = Math.max(
      Math.abs(direction) * (1 - overRatio),
      overRatio,
    );
    const show = showTarget() ? 1 : 0;

    return {
      bendTarget: MAX_BEND * direction * (1 - overRatio),
      shiftTarget:
        MAX_SHIFT * direction * (1 - overRatio) +
        OVER_SHIFT * Math.sign(rt.over) * overRatio,
      lengthTarget: REST_LENGTH + 21 * motion + 21 * overRatio,
      strokeTarget: (REST_STROKE - 3 * motion - 1 * overRatio) * show,
      revealTarget: show,
      color: REST_COLOR - DARK_COLOR * motion,
    };
  }

  function needsFrame(): boolean {
    if (rt.destroyed) return false;

    if (
      rt.mode === "spring" &&
      (Math.abs(rt.target - rt.visible) >= 0.01 ||
        Math.abs(rt.widthVelocity) >= 0.05)
    ) {
      return true;
    }

    if (rt.drag && now() - rt.lastMoveAt <= DRAGGING_KEEPALIVE_MS) {
      return true;
    }

    const geometry = geometryTargets();
    if (
      Math.abs(geometry.bendTarget - rt.bend) >= 0.01 ||
      Math.abs(rt.bendVelocity) >= 0.03
    ) {
      return true;
    }
    if (
      Math.abs(geometry.shiftTarget - rt.shift) >= 0.01 ||
      Math.abs(rt.shiftVelocity) >= 0.03
    ) {
      return true;
    }
    if (
      Math.abs(geometry.lengthTarget - rt.length) >= 0.01 ||
      Math.abs(geometry.strokeTarget - rt.stroke) >= 0.01 ||
      Math.abs(geometry.revealTarget - rt.reveal) >= 0.001
    ) {
      return true;
    }

    return false;
  }

  function settleShape(): void {
    if (rt.drag || rt.mode !== "idle") return;

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

  function finalizeWidth(commit = true): void {
    const target = Math.round(clampWidth(rt.target));
    rt.target = target;
    rt.visible = target;
    rt.mode = "idle";
    rt.widthVelocity = 0;
    rt.pointerVelocity = 0;
    rt.over = 0;

    const aside = asideRef.current;
    if (aside) {
      aside.style.width = `${target}px`;
      if (commit) aside.style.setProperty("--rail-w", `${target}px`);
    }
    const inner = innerRef.current;
    if (inner) inner.style.width = commit ? `${target}px` : "";

    syncAria(target);
    if (commit) propsRef.current.onCommit(target);
    rt.commitOnSettle = true;
    if (rt.session) {
      endResizeSession();
      rt.session = false;
    }

    if (rt.clearFrame) cancelAnimationFrame(rt.clearFrame);
    rt.clearFrame = requestAnimationFrame(() => {
      rt.clearFrame = 0;
      const asideNow = asideRef.current;
      if (!asideNow) return;
      // The React state and --rail-w now hold the same integer. Dropping the
      // inline width lets collapse (w-0) and future resets animate again.
      asideNow.style.width = "";
      asideNow.style.transitionDuration = "";
      asideNow.style.willChange = "";
    });
  }

  function snapReduced(): void {
    cancelFrame();

    if (rt.mode === "spring") {
      finalizeWidth(rt.commitOnSettle);
    }

    if (rt.mode === "drag") {
      rt.over = 0;
      rt.pointerVelocity = 0;
      rt.visible = rt.target;
      applyWidth(rt.target);
    }

    rt.bend = 0;
    rt.bendVelocity = 0;
    rt.shift = 0;
    rt.shiftVelocity = 0;
    rt.length = REST_LENGTH;
    const show = showTarget() ? 1 : 0;
    rt.reveal = show;
    rt.stroke = REST_STROKE * show;
    rt.color = REST_COLOR;
    render();
  }

  function start(): void {
    if (rt.destroyed) return;
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
    if (rt.destroyed) return;

    const frameTime = Number.isFinite(timestamp) ? timestamp : now();
    const dt = clamp((frameTime - rt.lastFrame) / 1000, 0, MAX_FRAME_DT);
    rt.lastFrame = frameTime;

    if (reducedRef.current) {
      snapReduced();
      return;
    }

    if (rt.mode === "spring") {
      const widthStep = dt / SUBSTEPS;
      for (let step = 0; step < SUBSTEPS; step += 1) {
        rt.widthVelocity +=
          (rt.target - rt.visible) * POSITION_STIFFNESS * widthStep -
          rt.widthVelocity * POSITION_DAMPING * widthStep;
        rt.visible += rt.widthVelocity * widthStep;
      }
      applyWidth(rt.visible);

      if (
        Math.abs(rt.target - rt.visible) < 0.01 &&
        Math.abs(rt.widthVelocity) < 0.05
      ) {
        finalizeWidth(rt.commitOnSettle);
      }
    }

    if (rt.drag && now() - rt.lastMoveAt > IDLE_POINTER_MS) {
      rt.pointerVelocity = 0;
    }

    const geometry = geometryTargets();
    const shapeStep = dt / SUBSTEPS;
    for (let step = 0; step < SUBSTEPS; step += 1) {
      rt.bendVelocity +=
        (geometry.bendTarget - rt.bend) * BEND_STIFFNESS * shapeStep -
        rt.bendVelocity * BEND_DAMPING * shapeStep;
      rt.bend += rt.bendVelocity * shapeStep;

      rt.shiftVelocity +=
        (geometry.shiftTarget - rt.shift) * BEND_STIFFNESS * shapeStep -
        rt.shiftVelocity * BEND_DAMPING * shapeStep;
      rt.shift += rt.shiftVelocity * shapeStep;
    }

    const shapeFactor = 1 - Math.exp(-SHAPE_RATE * dt);
    rt.stroke += (geometry.strokeTarget - rt.stroke) * shapeFactor;
    rt.length += (geometry.lengthTarget - rt.length) * shapeFactor;
    rt.reveal += (geometry.revealTarget - rt.reveal) * shapeFactor;
    rt.color = geometry.color;

    render();

    if (needsFrame()) {
      rt.raf = requestAnimationFrame(onFrame);
    } else {
      settleShape();
    }
  }

  function scheduleHide(force = false): void {
    if (rt.destroyed || rt.drag || rt.hovered || rt.focused) return;
    if (!force && rt.reveal <= 0.001 && rt.stroke <= 0.001) {
      rt.linger = false;
      return;
    }

    rt.linger = true;
    clearHideTimer();
    rt.hideTimer = window.setTimeout(() => {
      rt.hideTimer = 0;
      if (rt.destroyed || rt.drag || rt.hovered || rt.focused) {
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

  function pointInHit(clientX: number, clientY: number): boolean {
    const hit = hitRef.current;
    if (!hit) return false;
    const rect = hit.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }

  function removeWindowDragListeners(): void {
    if (rt.windowKeyHandler) {
      window.removeEventListener("keydown", rt.windowKeyHandler, true);
      rt.windowKeyHandler = null;
    }
    if (rt.windowBlurHandler) {
      window.removeEventListener("blur", rt.windowBlurHandler);
      rt.windowBlurHandler = null;
    }
  }

  function addWindowDragListeners(): void {
    removeWindowDragListeners();

    rt.windowKeyHandler = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !rt.drag) return;
      event.preventDefault();
      event.stopPropagation();
      finishDrag(
        true,
        rt.drag.pointerType,
        rt.drag.lastClientX,
        rt.drag.lastClientY,
      );
    };
    rt.windowBlurHandler = () => {
      if (!rt.drag) return;
      finishDrag(
        true,
        rt.drag.pointerType,
        rt.drag.lastClientX,
        rt.drag.lastClientY,
      );
    };

    window.addEventListener("keydown", rt.windowKeyHandler, true);
    window.addEventListener("blur", rt.windowBlurHandler);
  }

  function finishDrag(
    restore: boolean,
    pointerType: string,
    clientX: number,
    clientY: number,
  ): void {
    const drag = rt.drag;
    if (!drag) return;

    rt.drag = null;
    removeWindowDragListeners();

    try {
      const hit = hitRef.current;
      if (hit?.hasPointerCapture(drag.pointerId)) {
        hit.releasePointerCapture(drag.pointerId);
      }
    } catch {
      // Capture may already be gone.
    }

    if (restore) rt.target = clampWidth(drag.pressTarget);
    rt.target = Math.round(clampWidth(rt.target));
    rt.over = 0;
    rt.pointerVelocity = 0;
    rt.widthVelocity = 0;

    const target = rt.target;
    const changed = Math.abs(target - drag.pressTarget) >= 0.01;
    const shouldCommit = changed || drag.fromSpring;
    const needsSpring =
      !reducedRef.current && Math.abs(rt.visible - target) >= 0.01;

    if (!needsSpring) {
      rt.visible = target;
      applyWidth(target);
      finalizeWidth(shouldCommit);
    } else {
      rt.mode = "spring";
      rt.commitOnSettle = shouldCommit;
      applyWidth(rt.visible);
    }

    const inside =
      pointerType !== "touch" && pointInHit(clientX, clientY);
    rt.hovered = inside;
    if (inside) {
      cancelHide();
    } else {
      scheduleHide(true);
    }

    syncAria(target);

    if (restore) {
      announce(`已取消，侧边栏宽度 ${Math.round(target)} 像素`, 0);
    } else if (changed) {
      announce(`侧边栏宽度 ${Math.round(target)} 像素`, 0);
    }

    start();
  }

  function resetToDefault(): void {
    if (rt.drag) return;

    if (rt.clearFrame) {
      cancelAnimationFrame(rt.clearFrame);
      rt.clearFrame = 0;
    }
    cancelFrame();
    cancelHide();
    rt.mode = "idle";
    rt.widthVelocity = 0;
    rt.pointerVelocity = 0;
    rt.over = 0;

    const aside = asideRef.current;
    if (aside) {
      aside.style.width = "";
      aside.style.transitionDuration = "";
      aside.style.willChange = "";
    }
    const inner = innerRef.current;
    if (inner) inner.style.width = "";

    if (rt.session) {
      endResizeSession();
      rt.session = false;
    }

    propsRef.current.onReset();
    announce("已重置侧边栏宽度", 0);
    start();
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (rt.destroyed || rt.drag) return;
    if (event.button !== 0) return;
    if (event.pointerType === "touch" && event.isPrimary === false) return;

    const aside = asideRef.current;
    if (!aside) return;
    const startWidth = aside.offsetWidth;
    if (!(startWidth > 0)) return;

    const fromSpring = rt.mode === "spring";
    const pressTarget = fromSpring ? rt.target : clampWidth(startWidth);

    if (rt.clearFrame) {
      cancelAnimationFrame(rt.clearFrame);
      rt.clearFrame = 0;
    }
    cancelFrame();

    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Window listeners still cover Escape / blur; capture is best-effort.
    }

    aside.style.transitionDuration = "0s";
    aside.style.willChange = "width";
    applyWidth(startWidth);

    beginSession();

    rt.mode = "drag";
    rt.visible = startWidth;
    // Keep the in-flight target when grabbing during a spring; the first
    // pointermove will take over from the current visible width.
    rt.target = pressTarget;
    rt.widthVelocity = 0;
    rt.pointerVelocity = 0;
    rt.over = 0;
    rt.lastMoveAt = now();
    rt.drag = {
      pointerId: event.pointerId,
      pointerType: event.pointerType || "mouse",
      startX: event.clientX,
      startWidth,
      lastRaw: startWidth,
      lastMoveAt: now(),
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      pressTarget,
      fromSpring,
    };

    if (event.pointerType !== "touch") rt.hovered = true;
    cancelHide();
    addWindowDragListeners();
    syncAria(rt.target);
    start();
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = rt.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;

    const eventNow = now();
    const raw = drag.startWidth + (event.clientX - drag.startX);
    const elapsed = Math.max(
      (eventNow - drag.lastMoveAt) / 1000,
      POINTER_SPEED_DT,
    );

    rt.pointerVelocity = clamp(
      (raw - drag.lastRaw) / elapsed,
      -MAX_POINTER_SPEED,
      MAX_POINTER_SPEED,
    );
    drag.lastRaw = raw;
    drag.lastMoveAt = eventNow;
    rt.lastMoveAt = eventNow;
    drag.lastClientX = event.clientX;
    drag.lastClientY = event.clientY;

    const target = clampWidth(raw);
    const over = raw - target;
    const targetChanged = Math.abs(target - rt.target) > 0.01;
    rt.target = target;
    rt.over = over;

    if (reducedRef.current) {
      rt.visible = target;
      rt.over = 0;
      rt.pointerVelocity = 0;
      applyWidth(target);
      if (targetChanged) syncAria(target);
      snapReduced();
    } else {
      rt.visible =
        over === 0
          ? target
          : target +
            Math.sign(over) *
              RUBBER_DISTANCE *
              (1 - Math.exp(-Math.abs(over) / RUBBER_DECAY));
      applyWidth(rt.visible);
      if (targetChanged) syncAria(target);
      start();
    }
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = rt.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    finishDrag(
      false,
      event.pointerType || drag.pointerType,
      event.clientX,
      event.clientY,
    );
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = rt.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    finishDrag(
      true,
      event.pointerType || drag.pointerType,
      event.clientX,
      event.clientY,
    );
  }

  function handleLostPointerCapture(
    event: ReactPointerEvent<HTMLDivElement>,
  ): void {
    const drag = rt.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    finishDrag(
      false,
      drag.pointerType,
      drag.lastClientX,
      drag.lastClientY,
    );
  }

  function handlePointerEnter(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.pointerType === "touch") return;
    rt.hovered = true;
    cancelHide();
    start();
  }

  function handlePointerLeave(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.pointerType === "touch") return;
    rt.hovered = false;
    if (!rt.drag) scheduleHide(false);
  }

  function handleFocus(): void {
    rt.focused = true;
    cancelHide();
    start();
  }

  function handleBlur(): void {
    rt.focused = false;
    if (!rt.drag && !rt.hovered) scheduleHide(false);
  }

  function handleDoubleClick(event: ReactMouseEvent<HTMLDivElement>): void {
    if (rt.drag) return;
    event.preventDefault();
    resetToDefault();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (rt.destroyed || rt.drag) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === "Escape") {
      event.preventDefault();
      resetToDefault();
      return;
    }

    const aside = asideRef.current;
    if (!aside) return;

    const current =
      rt.mode === "spring"
        ? rt.target
        : Math.round(clampWidth(aside.offsetWidth));
    const step = event.shiftKey ? SHIFT_ARROW_STEP : ARROW_STEP;

    let next: number;
    if (event.key === "ArrowLeft") {
      next = current - step;
    } else if (event.key === "ArrowRight") {
      next = current + step;
    } else if (event.key === "Home") {
      next = propsRef.current.maxWidth;
    } else if (event.key === "End") {
      next = propsRef.current.minWidth;
    } else {
      return;
    }

    event.preventDefault();
    next = Math.round(clampWidth(next));
    if (Math.abs(next - current) < 0.01) return;

    if (rt.clearFrame) {
      cancelAnimationFrame(rt.clearFrame);
      rt.clearFrame = 0;
    }

    if (rt.mode !== "spring") {
      cancelFrame();
      aside.style.transitionDuration = "0s";
      aside.style.willChange = "width";
      applyWidth(aside.offsetWidth);
      beginSession();
      rt.mode = "spring";
    }

    rt.target = next;
    rt.widthVelocity = 0;
    rt.pointerVelocity = 0;
    rt.over = 0;
    rt.commitOnSettle = true;
    syncAria(next);

    if (reducedRef.current) {
      rt.visible = next;
      applyWidth(next);
      finalizeWidth();
      snapReduced();
      announce(`侧边栏宽度 ${Math.round(next)} 像素`, 0);
    } else {
      start();
      announce(`侧边栏宽度 ${Math.round(next)} 像素`, 160);
    }
  }

  useEffect(() => {
    rt.destroyed = false;
    render();

    const aside = asideRef.current;
    const measure = (): void => {
      if (rt.destroyed || rt.mode !== "idle") return;
      const width = aside?.offsetWidth ?? 0;
      if (!(width > 0)) return;
      rt.visible = width;
      rt.target = Math.round(clampWidth(width));
      const inner = innerRef.current;
      if (inner) inner.style.width = `${width}px`;
      syncAria(rt.target);
    };

    measure();

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

    let observer: ResizeObserver | null = null;
    if (aside && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => measure());
      observer.observe(aside);
    }
    window.addEventListener("resize", measure);

    return () => {
      rt.destroyed = true;
      cancelFrame();
      clearHideTimer();
      if (rt.announceTimer) {
        window.clearTimeout(rt.announceTimer);
        rt.announceTimer = 0;
      }
      if (rt.liveTimer) {
        window.clearTimeout(rt.liveTimer);
        rt.liveTimer = 0;
      }
      if (rt.clearFrame) {
        cancelAnimationFrame(rt.clearFrame);
        rt.clearFrame = 0;
      }

      removeWindowDragListeners();

      if (rt.drag) {
        const pointerId = rt.drag.pointerId;
        rt.drag = null;
        try {
          const hit = hitRef.current;
          if (hit?.hasPointerCapture(pointerId)) {
            hit.releasePointerCapture(pointerId);
          }
        } catch {
          // The element may already be detached.
        }
      }

      if (rt.session) {
        endResizeSession();
        rt.session = false;
      }

      const asideNow = asideRef.current;
      if (asideNow) {
        asideNow.style.width = "";
        asideNow.style.transitionDuration = "";
        asideNow.style.willChange = "";
      }
      const innerNow = innerRef.current;
      if (innerNow) innerNow.style.width = "";

      observer?.disconnect();
      window.removeEventListener("resize", measure);
      if (motionMedia) {
        if (typeof motionMedia.removeEventListener === "function") {
          motionMedia.removeEventListener("change", onMotionPreferenceChange);
        } else {
          motionMedia.removeListener(onMotionPreferenceChange);
        }
      }
    };
    // Refs and the imperative runtime are stable for the life of the handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={hitRef}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧边栏宽度"
      aria-controls={controlsId}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      tabIndex={0}
      title="拖动调整侧边栏宽度，双击复位"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handleLostPointerCapture}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "group absolute inset-y-0 left-0 z-50 hidden w-4 -translate-x-1/2 cursor-col-resize touch-none select-none outline-none md:block",
        className,
      )}
    >
      <svg
        ref={svgRef}
        viewBox="0 0 80 160"
        width={HANDLE_WIDTH}
        height={HANDLE_HEIGHT}
        aria-hidden="true"
        focusable="false"
        className="pointer-events-none absolute top-1/2 left-1/2 h-40 w-16 -translate-x-1/2 -translate-y-1/2 overflow-visible"
      >
        <path
          ref={outerPathRef}
          fill="none"
          stroke="#ffffff"
          strokeLinecap="round"
        />
        <path
          ref={innerPathRef}
          fill="none"
          stroke="#c6c6c6"
          strokeLinecap="round"
        />
      </svg>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 h-[132px] w-[48px] -translate-x-1/2 -translate-y-1/2 rounded-[18px] border-2 border-[#666] opacity-0 group-focus-visible:opacity-100 dark:border-[#aaa]"
      />
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {live}
      </span>
    </div>
  );
}

export default ElasticRailHandle;
