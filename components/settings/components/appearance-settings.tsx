"use client";

import { useState, type FC } from "react";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri";
import {
  setWindowEffect,
  useWindowEffect,
  type WindowEffectName,
} from "@/lib/appearance";
import { CheckIcon } from "lucide-react";

const EFFECT_OPTIONS: {
  value: WindowEffectName;
  label: string;
  desc: string;
}[] = [
  { value: "none", label: "不透明", desc: "默认纯色背景，性能最好" },
  {
    value: "acrylic",
    label: "高斯模糊",
    desc: "穿透模糊桌面背景（Windows Acrylic，macOS 使用系统材质）",
  },
  { value: "mica", label: "Mica", desc: "Windows 11 系统材质，随桌面壁纸色调" },
];

/** 外观配置页：窗口背景材质（穿透高斯模糊），仅桌面端可设置 */
export const AppearanceSettings: FC = () => {
  const effect = useWindowEffect();
  const [busy, setBusy] = useState<WindowEffectName | null>(null);

  if (!isTauri()) {
    return (
      <div className="text-muted-foreground p-5 text-sm">
        外观设置依赖桌面端窗口能力，请在 Tauri 应用中打开设置。
      </div>
    );
  }

  const pick = (value: WindowEffectName) => {
    if (value === effect || busy) return;
    setBusy(value);
    void setWindowEffect(value).finally(() => setBusy(null));
  };

  return (
    <div className="flex flex-col gap-4  h-full p-5 overflow-hidden">
      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium">窗口背景</div>
        <div className="text-muted-foreground text-xs">
          启用穿透效果后界面为半透明底色，可看到桌面模糊背景；效果由系统渲染，拖动窗口可能轻微掉帧。
        </div>
      </div>
      <div className="flex flex-col gap-2 ">
        {EFFECT_OPTIONS.map((opt) => {
          const active = effect === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              disabled={busy !== null}
              onClick={() => pick(opt.value)}
              data-active={active}
              className={cn(
                "hover:bg-muted/50 flex flex-col gap-0.5 rounded-lg border p-3 text-left transition-colors",
                "disabled:cursor-not-allowed disabled:opacity-60",
                active && "border-primary ring-primary/30 ring-1",
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{opt.label}</span>
                {active && <CheckIcon className="text-primary size-4" />}
              </div>
              <span className="text-muted-foreground text-xs">{opt.desc}</span>
            </button>
          );
        })}
      </div>
      <div className="text-muted-foreground text-xs shrink-0">
        高斯模糊（Acrylic）需 Windows 10 1809+，Mica 需 Windows
        11；不支持时自动回退不透明。
      </div>
    </div>
  );
};
