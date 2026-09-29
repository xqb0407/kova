/**
 * 颜色选择器（Inspector 用）：HSV 面板 + 色相条 + hex/rgb/hsl 输入 + 预设。
 *
 * 形态参考 shadcn 社区版 ColorPicker（Popover + 面板 + 预设格），两处按本项目调整：
 *   1. 不引 motion 依赖——动效全用 CSS 过渡（插件产物要控在体积红线内）；
 *   2. 输出统一 #rrggbb（文档里 fill/stroke/background 的颜色约定），
 *      而不是 rgb(...)；遇到 CSS 渐变串取其中第一个 hex（firstHex）。
 * 清除颜色留在 ColorField 行内（面板里不重复放"清除"）。
 */
import { useEffect, useRef, useState, type FC } from "react";
import { CheckIcon } from "lucide-react";
import { Input } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { cn } from "@/lib/utils";

/* ---------------- 颜色换算 ---------------- */

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

function toHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** rgb → hsv（h 0..360，s/v 0..1） */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

/** hsv → rgb */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const k = (n: number) => (n + h / 60) % 6;
  const f = (n: number) => v - c * Math.max(0, Math.min(k(n), 4 - k(n), 1));
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}

/** 任意 CSS 颜色串 → #rrggbb；识别不了返回 null */
function parseColor(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(s)) {
    if (s.length === 4) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
    return s;
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
  if (rgb) return toHex(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  const hsl = /^hsla?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%/.exec(s);
  if (hsl) {
    const h = Number(hsl[1]);
    const sat = Number(hsl[2]) / 100;
    const lig = Number(hsl[3]) / 100;
    const a = sat * Math.min(lig, 1 - lig);
    const k = (n: number) => (n + h / 30) % 12;
    const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return toHex(f(0) * 255, f(8) * 255, f(4) * 255);
  }
  return null;
}

/** 从任意色值（含 CSS 渐变串）里取第一个可识别颜色 */
export function firstHexOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const direct = parseColor(value);
  if (direct) return direct;
  const m = value.match(/#[0-9a-fA-F]{3,8}/);
  return m ? parseColor(m[0]) : null;
}

/* ---------------- 预设 ---------------- */

/** iOS 系统色（参考实现的同一组） */
const IOS_PRESETS = ["#FF3B30", "#FF9500", "#FFCC00", "#4CD964", "#5AC8FA", "#007AFF", "#5856D6", "#FF2D55", "#8E8E93", "#EFEFF4", "#E5E5EA", "#D1D1D6"];
/** 项目色板：森林绿 CTA / 淡黄 / 墨黑 / 白 / 浅灰 / 警示红 */
const BRAND_PRESETS = ["#166534", "#f4f692", "#1d1d1f", "#ffffff", "#f5f5f7", "#dc2626"];

/* ---------------- 组件 ---------------- */

export const ColorPicker: FC<{
  /** 当前色值（可为 #hex / rgb() / CSS 渐变串；空 = 无颜色） */
  color: string | undefined;
  onChange: (hex: string) => void;
  "aria-label"?: string;
  /** 触发外观：current=显示当前色圆点（默认）；palette=彩虹调色盘（"自定义"入口用，不显示当前色） */
  variant?: "current" | "palette";
  /** 触发尺寸：md=36px（独立一行用）；sm=28px（与色板条同行用） */
  size?: "md" | "sm";
}> = ({ color, onChange, "aria-label": ariaLabel, variant = "current", size = "md" }) => {
  const [open, setOpen] = useState(false);
  const seed = firstHexOrNull(color) ?? "#1d1d1f";
  const [hsv, setHsv] = useState<[number, number, number]>(() => {
    const [r, g, b] = hexToRgb(seed);
    return rgbToHsv(r, g, b);
  });
  const [draft, setDraft] = useState(seed);
  const areaRef = useRef<HTMLDivElement | null>(null);

  /** 外部色值变化（换选中/撤销/预设）时同步面板；面板正显示同一个颜色就不动，避免拖动被回写打断 */
  useEffect(() => {
    const h = firstHexOrNull(color);
    if (!h) return;
    const [r, g, b] = hsvToRgb(hsv[0], hsv[1], hsv[2]);
    if (toHex(r, g, b) === h.toLowerCase()) return;
    const [nr, ng, nb] = hexToRgb(h);
    setHsv(rgbToHsv(nr, ng, nb));
    setDraft(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color]);

  /** 已知 hex 的场景（预设/手动输入）：原样落色，避免 hsv 往返丢精度；面板标记仍按其 hsv 摆 */
  const applyHex = (hex: string) => {
    const [r, g, b] = hexToRgb(hex);
    setHsv(rgbToHsv(r, g, b));
    setDraft(hex.toLowerCase());
    onChange(hex.toLowerCase());
  };

  const apply = (next: [number, number, number]) => {
    setHsv(next);
    const [r, g, b] = hsvToRgb(next[0], next[1], next[2]);
    const hex = toHex(r, g, b);
    setDraft(hex);
    onChange(hex);
  };

  const pickFromEvent = (clientX: number, clientY: number) => {
    const el = areaRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const s = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const v = 1 - Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    apply([hsv[0], s, v]);
  };

  const onDraft = (text: string) => {
    setDraft(text);
    const parsed = parseColor(text);
    if (!parsed) return;
    const [r, g, b] = hexToRgb(parsed);
    setHsv(rgbToHsv(r, g, b));
    onChange(parsed);
  };

  const swatch = (hex: string, active: boolean, onPick: (h: string) => void) => (
    <button
      key={hex}
      type="button"
      aria-label={hex}
      onClick={() => onPick(hex)}
      className={cn(
        "relative size-7 rounded-full ring-1 ring-black/15 ring-inset transition-transform hover:scale-110 active:scale-95",
        active && "ring-2 ring-primary",
      )}
      style={{ backgroundColor: hex }}
    >
      {active && <CheckIcon className="absolute inset-0 m-auto size-3.5 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]" />}
    </button>
  );

  const current = firstHexOrNull(color);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel ?? "选择颜色"}
          className={cn("hover:bg-accent flex shrink-0 items-center justify-center rounded-full transition-colors", size === "sm" ? "size-7" : "size-9")}
        >
          {variant === "palette" ? (
            /* 自定义入口：彩虹盘 + 铅笔，不显示当前色（当前色由上方色板的高亮表达） */
            <span
              className={cn("flex items-center justify-center rounded-full ring-1 ring-black/15 ring-inset", size === "sm" ? "size-5" : "size-6")}
              style={{ background: "conic-gradient(from 0deg, #ff3b30, #ff9500, #ffcc00, #4cd964, #5ac8fa, #007aff, #5856d6, #ff2d55, #ff3b30)" }}
            >
              <span className="text-[9px] leading-none font-bold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.55)]">+</span>
            </span>
          ) : (
            /* 色块本身带极细内描边：白色/浅色也要看得见边界；按钮不再画方框 */
            <span
              className={cn("rounded-full shadow-sm ring-1 ring-black/15 ring-inset", size === "sm" ? "size-5" : "size-6")}
              style={{ backgroundColor: current ?? "transparent" }}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[248px] p-3"
        align="end"
        // 面板内按住拖取（饱和度/明度区、色相条）会让焦点移出内容层，
        // Radix 默认按"焦点跑到外面"收起面板——这里挡住，拖到一半面板消失就取样不成了。
        onFocusOutside={(e) => e.preventDefault()}
      >
        <div className="space-y-3">
          {/* 饱和度 × 明度面板（横轴饱和 / 纵轴明度，指针拖拽取样） */}
          <div
            ref={areaRef}
            tabIndex={-1}
            className="relative h-40 w-full cursor-crosshair touch-none overflow-hidden rounded-lg ring-1 ring-black/10 outline-none"
            style={{
              background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv[0]}, 100%, 50%))`,
            }}
            onPointerDown={(e) => {
              e.preventDefault();
              (e.currentTarget as HTMLElement).focus?.();
              (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
              pickFromEvent(e.clientX, e.clientY);
            }}
            onPointerMove={(e) => {
              if ((e.buttons & 1) === 0) return;
              pickFromEvent(e.clientX, e.clientY);
            }}
          >
            <span
              className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-md transition-transform"
              style={{
                left: `${hsv[1] * 100}%`,
                top: `${(1 - hsv[2]) * 100}%`,
                backgroundColor: draft,
              }}
            />
          </div>

          {/* 色相条 */}
          <input
            type="range"
            min={0}
            max={360}
            value={hsv[0]}
            aria-label="色相"
            onChange={(e) => apply([Number(e.target.value), hsv[1], hsv[2]])}
            className="sc-hue w-full cursor-pointer"
            style={{
              background:
                "linear-gradient(to right, hsl(0,100%,50%), hsl(60,100%,50%), hsl(120,100%,50%), hsl(180,100%,50%), hsl(240,100%,50%), hsl(300,100%,50%), hsl(360,100%,50%))",
            }}
          />

          {/* 文本输入：支持 #hex / rgb() / hsl() */}
          <div className="flex items-center gap-2">
            <Input
              type="text"
              value={draft}
              onChange={(e) => onDraft(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="#RRGGBB / rgb() / hsl()"
              className="h-8 min-w-0 flex-1 px-2 text-xs"
              aria-label="颜色值"
            />
            <span className="border-border size-8 shrink-0 rounded-md border shadow-sm" style={{ backgroundColor: draft }} />
          </div>

          {/* 预设：iOS 系统色 + 项目色板 */}
          <div className="grid grid-cols-6 gap-2">{IOS_PRESETS.map((p) => swatch(p, current?.toLowerCase() === p.toLowerCase(), (h) => apply(rgbToHsv(...hexToRgb(h)) as [number, number, number])))}</div>
          <div className="bg-border h-px w-full" />
          <div className="grid grid-cols-6 gap-2">{BRAND_PRESETS.map((p) => swatch(p, current?.toLowerCase() === p.toLowerCase(), (h) => apply(rgbToHsv(...hexToRgb(h)) as [number, number, number])))}</div>
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default ColorPicker;
