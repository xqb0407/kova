/**
 * slide-canvas 外壳：浮动玻璃条重组版。
 *   左竖工具栏（插入/形状弹层/历史） · 顶栏（文档名 · 问AI/放映/导出）
 *   右 Inspector（元素|页 Tabs，shadcn 表单） · 底部缩放条（百分比菜单）
 *   选中浮动工具条（对齐/分布/图层/复制/删除） · 画布/元素/画板/缩略图四处右键菜单
 * 全部交互原语来自 @/components/ui（真 shadcn/Radix）；编辑动作全走 store。
 */
import { useCallback, useEffect, useRef, useState, type FC, type ReactNode } from "react";
import {
  AlignCenterIcon,
  AlignCenterVerticalIcon,
  AlignEndVerticalIcon,
  AlignLeftIcon,
  AlignRightIcon,
  AlignStartVerticalIcon,
  ArrowDownIcon,
  ArrowDownToLineIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  ArrowUpToLineIcon,
  BoldIcon,
  ChevronDownIcon,
  CircleIcon,
  ClipboardCopyIcon,
  ClipboardPasteIcon,
  ClipboardXIcon,
  CopyIcon,
  DownloadIcon,
  FrameIcon,
  ImagePlusIcon,
  ItalicIcon,
  MaximizeIcon,
  MinusIcon,
  MoveHorizontalIcon,
  MoveVerticalIcon,
  PenIcon,
  PlayIcon,
  PlusIcon,
  Redo2Icon,
  ShapesIcon,
  SquareIcon,
  SparklesIcon,
  Trash2Icon,
  TypeIcon,
  UnderlineIcon,
  Undo2Icon,
  WorkflowIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Hint, TooltipProvider } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { CanvasStage, type ContextHit, type ZoomApi } from "./CanvasStage";
import { Presentation } from "./Presentation";
import { containerEls, useDeck, type DeckStore } from "./state";
import { exportPptx } from "./export";
import { bridge } from "./bridge";
import {
  CANVAS_ROOT,
  DEFAULT_MERMAID_CODE,
  PAGE_SIZES,
  slideFrames,
  uid,
  type DrawEl,
  type El,
  type ImageEl,
  type MermaidEl,
  type MermaidTheme,
  type PagePreset,
  type ShapeEl,
  type TextEl,
} from "./doc";
import { DEFAULT_TEXT_SIZE, SlideView } from "./render";

/* ---------------- 新建元素工厂 ---------------- */

/** 居中落位参照盒：页框 = 框尺寸；画布级 = 当前页预设尺寸（虚拟框，落在原点） */
function newEl(box: { w: number; h: number }, kind: "text" | "rect" | "ellipse" | "line" | "arrow" | "mermaid"): TextEl | ShapeEl | MermaidEl {
  const center = (w: number, h: number) => ({ x: Math.round((box.w - w) / 2), y: Math.round((box.h - h) / 2), w, h });
  if (kind === "mermaid") {
    return { kind: "mermaid", id: uid("m"), ...center(640, 400), code: DEFAULT_MERMAID_CODE };
  }
  if (kind === "text") {
    return {
      kind: "text",
      id: uid("t"),
      ...center(560, 120),
      runs: [{ text: "双击编辑文本", size: DEFAULT_TEXT_SIZE, color: "#111827" }],
      align: "center",
      vAlign: "middle",
    };
  }
  const id = uid("s");
  if (kind === "rect") return { kind: "shape", id, shape: "rect", ...center(360, 200), fill: "#0a84ff", radius: 12 };
  if (kind === "ellipse") return { kind: "shape", id, shape: "ellipse", ...center(260, 260), fill: "#5ac8fa" };
  const line = { kind: "shape" as const, id, shape: kind, ...center(360, 2), stroke: "#1d1d1f", strokeWidth: 3 };
  return line;
}

type SelKind = "text" | "rect" | "ellipse" | "line" | "arrow" | "mermaid";

/* ---------------- 外壳 ---------------- */

