import {
  createElasticPanelResizeEngine,
  type ElasticPanelResizeEngineHandle,
  type ElasticPanelResizeOptions,
  type ElasticPanelResizeState,
} from "./ElasticPanelResizeEngine";

/**
 * Instance lifecycle wrapper for ElasticPanelResize.
 *
 * The engine owns physics, DOM, SVG, pointer/keyboard handling and its own
 * RAF/timers. This runtime owns everything around the instance:
 *  - the isolated ShadowRoot and its host node,
 *  - ResizeObserver / fallback window resize measurement,
 *  - the system reduced-motion media query,
 *  - update-in-place and full teardown (RAF, timers, window listeners,
 *    pointer capture, observers and media listeners).
 *
 * No DOM is touched at module evaluation time, so the module is safe to import
 * during SSR. Every mount creates fresh state; multiple hosts never share
 * mutable state.
 */

export interface MountedElasticPanelResize {
  update(options: Partial<ElasticPanelResizeOptions>): void;
  destroy(): void;
  getState(): ElasticPanelResizeState;
  focus(): void;
  readonly element: HTMLElement;
  readonly shadowRoot: ShadowRoot;
}

const mountedByHost = new WeakMap<HTMLElement, MountedElasticPanelResize>();

function hasDom(): boolean {
  return typeof document !== "undefined" && typeof window !== "undefined";
}

export function mountElasticPanelResize(
  host: HTMLElement,
  options: ElasticPanelResizeOptions = {},
): MountedElasticPanelResize {
  if (!hasDom()) {
    throw new Error(
      "ElasticPanelResize can only be mounted in a browser environment.",
    );
  }

  if (!host || host.nodeType !== Node.ELEMENT_NODE) {
    throw new TypeError(
      "ElasticPanelResize requires a host element to mount into.",
    );
  }

  // Re-mounting on the same host replaces the previous instance cleanly.
  const previous = mountedByHost.get(host);
  if (previous) previous.destroy();

  const root = document.createElement("div");
  root.setAttribute("data-elastic-panel-resize", "");
  root.style.display = "block";
  root.style.width = "100%";
  root.style.minWidth = "0";
  host.appendChild(root);

  let shadow: ShadowRoot;
  try {
    shadow = root.attachShadow({ mode: "open" });
  } catch (error) {
    root.remove();
    throw error;
  }

  const mediaQuery =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;

  let engine: ElasticPanelResizeEngineHandle;
  try {
    engine = createElasticPanelResizeEngine({
      shadow,
      options,
      systemReducedMotion: mediaQuery?.matches ?? false,
    });
  } catch (error) {
    root.remove();
    throw error;
  }

  let destroyed = false;
  let initialMeasureFrame = 0;
  let observer: ResizeObserver | null = null;
  let fallbackResizeHandler: (() => void) | null = null;

  const measure = (): void => {
    if (destroyed) return;
    const width = root.getBoundingClientRect().width;
    // Zero observations are ignored: a hidden container or a preview first
    // frame must not divide by zero. The design width stays 1000 internally
    // and the first positive width sets the uniform scale.
    if (width > 0) engine.setViewportWidth(width);
  };

  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => measure());
    observer.observe(root);
  } else {
    fallbackResizeHandler = measure;
    window.addEventListener("resize", fallbackResizeHandler, {
      passive: true,
    });
  }

  // Read once synchronously so the first paint is already at the right scale.
  measure();
  if (typeof window.requestAnimationFrame === "function") {
    initialMeasureFrame = window.requestAnimationFrame(() => {
      initialMeasureFrame = 0;
      measure();
    });
  }

  const onMotionPreferenceChange = (event: MediaQueryListEvent): void => {
    if (destroyed) return;
    engine.setSystemReducedMotion(event.matches);
  };

  if (mediaQuery) {
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", onMotionPreferenceChange);
    } else {
      mediaQuery.addListener(onMotionPreferenceChange);
    }
  }

  const mounted: MountedElasticPanelResize = {
    update(nextOptions: Partial<ElasticPanelResizeOptions>): void {
      if (destroyed) return;
      engine.updateOptions(nextOptions);
      // A height update can change the host's layout; re-read the width so
      // the stage scale stays exact without remounting.
      measure();
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;

      if (
        initialMeasureFrame &&
        typeof window.cancelAnimationFrame === "function"
      ) {
        window.cancelAnimationFrame(initialMeasureFrame);
        initialMeasureFrame = 0;
      }

      observer?.disconnect();
      observer = null;

      if (fallbackResizeHandler) {
        window.removeEventListener("resize", fallbackResizeHandler);
        fallbackResizeHandler = null;
      }

      if (mediaQuery) {
        if (typeof mediaQuery.removeEventListener === "function") {
          mediaQuery.removeEventListener("change", onMotionPreferenceChange);
        } else {
          mediaQuery.removeListener(onMotionPreferenceChange);
        }
      }

      // The engine releases pointer capture while its DOM is still attached,
      // then cancels RAF/timers/window listeners.
      engine.destroy();
      root.remove();

      if (mountedByHost.get(host) === mounted) {
        mountedByHost.delete(host);
      }
    },

    getState(): ElasticPanelResizeState {
      return engine.getState();
    },

    focus(): void {
      if (!destroyed) engine.focus();
    },

    get element(): HTMLElement {
      return host;
    },

    get shadowRoot(): ShadowRoot {
      return shadow;
    },
  };

  mountedByHost.set(host, mounted);
  return mounted;
}

export default mountElasticPanelResize;
