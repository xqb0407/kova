/**
 * 页属性区（自 Inspector 拆出）：背景预设/取色、切换动画、页码页脚（整份）、页面尺寸。
 */
import { type FC } from "react";
import { TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { PresetSelect } from "@/PresetSelect";
import { slideFrames, type CanvasDoc, type El, type Frame } from "@/doc";
import { cn } from "@/lib/utils";
import type { DeckStore } from "@/state";
import { ColorField, GroupCard, SectionTitle } from "../fields";
import { SegGroup } from "../swatches";

const BG_PRESETS = [
  { label: "白", css: "#ffffff" },
  { label: "墨", css: "#111318" },
  { label: "蓝雾", css: "linear-gradient(135deg,#0a84ff55,#5ac8fa22)" },
  { label: "紫罗兰", css: "linear-gradient(160deg,#bf5af2aa,#0a84ff44)" },
];

export const PageSection: FC<{ store: DeckStore; doc: CanvasDoc; slide: Frame | undefined; el: El | null }> = ({
  store,
  doc,
  slide,
  el,
}) => {
  return (
    <TabsContent value="page" className="mt-0">
      {slide ? (
        <>
          <p className="text-muted-foreground pt-2.5 text-[11px] tabular-nums">
            第 {doc.frames.findIndex((f) => f.id === slide.id) + 1} / {slideFrames(doc).length} 页 · {slide.w} × {slide.h}
          </p>
          <SectionTitle>背景</SectionTitle>
          <GroupCard className="flex flex-col gap-2.5">
            <div className="grid grid-cols-4 gap-2">
              {BG_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  title={p.label}
                  onClick={() => slide && store.setFrameBackground(slide.id, p.css)}
                  className={cn(
                    "h-8 rounded-lg border text-[10px] font-medium shadow-inner transition-shadow",
                    slide.background === p.css ? "border-ink ring-2 ring-ink/50" : "border-border hover:border-ink/40",
                  )}
                  style={{ background: p.css, color: p.css === "#111318" ? "#fff" : "#000" }}
                />
              ))}
            </div>
            <ColorField label="取色" value={slide.background} onChange={(hex) => store.setFrameBackground(slide.id, hex)} />
          </GroupCard>
          <SectionTitle>切换动画</SectionTitle>
          <GroupCard>
            <SegGroup
              ariaLabel="切换动画"
              className="w-full"
              value={slide.transition ?? "slide"}
              onChange={(v) => store.setFrameTransition(slide.id, v)}
              options={[
                { v: "none", node: "无", title: "无动画" },
                { v: "slide", node: "滑动", title: "横向推入（默认）" },
                { v: "fade", node: "淡入", title: "淡入淡出" },
                { v: "zoom", node: "缩放", title: "缩放淡入" },
              ]}
            />
          </GroupCard>
          <SectionTitle>页码与页脚（整份）</SectionTitle>
          <GroupCard className="flex flex-col gap-2">
            <button
              type="button"
              aria-pressed={!!doc.meta.pageNumber}
              onClick={() => store.setDeckMeta({ pageNumber: !doc.meta.pageNumber })}
              className={cn(
                "border-border hover:bg-accent flex h-8 items-center justify-between rounded-lg border px-2.5 text-xs transition-colors",
                doc.meta.pageNumber && "border-ink/60 bg-accent",
              )}
            >
              <span>显示页码（右下角 N / 总页数）</span>
              <span className={cn("text-muted-foreground", doc.meta.pageNumber && "text-ink font-medium")}>
                {doc.meta.pageNumber ? "开" : "关"}
              </span>
            </button>
            <Input
              value={doc.meta.footer ?? ""}
              placeholder="页脚文字，如：内部分享 · 2026"
              className="h-8 text-xs"
              onChange={(e) => store.setDeckMeta({ footer: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <p className="text-muted-foreground text-[10px] leading-relaxed">放映、缩略图与导出（pptx/svg/html）同步显示。</p>
          </GroupCard>
          <SectionTitle>页面尺寸</SectionTitle>
          <GroupCard>
            <PresetSelect value={doc.meta.pagePreset} onChange={store.setPreset} className="h-7 w-full" />
          </GroupCard>
        </>
      ) : (
        <div className="flex flex-col items-center gap-2 px-2 py-10 text-center">
          <p className="text-[12px] font-medium">没有页面</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {el ? "选中的元素在页面之外" : "用左侧「新建页」开始"}
          </p>
        </div>
      )}
    </TabsContent>
  );
};
