/**
 * 文本格式浮条（选中态/编辑态共用）：字体族 · 字号 · 粗斜下划线 · 颜色 · 对齐。
 *
 * 无状态组件：当前样式由调用方给（元素态取 run 聚合，编辑态取 contentEditable 光标处），
 * 每次操作只回一个样式补丁。弹层内容统一带 data-sc-formatbar，编辑器的"点外提交"
 * 据此放行下拉/取色器里的点击（否则打开菜单就把编辑关掉了）。
 */
import { useEffect, useState, type FC } from "react";
import {
  BoldIcon,
  CheckIcon,
  ChevronDownIcon,
  ItalicIcon,
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  MinusIcon,
  PlusIcon,
  UnderlineIcon,
} from "lucide-react";
import { ColorPicker } from "@/components/ui/color-picker";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { TextAlign } from "@/doc";
import { FONT_OPTIONS, fontLabel, fontStack, round1, type RunStyle } from "./richText";
import { TEXT_PRESETS } from "./swatches";

const SIZE_PRESETS = [12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 72, 96];
/** 行距预设（倍数）——浮条与属性面板共用 */
export const LINE_HEIGHT_PRESETS = [1, 1.15, 1.35, 1.5, 1.75, 2, 2.5, 3];

const Aligns = [
  ["left", AlignLeftIcon, "左对齐"],
  ["center", AlignCenterIcon, "居中"],
  ["right", AlignRightIcon, "右对齐"],
] as const;

