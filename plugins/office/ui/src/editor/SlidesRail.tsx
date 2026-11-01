/**
 * 缩略图栏（自 App.tsx 拆出，deck 专属导航）：拖拽换序 + 右键页操作 + 底部建页/模板。
 */
import { useState, type FC } from "react";
import {
  ArrowDownIcon,
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
import { SlideView } from "@/render";
import type { DeckStore } from "@/state";

/* ---------------- 缩略图栏（deck 专属导航） ---------------- */

const RAIL_W = 152;
export const SlidesRail: FC<{ store: DeckStore; zoomApi: { current: ZoomApi | null } }> = ({ store, zoomApi }) => {
  const { doc, sel, selectFrame, addFrame, duplicateFrame, removeFrame, moveFrame } = store;
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [overAt, setOverAt] = useState<number | null>(null);
  const [tplOpen, setTplOpen] = useState(false);
  return (
    <div className="sc-chrome z-20 flex h-full w-[184px] shrink-0 flex-col border-border/60 border-r">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2.5 px-3 py-3">
          {doc.frames.map((s, i) => {
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
                    className={cn(
                      "group relative shrink-0 cursor-pointer rounded-lg transition-shadow",
                      overAt === i && dragFrom !== null && dragFrom !== i && "ring-2 ring-ink",
                    )}
                  >
                    <div className="text-muted-foreground  rounded-full  size-5 flex items-center justify-center absolute -top-0.5 left-1 z-10 text-xs font-semibold tabular-nums drop-shadow-sm">
                      {i + 1}
                    </div>
                    <div
                      className={cn(
                        "overflow-hidden rounded-md bg-white border border-border outline-offset-2",
                        active && "outline-1 outline-ink",
                      )}
                      style={{ width: s.w * scale, height: s.h * scale }}
                    >
                      <SlideView slide={s} scale={scale} />
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
      </ScrollArea>
      <div className="flex shrink-0 items-center gap-1 border-border/60 border-t p-2">
        <Button variant="secondary" size="sm" className="h-8 flex-1 justify-start px-2 text-xs" onClick={() => addFrame()}>
          <PlusIcon className="size-3.5" /> 新建页
        </Button>
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
