/**
 * 元素样式控件（自 App.tsx 拆出）：色板预设、线形/角形小样、SwatchRow、SegGroup、页面背景预设。
 */
import type { FC, ReactNode } from "react";
import { ColorPicker } from "@/components/ui/color-picker";
import { cn } from "@/lib/utils";

/* ---------------- 元素样式控件（参考 Excalidraw 元素面板：色板条 + 分段） ---------------- */

/** 描边色预设（深色系 + 品牌绿/警示红/白） */
export const STROKE_PRESETS = ["#1d1d1f", "#166534", "#dc2626", "#2563eb", "#f59e0b", "#7c3aed", "#0d9488", "#ffffff"];
/** 背景色预设（浅色系 + 淡黄） */
export const SHAPE_BG_PRESETS = ["#f5f5f7", "#dcfce7", "#dbeafe", "#fee2e2", "#fef3c7", "#f4f692", "#ede9fe", "#ffffff"];
/** 文字色预设 */
export const TEXT_PRESETS = ["#1d1d1f", "#52525b", "#ffffff", "#166534", "#dc2626", "#2563eb", "#f59e0b", "#7c3aed"];

/** 线形小样（实线/虚线/点线） */
export const StrokeGlyph: FC<{ dash?: string }> = ({ dash }) => (
  <svg viewBox="0 0 26 8" className="h-2 w-6" aria-hidden>
    <line x1="1.5" y1="4" x2="24.5" y2="4" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" {...(dash ? { strokeDasharray: dash } : {})} />
  </svg>
);

/** 角形小样（直角/圆角） */
export const CornerGlyph: FC<{ round?: boolean }> = ({ round }) => (
  <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
    <path d="M2 14 V6 A4 4 0 0 1 6 2 H14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" {...(round ? {} : { d: "M2 14 V2 H14" })} />
  </svg>
);

/** 色板条：一行预设色 + 「无」/「自定义」两颗带字入口（点开完整 ColorPicker） */
export const SwatchRow: FC<{
  presets: string[];
  value?: string;
  ariaLabel: string;
  onPick: (hex: string) => void;
  /** 传了就显示「无」 */
  onNone?: () => void;
}> = ({ presets, value, ariaLabel, onPick, onNone }) => {
  const cur = (value ?? "").toLowerCase();
  const none = cur === "" || cur === "none";
  return (
    <div className="flex flex-col gap-2">
      {/* 8 颗 × 24px + 4px 间距：贴着分组卡内宽的上限排，避免撑出横向滚动 */}
      <div className="flex items-center gap-1">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            title={p}
            aria-label={`${ariaLabel} ${p}`}
            onClick={() => onPick(p)}
            className={cn(
              "size-6 shrink-0 rounded-md ring-1 ring-black/15 ring-inset transition-transform hover:scale-110 active:scale-95",
              cur === p && "ring-2 ring-ink",
            )}
            style={{ backgroundColor: p }}
          />
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        {onNone && (
          <button
            type="button"
            title="无颜色"
            aria-label={`${ariaLabel} 无`}
            onClick={onNone}
            aria-pressed={none}
            className={cn(
              "border-border text-muted-foreground hover:text-foreground flex h-7 items-center gap-1.5 rounded-lg border px-2 text-[11px] transition-colors",
              none && "border-ink text-foreground",
            )}
          >
            {/* 白底 + 斜杠 = 经典"无填充"符号 */}
            <span
              className="size-3.5 rounded-[4px] ring-1 ring-black/15 ring-inset"
              style={{ background: "linear-gradient(135deg, transparent 42%, #ef4444 42%, #ef4444 58%, transparent 58%), #ffffff" }}
            />
            无
          </button>
        )}
        <ColorPicker variant="palette" size="sm" color={value} onChange={onPick} aria-label={`${ariaLabel} 自定义`} />
      </div>
    </div>
  );
};

/** 分段单选（边框样式/边角/线条风格这类三选一） */
export const SegGroup = <T extends string>({
  value,
  options,
  ariaLabel,
  onChange,
  className,
}: {
  value: T;
  options: { v: T; node: ReactNode; title: string }[];
  ariaLabel: string;
  onChange: (v: T) => void;
  className?: string;
}) => (
  <div className={cn("bg-secondary/60 flex items-center gap-0.5 rounded-lg p-0.5", className)} role="group" aria-label={ariaLabel}>
    {options.map((o) => (
      <button
        key={o.v}
        type="button"
        title={o.title}
        aria-label={`${ariaLabel} ${o.title}`}
        aria-pressed={value === o.v}
        onClick={() => onChange(o.v)}
        className={cn(
          "flex h-7 min-w-0 flex-1 items-center justify-center rounded-sm transition-colors",
          value === o.v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {o.node}
      </button>
    ))}
  </div>
);
