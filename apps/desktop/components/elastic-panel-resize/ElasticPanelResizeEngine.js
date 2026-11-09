/**
 * ElasticPanelResizeEngine.js
 *
 * Framework-agnostic interaction core for ElasticPanelResize.
 *
 * Everything visual is drawn into a ShadowRoot handed in by motion-runtime.ts:
 * one scene, one panel, one transparent hit strip, two SVG paths and a hidden
 * live region. The engine never reads or writes document.body, never installs
 * global CSS and never uses an iframe.
 *
 * The geometry is kept in "design pixels" (a 1000px-wide stage). The stage is
 * scaled as a whole with CSS transform, so every size in the spec keeps its
 * proportion at any container width.
 */

const DESIGN_WIDTH = 1000;
const DEFAULT_DESIGN_HEIGHT = 1000;
const INITIAL_RATIO = 0.3865;
const MIN_RATIO = 0.276;
const MAX_RATIO = 0.5;
const INITIAL_POSITION = DESIGN_WIDTH * INITIAL_RATIO;
const MIN_POSITION = DESIGN_WIDTH * MIN_RATIO;
const MAX_POSITION = DESIGN_WIDTH * MAX_RATIO;

const SCENE_INSET = 17;
const HIT_WIDTH = 32;
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

const REST_LENGTH = 60;
const REST_STROKE = 15;
const MAX_BEND = 4.5;
const MAX_SHIFT = 9;
const OVER_SHIFT = 6;
const MAX_LENGTH = 90;
const MAX_MOTION_STROKE = 5;
const OVER_LENGTH = 111;
const OVER_STROKE = 3;

const REST_COLOR = 198;
const DARK_COLOR = 39;

const INITIAL_HANDLE_LENGTH = 60;

let instanceCounter = 0;
let noiseUrlCache = "";

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}

/**
 * One 160px tile of fractal noise. It is embedded as a data URL (not a remote
 * asset) and only ever paints the scene background.
 */
function buildNoiseUrl() {
  if (noiseUrlCache) return noiseUrlCache;

  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">',
    '<filter id="epr-noise-filter" x="0" y="0" width="160" height="160" filterUnits="userSpaceOnUse">',
    '<feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="3" stitchTiles="stitch"/>',
    '<feColorMatrix type="saturate" values="0"/>',
    "</filter>",
    '<rect width="160" height="160" filter="url(#epr-noise-filter)"/>',
    "</svg>",
  ].join("");

  noiseUrlCache = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  return noiseUrlCache;
}

function widthPercentFor(position) {
  // 1e-6 compensates for binary float noise (386.5 / 1000 lands just below
  // .6135), so 61.35 displays as 61.4 with the expected half-up rounding.
  return Math.round((1 - position / DESIGN_WIDTH) * 1000 + 1e-6) / 10;
}

function formatPercent(percent) {
  return `${percent.toFixed(1)}%`;
}

function normalizeHeight(value, fallback) {
  return isFiniteNumber(value) && value > 0 ? value : fallback;
}

function normalizeAriaLabel(value, fallback) {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : fallback;
}

function resolveInitialPosition(value) {
  if (!isFiniteNumber(value)) return INITIAL_POSITION;

  // Accept either a 0..1 ratio (0.3865) or an already scaled design value
  // (386.5). Both are clamped to the legal edge range.
  const position = value > 1 ? value : value * DESIGN_WIDTH;
  return clamp(position, MIN_POSITION, MAX_POSITION);
}