export const TextFormatBar: FC<{
  style: RunStyle;
  align?: TextAlign;
  showAlign?: boolean;
  onStyle: (patch: Partial<RunStyle>) => void;
  onAlign?: (align: TextAlign) => void;
  /** 行距（元素级）：给了才显示行距控件 */
  lineHeight?: number;
  onLineHeight?: (n: number) => void;
}> = ({ style, align = "left", showAlign = true, onStyle, onAlign, lineHeight, onLineHeight }) => {
  const [sizeDraft, setSizeDraft] = useState(String(round1(style.size)));
  useEffect(() => setSizeDraft(String(round1(style.size))), [style.size]);

  const applySize = (n: number) => {
    if (!Number.isFinite(n) || n < 4 || n > 400) return;
    onStyle({ size: round1(n) });
  };

  /** 字号增/减：跳到下一个/上一个常用档，越过档位则 ±2 */
  const stepSize = (dir: 1 | -1) => {
    const cur = round1(style.size);
    const candidates = SIZE_PRESETS.filter((n) => (dir > 0 ? n > cur + 0.01 : n < cur - 0.01));
    const next = dir > 0 ? (candidates[0] ?? Math.min(400, cur + 2)) : (candidates[candidates.length - 1] ?? Math.max(4, cur - 2));
    applySize(next);
  };

  return (
    <>
      {/* 字体族 */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="sc-sel-act max-w-[84px] gap-1" title="字体" aria-label="字体">
            <span className="truncate">{fontLabel(style.font)}</span>
            <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-40" data-sc-formatbar="">
          <DropdownMenuLabel className="text-muted-foreground px-2 py-1 text-[10px]">字体</DropdownMenuLabel>
          {FONT_OPTIONS.map((o) => (
            <DropdownMenuItem
              key={o.value || "default"}
              onSelect={() => onStyle({ font: o.value })}
              style={{ fontFamily: fontStack(o.value) }}
              className="text-xs"
            >
              {o.label}
              {style.font === o.value && <CheckIcon className="ml-auto size-3.5" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 字号：常用档 + 手输 + 快捷增减 */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="sc-sel-act tabular-nums" title="字号" aria-label="字号">
            {round1(style.size)}
            <ChevronDownIcon className="size-3 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-44 p-2" data-sc-formatbar="">
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              className="sc-fmt-input"
              value={sizeDraft}
              min={4}
              max={400}
              aria-label="自定义字号"
              onChange={(e) => {
                setSizeDraft(e.target.value);
                const n = Number.parseFloat(e.target.value);
                if (Number.isFinite(n)) applySize(n);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
              }}
            />
            <span className="text-muted-foreground text-[11px]">pt</span>
            <span className="text-muted-foreground ml-auto text-[10px]">字号</span>
          </div>
          <DropdownMenuSeparator />
          <div className="grid grid-cols-4 gap-1">
            {SIZE_PRESETS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => applySize(n)}
                className={cn(
                  "hover:bg-accent h-7 rounded-md text-[11px] tabular-nums transition-colors",
                  round1(style.size) === n && "bg-accent font-medium text-ink",
                )}
              >
                {n}
              </button>
            ))}
          </div>
          {onLineHeight && (
            <>
              <DropdownMenuSeparator />
              <div className="flex items-center justify-between px-0.5">
                <span className="text-muted-foreground text-[10px]">行距</span>
                <span className="text-muted-foreground text-[10px] tabular-nums">{round1(lineHeight ?? 1.35)} 倍</span>
              </div>
              <div className="mt-1 grid grid-cols-4 gap-1">
                {LINE_HEIGHT_PRESETS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => onLineHeight(n)}
                    className={cn(
                      "hover:bg-accent h-7 rounded-md text-[11px] tabular-nums transition-colors",
                      round1(lineHeight ?? 1.35) === n && "bg-accent font-medium text-ink",
                    )}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <button type="button" className="sc-sel-act" title="增大字号" aria-label="增大字号" onClick={() => stepSize(1)}>
        <PlusIcon className="size-3.5" />
      </button>
      <button type="button" className="sc-sel-act" title="减小字号" aria-label="减小字号" onClick={() => stepSize(-1)}>
        <MinusIcon className="size-3.5" />
      </button>

      <span className="sc-sel-divider" />

      {/* 粗 / 斜 / 下划线 */}
      {(
        [
          ["bold", BoldIcon, "加粗 ⌘B"],
          ["italic", ItalicIcon, "斜体 ⌘I"],
          ["underline", UnderlineIcon, "下划线 ⌘U"],
        ] as const
      ).map(([key, Icon, label]) => (
        <button
          key={key}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={style[key]}
          className={cn("sc-sel-act", style[key] && "sc-fmt-on")}
          onClick={() => onStyle({ [key]: !style[key] })}
        >
          <Icon className="size-3.5" />
        </button>
      ))}

      {/* 文字颜色 */}
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="sc-sel-act gap-1" title="文字颜色" aria-label="文字颜色">
            <span
              className="size-3.5 rounded-full ring-1 ring-black/20 ring-inset"
              style={{ backgroundColor: style.color }}
            />
            <ChevronDownIcon className="size-3 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="center" className="w-[248px] p-2.5" data-sc-formatbar="">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-muted-foreground text-[10px] font-medium tracking-wide">文字颜色</span>
            <ColorPicker variant="palette" size="sm" color={style.color} onChange={(hex) => onStyle({ color: hex })} aria-label="自定义文字颜色" />
          </div>
          <div className="flex items-center gap-1.5">
            {TEXT_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                title={p}
                aria-label={`文字颜色 ${p}`}
                onClick={() => onStyle({ color: p })}
                className={cn(
                  "size-6 rounded-md ring-1 ring-black/15 ring-inset transition-transform hover:scale-110 active:scale-95",
                  style.color.toLowerCase() === p.toLowerCase() && "ring-2 ring-ink",
                )}
                style={{ backgroundColor: p }}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {showAlign && onAlign && (
        <>
          <span className="sc-sel-divider" />
          {Aligns.map(([a, Icon, label]) => (
            <button
              key={a}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={align === a}
              className={cn("sc-sel-act", align === a && "sc-fmt-on")}
              onClick={() => onAlign(a)}
            >
              <Icon className="size-3.5" />
            </button>
          ))}
        </>
      )}
    </>
  );
};
