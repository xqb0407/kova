"use client";

import { MotionConfig } from "framer-motion";
import type { ReactNode } from "react";

/**
 * 全局动效偏好：系统开启「减弱动效」时，framer 的位移/布局弹簧自动降级为
 * 仅透明度过渡。此前只有个别组件各自调用 useReducedMotion，覆盖不到 26 个
 * 使用 framer 的组件；包在应用根部后统一生效，组件内无需重复判断。
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
