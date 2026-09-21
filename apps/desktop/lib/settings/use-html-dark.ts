"use client";

import { useEffect, useState } from "react";

/**
 * 读取 <html> 上生效的 .dark 类（由 lib/ui-prefs applyPrefs 维护，
 * 含"跟随系统"模式下 matchMedia 的动态切换）。MutationObserver 保证
 * 与 ui-prefs 内部监听解耦：无论谁改了类，订阅方都能拿到最新值。
 */
export function useHtmlDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains("dark"));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return dark;
}
