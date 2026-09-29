"use client";

import { useEffect } from "react";
import { registerOverlay } from "@/lib/overlay-occlusion";

/**
 * 浮层遮挡登记位：渲染在任何会浮到主 webview 之上的 Portal 里。
 *
 * 它不渲染任何东西，只在挂载期间把自己登记进遮挡表（lib/overlay-occlusion.ts），
 * 让浏览器子 webview 知道自己被盖住了。放在 ui/ 的 primitive 层而不是各个
 * 业务调用点，是因为所有 Dialog / Popover / Sheet / 菜单 / Select 都要过那一层
 * ——在那儿登记一次，全站生效，不需要谁记得补。
 */
export function OcclusionSlot(): null {
  useEffect(() => registerOverlay(), []);
  return null;
}