const STYLE_TEXT = `
:host {
  display: block;
  width: 100%;
  min-width: 0;
}
*, *::before, *::after {
  box-sizing: border-box;
}
.epr-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 1000 / 1000;
  overflow: hidden;
  background: #efefef;
}
.epr-scene {
  position: absolute;
  left: 0;
  top: 0;
  width: 1000px;
  height: 1000px;
  transform-origin: 0 0;
  background: #efefef;
  isolation: isolate;
}
.epr-noise {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-size: 160px 160px;
  background-repeat: repeat;
  opacity: 0.65;
  mix-blend-mode: soft-light;
  filter: contrast(4);
}
.epr-panel {
  position: absolute;
  top: ${SCENE_INSET}px;
  bottom: ${SCENE_INSET}px;
  right: ${SCENE_INSET}px;
  left: var(--epr-edge, ${INITIAL_POSITION}px);
  z-index: 1;
  background: #fbfbfb;
  border: 1px solid #d4d4d4;
  border-radius: 40px;
  box-shadow:
    0 2px 4px #0000000a,
    inset 0 0 0 1px #ffffffb3;
  pointer-events: none;
}
.epr-hit {
  position: absolute;
  top: ${SCENE_INSET}px;
  bottom: ${SCENE_INSET}px;
  left: calc(var(--epr-edge, ${INITIAL_POSITION}px) - ${HIT_WIDTH / 2}px);
  width: ${HIT_WIDTH}px;
  z-index: 3;
  cursor: ew-resize;
  touch-action: none;
  outline: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.epr-handle {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 80px;
  height: 160px;
  margin: -80px 0 0 -40px;
  overflow: visible;
  pointer-events: none;
}
.epr-ring {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 48px;
  height: 132px;
  margin: -66px 0 0 -24px;
  border: 2px solid #666;
  border-radius: 18px;
  pointer-events: none;
  opacity: 0;
}
.epr-hit:focus-visible .epr-ring {
  opacity: 1;
}
.epr-live {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
  font-family: Arial, Helvetica, sans-serif;
  pointer-events: none;
}
`;

/**
 * Create one isolated engine inside a ShadowRoot.
 *
 * @param {{
 *   shadow: ShadowRoot;
 *   options?: import("./ElasticPanelResizeEngine").ElasticPanelResizeOptions;
 *   systemReducedMotion?: boolean;
 * }} deps
 * @returns {import("./ElasticPanelResizeEngine").ElasticPanelResizeEngineHandle}
 */
