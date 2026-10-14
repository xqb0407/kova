/**
 * 页属性区（自 Inspector 拆出）：背景预设/取色、切换动画、页面尺寸。
 */
import { type FC } from "react";
import { TabsContent } from "@/components/ui/tabs";
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
          <p className="text-muted-foreground pt-2.5 text-[11px] leading-relaxed">
            第 {doc.frames.findIndex((f) => f.id === slide.id) + 1} / {slideFrames(doc).length} 页 · {slide.w}×{slide.h}
            （放映/导出只含页框，画布级元素不入档）
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
          <SectionTitle>切换动画（放映/导出进入本页时）</SectionTitle>
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
            <p className="text-muted-foreground mt-2 leading-relaxed">
              HTML 放映页默认按此设置（可按 T 全局覆盖）；PPTX 支持滑动/淡入，缩放近似淡入。
            </p>
          </GroupCard>
          <SectionTitle>页面尺寸（全部画板等比重排）</SectionTitle>
          <GroupCard>
            <PresetSelect value={doc.meta.pagePreset} onChange={store.setPreset} className="h-7 w-full" />
          </GroupCard>
          <p className="text-muted-foreground mt-5 px-0.5 text-[11px] leading-relaxed">
            提示：拖拽元素边缘有吸附线；拖入/粘贴图片自动落盘资产目录；选中元素后可「问 AI」。
          </p>
        </>
      ) : (
        <p className="text-muted-foreground pt-2.5 leading-relaxed">
          {el ? "选中的是画布级元素（不在任何页框内），无页面属性。" : "还没有页框，点左侧「＋ 空白页」或用「模板库」起步。"}
        </p>
      )}
    </TabsContent>
  );
};