export const App: FC = () => {
  const store = useDeck();
  const { doc, sel, activeFrame, setSel } = store;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [presenting, setPresenting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  const [pen, setPen] = useState(false);
  const [menuHit, setMenuHit] = useState<ContextHit | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const zoomApi = useRef<ZoomApi | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onZoom = useCallback((s: number) => setZoomPct(Math.round(s * 100)), []);

  const selectedEl: El | null =
    sel && sel.elIds.length === 1 ? (containerEls(doc, sel.containerId)?.find((e) => e.id === sel.elIds[0]) ?? null) : null;

  /** 插入落位容器：有选择用选择容器，否则聚焦页框；画布级（无页框）时落当前视口中心 */
  const insert = useCallback(
    (kind: SelKind) => {
      const containerId = store.defaultContainerId;
      const owner = doc.frames.find((f) => f.id === containerId);
      if (owner) {
        store.addEl(containerId, newEl(owner, kind));
        return;
      }
      const el = newEl(PAGE_SIZES[doc.meta.pagePreset], kind);
      const c = zoomApi.current?.viewportCenter();
      if (c) Object.assign(el, { x: Math.round(c.x - el.w / 2), y: Math.round(c.y - el.h / 2) });
      store.addEl(CANVAS_ROOT, el);
    },
    [store, doc.frames, doc.meta.pagePreset],
  );

  const askAI = useCallback(() => {
    if (selectedEl) {
      const at =
        sel?.containerId === CANVAS_ROOT
          ? "画布级（objects）"
          : `第 ${doc.frames.findIndex((f) => f.id === sel?.containerId) + 1} 页`;
      bridge.prefill(
        `请修改画布文档${store.fileRel ? ` ${store.fileRel}` : ""}中${at}的这个 ${selectedEl.kind} 元素` +
          `（先 read 该文件拿最新内容，再改动它；元素当前 JSON）：\n` +
          "```json\n" + JSON.stringify(selectedEl, null, 2) + "\n```\n我的要求：",
      );
    } else {
      bridge.prefill(
        `请帮我完善画布中打开的演示文档${store.fileRel ? ` ${store.fileRel}` : ""}。` +
          "先 read 现有内容（用户可能手动改过），再按 slides 技能的 schema 编辑：\n",
      );
    }
  }, [selectedEl, doc.frames, sel?.containerId, store.fileRel]);

  const doExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await exportPptx(store.doc, store.fileRel);
      store.notifyLater(bridge.standalone ? "已生成 .pptx（独立模式无宿主落盘，见控制台）" : "正在生成 .pptx，完成后见右下角提示");
    } catch (err) {
      store.notifyLater(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
    }
  }, [exporting, store]);

  const onContextHit = useCallback((hit: ContextHit) => {
    setMenuHit(hit);
    setMenuOpen(true);
  }, []);

  /* ---------- 全局快捷键（输入框/文本编辑聚焦时让位） ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (presenting) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
      } else if (mod && key === "y") {
        e.preventDefault();
        store.redo();
      } else if (mod && key === "d") {
        e.preventDefault();
        store.duplicateSelected();
      } else if (mod && key === "a") {
        e.preventDefault();
        store.selectAllInContainer();
      } else if (mod && key === "c") {
        if (sel && sel.elIds.length > 0) {
          e.preventDefault();
          store.copySelected();
        }
      } else if (mod && key === "x") {
        if (sel && sel.elIds.length > 0) {
          e.preventDefault();
          store.cutSelected();
        }
      } else if (mod && key === "v") {
        if (store.hasClipboard()) {
          e.preventDefault();
          store.pasteClipboard();
        }
      } else if (mod && (e.key === "]" || e.key === "[")) {
        if (!sel || sel.elIds.length === 0) return;
        e.preventDefault();
        const up = e.key === "]";
        store.moveSelectedZ(e.shiftKey ? (up ? "front" : "back") : up ? "forward" : "backward");
      } else if (e.key === "Tab") {
        e.preventDefault();
        store.cycleSelection(e.shiftKey ? -1 : 1);
      } else if (e.key === "Enter") {
        if (selectedEl && (selectedEl.kind === "text" || selectedEl.kind === "mermaid") && sel) {
          e.preventDefault();
          setEditingId(selectedEl.id);
        }
      } else if (mod && e.key === "0") {
        e.preventDefault();
        zoomApi.current?.fitAll();
      } else if (mod && e.key === "1") {
        e.preventDefault();
        zoomApi.current?.zoom100();
      } else if ((mod && e.shiftKey && key === "f") || e.key === "F5") {
        e.preventDefault();
        if (slideFrames(doc).length > 0) setPresenting(true);
      } else if (!mod && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        store.deleteSelected();
      } else if (!mod && key === "p") {
        setPen((v) => !v);
      } else if (!mod && e.key === "Escape") {
        setEditingId(null);
        setSel(null);
        setPen(false);
      } else if (e.key.startsWith("Arrow")) {
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        if ((dx || dy) && sel) {
          e.preventDefault();
          store.nudge(dx, dy);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, sel, setSel, doc.frames.length, presenting, selectedEl]);

  /* ---------- 未绑定文档 ---------- */
  if (!store.connected) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        正在连接工作区…
      </div>
    );
  }
  if (!store.hasDoc) return <NewDeck store={store} />;

  return (
    <TooltipProvider>
      <div className="relative h-full w-full overflow-hidden">
      <ContextMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <ContextMenuTrigger asChild>
          <CanvasStage
            store={store}
            editingId={editingId}
            setEditingId={setEditingId}
            zoomApi={zoomApi}
            onZoom={onZoom}
            onContextHit={onContextHit}
            penMode={pen}
            selToolbar={sel && sel.elIds.length > 0 ? <SelectionBar store={store} multi={sel.elIds.length > 1} /> : undefined}
          />
        </ContextMenuTrigger>
        <CanvasContextMenu store={store} hit={menuHit} insert={insert} askAI={askAI} zoomApi={zoomApi} />
      </ContextMenu>

      {/* 文档名 chip（左上） */}
      <div className="glass glass-sm pointer-events-auto absolute top-3 left-3 z-10 flex max-w-[280px] items-center gap-2 px-3 py-1.5 text-xs">
        <span className="truncate font-medium">{store.fileRel?.split("/").pop()?.replace(/\.canvas\.json$/i, "") ?? "未命名画布"}</span>
        <span
          className={cn("size-1.5 shrink-0 rounded-full bg-primary transition-opacity", store.dirty ? "opacity-100" : "opacity-0")}
          title={store.dirty ? "有未保存改动（800ms 防抖写盘）" : "已保存"}
        />
        <span className="text-muted-foreground truncate">{store.fileRel ? "" : "（未落盘）"}</span>
      </div>

      {/* 顶栏（右上）：问 AI / 放映 / 导出 */}
      <div className="glass glass-sm pointer-events-auto absolute top-3 right-3 z-10 flex items-center gap-1 px-1.5 py-1">
        <Hint label="问 AI：把选中元素/整档上下文填入对话输入框" side="bottom">
          <Button variant="ghost" size="icon-sm" onClick={askAI} aria-label="问 AI">
            <SparklesIcon className="size-4" />
          </Button>
        </Hint>
        <Hint label="放映（⌘⇧F / F5）" side="bottom">
          <Button variant="ghost" size="icon-sm" onClick={() => setPresenting(true)} aria-label="放映">
            <PlayIcon className="size-4" />
          </Button>
        </Hint>
        <Separator orientation="vertical" className="mx-0.5 !h-5" />
        <Hint label="导出 .pptx（PowerPoint 兼容；渐变/字体有损近似）" side="bottom">
          <Button size="sm" onClick={() => void doExport()} disabled={exporting}>
            <DownloadIcon className="size-3.5" /> {exporting ? "导出中…" : "导出"}
          </Button>
        </Hint>
      </div>

      {/* 左竖工具栏：插入 + 历史 */}
      <div className="glass pointer-events-auto absolute top-1/2 left-3 z-10 flex -translate-y-1/2 flex-col items-center gap-0.5 px-1 py-1.5">
        <Hint label="文本（Enter/双击可编辑）" side="right">
          <Button variant="ghost" size="icon-sm" onClick={() => insert("text")} aria-label="插入文本">
            <TypeIcon className="size-4" />
          </Button>
        </Hint>
        <Popover>
          <Hint label="形状（矩形/椭圆/直线/箭头）" side="right">
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="插入形状">
                <ShapesIcon className="size-4" />
              </Button>
            </PopoverTrigger>
          </Hint>
          <PopoverContent side="right" align="center" className="w-auto p-1.5">
            <div className="grid grid-cols-2 gap-1">
              {(
                [
                  ["rect", SquareIcon, "矩形"],
                  ["ellipse", CircleIcon, "椭圆"],
                  ["line", MinusIcon, "直线"],
                  ["arrow", ArrowUpRightIcon, "箭头"],
                ] as const
              ).map(([kind, Icon, label]) => (
                <Button key={kind} variant="ghost" size="icon" title={label} aria-label={label} onClick={() => insert(kind)}>
                  <Icon className="size-4" />
                </Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <Hint label="图片（选择文件，自动落盘到资产目录）" side="right">
          <Button variant="ghost" size="icon-sm" onClick={() => fileRef.current?.click()} aria-label="插入图片">
            <ImagePlusIcon className="size-4" />
          </Button>
        </Hint>
        <Hint label="Mermaid 流程图（Enter/双击可编辑代码）" side="right">
          <Button variant="ghost" size="icon-sm" onClick={() => insert("mermaid")} aria-label="插入 Mermaid">
            <WorkflowIcon className="size-4" />
          </Button>
        </Hint>
        <Separator className="my-1 !h-px w-5" />
        <Hint label="钢笔手绘（P）：按下拖动起笔，抬起成线；Esc 退出" side="right">
          <Button
            variant={pen ? "secondary" : "ghost"}
            size="icon-sm"
            onClick={() => setPen((v) => !v)}
            aria-label="钢笔手绘"
            aria-pressed={pen}
          >
            <PenIcon className="size-4" />
          </Button>
        </Hint>
        <Hint label="插入页框（PPT 页：现有页框右侧）" side="right">
          <Button variant="ghost" size="icon-sm" onClick={() => store.addFrame()} aria-label="插入页框">
            <FrameIcon className="size-4" />
          </Button>
        </Hint>
        <Separator className="my-1 !h-px w-5" />
        <Hint label="撤销 ⌘Z" side="right">
          <Button variant="ghost" size="icon-sm" disabled={!store.canUndo} onClick={() => store.undo()} aria-label="撤销">
            <Undo2Icon className="size-4" />
          </Button>
        </Hint>
        <Hint label="重做 ⇧⌘Z" side="right">
          <Button variant="ghost" size="icon-sm" disabled={!store.canRedo} onClick={() => store.redo()} aria-label="重做">
            <Redo2Icon className="size-4" />
          </Button>
        </Hint>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void store.insertImageFromFile(f);
          e.target.value = "";
        }}
      />

      {/* 左：页面缩略图栏 */}
      <SlidesRail store={store} zoomApi={zoomApi} />

      {/* 右：属性面板 */}
      <Inspector store={store} selectedEl={selectedEl} askAI={askAI} />

      {/* 下：缩放条 */}
      <div className="glass glass-sm pointer-events-auto absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center px-1 py-0.5">
        <Hint label="缩小" side="top">
          <Button variant="ghost" size="icon-sm" onClick={() => zoomApi.current?.zoomBy(1 / 1.2)} aria-label="缩小">
            <MinusIcon className="size-3.5" />
          </Button>
        </Hint>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="tabular-nums w-14 px-0">
              {zoomPct}%
              <ChevronDownIcon className="size-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" className="w-44">
            <DropdownMenuLabel>缩放</DropdownMenuLabel>
            {[25, 50, 75, 100, 150, 200, 400].map((p) => (
              <DropdownMenuItem key={p} onSelect={() => zoomApi.current?.zoomTo(p / 100)}>
                {p}%
                {zoomPct === p && <span className="text-primary ml-auto text-xs">✓</span>}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => zoomApi.current?.fitAll()}>
              <MaximizeIcon className="size-3.5" /> 适配全部画板
              <span className="ml-auto text-[10px] opacity-60">⌘0</span>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!activeFrame} onSelect={() => activeFrame && zoomApi.current?.focusFrame(activeFrame.id)}>
              <FrameIcon className="size-3.5" /> 缩放至当前页
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Hint label="放大" side="top">
          <Button variant="ghost" size="icon-sm" onClick={() => zoomApi.current?.zoomBy(1.2)} aria-label="放大">
            <PlusIcon className="size-3.5" />
          </Button>
        </Hint>
        <Separator orientation="vertical" className="mx-0.5 !h-4" />
        <Hint label="适配全部画板 ⌘0" side="top">
          <Button variant="ghost" size="icon-sm" onClick={() => zoomApi.current?.fitAll()} aria-label="适配全部">
            <MaximizeIcon className="size-3.5" />
          </Button>
        </Hint>
      </div>

      {/* 空画布（agent 写了 frames:[] && objects:[]）：一键补首页框 */}
      {doc.frames.length === 0 && doc.objects.length === 0 && (
        <div className="absolute inset-0 z-10 flex items-center justify-center">
          <div className="glass px-5 py-4 text-center text-sm">
            <div className="text-muted-foreground mb-2">这块画布还是空的</div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => store.addFrame()}>
                <PlusIcon className="size-3.5" /> 空白页框
              </Button>
              <Button onClick={() => store.addFrame({ title: true })}>
                <PlusIcon className="size-3.5" /> 标题页框
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 冲突对话框（agent 外部改写 × 本地未保存编辑） */}
      <Dialog open={!!store.conflict} onOpenChange={(o) => !o && store.resolveConflict("keep")}>
        <DialogContent className="max-w-[400px]">
          <DialogHeader>
            <DialogTitle>文档在外部被修改</DialogTitle>
            <DialogDescription>
              工作区里的 {store.fileRel ?? "文档"} 被（agent 或别的窗口）改动了，而你有尚未保存的编辑。
              载入外部版本会丢掉本地改动；保留本地会稍后覆盖写回。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => store.resolveConflict("keep")}>
              保留本地
            </Button>
            <Button onClick={() => store.resolveConflict("reload")}>载入外部版本</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {store.notice && (
        <div className="glass glass-sm pointer-events-none absolute right-3 bottom-14 z-30 max-w-[60%] animate-in fade-in slide-in-from-bottom-2 px-3 py-2 text-xs shadow-lg">
          {store.notice}
        </div>
      )}

      {presenting && <Presentation store={store} onClose={() => setPresenting(false)} />}
      </div>
    </TooltipProvider>
  );
};