export function createElasticPanelResizeEngine({
  shadow,
  options = {},
  systemReducedMotion = false,
}) {
  if (!shadow) {
    throw new TypeError("ElasticPanelResizeEngine requires a ShadowRoot.");
  }

  const doc = shadow.ownerDocument;
  const win = doc.defaultView || globalThis;
  const now = () =>
    typeof win.performance?.now === "function" ? win.performance.now() : Date.now();

  const panelId = `epr-panel-${++instanceCounter}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const initialAriaLabel = normalizeAriaLabel(
    options.ariaLabel,
    "面板宽度",
  );

  shadow.innerHTML = `
    <style>${STYLE_TEXT}</style>
    <div class="epr-wrap" part="scene">
      <div class="epr-scene" part="stage">
        <div class="epr-noise" aria-hidden="true"></div>
        <div class="epr-panel" id="${panelId}" part="panel"></div>
        <div
          class="epr-hit"
          role="separator"
          tabindex="0"
          aria-orientation="vertical"
          aria-controls="${panelId}"
          aria-valuemin="50"
          aria-valuemax="72.4"
          aria-valuenow="61.4"
          aria-valuetext="61.4%"
          aria-label="${escapeAttribute(initialAriaLabel)}"
          part="separator"
        >
          <svg
            class="epr-handle"
            viewBox="0 0 80 160"
            width="80"
            height="160"
            aria-hidden="true"
            focusable="false"
          >
            <path class="epr-handle-outer" fill="none" stroke="#ffffff" stroke-linecap="round"></path>
            <path class="epr-handle-inner" fill="none" stroke="#c6c6c6" stroke-linecap="round"></path>
          </svg>
          <span class="epr-ring" aria-hidden="true"></span>
        </div>
      </div>
    </div>
    <div class="epr-live" role="status" aria-live="polite" aria-atomic="true"></div>
  `;

  const wrap = shadow.querySelector(".epr-wrap");
  const scene = shadow.querySelector(".epr-scene");
  const noise = shadow.querySelector(".epr-noise");
  const hit = shadow.querySelector(".epr-hit");
  const handle = shadow.querySelector(".epr-handle");
  const outerPath = shadow.querySelector(".epr-handle-outer");
  const innerPath = shadow.querySelector(".epr-handle-inner");
  const live = shadow.querySelector(".epr-live");

  noise.style.backgroundImage = buildNoiseUrl();

  let designHeight = normalizeHeight(options.height, DEFAULT_DESIGN_HEIGHT);
  let ariaLabel = initialAriaLabel;
  let reducedOverride =
    typeof options.reducedMotion === "boolean"
      ? options.reducedMotion
      : undefined;
  let systemReduced = Boolean(systemReducedMotion);
  let reducedMotion =
    typeof reducedOverride === "boolean" ? reducedOverride : systemReduced;
  let onChange =
    typeof options.onChange === "function" ? options.onChange : null;

  const initialPosition = resolveInitialPosition(options.initialPosition);

  let edge = initialPosition;
  let target = initialPosition;
  let positionVelocity = 0;
  let pointerVelocity = 0;
  let overshoot = 0;

  let bend = 0;
  let bendVelocity = 0;
  let shift = 0;
  let shiftVelocity = 0;
  let stroke = 0;
  let length = INITIAL_HANDLE_LENGTH;
  let reveal = 0;
  let colorChannel = REST_COLOR;

  let hovered = false;
  let focused = false;
  let dragging = false;
  let linger = false;
  let dragState = null;

  let rafId = 0;
  let lastFrameTime = 0;
  let lastMoveAt = 0;
  let hideTimer = 0;
  let announceTimer = 0;
  let liveTimer = 0;
  let destroyed = false;

  const permanentCleanups = [];
  let dragWindowCleanups = [];

  function listen(target, type, handler, listenerOptions) {
    target.addEventListener(type, handler, listenerOptions);
    permanentCleanups.push(() =>
      target.removeEventListener(type, handler, listenerOptions),
    );
  }

  function listenDragWindow(type, handler, listenerOptions) {
    win.addEventListener(type, handler, listenerOptions);
    dragWindowCleanups.push(() =>
      win.removeEventListener(type, handler, listenerOptions),
    );
  }

  function applyHeight(nextHeight) {
    designHeight = nextHeight;
    scene.style.height = `${designHeight}px`;
    wrap.style.aspectRatio = `${DESIGN_WIDTH} / ${designHeight}`;
  }

  function applyAriaLabel(nextLabel) {
    ariaLabel = normalizeAriaLabel(nextLabel, "面板宽度");
    hit.setAttribute("aria-label", ariaLabel);
  }

  applyHeight(designHeight);
  applyAriaLabel(ariaLabel);
  scene.style.setProperty("--epr-edge", `${edge}px`);
  hit.setAttribute("aria-valuemin", "50");
  hit.setAttribute("aria-valuemax", "72.4");

  function showTarget() {
    return dragging || hovered || focused || linger;
  }

  function syncAria() {
    const percent = widthPercentFor(target);
    hit.setAttribute("aria-valuenow", percent.toFixed(1));
    hit.setAttribute("aria-valuetext", formatPercent(percent));
  }

  function stateSnapshot() {
    return {
      position: edge,
      target,
      ratio: edge / DESIGN_WIDTH,
      widthPercent: widthPercentFor(target),
      dragging,
      visible: reveal > 0.001,
      reducedMotion,
    };
  }

  function emitChange() {
    if (!onChange) return;
    try {
      onChange(stateSnapshot());
    } catch (error) {
      // A consumer callback must not take down the interaction loop.
      console.error("[ElasticPanelResize] onChange failed:", error);
    }
  }

  function clearHideTimer() {
    if (!hideTimer) return;
    win.clearTimeout(hideTimer);
    hideTimer = 0;
  }

  function pushLive(text) {
    if (destroyed) return;
    if (liveTimer) {
      win.clearTimeout(liveTimer);
      liveTimer = 0;
    }
    live.textContent = "";
    liveTimer = win.setTimeout(() => {
      liveTimer = 0;
      if (!destroyed) live.textContent = text;
    }, 24);
  }

  function announceWidth(prefix, delay) {
    if (destroyed) return;

    const percent = widthPercentFor(target);
    const text = `${prefix ? `${prefix}，` : ""}${ariaLabel} ${formatPercent(percent)}`;

    if (announceTimer) {
      win.clearTimeout(announceTimer);
      announceTimer = 0;
    }

    if (delay > 0) {
      announceTimer = win.setTimeout(() => {
        announceTimer = 0;
        pushLive(text);
      }, delay);
    } else {
      pushLive(text);
    }
  }

  function cancelAnimation() {
    if (!rafId) return;
    win.cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function snapReducedState() {
    if (destroyed) return;
    cancelAnimation();
    edge = target;
    positionVelocity = 0;
    pointerVelocity = 0;
    overshoot = 0;
    bend = 0;
    bendVelocity = 0;
    shift = 0;
    shiftVelocity = 0;
    length = REST_LENGTH;
    const show = showTarget() ? 1 : 0;
    reveal = show;
    stroke = REST_STROKE * show;
    colorChannel = REST_COLOR;
    render();
  }

  function startAnimation() {
    if (destroyed) return;
    if (reducedMotion) {
      snapReducedState();
      return;
    }
    if (rafId) return;
    lastFrameTime = now();
    rafId = win.requestAnimationFrame(onFrame);
  }

  function settlePointerVelocity() {
    if (!dragging || now() - lastMoveAt > IDLE_POINTER_MS) {
      pointerVelocity = 0;
    }
  }

  function geometryTargets() {
    settlePointerVelocity();

    const direction = clamp(pointerVelocity / 60, -1, 1);
    const overRatio = clamp01(Math.abs(overshoot) / 80);
    const motion = Math.max(
      Math.abs(direction) * (1 - overRatio),
      overRatio,
    );
    const show = showTarget() ? 1 : 0;

    return {
      direction,
      overRatio,
      motion,
      bendTarget: MAX_BEND * direction * (1 - overRatio),
      shiftTarget:
        MAX_SHIFT * direction * (1 - overRatio) +
        OVER_SHIFT * Math.sign(overshoot) * overRatio,
      lengthTarget: REST_LENGTH + 30 * motion + 21 * overRatio,
      strokeTarget: (REST_STROKE - 10 * motion - 2 * overRatio) * show,
      revealTarget: show,
    };
  }

  function renderEdge() {
    scene.style.setProperty("--epr-edge", `${edge}px`);
  }

  function render() {
    renderEdge();

    const centerX = 40 + shift;
    const topY = 80 - length / 2;
    const bottomY = 80 + length / 2;
    const controlX = 40 + shift + 2 * bend;
    const path = `M ${centerX} ${topY} Q ${controlX} 80 ${centerX} ${bottomY}`;

    outerPath.setAttribute("d", path);
    innerPath.setAttribute("d", path);
    outerPath.setAttribute("stroke-width", `${Math.max(0, stroke + 2 * reveal)}`);
    innerPath.setAttribute("stroke-width", `${Math.max(0, stroke)}`);

    const channel = clamp(Math.round(colorChannel), 0, 255);
    innerPath.setAttribute("stroke", `rgb(${channel}, ${channel}, ${channel})`);
    handle.style.opacity = `${clamp01(reveal)}`;
  }

  function onFrame(timestamp) {
    rafId = 0;
    if (destroyed) return;

    const frameTime = Number.isFinite(timestamp) ? timestamp : now();
    const dt = clamp((frameTime - lastFrameTime) / 1000, 0, MAX_FRAME_DT);
    lastFrameTime = frameTime;

    if (reducedMotion) {
      snapReducedState();
      return;
    }

    const geometry = geometryTargets();

    if (!dragging) {
      const substep = dt / SUBSTEPS;
      for (let step = 0; step < SUBSTEPS; step += 1) {
        positionVelocity +=
          (target - edge) * POSITION_STIFFNESS * substep -
          positionVelocity * POSITION_DAMPING * substep;
        edge += positionVelocity * substep;
      }
    }

    const bendStep = dt / SUBSTEPS;
    for (let step = 0; step < SUBSTEPS; step += 1) {
      bendVelocity +=
        (geometry.bendTarget - bend) * BEND_STIFFNESS * bendStep -
        bendVelocity * BEND_DAMPING * bendStep;
      bend += bendVelocity * bendStep;

      shiftVelocity +=
        (geometry.shiftTarget - shift) * BEND_STIFFNESS * bendStep -
        shiftVelocity * BEND_DAMPING * bendStep;
      shift += shiftVelocity * bendStep;
    }

    const shapeFactor = 1 - Math.exp(-SHAPE_RATE * dt);
    stroke += (geometry.strokeTarget - stroke) * shapeFactor;
    length += (geometry.lengthTarget - length) * shapeFactor;
    reveal += (geometry.revealTarget - reveal) * shapeFactor;
    colorChannel = REST_COLOR - DARK_COLOR * geometry.motion;

    render();

    if (needsFrame()) {
      rafId = win.requestAnimationFrame(onFrame);
    } else {
      settle();
    }
  }

  function needsFrame() {
    if (destroyed) return false;

    settlePointerVelocity();

    if (dragging && now() - lastMoveAt <= DRAGGING_KEEPALIVE_MS) {
      return true;
    }

    if (
      !dragging &&
      (Math.abs(target - edge) >= 0.01 || Math.abs(positionVelocity) >= 0.05)
    ) {
      return true;
    }

    const geometry = geometryTargets();

    if (
      Math.abs(geometry.bendTarget - bend) >= 0.01 ||
      Math.abs(bendVelocity) >= 0.03
    ) {
      return true;
    }
    if (
      Math.abs(geometry.shiftTarget - shift) >= 0.01 ||
      Math.abs(shiftVelocity) >= 0.03
    ) {
      return true;
    }
    if (
      Math.abs(geometry.lengthTarget - length) >= 0.01 ||
      Math.abs(geometry.strokeTarget - stroke) >= 0.01 ||
      Math.abs(geometry.revealTarget - reveal) >= 0.001
    ) {
      return true;
    }

    return false;
  }

  function settle() {
    if (dragging) return;

    edge = target;
    positionVelocity = 0;
    bend = 0;
    shift = 0;
    bendVelocity = 0;
    shiftVelocity = 0;
    length = REST_LENGTH;
    const show = showTarget() ? 1 : 0;
    reveal = show;
    stroke = REST_STROKE * show;
    colorChannel = REST_COLOR;
    render();
  }

  function scheduleHide(force = false) {
    if (destroyed || dragging || hovered || focused) return;
    if (!force && reveal <= 0.001 && stroke <= 0.001) {
      linger = false;
      return;
    }

    linger = true;
    clearHideTimer();
    hideTimer = win.setTimeout(() => {
      hideTimer = 0;
      if (destroyed || dragging || hovered || focused) return;
      linger = false;
      if (reducedMotion) {
        reveal = 0;
        stroke = 0;
        length = REST_LENGTH;
        bend = 0;
        shift = 0;
        bendVelocity = 0;
        shiftVelocity = 0;
        render();
      } else {
        startAnimation();
      }
    }, HIDE_DELAY);
  }

  function pointInHit(clientX, clientY) {
    const rect = hit.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }

  function localPointerX(clientX) {
    const rect = scene.getBoundingClientRect();
    if (!(rect.width > 0)) return null;
    return ((clientX - rect.left) / rect.width) * DESIGN_WIDTH;
  }

  function removeDragWindowListeners() {
    for (const cleanup of dragWindowCleanups) cleanup();
    dragWindowCleanups = [];
  }

  function addDragWindowListeners() {
    removeDragWindowListeners();
    listenDragWindow("pointermove", onDragMove, { passive: false });
    listenDragWindow("pointerup", onDragUp);
    listenDragWindow("pointercancel", onDragCancel);
    listenDragWindow("keydown", onWindowKeyDown, true);
    listenDragWindow("blur", onWindowBlur);
  }

  function finishDrag({ restore, pointerType, clientX, clientY }) {
    if (!dragState) return;

    const state = dragState;
    const pressTarget = state.pressTarget;
    const changed = Math.abs(target - pressTarget) > 0.0001;

    dragState = null;
    dragging = false;
    removeDragWindowListeners();

    if (restore) {
      target = clamp(pressTarget, MIN_POSITION, MAX_POSITION);
    }

    overshoot = 0;
    pointerVelocity = 0;
    positionVelocity = 0;
    lastMoveAt = 0;

    try {
      if (hit.hasPointerCapture(state.pointerId)) {
        hit.releasePointerCapture(state.pointerId);
      }
    } catch {
      // The capture may already have been lost; nothing else to do.
    }

    const inside =
      pointerType !== "touch" && pointInHit(clientX, clientY);
    hovered = inside;
    if (inside) {
      clearHideTimer();
      linger = false;
    } else {
      // Force the grace period for a completed press/pull. A very short touch
      // tap can end before the first show frame; without this the press would
      // never produce any visible feedback.
      scheduleHide(true);
    }

    if (reducedMotion) {
      edge = target;
    }
    startAnimation();
    syncAria();

    if (restore) {
      emitChange();
      announceWidth("已取消", 0);
    } else if (changed) {
      emitChange();
      announceWidth("", 0);
    }
  }

  function onPointerDown(event) {
    if (destroyed || dragging) return;
    if (event.button !== 0) return;
    if (event.pointerType === "touch" && event.isPrimary === false) return;

    const localX = localPointerX(event.clientX);
    if (localX === null) return;

    const grabOffset = localX - edge;

    dragState = {
      pointerId: event.pointerId,
      pointerType: event.pointerType || "mouse",
      grabOffset,
      pressTarget: target,
      lastRaw: edge,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      startTarget: event.target,
    };
    dragging = true;
    pointerVelocity = 0;
    positionVelocity = 0;
    overshoot = 0;
    lastMoveAt = now();

    clearHideTimer();
    linger = false;
    if (event.pointerType !== "touch") hovered = true;

    try {
      hit.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort; window listeners still cover moves
      // while the pointer is over the page.
    }

    addDragWindowListeners();
    startAnimation();
    syncAria();

    if (event.cancelable) event.preventDefault();
  }

  function onDragMove(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;

    const localX = localPointerX(event.clientX);
    if (localX === null) return;

    const raw = localX - dragState.grabOffset;
    const eventNow = now();
    const elapsed = Math.max(
      (eventNow - lastMoveAt) / 1000,
      POINTER_SPEED_DT,
    );
    const delta = raw - dragState.lastRaw;

    pointerVelocity = clamp(
      delta / elapsed,
      -MAX_POINTER_SPEED,
      MAX_POINTER_SPEED,
    );

    dragState.lastRaw = raw;
    dragState.lastClientX = event.clientX;
    dragState.lastClientY = event.clientY;
    lastMoveAt = eventNow;

    const nextTarget = clamp(raw, MIN_POSITION, MAX_POSITION);
    const nextOvershoot = raw - nextTarget;
    const targetChanged = Math.abs(nextTarget - target) > 0.0001;

    target = nextTarget;
    overshoot = nextOvershoot;

    if (reducedMotion) {
      edge = target;
      overshoot = 0;
      pointerVelocity = 0;
      startAnimation();
    } else {
      edge =
        nextOvershoot === 0
          ? nextTarget
          : nextTarget +
            Math.sign(nextOvershoot) *
              RUBBER_DISTANCE *
              (1 -
                Math.exp(
                  -Math.abs(nextOvershoot) / RUBBER_DECAY,
                ));
      renderEdge();
      startAnimation();
    }

    if (targetChanged) {
      syncAria();
      emitChange();
    }

    if (event.cancelable) event.preventDefault();
  }

  function onDragUp(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;

    finishDrag({
      restore: false,
      pointerType: event.pointerType || dragState.pointerType,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  }

  function onDragCancel(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;

    finishDrag({
      restore: true,
      pointerType: event.pointerType || dragState.pointerType,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  }

  function onLostPointerCapture(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;

    finishDrag({
      restore: false,
      pointerType: dragState.pointerType,
      clientX: dragState.lastClientX,
      clientY: dragState.lastClientY,
    });
  }

  function onWindowKeyDown(event) {
    if (event.key !== "Escape" || !dragState) return;

    event.preventDefault();
    event.stopPropagation();
    finishDrag({
      restore: true,
      pointerType: dragState.pointerType,
      clientX: dragState.lastClientX,
      clientY: dragState.lastClientY,
    });
  }

  function onWindowBlur() {
    if (!dragState) return;

    finishDrag({
      restore: true,
      pointerType: dragState.pointerType,
      clientX: dragState.lastClientX,
      clientY: dragState.lastClientY,
    });
  }

  function onPointerEnter(event) {
    if (event.pointerType === "touch") return;
    hovered = true;
    clearHideTimer();
    linger = false;
    startAnimation();
  }

  function onPointerLeave(event) {
    if (event.pointerType === "touch") return;
    hovered = false;
    if (!dragging) scheduleHide();
  }

  function onFocus() {
    focused = true;
    clearHideTimer();
    linger = false;
    startAnimation();
  }

  function onBlur() {
    focused = false;
    if (!dragging && !hovered) scheduleHide();
  }

  function resetToInitial(prefix) {
    clearHideTimer();
    linger = false;
    pointerVelocity = 0;
    overshoot = 0;
    positionVelocity = 0;

    const changed = Math.abs(target - initialPosition) > 0.0001;
    target = initialPosition;

    if (reducedMotion) edge = target;
    startAnimation();
    syncAria();
    if (changed) emitChange();
    announceWidth(prefix, 0);
  }

  function onDoubleClick(event) {
    if (event.cancelable) event.preventDefault();
    resetToInitial("已重置");
  }

  function onKeyDown(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === "Escape") {
      event.preventDefault();
      resetToInitial("已重置");
      return;
    }

    let next = target;
    if (event.key === "ArrowLeft") {
      const step = event.shiftKey ? DESIGN_WIDTH * 0.06 : DESIGN_WIDTH * 0.02;
      next = target - step;
    } else if (event.key === "ArrowRight") {
      const step = event.shiftKey ? DESIGN_WIDTH * 0.06 : DESIGN_WIDTH * 0.02;
      next = target + step;
    } else if (event.key === "Home") {
      next = MIN_POSITION;
    } else if (event.key === "End") {
      next = MAX_POSITION;
    } else {
      return;
    }

    event.preventDefault();
    next = clamp(next, MIN_POSITION, MAX_POSITION);

    if (Math.abs(next - target) < 0.0001) return;

    clearHideTimer();
    linger = false;
    target = next;
    pointerVelocity = 0;
    overshoot = 0;
    positionVelocity = 0;

    if (reducedMotion) edge = target;
    startAnimation();
    syncAria();
    emitChange();
    announceWidth("", 160);
  }

  listen(hit, "pointerdown", onPointerDown);
  listen(hit, "pointerenter", onPointerEnter);
  listen(hit, "pointerleave", onPointerLeave);
  listen(hit, "lostpointercapture", onLostPointerCapture);
  listen(hit, "focus", onFocus);
  listen(hit, "blur", onBlur);
  listen(hit, "keydown", onKeyDown);
  listen(hit, "dblclick", onDoubleClick);
  listen(hit, "dragstart", (event) => event.preventDefault());

  syncAria();
  render();

  return {
    setViewportWidth(width) {
      if (destroyed) return;
      if (!isFiniteNumber(width) || width <= 0) return;

      // Keep all geometry in design pixels and scale the stage itself. A zero
      // observation is ignored so a hidden/preview first frame cannot divide
      // by zero; the first positive measurement simply updates the scale.
      const scale = width / DESIGN_WIDTH;
      scene.style.transform = `scale(${scale})`;
    },

    setSystemReducedMotion(matches) {
      if (destroyed) return;
      systemReduced = Boolean(matches);
      const next = typeof reducedOverride === "boolean"
        ? reducedOverride
        : systemReduced;
      if (next === reducedMotion) return;
      reducedMotion = next;
      if (reducedMotion) snapReducedState();
    },

    updateOptions(nextOptions) {
      if (destroyed || !nextOptions || typeof nextOptions !== "object") return;

      if (hasOwn(nextOptions, "height")) {
        const nextHeight = normalizeHeight(
          nextOptions.height,
          DEFAULT_DESIGN_HEIGHT,
        );
        if (nextHeight !== designHeight) applyHeight(nextHeight);
      }

      if (hasOwn(nextOptions, "reducedMotion")) {
        reducedOverride =
          typeof nextOptions.reducedMotion === "boolean"
            ? nextOptions.reducedMotion
            : undefined;
        const next = typeof reducedOverride === "boolean"
          ? reducedOverride
          : systemReduced;
        if (next !== reducedMotion) {
          reducedMotion = next;
          if (reducedMotion) snapReducedState();
        }
      }

      if (hasOwn(nextOptions, "ariaLabel")) {
        applyAriaLabel(nextOptions.ariaLabel);
      }

      if (hasOwn(nextOptions, "onChange")) {
        onChange =
          typeof nextOptions.onChange === "function"
            ? nextOptions.onChange
            : null;
      }
    },

    getState: stateSnapshot,

    focus() {
      if (destroyed) return;
      try {
        hit.focus({ preventScroll: true });
      } catch {
        hit.focus();
      }
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;

      cancelAnimation();
      clearHideTimer();
      if (announceTimer) {
        win.clearTimeout(announceTimer);
        announceTimer = 0;
      }
      if (liveTimer) {
        win.clearTimeout(liveTimer);
        liveTimer = 0;
      }

      removeDragWindowListeners();

      if (dragState) {
        const pointerId = dragState.pointerId;
        dragState = null;
        dragging = false;
        try {
          if (hit.hasPointerCapture(pointerId)) {
            hit.releasePointerCapture(pointerId);
          }
        } catch {
          // The element may already be detached.
        }
      }

      for (const cleanup of permanentCleanups) cleanup();
      permanentCleanups.length = 0;

      onChange = null;
      live.textContent = "";
    },
  };
}

export default createElasticPanelResizeEngine;
