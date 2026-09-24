/**
 * 属性面板骨架（自 App.tsx 拆出）：「元素 / 页」两页签 + 元素头部 + 几何/透明度通用区。
 * 各 kind 的属性区拆在 ./<Kind>Section.tsx ——新增元素（表格等）挂一个分支即可。
 */
import { useEffect, useRef, useState, type FC } from "react";
import { CopyIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import type { DeckStore } from "@/state";
import { GroupCard, NumField, SectionTitle } from "../fields";
import { ChartSection } from "./ChartSection";
import { DrawSection } from "./DrawSection";
import { EmbedSection } from "./EmbedSection";
import { ImageSection } from "./ImageSection";
import { MermaidSection } from "./MermaidSection";
import { MultiSection } from "./MultiSection";
import { PageSection } from "./PageSection";
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
  "curve-arrow": "弧线箭头",
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

export const Inspector: FC<{ store: DeckStore; selectedEl: El | null; askAI: () => void; deck: boolean }> = ({
  store,
  selectedEl,
  askAI,
  deck,
}) => {
  const { doc, sel, activeFrame } = store;
  const multiCount = sel?.elIds.length ?? 0;
  const hasEl = multiCount > 0;
  const [tab, setTab] = useState<"element" | "page">(deck ? "page" : "element");
  const prevHasEl = useRef(false);
  useEffect(() => {
    if (hasEl !== prevHasEl.current) {
      prevHasEl.current = hasEl;
      if (hasEl) setTab("element");
      else if (deck) setTab("page");
    }
  }, [hasEl, deck]);
  /* 模式切换时重置页签；board 没有"页"面板可言（页框不可见） */
  useEffect(() => {
    setTab(deck && !hasEl ? "page" : "element");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck]);

  const el = selectedEl;
  /** 页面板聚焦对象：选中元素所在页框（画布级元素=无）；否则当前聚焦页框 */
  const slide = el ? doc.frames.find((f) => f.id === sel?.containerId) : activeFrame;
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

  // 白板（无限画布）没有页面板、元素也没选中时不显示整块属性卡；
  // 返回 null 不卸载组件，页签/滚动等实例状态在选择变化间保留。
  if (!deck && !hasEl) return null;

  return (
    <div
      className={cn(
        "sc-ui-panel z-10 flex min-h-0 flex-col text-xs",
        deck ? "glass-dock z-20 h-full w-[304px] shrink-0 border-border/60 border-l" : "glass rounded-[24px]! absolute top-16 bottom-14 right-3 w-[304px]",
      )}
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as "element" | "page")} className="min-h-0 flex-1 gap-0">
        {/* 白板（board）只有"元素"一件事：面板本来就只在选中元素时出现，
            页签是多余的一层壳——直接从属性内容开始；幻灯片保留 元素/页 切换。 */}
        {deck && (
          <div className="shrink-0 px-3 pt-3 pb-1.5">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="element">元素{multiCount > 1 ? ` · ${multiCount}` : ""}</TabsTrigger>
              <TabsTrigger value="page">页</TabsTrigger>
            </TabsList>
          </div>
        )}
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-4 pt-2 pb-4">
            <TabsContent value="element">
              {el ? (
                <>
                  <div className="flex items-center justify-between pt-2.5 pb-0.5">
                    <span className="text-base font-semibold">{kindLabel(el)}</span>
                    <div className="flex gap-0.5">
                      <Hint label="复制 ⌘D">
                        <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => store.duplicateSelected()} aria-label="复制">
                          <CopyIcon className="size-4" />
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
            </TabsContent>

            {deck && (
            <PageSection store={store} doc={doc} slide={slide} el={el} />
            )}
          </div>
        </ScrollArea>
      </Tabs>
    </div>
  );
};
