"use client";

import { useEffect, useLayoutEffect } from "react";
import { forceApplyPrefs } from "@/lib/settings/ui-prefs";

/** SSR 阶段没有 layout effect，用同构别名避免 React 的 useLayoutEffect 警告 */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * 主题重放：首帧的 .dark / CSS 变量由 layout 的预绘制脚本套用，
 * 但 React 19 水合 <html> 时会按受控属性重同步，外部写入的 inline style
 * 可能被清掉（表现为刷新后暗色/壁纸闪回默认）。这里在提交后、绘制前
 * 无条件再套一次（force 会清掉增量缓存，避免误判"已经写过"）。
 */
export function ThemeRuntime() {
  useIsomorphicLayoutEffect(() => {
    forceApplyPrefs();
  }, []);
  return null;
}