/* ---------------- 新建文档 ---------------- */

const NewDeck: FC<{ store: DeckStore }> = ({ store }) => {
  const [name, setName] = useState("演示文稿");
  const [preset, setPreset] = useState<PagePreset>("16:9");
  return (
    <div className="flex h-full items-center justify-center">
      <div className="glass w-[420px] p-6">
        <div className="text-[17px] font-semibold">新建幻灯片画布</div>
        <p className="text-muted-foreground mt-1 text-[13px] leading-relaxed">
          会在工作区根目录创建一个 <code className="bg-secondary rounded px-1">.canvas.json</code> 文档并绑定到本面板；
          之后 agent 可以直接读写这份文件，画布即时刷新。
        </p>
        <div className="mt-5 grid gap-2">
          <Label htmlFor="deck-name">文档名</Label>
          <div className="flex items-center gap-2">
            <Input
              id="deck-name"
              value={name}
              autoFocus
              placeholder="演示文稿"
              className="h-8 flex-1"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && name.trim()) store.createDoc(name, preset);
              }}
            />
            <PresetSelect value={preset} onChange={setPreset} className="w-[150px]" />
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <Button disabled={!name.trim()} onClick={() => store.createDoc(name, preset)}>
            创建画布
          </Button>
        </div>
      </div>
    </div>
  );
};

