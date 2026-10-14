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
 */
export const APP_MODE_META: Record<
  AppMode,
  { label: string; icon: LucideIcon }
> = {
  code: { label: "编码", icon: FileBracesIcon },
  work: { label: "工作", icon: BriefcaseIcon },
  design: { label: "设计", icon: PaletteIcon },
};