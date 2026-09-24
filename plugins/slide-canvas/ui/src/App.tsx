/**
 * slide-canvas 外壳：一份文档、两个模式，两套外壳布局。
 *   board（白板画布）：Excalidraw 式无限画布，只编辑 objects；chrome 全浮层
 *     （顶栏 pill / 左工具栏 / 右 Inspector 玻璃卡 / 底部缩放 pill）。
 *   deck（幻灯片 PPT）：Figma/PowerPoint 式固定四栏——顶栏（文档名·模式·放映/导出）、
 *     左缩略图栏（border-r）、中央画布盒（当前页 fit 于此，不再被面板遮挡）、
 *     右 Inspector（border-l）、底部状态条（左翻页 · 右缩放）。
 *   模式缺省按内容推断（纯页框档→deck，否则 localStorage 记忆→board）。
 * 共用：左竖工具栏（插入/钢笔/历史，浮于画布盒内） · 选中浮动工具条 · 右键菜单 ·
 *   撤销栈/防抖保存/桥。交互原语全来自 @/components/ui。
 * 外壳之外的功能块已拆至 ./editor/*（元素工厂 / 工具条 / 右键菜单 / 缩略图栏 / 属性面板 / 表单件）。
 */
import { type FC } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  DownloadIcon,
  FrameIcon,
  HelpCircleIcon,
  LayoutGridIcon,
  LayoutTemplateIcon,
  MaximizeIcon,
  MinusIcon,
  PlayIcon,
  PlusIcon,
  Redo2Icon,
  SparklesIcon,
  Undo2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Hint, TooltipProvider } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { CanvasStage } from "./CanvasStage";
import { Presentation } from "./Presentation";
import { TemplatePicker } from "./TemplatePicker";
import { Home } from "./Home";
import { useEditorShell } from "./editor/useEditorShell";
import { ToolButtons } from "./editor/ToolButtons";
import { BoardToolbar } from "./editor/BoardToolbar";
import { SelectionBar } from "./editor/SelectionBar";
import { CanvasContextMenu } from "./editor/CanvasContextMenu";
import { SlidesRail } from "./editor/SlidesRail";
import { Inspector } from "./editor/inspector";

/* ---------------- 外壳 ---------------- */