const PresetSelect: FC<{ value: PagePreset; onChange: (p: PagePreset) => void; className?: string }> = ({ value, onChange, className }) => (
  <Select value={value} onValueChange={(v) => onChange(v as PagePreset)}>
    <SelectTrigger className={cn("h-8 text-xs", className)}>
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {Object.entries(PAGE_SIZES).map(([k, s]) => (
        <SelectItem key={k} value={k} className="text-xs">
          {s.label} · {s.w}×{s.h}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

/* ---------------- 选中浮动工具条 ---------------- */

const SelectionBar: FC<{ store: DeckStore; multi: boolean }> = ({ store, multi }) => (
  <div className="glass glass-sm flex items-center gap-0.5 px-1 py-0.5 shadow-lg">
    <Hint label="左对齐" side="top">
      <Button variant="ghost" size="icon-sm" onClick={() => store.alignSelected("left")} aria-label="左对齐">
        <AlignLeftIcon className="size-3.5" />
      </Button>
    </Hint>
    <Hint label="水平居中" side="top">
      <Button variant="ghost" size="icon-sm" onClick={() => store.alignSelected("hcenter")} aria-label="水平居中">
        <AlignCenterIcon className="size-3.5" />
      </Button>
    </Hint>
    <Hint label="右对齐" side="top">
      <Button variant="ghost" size="icon-sm" onClick={() => store.alignSelected("right")} aria-label="右对齐">
        <AlignRightIcon className="size-3.5" />
      </Button>
    </Hint>
    <Hint label="顶对齐" side="top">
      <Button variant="ghost" size="icon-sm" onClick={() => store.alignSelected("top")} aria-label="顶对齐">
        <AlignStartVerticalIcon className="size-3.5" />
      </Button>
    </Hint>
    <Hint label="垂直居中" side="top">
      <Button variant="ghost" size="icon-sm" onClick={() => store.alignSelected("vcenter")} aria-label="垂直居中">
        <AlignCenterVerticalIcon className="size-3.5" />
      </Button>
    </Hint>
    <Hint label="底对齐" side="top">
      <Button variant="ghost" size="icon-sm" onClick={() => store.alignSelected("bottom")} aria-label="底对齐">
        <AlignEndVerticalIcon className="size-3.5" />
      </Button>
    </Hint>
    {multi && (
      <>
        <Separator orientation="vertical" className="mx-0.5 !h-4" />
        <Hint label="水平等间隙分布（≥3 个）" side="top">
          <Button variant="ghost" size="icon-sm" onClick={() => store.distributeSelected("h")} aria-label="水平分布">
            <MoveHorizontalIcon className="size-3.5" />
          </Button>
        </Hint>
        <Hint label="垂直等间隙分布（≥3 个）" side="top">
          <Button variant="ghost" size="icon-sm" onClick={() => store.distributeSelected("v")} aria-label="垂直分布">
            <MoveVerticalIcon className="size-3.5" />
          </Button>
        </Hint>
      </>
    )}
    <Separator orientation="vertical" className="mx-0.5 !h-4" />
    <Hint label="置于顶层 ⇧⌘]" side="top">
      <Button variant="ghost" size="icon-sm" onClick={() => store.moveSelectedZ("front")} aria-label="置于顶层">
        <ArrowUpToLineIcon className="size-3.5" />
      </Button>
    </Hint>
    <Hint label="置于底层 ⇧⌘[" side="top">
      <Button variant="ghost" size="icon-sm" onClick={() => store.moveSelectedZ("back")} aria-label="置于底层">
        <ArrowDownToLineIcon className="size-3.5" />
      </Button>
    </Hint>
    <Separator orientation="vertical" className="mx-0.5 !h-4" />
    <Hint label="复制 ⌘D" side="top">
      <Button variant="ghost" size="icon-sm" onClick={() => store.duplicateSelected()} aria-label="复制">
        <CopyIcon className="size-3.5" />
      </Button>
    </Hint>
    <Hint label="删除 Del" side="top">
      <Button variant="ghost" size="icon-sm" onClick={() => store.deleteSelected()} aria-label="删除">
        <Trash2Icon className="size-3.5" />
      </Button>
    </Hint>
  </div>
);

/* ---------------- 画布右键菜单（四处命中合一） ---------------- */

const Z_ITEMS: { mode: "front" | "back" | "forward" | "backward"; label: string; shortcut?: string }[] = [
  { mode: "front", label: "置于顶层", shortcut: "⇧⌘]" },
  { mode: "forward", label: "上移一层", shortcut: "⌘]" },
  { mode: "backward", label: "下移一层", shortcut: "⌘[" },
  { mode: "back", label: "置于底层", shortcut: "⇧⌘[" },
];

const CanvasContextMenu: FC<{
  store: DeckStore;
  hit: ContextHit | null;
  insert: (kind: SelKind) => void;
  askAI: () => void;
  zoomApi: { current: ZoomApi | null };
}> = ({ store, hit, insert, askAI, zoomApi }) => {
  const hasSel = !!store.sel && store.sel.elIds.length > 0;
  const frame = hit && hit.kind !== "canvas" ? store.doc.frames.find((f) => f.id === hit.containerId) : undefined;
  return (
    <ContextMenuContent className="w-52">
      {hit?.kind === "element" && (
        <>
          <ContextMenuLabel>元素</ContextMenuLabel>
          <ContextMenuItem disabled={!hasSel} onSelect={() => store.copySelected()}>
            <ClipboardCopyIcon className="size-3.5" /> 复制 <span className="ml-auto opacity-60">⌘C</span>
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasSel} onSelect={() => store.cutSelected()}>
            <ClipboardXIcon className="size-3.5" /> 剪切 <span className="ml-auto opacity-60">⌘X</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => store.pasteClipboard()}>
            <ClipboardPasteIcon className="size-3.5" /> 粘贴 <span className="ml-auto opacity-60">⌘V</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => store.duplicateSelected()}>
            <CopyIcon className="size-3.5" /> 重制 <span className="ml-auto opacity-60">⌘D</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <ArrowUpIcon className="size-3.5" /> 图层
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-44">
              {Z_ITEMS.map((z) => (
                <ContextMenuItem key={z.mode} onSelect={() => store.moveSelectedZ(z.mode)}>
                  {z.label} <span className="ml-auto opacity-60">{z.shortcut}</span>
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem className="text-primary" onSelect={askAI}>
            <SparklesIcon className="size-3.5" /> 问 AI 修改此元素
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => store.deleteSelected()}>
            <Trash2Icon className="size-3.5" /> 删除 <span className="ml-auto opacity-60">Del</span>
          </ContextMenuItem>
        </>
      )}
      {hit?.kind === "artboard" && frame && (
        <>
          <ContextMenuLabel>页框 · 第 {store.doc.frames.findIndex((f) => f.id === frame.id) + 1} 页</ContextMenuLabel>
          <ContextMenuItem onSelect={() => insert("text")}>
            <TypeIcon className="size-3.5" /> 添加文本
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => insert("rect")}>
            <SquareIcon className="size-3.5" /> 添加矩形
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => store.duplicateFrame(frame.id)}>
            <CopyIcon className="size-3.5" /> 复制页
          </ContextMenuItem>
          <ContextMenuItem disabled={store.doc.frames.length <= 1} variant="destructive" onSelect={() => store.removeFrame(frame.id)}>
            <Trash2Icon className="size-3.5" /> 删除页
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => zoomApi.current?.focusFrame(frame.id)}>
            <FrameIcon className="size-3.5" /> 缩放至此页
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => store.tidyFrames()}>
            <MaximizeIcon className="size-3.5" /> 一键整理页框
          </ContextMenuItem>
        </>
      )}
      {(!hit || hit.kind === "canvas") && (
        <>
          <ContextMenuItem onSelect={() => store.pasteClipboard()}>
            <ClipboardPasteIcon className="size-3.5" /> 粘贴 <span className="ml-auto opacity-60">⌘V</span>
          </ContextMenuItem>
          <ContextMenuItem disabled={!store.activeFrame} onSelect={() => store.selectAllInContainer()}>
            全选当前容器 <span className="ml-auto opacity-60">⌘A</span>
          </ContextMenuItem>
          <ContextMenuItem disabled={store.doc.frames.length === 0} onSelect={() => store.addFrame()}>
            <PlusIcon className="size-3.5" /> 插入页框
          </ContextMenuItem>
          <ContextMenuItem disabled={store.doc.frames.length <= 1} onSelect={() => store.tidyFrames()}>
            <MaximizeIcon className="size-3.5" /> 一键整理页框
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => zoomApi.current?.fitAll()}>
            <MaximizeIcon className="size-3.5" /> 适配全部画板 <span className="ml-auto opacity-60">⌘0</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => zoomApi.current?.zoom100()}>
            <FrameIcon className="size-3.5" /> 缩放 100% <span className="ml-auto opacity-60">⌘1</span>
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
};

