/**
 * 模板库选择器：上方选主题（token 色板 chip），下方版式网格——缩略图用 SlideView
 * 渲染真实模板页（与画布/缩略图栏同一渲染器，预览即所得）。动作两个：
 * 插入此版式（单页，追加到页尾）与 应用整套（6 页起步deck）。
 * 纯 UI 组合：插入走 store.insertTemplateFrame / applyStarterDeck，这里不碰文档。
 */
import { useMemo, useState, type FC } from "react";
import { LayoutTemplateIcon, Rows3Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { SlideView } from "./render";
import { LAYOUT_META, buildTemplateFrame, TEMPLATE_THEMES } from "./templates";
import type { DeckStore } from "./state";

const THUMB_W = 148;

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
  const scale = THUMB_W / pageW;
  const pageH = Math.round((preset === "4:3" ? 768 : preset === "A4L" ? 794 : 720) * scale);

  const pick = (id: string) => LAYOUT_META.find((l) => l.id === id)?.label ?? id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[900px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LayoutTemplateIcon className="size-4" /> 模板库
          </DialogTitle>
          <DialogDescription>
            选一套主题配色，再挑版式插入单页；或直接应用整套 {LAYOUT_META.length >= 6 ? 6 : LAYOUT_META.length} 页起步结构。所有元素落盘后都能继续编辑。
          </DialogDescription>
        </DialogHeader>

        {/* 主题行：色板 chip（底色块 + 强调点） */}
        <div className="flex flex-wrap gap-2">
          {TEMPLATE_THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setThemeId(t.id)}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                t.id === themeId ? "border-ink ring-ink ring-2" : "hover:bg-accent border-border",
              )}
            >
              <span className="border-border/60 flex size-7 items-center justify-center rounded-md border" style={{ background: t.tokens.bg }}>
                <span className="size-3 rounded-full" style={{ background: t.tokens.accent }} />
              </span>
              <span>
                <span className="block text-[13px] leading-tight font-semibold">{t.label}</span>
                <span className="text-muted-foreground block text-[11px] leading-tight">{t.hint}</span>
              </span>
            </button>
          ))}
        </div>

        {/* 版式网格：真实渲染缩略图 */}
        <ScrollArea className="max-h-[420px]">
          <div className="grid grid-cols-5 gap-3 pr-3 pl-1">
            {previews.map(({ meta, frame }) => (
              <button
                key={meta.id}
                type="button"
                onClick={() => setLayoutId(meta.id)}
                className={cn(
                  "w-fit rounded-lg text-left transition-shadow",
                  meta.id === layoutId ? "ring-ink ring-2" : "hover:ring-border hover:ring-2",
                )}
              >
                <div
                  className="border-border/70 overflow-hidden rounded-md border bg-white shadow-[0_1px_4px_rgba(0,0,0,0.12)]"
                  style={{ width: THUMB_W, height: pageH }}
                >
                  <SlideView slide={frame} scale={scale} />
                </div>
                <div className="mt-1.5 px-0.5">
                  <div className="text-[12px] leading-tight font-semibold">{meta.label}</div>
                  <div className="text-muted-foreground text-[10.5px] leading-tight">{meta.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </ScrollArea>

        {/* 动作条 */}
        <div className="flex items-center justify-between gap-2">
          <div className="text-muted-foreground text-xs">
            已选：{theme.label} · {pick(layoutId)}
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              className="text-xs"
              onClick={() => {
                store.applyStarterDeck(themeId);
                onOpenChange(false);
              }}
            >
              <Rows3Icon className="size-3.5" /> 应用整套（6 页）
            </Button>
            <Button
              size="sm"
              className="text-xs"
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