export const App: FC = () => {
  const {
    store,
    docKind,
    effMode,
    editingId,
    setEditingId,
    presenting,
    setPresenting,
    exporting,
    zoomPct,
    pen,
    setPen,
    hand,
    setHand,
    drawTool,
    setDrawTool,
    menuHit,
    menuOpen,
    setMenuOpen,
    homeOpen,
    setHomeOpen,
    emptyTplOpen,
    setEmptyTplOpen,
    zoomApi,
    fileRef,
    curIdx,
    stepFrame,
    selectedEl,
    insert,
    toggleDraw,
    askAI,
    doExport,
    doExportSvg,
    doExportHtml,
    onContextHit,
    onZoom,
  } = useEditorShell();
  const { doc, sel, activeFrame } = store;

  /* ---------- 未绑定文档 ---------- */
  if (!store.connected) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        正在连接工作区…
      </div>
    );
  }
  if (!store.hasDoc || homeOpen) return <Home store={store} currentPath={store.fileRel} onEnter={() => setHomeOpen(false)} />;

  const deck = effMode === "deck";

  /* ---------- 共用 chrome 片段：deck 固定四栏与 board 浮层复用同一批控件 ---------- */

  const undoRedo = (
    <>
      <Hint label="撤销 ⌘Z" side="top">
        <Button variant="ghost" size="icon-sm" className="sc-tool" disabled={!store.canUndo} onClick={() => store.undo()} aria-label="撤销">
          <Undo2Icon className="size-4" />
        </Button>
      </Hint>
      <Hint label="重做 ⇧⌘Z" side="top">
        <Button variant="ghost" size="icon-sm" className="sc-tool" disabled={!store.canRedo} onClick={() => store.redo()} aria-label="重做">
          <Redo2Icon className="size-4" />
        </Button>
      </Hint>
    </>
  );

  const docTitle = (
    <>
      <span className="bg-secondary text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[10px]">{docKind === "deck" ? "幻灯片" : docKind === "ui" ? "UI 设计" : "白板"}</span>
      <span className="truncate font-medium">{store.fileRel?.split("/").pop()?.replace(/\.canvas\.json$/i, "") ?? "未命名画布"}</span>
      <span
        className={cn("size-1.5 shrink-0 rounded-full bg-ink transition-opacity", store.dirty ? "opacity-100" : "opacity-0")}
        title={store.dirty ? "有未保存改动（800ms 防抖写盘）" : "已保存"}
      />
      <span className="text-muted-foreground truncate">{store.fileRel ? "" : "（未落盘）"}</span>
    </>
  );

  const askAIBtn = (
    <Hint label="问 AI：把选中元素/整档上下文填入对话输入框" side="bottom">
      <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={askAI} aria-label="问 AI">
        <SparklesIcon className="size-4" />
      </Button>
    </Hint>
  );

  const deckActions = (
    <>
      <Hint label="放映（⌘⇧F / F5）" side="bottom">
        <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => setPresenting(true)} aria-label="放映">
          <PlayIcon className="size-4" />
        </Button>
      </Hint>
      <Separator orientation="vertical" className="mx-1 !h-6" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" disabled={exporting} aria-label="导出">
            <DownloadIcon className="size-3.5" /> {exporting ? "导出中…" : "导出"}
            <ChevronDownIcon className="size-3.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void doExport()}>
            PPTX · PowerPoint <span className="text-muted-foreground ml-auto text-[10px]">.pptx</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void doExportSvg()}>
            SVG · 每页一文件 <span className="text-muted-foreground ml-auto text-[10px]">-pN.svg</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void doExportHtml()}>
            HTML · 自含放映页 <span className="text-muted-foreground ml-auto text-[10px]">.html</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  /** 回首页（历史卡片墙）入口：类型已随文档固定，这里只做导航 */
  const homeBtn = (
    <Hint label="全部画布（回到首页）" side="bottom">
      <Button variant="ghost" size="sm" className="sc-tool gap-1 text-xs" onClick={() => setHomeOpen(true)} aria-label="全部画布">
        <LayoutGridIcon className="size-3.5" /> 全部画布
      </Button>
    </Hint>
  );

  const pageNav = (
    <>
      <Hint label="上一页（PgUp）" side="top">
        <Button variant="ghost" size="icon-sm" className="sc-tool" disabled={curIdx <= 0} onClick={() => stepFrame(-1)} aria-label="上一页">
          <ArrowLeftIcon className="size-3.5" />
        </Button>
      </Hint>
      <span className="px-0.5 text-xs tabular-nums">
        第 {curIdx + 1} / {doc.frames.length} 页
      </span>
      <Hint label="下一页（PgDn）" side="top">
        <Button variant="ghost" size="icon-sm" className="sc-tool" disabled={curIdx >= doc.frames.length - 1} onClick={() => stepFrame(1)} aria-label="下一页">
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </Hint>
    </>
  );

  const zoomCluster = (
    <>
      <Hint label="缩小" side="top">
        <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => zoomApi.current?.zoomBy(1 / 1.2)} aria-label="缩小">
          <MinusIcon className="size-3.5" />
        </Button>
      </Hint>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="sc-tool tabular-nums w-14 px-0">
            {zoomPct}%
            <ChevronDownIcon className="size-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-44">
          <DropdownMenuLabel>缩放</DropdownMenuLabel>
          {[25, 50, 75, 100, 150, 200, 400].map((p) => (
            <DropdownMenuItem key={p} onSelect={() => zoomApi.current?.zoomTo(p / 100)}>
              {p}%
              {zoomPct === p && <span className="text-ink ml-auto text-xs">✓</span>}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => zoomApi.current?.fitAll()}>
            <MaximizeIcon className="size-3.5" /> {deck ? "适配当前页" : "适配全部元素"}
            <span className="ml-auto text-[10px] opacity-60">⌘0</span>
          </DropdownMenuItem>
          {deck && (
            <DropdownMenuItem disabled={!activeFrame} onSelect={() => activeFrame && zoomApi.current?.focusFrame(activeFrame.id)}>
              <FrameIcon className="size-3.5" /> 缩放至当前页
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Hint label="放大" side="top">
        <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => zoomApi.current?.zoomBy(1.2)} aria-label="放大">
          <PlusIcon className="size-3.5" />
        </Button>
      </Hint>
      <Separator orientation="vertical" className="mx-0.5 !h-4" />
      <Hint label={deck ? "适配当前页 ⌘0" : "适配全部元素 ⌘0"} side="top">
        <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => zoomApi.current?.fitAll()} aria-label="适配">
          <MaximizeIcon className="size-3.5" />
        </Button>
      </Hint>
    </>
  );

  return (
    <TooltipProvider>
      <div
        className="relative flex h-full w-full flex-col overflow-hidden"
        style={
          deck
            ? {
                // 窗口壳：上亮下暗的极轻纵渐变（macOS 窗口感），停靠玻璃面板
                // 的模糊才透得出层次，而非糊在死平纯色上
                background:
                  "linear-gradient(180deg, color-mix(in oklab, var(--sc-app-bg), white 1.5%) 0%, var(--sc-app-bg) 45%, color-mix(in oklab, var(--sc-app-bg), black 1.5%) 100%)",
              }
            : undefined
        }
      >
        {/* 顶栏（deck 固定·磨砂停靠）：左插入/历史工具，中模式切换+文档名，右问AI/放映/导出 */}
        {deck && (
          <div className="glass-dock z-20 flex h-14 shrink-0 items-center gap-2 border-border/60 border-b px-3">
            <div className="sc-seg flex shrink-0 items-center gap-1">
              <ToolButtons
                store={store}
                pen={pen}
                onPen={() => {
                  setDrawTool(null);
                  setPen((v) => !v);
                }}
                insert={insert}
                pickImage={() => fileRef.current?.click()}
                deck
                vertical={false}
              />
            </div>
            <span className="sc-divider" />
            <div className="shrink-0">{homeBtn}</div>
            <div className="flex min-w-0 flex-1 items-center justify-center px-4">
              <div className="glass glass-sm flex min-w-0 max-w-[46ch] items-center gap-2 px-3.5 py-1.5 text-xs">{docTitle}</div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {askAIBtn}
              <span className="sc-divider" style={{ margin: "0 0.125rem" }} />
              {deckActions}
            </div>
          </div>
        )}

        <div className="relative flex min-h-0 flex-1">
          {/* 左：页面缩略图栏（deck 专属固定列） */}
          {deck && <SlidesRail store={store} zoomApi={zoomApi} />}

          {/* 中：画布盒——stage 的稳定树位（切模式不重挂）；白板模式下即全窗口，浮层几何不变 */}
          <div className="relative min-w-0 flex-1">
            <ContextMenu open={menuOpen} onOpenChange={setMenuOpen}>
              {/* 不能用 asChild：CanvasStage 是普通组件，Slot 合并到元素上的
                  onContextMenu（Radix 记录触发点的处理器）会被其 props 解构丢弃，
                  触发点永远停在默认 (0,0) → 菜单锚到屏幕左上/右上角。
                  包一层真实 span，stage 上的 contextmenu 冒泡进 Trigger 记录点位。 */}
              <ContextMenuTrigger className="absolute inset-0">
                <CanvasStage
                  store={store}
                  editingId={editingId}
                  setEditingId={setEditingId}
                  zoomApi={zoomApi}
                  onZoom={onZoom}
                  onContextHit={onContextHit}
                  penMode={pen}
                  handMode={hand}
                  drawTool={drawTool}
                  refitKey={store.fileRel}
                  surface={effMode}
                  selToolbar={sel && sel.elIds.length > 0 ? <SelectionBar store={store} multi={sel.elIds.length > 1} /> : undefined}
                />
              </ContextMenuTrigger>
              <CanvasContextMenu store={store} hit={menuHit} insert={insert} askAI={askAI} zoomApi={zoomApi} deck={deck} />
            </ContextMenu>

            {/* 白板空态：轻引导（不挡绘制落点） */}
            {!deck && doc.objects.length === 0 && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                <div className="glass glass-sm px-4 py-2.5 text-center text-xs leading-relaxed text-muted-foreground">
                  白板空空如也：用顶部工具条插入文本/形状/图片/Mermaid，按 P 起钢笔自由绘制
                  <br />
                  要逐页编辑做过场的话，回「全部画布」新建一个幻灯片档
                </div>
              </div>
            )}

            {/* 幻灯片空态：建首页 */}
            {deck && doc.frames.length === 0 && (
              <div className="absolute inset-0 z-10 flex items-center justify-center">
                <div className="glass px-5 py-4 text-center text-sm">
                  <div className="text-muted-foreground mb-2">还没有幻灯片页</div>
                  <div className="flex gap-2">
                    <Button variant="secondary" onClick={() => store.addFrame()}>
                      <PlusIcon className="size-3.5" /> 空白页
                    </Button>
                    <Button variant="secondary" onClick={() => store.addFrame({ title: true })}>
                      <PlusIcon className="size-3.5" /> 标题页
                    </Button>
                    <Button onClick={() => setEmptyTplOpen(true)}>
                      <LayoutTemplateIcon className="size-3.5" /> 模板起步
                    </Button>
                  </div>
                </div>
              </div>
            )}
            {deck && <TemplatePicker store={store} open={emptyTplOpen} onOpenChange={setEmptyTplOpen} />}
          </div>

          {/* 右：属性面板（deck 固定列 / board 浮卡，同一实例不重挂） */}
          <Inspector store={store} selectedEl={selectedEl} askAI={askAI} deck={deck} />

          {/* 白板浮层 chrome：单条顶栏装下 文档+工具+问AI（窄面板自动换行不重叠）/
              左下缩放与历史，末尾 ？ 图标悬停显示平移说明 */}
          {!deck && (
            <>
              <div className="glass pointer-events-auto absolute top-3 right-3 left-3 z-10 flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5">
                {homeBtn}
                <span className="bg-border h-4 w-px shrink-0" />
                <div className="flex min-w-16 flex-1 items-center gap-1.5 text-xs">{docTitle}</div>
                <BoardToolbar
                  store={store}
                  pen={pen}
                  hand={hand}
                  drawTool={drawTool}
                  onSelect={() => {
                    setPen(false);
                    setHand(false);
                    setDrawTool(null);
                  }}
                  onHand={() => {
                    setPen(false);
                    setDrawTool(null);
                    setHand((v) => !v);
                  }}
                  onPen={() => {
                    setHand(false);
                    setDrawTool(null);
                    setPen((v) => !v);
                  }}
                  insert={insert}
                  pickImage={() => fileRef.current?.click()}
                />
                <Separator orientation="vertical" className="mx-0.5 !h-5" />
                {askAIBtn}
              </div>
              <div className="glass glass-sm pointer-events-auto absolute bottom-3 left-3 z-10 flex items-center gap-1 px-1.5 py-1">
                {zoomCluster}
                <Separator orientation="vertical" className="mx-1 !h-4" />
                {undoRedo}
                <Separator orientation="vertical" className="mx-1 !h-4" />
                <Hint label="移动画布：按住 空格 或 中键 拖拽，或选抓手工具（H）" side="top">
                  <Button variant="ghost" size="icon-sm" className="sc-tool cursor-help" aria-label="画布操作说明">
                    <HelpCircleIcon className="size-3.5" />
                  </Button>
                </Hint>
              </div>
            </>
          )}
        </div>

        {/* 底部状态条（deck 固定）：左翻页 · 右缩放，各归各位不再混一颗 pill */}
        {deck && (
          <div className="glass-dock z-20 flex h-11 shrink-0 items-center justify-between border-border/60 border-t px-3">
            <div className="flex items-center gap-1">{curIdx >= 0 ? pageNav : null}</div>
            <div className="flex items-center gap-1">{zoomCluster}</div>
          </div>
        )}

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
            <Button variant="secondary" onClick={() => store.resolveConflict("keep")}>
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
