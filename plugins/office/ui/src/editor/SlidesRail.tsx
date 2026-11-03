/**
 * 缩略图栏（自 App.tsx 拆出，deck 专属导航）：拖拽换序 + 右键页操作 + 底部建页/模板。
 */
import { useEffect, useMemo, useRef, useState, type FC } from "react";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  CopyIcon,
  FrameIcon,
  LayoutTemplateIcon,
  MaximizeIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ZoomApi } from "@/CanvasStage";
import { TemplatePicker } from "@/TemplatePicker";
import { LayoutPicker } from "./LayoutPicker";
import { SlideView } from "@/render";
import type { Frame } from "@/doc";
import type { DeckStore } from "@/state";

/* ---------------- 缩略图栏（deck 专属导航） ---------------- */

const RAIL_NUM_W = 18;
const RAIL_GAP = 6;
const RAIL_W = 130;
/** 左栏固定宽度（大纲总览是覆盖层，不改变栏宽） */
const RAIL_ROOT_W = 184;
export type RailView = "thumbs" | "outline";

export const SlidesRail: FC<{ store: DeckStore; zoomApi: { current: ZoomApi | null } }> = ({ store, zoomApi }) => {
  const { doc, sel, selectFrame, addFrame, duplicateFrame, removeFrame, moveFrame } = store;
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [overAt, setOverAt] = useState<number | null>(null);
  const [tplOpen, setTplOpen] = useState(false);

  /* ---- 缩略图虚拟化：只渲染可视区 ± 预取，200 页文档选中/滚动不再全量重渲染 ---- */
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /** 行高 = 缩略图高 + gap-2.5；页尺寸可能不同（混排预设），逐页计算 */
  const rowH = useMemo(() => doc.frames.map((f) => (RAIL_W / f.w) * f.h + 10), [doc.frames]);
  const offsets = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (const h of rowH) {
      out.push(acc);
      acc += h;
    }
    return out;
  }, [rowH]);
  const totalH = rowH.length ? offsets[offsets.length - 1]! + rowH[rowH.length - 1]! : 0;
  const OVERSCAN = 320;
  const { start, end } = useMemo(() => {
    const n = doc.frames.length;
    if (!viewH || n === 0) return { start: 0, end: n };
    let a = 0;
    while (a < n && offsets[a]! + rowH[a]! < scrollTop - OVERSCAN) a++;
    let b = a;
    while (b < n && offsets[b]! < scrollTop + viewH + OVERSCAN) b++;
    return { start: a, end: Math.max(a, b) };
  }, [doc.frames.length, offsets, rowH, scrollTop, viewH]);

  return (
    <div
      className="sc-chrome z-20 flex h-full shrink-0 flex-col border-border/60 border-r"
      style={{ width: RAIL_ROOT_W }}
    >
      {/* 视图切换已移到画布底部工具栏（大纲），左栏只承载缩略图。
          虚拟化：外层撑出总高度，只挂可视区 ± 预取的条目。 */}
      <div
        ref={scrollRef}
        data-rail-scroll=""
        data-rail-count={doc.frames.length}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: totalH + 24, position: "relative" }}>
          <div
            className="absolute right-0 left-0 flex flex-col gap-2.5 px-3"
            style={{ top: 12 + (offsets[start] ?? 0) }}
          >
          {doc.frames.slice(start, end).map((s, k) => {
            const i = start + k;
            const scale = RAIL_W / s.w;
            const active = sel?.containerId === s.id;
            return (
              <ContextMenu key={s.id}>
                <ContextMenuTrigger asChild>
                  <div
                    draggable
                    onDragStart={(e) => {
                      setDragFrom(i);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setOverAt(i);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragFrom !== null && dragFrom !== i) moveFrame(dragFrom, i);
                      setDragFrom(null);
                      setOverAt(null);
                    }}
                    onDragEnd={() => {
                      setDragFrom(null);
                      setOverAt(null);
                    }}
                    onClick={() => selectFrame(s.id)}
                    data-rail-index={i}
                    className="group flex shrink-0 cursor-pointer items-center"
                    style={{ gap: RAIL_GAP }}
                  >
                    <div
                      className={cn(
                        "shrink-0 text-center text-[11px] tabular-nums text-muted-foreground",
                        active && "font-semibold text-ink",
                      )}
                      style={{ width: RAIL_NUM_W }}
                    >
                      {i + 1}
                    </div>
                    <div className="relative">
                      <div
                        className={cn(
                          "overflow-hidden rounded-md bg-white border border-border outline-offset-2",
                          active && "outline-1 outline-ink",
                          overAt === i && dragFrom !== null && dragFrom !== i && "ring-2 ring-ink",
                        )}
                        style={{ width: s.w * scale, height: s.h * scale }}
                      >
                        <SlideView
                          slide={s}
                          scale={scale}
                          chrome={
                            doc.meta.pageNumber || doc.meta.footer
                              ? { index: i + 1, total: doc.frames.length, showNumber: doc.meta.pageNumber, footer: doc.meta.footer }
                              : undefined
                          }
                        />
                      </div>
                      <div className="absolute right-1 bottom-1 z-10 hidden gap-1 group-hover:flex">
                        <button
                          type="button"
                          title="复制页"
                          onClick={(e) => {
                            e.stopPropagation();
                            duplicateFrame(s.id);
                          }}
                          className="rounded-md bg-black/55 p-1 text-white hover:bg-black/75"
                        >
                          <CopyIcon className="size-3" />
                        </button>
                        <button
                          type="button"
                          title="删除页"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeFrame(s.id);
                          }}
                          className="rounded-md bg-black/55 p-1 text-white hover:bg-red-600/90"
                        >
                          <Trash2Icon className="size-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-48">
                  <ContextMenuItem onSelect={() => selectFrame(s.id)}>
                    <FrameIcon className="size-3.5" /> 选中此页
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => zoomApi.current?.focusFrame(s.id)}>
                    <MaximizeIcon className="size-3.5" /> 缩放至此页
                  </ContextMenuItem>
                  <ContextMenuItem disabled={i === 0} onSelect={() => moveFrame(i, i - 1)}>
                    <ArrowUpIcon className="size-3.5" /> 上移一页
                  </ContextMenuItem>
                  <ContextMenuItem disabled={i === doc.frames.length - 1} onSelect={() => moveFrame(i, i + 1)}>
                    <ArrowDownIcon className="size-3.5" /> 下移一页
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => duplicateFrame(s.id)}>
                    <CopyIcon className="size-3.5" /> 复制页
                  </ContextMenuItem>
                  <ContextMenuItem variant="destructive" onSelect={() => removeFrame(s.id)}>
                    <Trash2Icon className="size-3.5" /> 删除页
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 border-border/60 border-t p-2">
        <LayoutPicker store={store} onMore={() => setTplOpen(true)}>
          <Button variant="secondary" size="sm" className="h-8 flex-1 justify-start px-2 text-xs">
            <PlusIcon className="size-3.5" /> 新建页
          </Button>
        </LayoutPicker>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="sc-tool" aria-label="新建选项">
              <ChevronDownIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onSelect={() => addFrame()}>空白页</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => addFrame({ title: true })}>标题页</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setTplOpen(true)}>
              <LayoutTemplateIcon className="size-3.5" /> 模板库…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <TemplatePicker store={store} open={tplOpen} onOpenChange={setTplOpen} />
    </div>
  );
};