/* ---------------- 缩略图栏 ---------------- */

const RAIL_W = 172;
const SlidesRail: FC<{ store: DeckStore; zoomApi: { current: ZoomApi | null } }> = ({ store, zoomApi }) => {
  const { doc, sel, selectFrame, addFrame, duplicateFrame, removeFrame, moveFrame, tidyFrames } = store;
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [overAt, setOverAt] = useState<number | null>(null);
  return (
    <div className="glass pointer-events-auto absolute top-16 bottom-14 left-[68px] z-10 flex w-[196px] flex-col gap-2.5">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2.5 px-2.5 py-2.5">
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
                      overAt === i && dragFrom !== null && dragFrom !== i && "ring-2 ring-primary",
                    )}
                  >
                    <div className="text-muted-foreground absolute -top-0.5 left-1 z-10 text-[10px] font-semibold tabular-nums drop-shadow-sm">
                      {i + 1}
                    </div>
                    <div
                      className={cn(
                        "overflow-hidden rounded-md bg-white shadow-[0_1px_4px_rgba(0,0,0,0.18)] outline-offset-2",
                        active && "outline-2 outline-primary",
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
                      {doc.frames.length > 1 && (
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
                      )}
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
                  <ContextMenuItem disabled={doc.frames.length <= 1} variant="destructive" onSelect={() => removeFrame(s.id)}>
                    <Trash2Icon className="size-3.5" /> 删除页
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
      </ScrollArea>
      <div className="grid shrink-0 grid-cols-2 gap-1.5 px-2.5 pb-1">
        <Button variant="secondary" size="sm" className="text-xs" onClick={() => addFrame()}>
          <PlusIcon className="size-3" /> 空白页
        </Button>
        <Button variant="secondary" size="sm" className="text-xs" onClick={() => addFrame({ title: true })}>
          <PlusIcon className="size-3" /> 标题页
        </Button>
      </div>
      <div className="shrink-0 px-2.5 pb-2.5">
        <Hint label="把全部页框按页序网格归位（幂等）" side="top">
          <Button variant="ghost" size="sm" className="w-full text-xs" disabled={doc.frames.length <= 1} onClick={() => tidyFrames()}>
            <MaximizeIcon className="size-3" /> 一键整理
          </Button>
        </Hint>
      </div>
    </div>
  );
};

/* ---------------- 属性面板 ---------------- */

const BG_PRESETS = [
  { label: "白", css: "#ffffff" },
  { label: "墨", css: "#111318" },
  { label: "蓝雾", css: "linear-gradient(135deg,#0a84ff55,#5ac8fa22)" },
  { label: "紫罗兰", css: "linear-gradient(160deg,#bf5af2aa,#0a84ff44)" },
];

