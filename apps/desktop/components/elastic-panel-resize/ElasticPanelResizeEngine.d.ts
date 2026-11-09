/**
 * Public types for ElasticPanelResizeEngine.js.
 *
 * The engine is deliberately framework-agnostic: it only knows a ShadowRoot,
 * one canvas-like scene and the pointer/keyboard model of the separator.
 */

export interface ElasticPanelResizeState {
  /** Current visible left edge, in 1000-wide design pixels. */
  position: number;
  /** Legal (un-rubber-banded) left edge, in design pixels. */
  target: number;
  /** Current visible left edge as a 0..1 ratio of the scene width. */
  ratio: number;
  /** Nominal panel width, 50..72.4, rounded to one decimal. */
  widthPercent: number;
  dragging: boolean;
  visible: boolean;
  reducedMotion: boolean;
}

export interface ElasticPanelResizeOptions {
  /**
   * Scene height in design pixels. The scene is always 1000 design pixels
   * wide and is scaled uniformly to its container, so a height of 600 renders
   * as 600 design units tall at the 1000px baseline. Defaults to 1000.
   */
  height?: number;
  /**
   * Force the reduced-motion branch. When omitted (or undefined), the system
   * `prefers-reduced-motion` preference is followed. Passing false overrides a
   * system preference of reduce.
   */
  reducedMotion?: boolean;
  /**
   * Initial left edge. Accepts either a 0..1 ratio of the scene width
   * (0.3865) or an already scaled design-pixel value (386.5). Clamped to the
   * legal 27.6%..50% range. Only read when the instance is created.
   */
  initialPosition?: number;
  /** Accessible name for the separator. Defaults to "面板宽度". */
  ariaLabel?: string;
  /** Called whenever the nominal target width changes (including mid-drag). */
  onChange?: (state: ElasticPanelResizeState) => void;
}

export interface ElasticPanelResizeEngineDeps {
  /** Root whose contents the engine owns. */
  shadow: ShadowRoot;
  /** Optional initial options. */
  options?: ElasticPanelResizeOptions;
  /** Current system reduced-motion preference. */
  systemReducedMotion?: boolean;
}

export interface ElasticPanelResizeEngineHandle {
  /**
   * Feed the rendered scene width in CSS pixels. Values <= 0 are ignored; the
   * first positive measurement sets the uniform stage scale.
   */
  setViewportWidth(width: number): void;
  /** Feed a changed system `prefers-reduced-motion` value. */
  setSystemReducedMotion(matches: boolean): void;
  /** Update height / reduced-motion / label / callback without remounting. */
  updateOptions(options: Partial<ElasticPanelResizeOptions>): void;
  getState(): ElasticPanelResizeState;
  /** Move keyboard focus to the separator. */
  focus(): void;
  /** Cancel RAF/timers/listeners/capture and make the engine inert. */
  destroy(): void;
}

export function createElasticPanelResizeEngine(
  deps: ElasticPanelResizeEngineDeps,
): ElasticPanelResizeEngineHandle;

export default createElasticPanelResizeEngine;
