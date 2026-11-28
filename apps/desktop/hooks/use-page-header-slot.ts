"use client";

import { useEffect, useState } from "react";

/**
 * 应用顶栏「页面页头动作」槽位（`[data-slot="page-header-actions"]`）：
 * 页面视图（收件箱/自动化/资料库/插件/远程）把各自的页头内容（标题、返回、
 * 刷新、工具条）portal 到这里，内容区不再自画一条 48px 的 header。
 *
 * 槽位的两个宿主并存：
 * - 桌面端：壳层顶部 chrome 条（始终可见）；
 * - 移动端：页内 Header（chrome 条在 <md 隐藏）。
 * 取「最后一个可见」的槽位：设置覆层等后渲染的层叠在上层，取后者才不会被
 * 底下被遮住的槽位抢走；`offsetParent === null` 跳过 display:none 的隐藏槽位。
 * 断点变化（跨 md）时重新选取，保证移动端/桌面端切换后 portal 目标跟随。
 */
export function usePageHeaderSlot(): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const sync = () => {
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-slot="page-header-actions"]',
        ),
      );
      let picked: HTMLElement | null = null;
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const el = nodes[i]!;
        if (el.offsetParent !== null) {
          picked = el;
          break;
        }
      }
      setSlot(picked);
    };
    sync();
    const mq = window.matchMedia("(min-width: 768px)");
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  return slot;
}