const kindLabel = (el: El) =>
  el.kind === "text" ? "文本" : el.kind === "image" ? "图片" : el.kind === "mermaid" ? "Mermaid 图表" : el.kind === "draw" ? "手绘笔迹" : (el as ShapeEl).shape === "rect" ? "矩形" : (el as ShapeEl).shape === "ellipse" ? "椭圆" : (el as ShapeEl).shape === "arrow" ? "箭头" : "直线";

const Inspector: FC<{ store: DeckStore; selectedEl: El | null; askAI: () => void }> = ({
  store,
  selectedEl,
  askAI,
}) => {
  const { doc, sel, activeFrame } = store;
  const multiCount = sel?.elIds.length ?? 0;
  const hasEl = multiCount > 0;
  const [tab, setTab] = useState<"element" | "page">("page");
  const prevHasEl = useRef(false);
  useEffect(() => {
    if (hasEl !== prevHasEl.current) {
      prevHasEl.current = hasEl;
      if (hasEl) setTab("element");
    }
  }, [hasEl]);

  const el = selectedEl;
  /** 页面板聚焦对象：选中元素所在页框（画布级元素=无）；否则当前聚焦页框 */
  const slide = el ? doc.frames.find((f) => f.id === sel?.containerId) : activeFrame;
  const patch = (
    p: Partial<TextEl> | Partial<ShapeEl> | Partial<ImageEl> | Partial<MermaidEl> | Partial<DrawEl>,
    coalesce?: boolean,
  ) => {
    if (!el || !sel) return;
    store.updateEl(sel.containerId, el.id, p as Parameters<typeof store.updateEl>[2], coalesce);
  };
  const runsOf = (el: TextEl) => el.runs;
  const everyRun = (el: TextEl, pred: (r: TextEl["runs"][number]) => boolean) => runsOf(el).every(pred);
  const toggleRunFlag = (el: TextEl, key: "bold" | "italic" | "underline") => {
    const next = !everyRun(el, (r) => !!r[key]);
    patch({ runs: el.runs.map((r) => ({ ...r, [key]: next })) });
  };

  return (
    <div className="glass absolute top-16 bottom-14 right-3 z-10 flex w-[260px] flex-col px-3 py-2 text-xs">
      <Tabs value={tab} onValueChange={(v) => setTab(v as "element" | "page")} className="min-h-0 flex-1">
        <TabsList>
          <TabsTrigger value="element">元素{multiCount > 1 ? ` · ${multiCount}` : ""}</TabsTrigger>
          <TabsTrigger value="page">页</TabsTrigger>
        </TabsList>
        <ScrollArea className="min-h-0 flex-1">
          <div className="pb-2">
            <TabsContent value="element" className="mt-2">
              {el ? (
                <>
                  <div className="flex items-center justify-between pt-0.5">
                    <span className="text-[13px] font-semibold">{kindLabel(el)}</span>
                    <div className="flex gap-0.5">
                      <Hint label="复制 ⌘D">
                        <Button variant="ghost" size="icon-sm" onClick={() => store.duplicateSelected()} aria-label="复制">
                          <CopyIcon className="size-3.5" />
                        </Button>
                      </Hint>
                      <Hint label="删除（Del）">
                        <Button variant="ghost" size="icon-sm" onClick={() => store.deleteSelected()} aria-label="删除">
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      </Hint>
                    </div>
                  </div>
                  <Separator className="my-2.5" />
                  <SectionTitle>几何</SectionTitle>
                  <div className="grid grid-cols-2 gap-x-2.5 gap-y-1.5">
                    <NumField label="X" value={el.x} onChange={(v) => patch({ x: v } as Partial<TextEl>, true)} />
                    <NumField label="Y" value={el.y} onChange={(v) => patch({ y: v } as Partial<TextEl>, true)} />
                    <NumField label="W" min={4} value={el.w} onChange={(v) => patch({ w: v } as Partial<TextEl>, true)} />
                    <NumField label="H" min={2} value={el.h} onChange={(v) => patch({ h: v } as Partial<TextEl>, true)} />
                    <NumField label="∠" min={-180} max={180} value={el.rotation ?? 0} onChange={(v) => patch({ rotation: v } as Partial<TextEl>, true)} />
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-foreground w-4 shrink-0 text-[10.5px] font-medium uppercase">α</span>
                      <Slider
                        min={0}
                        max={100}
                        value={[Math.round((el.opacity ?? 1) * 100)]}
                        onValueChange={([v]) => patch({ opacity: (v ?? 100) / 100 } as Partial<TextEl>, true)}
                        className="flex-1"
                      />
                    </div>
                  </div>

                  {el.kind === "text" && (
                    <>
                      <Separator className="my-2.5" />
                      <SectionTitle>文字</SectionTitle>
                      <div className="flex items-center gap-1">
                        <NumField
                          label="字号"
                          min={6}
                          max={400}
                          value={el.runs[0]?.size ?? DEFAULT_TEXT_SIZE}
                          onChange={(v) => patch({ runs: el.runs.map((r) => ({ ...r, size: v })) })}
                        />
                        <Hint label="加粗">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className={cn(everyRun(el, (r) => !!r.bold) && "bg-primary/12 text-primary")}
                            onClick={() => toggleRunFlag(el, "bold")}
                            aria-label="加粗"
                          >
                            <BoldIcon className="size-3.5" />
                          </Button>
                        </Hint>
                        <Hint label="斜体">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className={cn(everyRun(el, (r) => !!r.italic) && "bg-primary/12 text-primary")}
                            onClick={() => toggleRunFlag(el, "italic")}
                            aria-label="斜体"
                          >
                            <ItalicIcon className="size-3.5" />
                          </Button>
                        </Hint>
                        <Hint label="下划线">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className={cn(everyRun(el, (r) => !!r.underline) && "bg-primary/12 text-primary")}
                            onClick={() => toggleRunFlag(el, "underline")}
                            aria-label="下划线"
                          >
                            <UnderlineIcon className="size-3.5" />
                          </Button>
                        </Hint>
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <div className="flex gap-0.5">
                          {(
                            [
                              ["left", AlignLeftIcon, "左"],
                              ["center", AlignCenterIcon, "居中"],
                              ["right", AlignRightIcon, "右"],
                            ] as const
                          ).map(([a, Icon, label]) => (
                            <Hint key={a} label={`水平${label}对齐`}>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className={cn((el.align ?? "left") === a && "bg-primary/12 text-primary")}
                                onClick={() => patch({ align: a })}
                                aria-label={`水平${label}对齐`}
                              >
                                <Icon className="size-3.5" />
                              </Button>
                            </Hint>
                          ))}
                        </div>
                        <Separator orientation="vertical" className="!h-4" />
                        <div className="flex gap-0.5">
                          {(
                            [
                              ["top", AlignStartVerticalIcon, "上"],
                              ["middle", AlignCenterVerticalIcon, "居中"],
                              ["bottom", AlignEndVerticalIcon, "下"],
                            ] as const
                          ).map(([a, Icon, label]) => (
                            <Hint key={a} label={`垂直${label}对齐`}>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className={cn((el.vAlign ?? "top") === a && "bg-primary/12 text-primary")}
                                onClick={() => patch({ vAlign: a })}
                                aria-label={`垂直${label}对齐`}
                              >
                                <Icon className="size-3.5" />
                              </Button>
                            </Hint>
                          ))}
                        </div>
                      </div>
                      <div className="mt-2">
                        <ColorField
                          label="颜色"
                          value={el.runs[0]?.color}
                          onChange={(hex) => patch({ runs: el.runs.map((r) => ({ ...r, color: hex })) })}
                        />
                      </div>
                    </>
                  )}

                  {el.kind === "shape" && (
                    <>
                      <Separator className="my-2.5" />
                      <SectionTitle>填充与描边</SectionTitle>
                      <div className="flex flex-col gap-1.5">
                        {el.shape !== "line" && el.shape !== "arrow" && (
                          <ColorField
                            label="填充"
                            value={el.fill}
                            onChange={(hex) => patch({ fill: hex } as Partial<ShapeEl>)}
                            onClear={() => patch({ fill: "none" } as Partial<ShapeEl>)}
                          />
                        )}
                        <ColorField
                          label="描边"
                          value={el.stroke}
                          onChange={(hex) => patch({ stroke: hex } as Partial<ShapeEl>)}
                          onClear={() => patch({ stroke: undefined } as Partial<ShapeEl>)}
                        />
                        <div className="grid grid-cols-2 gap-2">
                          <NumField
                            label="粗细"
                            min={0.5}
                            max={40}
                            value={el.strokeWidth ?? 2}
                            onChange={(v) => patch({ strokeWidth: v } as Partial<ShapeEl>, true)}
                          />
                          {el.shape === "rect" && (
                            <NumField label="圆角" min={0} value={el.radius ?? 0} onChange={(v) => patch({ radius: v } as Partial<ShapeEl>, true)} />
                          )}
                        </div>
                      </div>
                    </>
                  )}

                  {el.kind === "image" && (
                    <>
                      <Separator className="my-2.5" />
                      <SectionTitle>图片</SectionTitle>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground">适配</span>
                        <Select value={el.fit ?? "cover"} onValueChange={(v) => patch({ fit: v as ImageEl["fit"] })}>
                          <SelectTrigger className="w-[130px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="cover">裁剪填满 cover</SelectItem>
                            <SelectItem value="contain">整图 contain</SelectItem>
                            <SelectItem value="stretch">拉伸 stretch</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="mt-1.5">
                        <NumField label="圆角" min={0} value={el.radius ?? 0} onChange={(v) => patch({ radius: v } as Partial<ImageEl>, true)} />
                      </div>
                      <div className="text-muted-foreground mt-1.5 truncate text-[10.5px]" title={el.src}>
                        {el.src}
                      </div>
                    </>
                  )}

                  {el.kind === "mermaid" && (
                    <>
                      <Separator className="my-2.5" />
                      <SectionTitle>Mermaid</SectionTitle>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground">主题</span>
                        <Select value={el.theme ?? "follow"} onValueChange={(v) => patch({ theme: v as MermaidTheme })}>
                          <SelectTrigger className="w-[120px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="follow">跟随应用</SelectItem>
                            <SelectItem value="default">浅色</SelectItem>
                            <SelectItem value="dark">深色</SelectItem>
                            <SelectItem value="neutral">中性</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <textarea
                        value={el.code}
                        spellCheck={false}
                        onChange={(e) => patch({ code: e.target.value }, true)}
                        onKeyDown={(e) => e.stopPropagation()}
                        className="mt-1.5 h-40 w-full resize-y rounded-md border border-input bg-secondary/50 p-2 font-mono text-[11px] leading-relaxed outline-none focus-visible:border-primary"
                      />
                      <p className="text-muted-foreground mt-1 text-[10.5px] leading-relaxed">
                        支持 flowchart / sequence / pie / state 等全部 mermaid 图类型；画布上双击也可直接改代码。
                      </p>
                    </>
                  )}

                  {el.kind === "draw" && (
                    <>
                      <Separator className="my-2.5" />
                      <SectionTitle>手绘笔迹</SectionTitle>
                      <div className="flex flex-col gap-1.5">
                        <ColorField label="颜色" value={el.stroke} onChange={(hex) => patch({ stroke: hex })} />
                        <NumField
                          label="粗细"
                          min={0.5}
                          max={40}
                          value={el.strokeWidth ?? 2}
                          onChange={(v) => patch({ strokeWidth: v }, true)}
                        />
                      </div>
                      <p className="text-muted-foreground mt-1.5 text-[10.5px] leading-relaxed">
                        {el.points.length} 个采样点；缩放笔迹会按包围盒拉伸。
                      </p>
                    </>
                  )}

                  <Separator className="my-2.5" />
                  <Button variant="secondary" className="w-full" onClick={askAI}>
                    <SparklesIcon className="size-3.5" /> 问 AI 修改此元素
                  </Button>
                </>
              ) : multiCount > 1 && sel ? (
                <>
                  <div className="pt-0.5 text-[13px] font-semibold">已选 {multiCount} 个元素</div>
                  <p className="text-muted-foreground mt-0.5 text-[10.5px]">拖动组框手柄可整体等比缩放。</p>
                  <Separator className="my-2.5" />
                  <SectionTitle>对齐（相对组框）</SectionTitle>
                  <div className="grid grid-cols-6 gap-1">
                    {(
                      [
                        ["left", AlignLeftIcon, "左对齐"],
                        ["hcenter", AlignCenterIcon, "水平居中"],
                        ["right", AlignRightIcon, "右对齐"],
                        ["top", AlignStartVerticalIcon, "顶对齐"],
                        ["vcenter", AlignCenterVerticalIcon, "垂直居中"],
                        ["bottom", AlignEndVerticalIcon, "底对齐"],
                      ] as const
                    ).map(([mode, Icon, label]) => (
                      <Hint key={mode} label={label}>
                        <Button variant="ghost" size="icon-sm" onClick={() => store.alignSelected(mode)} aria-label={label}>
                          <Icon className="size-3.5" />
                        </Button>
                      </Hint>
                    ))}
                  </div>
                  <SectionTitle>分布</SectionTitle>
                  <div className="flex gap-1">
                    <Hint label="水平等间隙分布（≥3）">
                      <Button variant="ghost" size="icon-sm" onClick={() => store.distributeSelected("h")} aria-label="水平分布">
                        <MoveHorizontalIcon className="size-3.5" />
                      </Button>
                    </Hint>
                    <Hint label="垂直等间隙分布（≥3）">
                      <Button variant="ghost" size="icon-sm" onClick={() => store.distributeSelected("v")} aria-label="垂直分布">
                        <MoveVerticalIcon className="size-3.5" />
                      </Button>
                    </Hint>
                  </div>
                  <SectionTitle>图层</SectionTitle>
                  <div className="grid grid-cols-4 gap-1">
                    {Z_ITEMS.map((z) => (
                      <Hint key={z.mode} label={z.label}>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => store.moveSelectedZ(z.mode)}
                          aria-label={z.label}
                          className={cn(z.mode === "forward" && "col-start-3", z.mode === "backward" && "col-start-4")}
                        >
                          {z.mode === "front" ? <ArrowUpToLineIcon className="size-3.5" /> : z.mode === "back" ? <ArrowDownToLineIcon className="size-3.5" /> : z.mode === "forward" ? <ArrowUpIcon className="size-3.5" /> : <ArrowDownIcon className="size-3.5" />}
                        </Button>
                      </Hint>
                    ))}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-1.5">
                    <Button variant="secondary" size="sm" onClick={() => store.duplicateSelected()}>
                      <CopyIcon className="size-3" /> 复制
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => store.deleteSelected()}>
                      <Trash2Icon className="size-3" /> 删除
                    </Button>
                  </div>
                </>
              ) : (
                <p className="text-muted-foreground py-2 leading-relaxed">
                  在画布上点选或框选元素后在这里改属性。拖动空白处可框选，按住 ⇧ 加选。
                </p>
              )}
            </TabsContent>

            <TabsContent value="page" className="mt-2">
              <div className="text-[13px] font-semibold">页面</div>
              {slide ? (
                <>
                  <p className="text-muted-foreground mt-0.5 text-[11px]">
                    第 {doc.frames.findIndex((f) => f.id === slide.id) + 1} / {slideFrames(doc).length} 页 · {slide.w}×{slide.h}
                    （放映/导出只含页框，画布级元素不入档）
                  </p>
                  <Separator className="my-2.5" />
                  <SectionTitle>背景</SectionTitle>
                  <div className="mb-1.5 grid grid-cols-4 gap-1.5">
                    {BG_PRESETS.map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        title={p.label}
                        onClick={() => slide && store.setFrameBackground(slide.id, p.css)}
                        className={cn(
                          "h-8 rounded-md border text-[10px] font-medium shadow-inner",
                          slide.background === p.css ? "border-primary ring-1 ring-primary" : "border-border",
                        )}
                        style={{ background: p.css, color: p.css === "#111318" ? "#fff" : "#000" }}
                      />
                    ))}
                  </div>
                  <ColorField label="取色" value={slide.background} onChange={(hex) => store.setFrameBackground(slide.id, hex)} />
                </>
              ) : (
                <p className="text-muted-foreground mt-1">
                  {el ? "选中的是画布级元素（不在任何页框内），无页面属性。" : "还没有页框，点左侧「＋ 空白页」。"}
                </p>
              )}
              <Separator className="my-2.5" />
              <SectionTitle>页面尺寸（全部画板等比重排）</SectionTitle>
              <PresetSelect value={doc.meta.pagePreset} onChange={store.setPreset} className="w-full" />
              <Separator className="my-2.5" />
              <p className="text-muted-foreground px-0.5 leading-relaxed">
                提示：拖拽元素边缘有吸附线；拖入/粘贴图片自动落盘资产目录；选中元素后可「问 AI」。
              </p>
            </TabsContent>
          </div>
        </ScrollArea>
      </Tabs>
    </div>
  );
};

