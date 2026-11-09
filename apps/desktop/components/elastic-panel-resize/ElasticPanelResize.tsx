"use client";

import * as React from "react";
import {
  mountElasticPanelResize,
  type MountedElasticPanelResize,
} from "./motion-runtime";
import type {
  ElasticPanelResizeOptions,
  ElasticPanelResizeState,
} from "./ElasticPanelResizeEngine";

export interface ElasticPanelResizeProps extends ElasticPanelResizeOptions {
  className?: string;
  style?: React.CSSProperties;
  id?: string;
}

/**
 * React entry for the elastic panel resize core.
 *
 * Only the host element is rendered by React. The scene, panel, SVG handle and
 * hidden status region are created inside a ShadowRoot after mount, so this
 * component never touches document.body, global CSS or global IDs.
 *
 * Changing height / reducedMotion / ariaLabel / onChange updates the existing
 * instance; it does not remount. Unmounting cancels RAF, hide and live-region
 * timers, window listeners, pointer capture, ResizeObserver and the media query
 * listener, then removes the instance. Mounting again on the same host works.
 */
export const ElasticPanelResize = React.forwardRef<
  HTMLDivElement,
  ElasticPanelResizeProps
>(function ElasticPanelResize(
  {
    height,
    reducedMotion,
    initialPosition,
    ariaLabel,
    onChange,
    className,
    style,
    id,
  },
  forwardedRef,
) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const instanceRef = React.useRef<MountedElasticPanelResize | null>(null);

  // The first render's values are used for mount. Later changes are applied by
  // the update effect below, without recreating the engine.
  const initialOptionsRef = React.useRef<ElasticPanelResizeOptions>({
    height,
    reducedMotion,
    initialPosition,
    ariaLabel,
    onChange,
  });

  const setHostRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      hostRef.current = node;
      if (typeof forwardedRef === "function") {
        forwardedRef(node);
      } else if (forwardedRef) {
        forwardedRef.current = node;
      }
    },
    [forwardedRef],
  );

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const instance = mountElasticPanelResize(
      host,
      initialOptionsRef.current,
    );
    instanceRef.current = instance;

    return () => {
      instance.destroy();
      instanceRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    instanceRef.current?.update({
      height,
      reducedMotion,
      ariaLabel,
      onChange,
    });
  }, [height, reducedMotion, ariaLabel, onChange]);

  return (
    <div
      ref={setHostRef}
      id={id}
      className={className}
      style={{
        display: "block",
        width: "100%",
        minWidth: 0,
        ...style,
      }}
      data-elastic-panel-resize-host=""
    />
  );
});

ElasticPanelResize.displayName = "ElasticPanelResize";

/**
 * Convenience type export for consumers that keep the latest state in React.
 */
export type { ElasticPanelResizeState };

export default ElasticPanelResize;
