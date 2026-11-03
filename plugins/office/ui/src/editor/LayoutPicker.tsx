/**
 * 新建页版式选择器（WPS 式）：缩略图网格直接选版式插入新页。
 *
 * 复用 templates.ts 的「主题 token × 版式原型」：上方主题色板、下方 14 种版式 + 空白页，
 * 预览用 SlideView 真实渲染（与画布/缩略图栏同一渲染器）。主题选择记忆到 localStorage，
 * 下次新建沿用上次的主题。
 */
import { useEffect, useMemo, useState, type FC, type ReactNode } from "react";
import { LayoutTemplateIcon, PlusIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { SlideView } from "@/render";
import {
  LAYOUT_META,
  TEMPLATE_THEMES,
  buildTemplateFrame,
  loadThemeId,
  saveThemeId,
  themeById,
} from "@/templates";
import type { DeckStore } from "@/state";

/** 版式缩略图宽（弹层两列） */
const THUMB_W = 148;

export const LayoutPicker: FC<{
  store: DeckStore;
  /** 触发按钮（asChild，新建页主按钮） */
  children: ReactNode;
  /** 「更多模板…」入口（外壳已有 TemplatePicker 弹窗） */
  onMore: () => void;
}> = ({ store, children, onMore }) => {
  const [open, setOpen] = useState(false);
  const preset = store.doc.meta.pagePreset;
  const [themeId, setThemeId] = useState(loadThemeId);
  useEffect(() => saveThemeId(themeId), [themeId]);
  const theme = themeById(themeId);

  const previews = useMemo(() => {
    if (!open) return [];
    return LAYOUT_META.map((meta) => ({ meta, frame: buildTemplateFrame(themeId, meta.id, preset) })).filter(
      (p): p is { meta: (typeof LAYOUT_META)[number]; frame: NonNullable<ReturnType<typeof buildTemplateFrame>> } => !!p.frame,
    );
  }, [open, themeId, preset]);

  const pageW = preset === "4:3" ? 1024 : preset === "A4L" ? 1123 : 1280;
  const pageH = preset === "4:3" ? 768 : preset === "A4L" ? 794 : 720;
  const scale = THUMB_W / pageW;
  const thumbH = Math.round(pageH * scale);

  const pick = (layoutId: string) => {
    store.insertTemplateFrame(themeId, layoutId);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="right" align="end" sideOffset={8} collisionPadding={12} className="w-[366px] overflow-hidden p-0">
        <div className="border-border/60 flex items-center justify-between border-b px-3 py-2">
          <span className="text-[12px] font-medium">新建页 · 选择版式</span>
          <button type="button" className="text-muted-foreground hover:text-foreground text-[11px] underline-offset-2 hover:underline" onClick={() => { setOpen(false); onMore(); }}>
            更多模板…
          </button>
        </div>

        {/* 主题：小圆点色板，当前主题加墨色圈 */}
        <div className="border-border/60 flex items-center gap-1 overflow-x-auto border-b px-3 py-2">
          {TEMPLATE_THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              title={`${t.label} · ${t.hint}`}
              aria-label={t.label}
              aria-pressed={t.id === themeId}
              onClick={() => setThemeId(t.id)}
              className={cn(
                "relative flex size-6 shrink-0 items-center justify-center rounded-full ring-1 ring-black/15 ring-inset transition-transform hover:scale-110",
                t.id === themeId && "ring-2 ring-ink ring-offset-1",
              )}
              style={{ background: t.tokens.bg }}
            >
              <span className="size-2 rounded-full" style={{ background: t.tokens.accent }} />
            </button>
          ))}
          <span className="text-muted-foreground ml-1 truncate text-[10px]">{theme.label}</span>
        </div>

        <ScrollArea className="h-[420px]">
          <div className="grid grid-cols-2 gap-2 p-3">
            {/* 空白页 */}
            <button
              type="button"
              onClick={() => {
                store.addFrame();
                setOpen(false);
              }}
              className="group flex flex-col gap-1 text-left"
            >
              <span
                className="border-border bg-background hover:border-ink flex items-center justify-center rounded-md border transition-colors"
                style={{ width: THUMB_W, height: thumbH }}
              >
                <PlusIcon className="text-muted-foreground size-4" />
              </span>
              <span className="text-muted-foreground text-[11px]">空白页</span>
            </button>

            {previews.map(({ meta, frame }) => (
              <button key={meta.id} type="button" onClick={() => pick(meta.id)} className="group flex flex-col gap-1 text-left">
                <span
                  className="border-border overflow-hidden rounded-md border transition-shadow group-hover:shadow-md"
                  style={{ width: THUMB_W, height: thumbH }}
                >
                  <SlideView slide={frame} scale={scale} />
                </span>
                <span className="flex items-baseline gap-1 text-[11px]">
                  <span className="text-foreground font-medium">{meta.label}</span>
                  <span className="text-muted-foreground truncate">{meta.desc}</span>
                </span>
              </button>
            ))}
          </div>
        </ScrollArea>
        <div className="border-border/60 text-muted-foreground flex items-center gap-1.5 border-t px-3 py-2 text-[10px]">
          <LayoutTemplateIcon className="size-3" />
          插入当前页之后；版式里的文字可直接双击改写
        </div>
      </PopoverContent>
    </Popover>
  );
};