/* ---------------- 小表单件 ---------------- */

const SectionTitle: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="text-muted-foreground pb-1.5 pt-1 text-[10.5px] font-semibold tracking-wide uppercase">{children}</div>
);

/** 受控数值输入：编辑中不被外部值回写打断（拖拽同步等），失焦后归一 */
const NumField: FC<{
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
}> = ({ label, value, onChange, min, max, step = 1 }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(Math.round(value * 100) / 100);
  const commitVal = (raw: string) => {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n)) {
      let v = n;
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
      onChange(v);
    }
    setDraft(null);
  };
  return (
    <label className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="text-muted-foreground w-4 shrink-0 text-[10.5px] font-medium uppercase">{label}</span>
      <Input
        type="number"
        className="h-7 w-full min-w-0 px-1.5 text-xs"
        value={shown}
        step={step}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Number.parseFloat(e.target.value);
          if (Number.isFinite(n)) commitVal(e.target.value);
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => e.stopPropagation()}
      />
    </label>
  );
};

const ColorField: FC<{
  label: string;
  value: string | undefined;
  onChange: (hex: string) => void;
  onClear?: () => void;
}> = ({ label, value, onChange, onClear }) => {
  const valid = value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : value ? firstHex(value) : undefined;
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-muted-foreground w-10 shrink-0 text-[10.5px] font-medium uppercase">{label}</span>
      <input
        type="color"
        className="size-7 shrink-0 cursor-pointer rounded-md"
        value={valid ?? "#1d1d1f"}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="text-muted-foreground truncate text-[11px]">{value === "none" ? "无" : (value ?? "—")}</span>
      {onClear && (
        <button
          type="button"
          title="清除颜色"
          onClick={onClear}
          className="text-muted-foreground hover:text-foreground ml-auto shrink-0 text-[11px] underline-offset-2 hover:underline"
        >
          清除
        </button>
      )}
    </label>
  );
};

function firstHex(css: string): string | undefined {
  const m = /#([0-9a-f]{6}|[0-9a-f]{3})\b/i.exec(css);
  if (!m) return undefined;
  const h = m[1];
  return `#${h.length === 3 ? h.split("").map((c) => c + c).join("") : h}`;
}