/* ---------------- 大纲总览：整份 PPT 的页面缩略网格（点击选中，双击回单页编辑） ---------------- */

/** 单页缩略：按可用宽度等比缩放整页（SlideView 内部仍按页面原始坐标渲染） */
const SlideThumb: FC<{ frame: Frame; chrome?: { index: number; total: number; showNumber?: boolean; footer?: string } }> = ({ frame, chrome }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setW(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const k = w > 0 ? w / frame.w : 0;
  return (
    <div
      ref={ref}
      className="relative w-full overflow-hidden rounded-lg border border-border bg-white"
      style={{ aspectRatio: `${frame.w} / ${frame.h}` }}
    >
      {k > 0 && (
        <div style={{ width: frame.w, height: frame.h, transform: `scale(${k})`, transformOrigin: "top left" }}>
          <SlideView slide={frame} chrome={chrome} />
        </div>
      )}
    </div>
  );
};

export const SlideOverview: FC<{ store: DeckStore; onView: (v: RailView) => void }> = ({ store, onView }) => {
  const { doc, sel, selectFrame, addFrame } = store;
  return (
    <div className="absolute inset-0 z-30" style={{ background: "var(--sc-deck-bg)" }}>
      <ScrollArea className="h-full">
        {doc.frames.length === 0 ? (
          <p className="text-muted-foreground p-8 text-center text-[12px]">还没有幻灯片页，点下方「新建页」开始</p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-x-4 gap-y-6 p-6 pb-20">
            {doc.frames.map((s, i) => {
              const active = sel?.containerId === s.id;
              return (
                <div key={s.id} className="flex flex-col gap-1.5">
                  <button
                    type="button"
                    onClick={() => selectFrame(s.id)}
                    onDoubleClick={() => {
                      selectFrame(s.id);
                      onView("thumbs");
                    }}
                    title="点击选中 · 双击编辑"
                    className={cn(
                      "block w-full cursor-pointer rounded-lg text-left outline-offset-2 transition-[outline-color]",
                      active ? "outline-2 outline-ink" : "hover:outline-1 hover:outline-ink/30",
                    )}
                  >
                    <SlideThumb
                      frame={s}
                      chrome={
                        store.doc.meta.pageNumber || store.doc.meta.footer
                          ? { index: i + 1, total: store.doc.frames.length, showNumber: store.doc.meta.pageNumber, footer: store.doc.meta.footer }
                          : undefined
                      }
                    />
                  </button>
                  <span
                    className={cn(
                      "text-muted-foreground pl-0.5 text-[11px] tabular-nums",
                      active && "text-ink font-semibold",
                    )}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
      {/* 悬浮底栏（与单页编辑同一套语言）：返回幻灯片 · 新建页 · 页数 */}
      <div className="glass glass-sm absolute bottom-3 left-1/2 z-40 flex w-max -translate-x-1/2 items-center gap-1 whitespace-nowrap px-1.5 py-1">
        <button
          type="button"
          onClick={() => onView("thumbs")}
          title="返回单页编辑"
          className="hover:bg-accent flex h-6 items-center gap-1 rounded px-1.5 text-[11px] transition-colors"
        >
          <ArrowLeftIcon className="size-3.5" /> 幻灯片
        </button>
        <span className="bg-border mx-0.5 h-4 w-px" />
        <button
          type="button"
          onClick={() => addFrame()}
          className="hover:bg-accent flex h-6 items-center gap-1 rounded px-1.5 text-[11px] transition-colors"
        >
          <PlusIcon className="size-3.5" /> 新建页
        </button>
        <span className="bg-border mx-0.5 h-4 w-px" />
        <span className="text-muted-foreground px-1 text-[11px] tabular-nums">{doc.frames.length} 页</span>
      </div>
    </div>
  );
};
