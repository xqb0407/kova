/**
 * 属性面板骨架（自 App.tsx 拆出）：元素头部 + 几何/透明度通用区。
 * 各 kind 的属性区拆在 ./<Kind>Section.tsx ——新增元素（表格等）挂一个分支即可。
 */
import { useState, type FC } from "react";
import { CopyIcon, LockIcon, LockOpenIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import {
  type ChartEl,
  type DrawEl,
  type El,
  type EmbedEl,
  type ImageEl,
  type MermaidEl,
  type ShapeEl,
  type SvgEl,
  type TableEl,
  type TextEl,
} from "@/doc";
import type { CanvasStore } from "@/state";
import { GroupCard, NumField, SectionTitle } from "../fields";
import { ChartSection } from "./ChartSection";
import { DrawSection } from "./DrawSection";
import { EmbedSection } from "./EmbedSection";
import { ImageSection } from "./ImageSection";
import { MermaidSection } from "./MermaidSection";
import { LayerSection, MultiSection } from "./MultiSection";
import { ShapeSection } from "./ShapeSection";
import { SvgSection } from "./SvgSection";
import { TableSection } from "./TableSection";
import { TextSection } from "./TextSection";

const SHAPE_LABEL: Record<string, string> = {
  rect: "矩形",
  ellipse: "椭圆",
  diamond: "菱形",
  triangle: "三角形",
  trapezoid: "梯形",
  pentagon: "五边形",
  hexagon: "六边形",
  star: "星形",
  line: "直线",
  arrow: "箭头",
  "double-arrow": "双头箭头",
};

const kindLabel = (el: El) =>
  el.kind === "text"
    ? "文本"
    : el.kind === "image"
      ? "图片"
      : el.kind === "mermaid"
        ? "Mermaid 图表"
        : el.kind === "draw"
          ? "手绘笔迹"
          : el.kind === "embed"
            ? "网页嵌入"
            : el.kind === "svg"
              ? "SVG 源码"
              : el.kind === "table"
                ? "表格"
                : el.kind === "chart"
                  ? "数据图表"
                  : (SHAPE_LABEL[(el as ShapeEl).shape] ?? "形状");

export const Inspector: FC<{ store: CanvasStore; selectedEl: El | null; askAI: () => void }> = ({
  store,
  selectedEl,
  askAI,
}) => {
  const { sel } = store;
  const multiCount = sel?.elIds.length ?? 0;
  const hasEl = multiCount > 0;

  const el = selectedEl;
  const patch = (
    p:
      | Partial<TextEl>
      | Partial<ShapeEl>
      | Partial<ImageEl>
      | Partial<MermaidEl>
      | Partial<DrawEl>
      | Partial<EmbedEl>
      | Partial<SvgEl>
      | Partial<TableEl>
      | Partial<ChartEl>,
    coalesce?: boolean,
  ) => {
    if (!el || !sel) return;
    store.updateEl(sel.containerId, el.id, p as Parameters<typeof store.updateEl>[2], coalesce);
  };

  // 元素没选中时不显示整块属性卡；
  // 返回 null 不卸载组件，滚动等实例状态在选择变化间保留。
  if (!hasEl) return null;

  return (
    <div
      className={cn(
        "sc-ui-panel z-10 flex min-h-0 flex-col text-xs glass rounded-[24px]! absolute top-16 bottom-14 right-3 w-[304px]",
      )}
    >
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-4 pt-2 pb-4">
          {el ? (
            <>
              <div className="flex items-center justify-between pt-2.5 pb-0.5">
                <span className="text-base font-semibold">{kindLabel(el)}{el.locked ? " · 已锁定" : ""}</span>
                <div className="flex gap-0.5">
                  <Hint label="复制 ⌘D">
                    <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => store.duplicateSelected()} aria-label="复制">
                      <CopyIcon className="size-4" />
                    </Button>
                  </Hint>
                  <Hint label={el.locked ? "解锁（恢复编辑）" : "锁定（防误拖误删）"}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="sc-tool"
                      aria-label={el.locked ? "解锁" : "锁定"}
                      onClick={() => sel && store.updateEl(sel.containerId, el.id, { locked: el.locked ? undefined : true } as Partial<El>)}
                    >
                      {el.locked ? <LockOpenIcon className="size-4" /> : <LockIcon className="size-4" />}
                    </Button>
                  </Hint>
                  <Hint label="删除（Del）">
                    <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => store.deleteSelected()} aria-label="删除">
                      <Trash2Icon className="size-4" />
                    </Button>
                  </Hint>
                </div>
              </div>
              <SectionTitle>几何</SectionTitle>
              <GroupCard>
                <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                  <NumField label="X" value={el.x} onChange={(v) => patch({ x: v } as Partial<TextEl>, true)} />
                  <NumField label="Y" value={el.y} onChange={(v) => patch({ y: v } as Partial<TextEl>, true)} />
                  <NumField label="W" min={4} value={el.w} onChange={(v) => patch({ w: v } as Partial<TextEl>, true)} />
                  <NumField label="H" min={2} value={el.h} onChange={(v) => patch({ h: v } as Partial<TextEl>, true)} />
                  <NumField label="∠" min={-180} max={180} value={el.rotation ?? 0} onChange={(v) => patch({ rotation: v } as Partial<TextEl>, true)} />
                </div>
              </GroupCard>

              {el.kind === "text" && <TextSection el={el} patch={(p, c) => patch(p, c)} />}

              {el.kind === "shape" && <ShapeSection el={el} patch={(p, c) => patch(p, c)} />}

              {el.kind === "image" && <ImageSection el={el} patch={(p, c) => patch(p, c)} />}

              {el.kind === "mermaid" && <MermaidSection el={el} patch={(p, c) => patch(p, c)} />}

              {el.kind === "embed" && <EmbedSection el={el} patch={(p, c) => patch(p, c)} />}

              {el.kind === "svg" && <SvgSection el={el} patch={(p, c) => patch(p, c)} />}

              {el.kind === "draw" && <DrawSection el={el} patch={(p, c) => patch(p, c)} />}

              {el.kind === "table" && <TableSection el={el} patch={(p, c) => patch(p, c)} />}

              {el.kind === "chart" && <ChartSection el={el} patch={(p, c) => patch(p, c)} />}

              <SectionTitle>透明度</SectionTitle>
              <GroupCard>
                <div className="flex items-center gap-2.5">
                  <Slider
                    min={0}
                    max={100}
                    value={[Math.round((el.opacity ?? 1) * 100)]}
                    onValueChange={([v]) => patch({ opacity: (v ?? 100) / 100 } as Partial<TextEl>, true)}
                    className="flex-1"
                  />
                  <span className="text-muted-foreground w-9 shrink-0 text-right text-[11px] tabular-nums">{Math.round((el.opacity ?? 1) * 100)}%</span>
                </div>
              </GroupCard>
              {/* 层序/解组：元素顶部不再有浮动工具条，图层操作全部收进属性面板 */}
              <LayerSection store={store} />
              <Button variant="secondary" className="mt-5 h-9 w-full gap-2 rounded-lg text-xs" onClick={askAI}>
                <SparklesIcon className="size-3.5" /> 问 AI 修改此元素
              </Button>
            </>
          ) : multiCount > 1 && sel ? (
            <MultiSection store={store} count={multiCount} />
          ) : (
            <p className="text-muted-foreground py-2 leading-relaxed">
              在画布上点选或框选元素后在这里改属性。拖动空白处可框选，按住 ⇧ 加选。
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};
