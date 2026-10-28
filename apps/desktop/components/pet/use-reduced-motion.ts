"use client";

import * as React from "react";

/** 系统「减少动态效果」偏好（`prefers-reduced-motion: reduce`）。SSR 期间为 false。 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);

  React.useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => {
      setReduced(mql.matches);
    };
    onChange();
    mql.addEventListener("change", onChange);
    return () => {
      mql.removeEventListener("change", onChange);
    };
  }, []);

  return reduced;
}
