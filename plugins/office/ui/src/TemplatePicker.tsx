/**
 * 模板库选择器：上方选主题（token 色板卡片），下方版式网格——缩略图用 SlideView
 * 渲染真实模板页（与画布/缩略图栏同一渲染器，预览即所得）。动作两个：
 * 插入此版式（单页，追加到页尾）与 应用整套（6 页起步deck）。
 * 纯 UI 组合：插入走 store.insertTemplateFrame / applyStarterDeck，这里不碰文档。
 * 视觉：Wise 语言——发丝线卡面、选中 ink 描边、亮绿仅上主 CTA、深度靠悬浮抬升。
 */
import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { CheckIcon, LayoutTemplateIcon, Rows3Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { SlideView } from "./render";
import { LAYOUT_META, buildTemplateFrame, TEMPLATE_THEMES } from "./templates";
import type { DeckStore } from "./state";

const THUMB_W = 148;

/** 主题卡片的调色板预览：bg 底 + ink/accent/accent2 三点 */
const ThemePalette: FC<{ tokens: (typeof TEMPLATE_THEMES)[number]["tokens"] }> = ({ tokens }) => (
  <span
    className="border-border/40 flex size-9 shrink-0 items-center justify-center rounded-xl border"
    style={{ background: tokens.bg }}
  >
    <span className="size-2 rounded-full" style={{ background: tokens.accent }} />
  </span>
);

export const TemplatePicker: FC<{
  store: DeckStore;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({ store, open, onOpenChange }) => {
  const preset = store.doc.meta.pagePreset;
  const [themeId, setThemeId] = useState(TEMPLATE_THEMES[0]!.id);
  const [layoutId, setLayoutId] = useState<string>("cover");
  const theme = TEMPLATE_THEMES.find((t) => t.id === themeId) ?? TEMPLATE_THEMES[0]!;

  // 主题切换才重建整组预览页（纯函数，构造便宜；挂 open 避免关着也算）
  const previews = useMemo(() => {
    if (!open) return [];
    return LAYOUT_META.map((l) => ({ meta: l, frame: buildTemplateFrame(themeId, l.id, preset) })).filter(
      (p): p is { meta: (typeof LAYOUT_META)[number]; frame: NonNullable<ReturnType<typeof buildTemplateFrame>> } => !!p.frame,
    );
  }, [open, themeId, preset]);
  const pageW = preset === "4:3" ? 1024 : preset === "A4L" ? 1123 : 1280;
  const pageH0 = preset === "4:3" ? 768 : preset === "A4L" ? 794 : 720;

  // 窄面板自适应：实测网格容器宽 → 列数 = 能放下几个 148px 缩略图（2-5 列），
  // 单元格宽度均分，缩略图按列宽等比缩放（SlideView 本来就是按 scale 绘制）。
  // 固定列数会在窄宽度下溢出弹窗、把右列裁掉。
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridW, setGridW] = useState(0);
  useEffect(() => {
    if (!open) return;
    const el = gridRef.current;
    if (!el) return;
    setGridW(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setGridW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  const THUMB_GAP = 12;
  const cols =
    gridW > 0 ? Math.max(2, Math.min(5, Math.floor((gridW + THUMB_GAP) / (THUMB_W + THUMB_GAP)))) : 5;
  const cellW = gridW > 0 ? Math.floor((gridW - THUMB_GAP * (cols - 1)) / cols) : THUMB_W;
  const scale = cellW / pageW;
  const pageH = Math.round(pageH0 * scale);

  const pick = (id: string) => LAYOUT_META.find((l) => l.id === id)?.label ?? id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[940px] gap-5 rounded-3xl p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <span className="bg-accent/15 text-ink flex size-7 items-center justify-center rounded-xl">
              <LayoutTemplateIcon className="size-4" />
            </span>
            模板库
          </DialogTitle>
          <DialogDescription>
            选一套主题配色，再挑版式插入单页；或直接应用整套 {LAYOUT_META.length >= 6 ? 6 : LAYOUT_META.length} 页起步结构。所有元素落盘后都能继续编辑。
          </DialogDescription>
        </DialogHeader>

        {/* 主题：4 列卡片，调色板预览 + 名称/提示；选中 ink 描边 */}
        <div>
          <div className="text-muted-foreground mb-2 text-[11px] font-medium tracking-wide">主题</div>
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
            {TEMPLATE_THEMES.map((t) => {
              const selected = t.id === themeId;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setThemeId(t.id)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-2xl border p-2 text-left transition-all",
                    selected
                      ? "border-ink shadow-[0_2px_10px_rgba(14,15,12,0.08)]"
                      : "border-border/60 hover:border-ink/40 hover:-translate-y-px",
                  )}
                >
                  <ThemePalette tokens={t.tokens} />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1">
                      <span className="truncate text-[13px] leading-tight font-semibold">{t.label}</span>
                      {selected ? <CheckIcon className="text-ink size-3.5 shrink-0" /> : null}
                    </span>
                    <span className="text-muted-foreground block truncate text-[11px] leading-tight">{t.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 版式：5 列真实渲染缩略图，卡片悬浮抬升，选中 ink 描边 + 角标 */}
        <div className="min-w-0">
          <div className="text-muted-foreground mb-2 flex items-center gap-2 text-[11px] font-medium tracking-wide">
            版式
            <span className="text-muted-foreground/60">{LAYOUT_META.length} 款 · 按当前页尺寸预览</span>
          </div>
          <ScrollArea className="max-h-[44vh]">
            {/* 呼吸内距放包裹层（不进测量）：网格测到的是纯内容宽，cols/cellW 的算术才精确 */}
            <div className="p-1 pr-3">
            <div
              ref={gridRef}
              className="grid"
              style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: `${THUMB_GAP * 1.33}px ${THUMB_GAP}px` }}
            >
              {previews.map(({ meta, frame }) => {
                const selected = meta.id === layoutId;
                return (
                  <button
                    key={meta.id}
                    type="button"
                    onClick={() => setLayoutId(meta.id)}
                    className="group text-left"
                  >
                    <div
                      className={cn(
                        "bg-background relative overflow-hidden rounded-xl border transition-all",
                        selected
                          ? "border-ink shadow-[0_4px_16px_rgba(14,15,12,0.14)]"
                          : "border-border/60 shadow-[0_1px_4px_rgba(14,15,12,0.06)] group-hover:-translate-y-0.5 group-hover:border-ink/40 group-hover:shadow-[0_6px_18px_rgba(14,15,12,0.10)]",
                      )}
                      style={{ width: cellW, height: pageH }}
                    >
                      <SlideView slide={frame} scale={scale} />
                      {selected ? (
                        <span className="bg-ink text-background absolute top-1.5 right-1.5 flex size-4.5 items-center justify-center rounded-full">
                          <CheckIcon className="size-3" />
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-2 px-0.5">
                      <div
                        className={cn(
                          "text-[12px] leading-tight font-semibold",
                          selected ? "text-ink" : "text-foreground/80 group-hover:text-ink",
                        )}
                      >
                        {meta.label}
                      </div>
                      <div className="text-muted-foreground mt-0.5 text-[10.5px] leading-tight">{meta.desc}</div>
                    </div>
                  </button>
                );
              })}
            </div>
            </div>
          </ScrollArea>
        </div>

        {/* 动作条：发丝线分隔，左已选、右双 CTA（主 CTA 亮绿药丸） */}
        <div className="border-border/60 flex items-center justify-between gap-3 border-t pt-4">
          <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
            已选
            <span className="border-border/60 inline-flex items-center gap-1.5 rounded-full border bg-background px-2 py-0.5">
              <span className="size-2 rounded-full" style={{ background: theme.tokens.accent }} />
              <span className="text-foreground font-medium">{theme.label}</span>
              <span className="text-muted-foreground">· {pick(layoutId)}</span>
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              className="rounded-full text-xs"
              onClick={() => {
                store.applyStarterDeck(themeId);
                onOpenChange(false);
              }}
            >
              <Rows3Icon className="size-3.5" /> 应用整套（6 页）
            </Button>
            <Button
              size="sm"
              className="rounded-full text-xs"
              onClick={() => {
                store.insertTemplateFrame(themeId, layoutId);
                onOpenChange(false);
              }}
            >
              <LayoutTemplateIcon className="size-3.5" /> 插入此版式
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
