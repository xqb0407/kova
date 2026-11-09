"use client";

import {
  BriefcaseIcon,
  FileBracesIcon,
  PaletteIcon,
  type LucideIcon,
} from "lucide-react";
import type { AppMode } from "@/lib/pi/app-mode";

/**
 * 工作模式档位的中文名与图标单源：欢迎页分段器（app-mode-switch）与侧栏
 * 行首档位图标（thread-list）都从这里取，避免两处各画一套。
 *
 * label 只存词典 key（common.appMode.*）——模块求值期不能调 t()，否则语言会
 * 被烧死在求值那一刻；消费方渲染时经 useT 解析。
 */
export const APP_MODE_META: Record<
  AppMode,
  { labelKey: string; icon: LucideIcon }
> = {
  code: { labelKey: "common.appMode.code", icon: FileBracesIcon },
  work: { labelKey: "common.appMode.work", icon: BriefcaseIcon },
  design: { labelKey: "common.appMode.design", icon: PaletteIcon },
};
