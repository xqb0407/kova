"use client";

import { useSyncExternalStore } from "react";

/**
 * 浮层遮挡登记表。
 *
 * 为什么需要它：浏览器面板是独立的原生子 webview，合成在主 webview 的 DOM
 * 之上，任何 React z-index 都压不住它。全站有几十处 Dialog / Popover / Sheet
 * / 菜单 / Select 浮在主 webview 上，只要其中任意一个盖到面板区域，用户看到的
 * 就是"面板把弹窗吃掉了"。
 *
 * 过去的做法是在每个会遮挡的地方手动广播一次 `browser:occluded`——那是个人工
 * 白名单，漏一处就复现一次 bug（新手引导那处就是这么漏的：引导激活时 view 已经
 * 置回 "chat"，只看 view 必然误判）。44 个调用点各记一次，记住第 45 次是幻觉。
 *
 * 改成登记制：浮层挂载即登记、卸载即注销，谁都不用记。挂载在 ui/ 那几个
 * primitive 的 Portal 上——所有调用点都经过它们，所以改一处全站生效。
 *
 * 这里只负责"有多少个浮层开着"，不负责"要不要广播"：广播仍由 base.tsx 统一
 * 发一次，把登记数、主视图接管态（设置页/向导）、面板动画临时态三者或起来。
 */

let count = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = () => count;

const serverSnapshot = () => 0;

/** 登记一个浮层，返回注销函数（useEffect 的清理函数即注销） */
export function registerOverlay(): () => void {
  count++;
  emit();
  let released = false;
  return () => {
    // StrictMode 会双跑 effect：注销必须幂等，否则计数会漂移且永不归零，
    // 表现为"关掉所有弹窗后面板 webview 仍然不显示"
    if (released) return;
    released = true;
    count = Math.max(0, count - 1);
    emit();
  };
}

/** 当前是否有任意浮层打开 */
export function useOverlayPresent(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot) > 0;
}

/** 仅供测试读取当前计数 */
export function getOverlayCountForTest(): number {
  return count;
}

/** 仅供测试清零 */
export function resetOverlayRegistryForTest(): void {
  count = 0;
  emit();
}
