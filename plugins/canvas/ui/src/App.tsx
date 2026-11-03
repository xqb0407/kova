/**
 * 无限画布外壳：Excalidraw 式画布，只编辑 objects；chrome 全浮层
 *   （顶栏 pill / 左工具栏 / 右 Inspector 玻璃卡 / 底部缩放 pill）。
 * 共用：左竖工具栏（插入/钢笔/历史，浮于画布内） · 右键菜单（选中元素的操作走属性面板） ·
 *   撤销栈/防抖保存/桥。交互原语全来自 @/components/ui。
 * 外壳之外的功能块已拆至 ./editor/*（元素工厂 / 工具条 / 右键菜单 / 属性面板 / 表单件）。
 */
import { useEffect, useState, type FC } from "react";
import {
  ChevronDownIcon,
  DownloadIcon,
  HelpCircleIcon,
  ImagePlusIcon,
  MaximizeIcon,
  MinusIcon,
  PlusIcon,
  Redo2Icon,
  SparklesIcon,
  TriangleAlertIcon,
  TypeIcon,
  Undo2Icon,
  WorkflowIcon,
} from "lucide-react";import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Hint, TooltipProvider } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProjectHeader } from "./editor/ProjectHeader";
import { bridge } from "./bridge";
import { CanvasStage } from "./CanvasStage";
import { Home } from "./Home";
import { LibraryPicker } from "./editor/LibraryPicker";
import { useEditorShell } from "./editor/useEditorShell";
import { BoardToolbar } from "./editor/BoardToolbar";
import { QuickEditComposer } from "./editor/QuickEditComposer";
import { CanvasContextMenu } from "./editor/CanvasContextMenu";
import { Inspector } from "./editor/inspector";

/* ---------------- 外壳 ---------------- */

export const App: FC = () => {
  const {
    store,
    docKind,
    editingId,
    setEditingId,
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
    libOpen,
    setLibOpen,
    annotate,
    annotateTargetId,
    toggleAnnotate,
    turnOffAnnotate,
    annotateAskAI,
    quickEditSubmit,
    insertLibrary,
    zoomApi,
    fileRef,
    selectedEl,
    insert,
    toggleDraw,
    askAI,
    doExportSvg,
    doExportPng,
    onContextHit,
    onZoom,
  } = useEditorShell();
  const { doc, sel } = store;
  const selected = !!sel && sel.elIds.length > 0;

  /* ---------- 进入逻辑：打开即画（若无绑定文档，自动新建一张空白画布，
      不再停首页等「新建」——对齐稿定 AI 画布；首页仅作为「全部画布」呼出）---------- */
  const [autoCreated, setAutoCreated] = useState(false);
  useEffect(() => {
    if (store.connected && !store.hasDoc && !homeOpen && !autoCreated) {
      setAutoCreated(true);
      store.createDoc("画布");
    }
  }, [store.connected, store.hasDoc, homeOpen, autoCreated, store]);

  if (!store.connected) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        正在连接工作区…
      </div>
    );
  }
  if (homeOpen) return <Home store={store} currentPath={store.fileRel} onEnter={() => setHomeOpen(false)} />;
  if (!store.hasDoc) {
    // 已连接但还没拿到文档（宿主异步推 doc.open）：短暂占位，等自动新建落地
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        正在打开画布…
      </div>
    );
  }

  /* ---------- 共用 chrome 片段 ---------- */

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

  const askAIBtn = (
    <Hint label="问 AI：把选中元素/整档上下文填入对话输入框" side="bottom">
      <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => askAI()} aria-label="问 AI">
        <SparklesIcon className="size-4" />
      </Button>
    </Hint>
  );

  const exportBtn = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" disabled={exporting} aria-label="导出">
          <DownloadIcon className="size-3.5" /> {exporting ? "导出中…" : "导出"}
          <ChevronDownIcon className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={!selected} onSelect={() => void doExportPng("selection")}>
          PNG · 仅选中 <span className="text-muted-foreground ml-auto text-xs">.png</span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!selected} onSelect={() => void doExportSvg("selection")}>
          SVG · 仅选中 <span className="text-muted-foreground ml-auto text-xs">.svg</span>
        </DropdownMenuItem>
        {/* <DropdownMenuSeparator /> */}
        <DropdownMenuItem onSelect={() => void doExportPng("all")}>
          PNG · 整画布 <span className="text-muted-foreground ml-auto text-xs">.png</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void doExportSvg("all")}>
          SVG · 整画布 <span className="text-muted-foreground ml-auto text-xs">.svg</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const zoomCluster = (
    <>
      <Hint label="缩小" side="top">
        <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => zoomApi.current?.zoomBy(1 / 1.2)} aria-label="缩小">
          <MinusIcon className="size-3.5" />
        </Button>
      </Hint>
      <DropdownMenu>
        <Hint label="缩放比例：⌘0 适配全部元素，⌘1 还原 100%" side="top">
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="sc-tool tabular-nums w-14 px-0">
              {zoomPct}%
              <ChevronDownIcon className="size-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
        </Hint>
        <DropdownMenuContent align="center" className="w-44">
          {[25, 50, 75, 100, 150, 200, 400].map((p) => (
            <DropdownMenuItem key={p} onSelect={() => zoomApi.current?.zoomTo(p / 100)}>
              {p}%
              {zoomPct === p && <span className="text-ink ml-auto text-xs">✓</span>}
            </DropdownMenuItem>
          ))}
          {/* <DropdownMenuSeparator /> */}
          <DropdownMenuItem onSelect={() => zoomApi.current?.fitAll()}>
            <MaximizeIcon className="size-3.5" /> 适配全部元素
            <span className="ml-auto text-xs opacity-60">⌘0</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Hint label="放大" side="top">
        <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => zoomApi.current?.zoomBy(1.2)} aria-label="放大">
          <PlusIcon className="size-3.5" />
        </Button>
      </Hint>
      {/* <Separator orientation="vertical" className="mx-0.5 !h-4" /> */}
      <Hint label="适配全部元素 ⌘0" side="top">
        <Button variant="ghost" size="icon-sm" className="sc-tool" onClick={() => zoomApi.current?.fitAll()} aria-label="适配">
          <MaximizeIcon className="size-3.5" />
        </Button>
      </Hint>
    </>
  );

  return (
    <TooltipProvider>
      <div className="relative flex h-full w-full flex-col overflow-hidden">
        <div className="relative flex min-h-0 flex-1">
          {/* 中：画布——stage 的稳定树位 */}
          <div className="relative min-w-0 flex-1">
            {docKind === "ui" && (
              <div className="bg-secondary/95 absolute inset-x-0 top-0 z-20 flex items-center justify-center gap-3 border-b px-4 py-2 text-[12px]">
                <span className="min-w-0 truncate">
                  这是旧「UI 设计」档，编辑表面仍是无限画布。UI 设计已拆分为独立面板（画板/图层树/吸附/PNG·SVG 导出）。
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() =>
                    bridge.prefill(
                      `请把画布文档 ${store.fileRel ?? "（当前画布）"}（旧「UI 设计」档）迁移为新的 UI 设计档：先 read 该文件拿最新内容，` +
                        `再按 ui-design skill 的规范生成同名 *.uidesign.json——三块圆角矩形设备画板转成 frame 节点（首页/关键流程/详情），` +
                        `落在画板内的矩形/文本等 objects 平铺为对应画板的子节点（坐标换算为画板局部系），画板外的说明文字放页面顶层。`,
                    )
                  }
                >
                  让 AI 迁移
                </Button>
              </div>
            )}
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
                  annotateTargetId={annotate ? annotateTargetId : null}
                  onDrawDone={() => setDrawTool(null)}
                  refitKey={store.fileRel}
                />
              </ContextMenuTrigger>
              <CanvasContextMenu store={store} hit={menuHit} insert={insert} askAI={askAI} annotateAskAI={annotateAskAI} zoomApi={zoomApi} />
            </ContextMenu>

            {/* 画布空态：居中的轻引导（参考 Figma/Canva 空画布提示），可点直接开画；
                背景层 pointer-events-none 不挡绘制，只有按钮可点 */}
            {doc.objects.length === 0 && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                <div className="max-w-[460px] text-center">
                  <p className="text-muted-foreground px-4 text-xs leading-relaxed">
                    画布空空如也。任选一样开画，或按 <b className="font-medium">P</b> 起钢笔自由绘制
                  </p>
                  <div className="pointer-events-auto mt-5 flex flex-wrap items-center justify-center gap-2 px-4">
                    <Button variant="secondary" size="sm" className="h-9 gap-1.5 rounded-full text-xs" onClick={() => insert("text")}>
                      <TypeIcon className="size-3.5" /> 文本
                    </Button>
                    <Button variant="secondary" size="sm" className="h-9 gap-1.5 rounded-full text-xs" onClick={() => insert("mermaid")}>
                      <WorkflowIcon className="size-3.5" /> Mermaid
                    </Button>
                    <Button variant="secondary" size="sm" className="h-9 gap-1.5 rounded-full text-xs" onClick={() => fileRef.current?.click()}>
                      <ImagePlusIcon className="size-3.5" /> 图片
                    </Button>
                    <Button size="sm" className="h-9 gap-1.5 rounded-full text-xs" onClick={() => askAI()}>
                      <SparklesIcon className="size-3.5" /> 问 AI 生成
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 右：属性面板（浮卡） */}
          <Inspector store={store} selectedEl={selectedEl} askAI={askAI} />

          {/* 画布浮层 chrome：顶部项目头（mark+标题+最近下拉，透明融入画布无悬浮阴影），
              右侧 导出/问AI；左侧竖排工具条浮条；左下缩放与历史 pill，末尾 ？ 悬停说明 */}
          <>
            <div className="pointer-events-none absolute top-0 right-0 left-0 z-10 flex items-center gap-2 to-transparent px-3 pt-1.5 pb-2 dark:from-white/8">
              <div className="pointer-events-auto min-w-0 flex-1">
                <ProjectHeader
                  title={store.fileRel?.split("/").pop()?.replace(/\.canvas\.json$/i, "") ?? "未命名画布"}
                  kind={docKind === "ui" ? "ui" : "board"}
                  dirty={store.dirty}
                  currentPath={store.fileRel}
                  onAll={() => setHomeOpen(true)}
                />
              </div>
              <div className="pointer-events-auto flex shrink-0 items-center gap-2">
                {exportBtn}
                {/* <Separator orientation="vertical" className="mx-0.5 !h-5" /> */}
                {askAIBtn}
              </div>
            </div>
            {/* 底部浮条：左下 zoom/undo/help 独立 pill + 单选时 QuickEdit 浮窗同排
                （flex-wrap 整行：过窄自动换行居中，不互撞——参考 zoom 簇 321px 的教训） */}
            <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex flex-wrap items-center justify-between gap-2">
              <div className="sc-float pointer-events-auto flex flex-wrap items-center justify-center gap-1 px-1.5 py-1">
                {zoomCluster}
                <div className="sc-divider" />
                {undoRedo}
                <div className="sc-divider" />
                <Hint label="移动画布：按住 空格 或 中键 拖拽，或选抓手工具（H）" side="top">
                  <Button variant="ghost" size="icon-sm" className="sc-tool cursor-help" aria-label="画布操作说明">
                    <HelpCircleIcon className="size-3.5" />
                  </Button>
                </Hint>
              </div>
              {selected && !editingId && selectedEl && (
                <QuickEditComposer
                  store={store}
                  selectedEl={selectedEl}
                  annotate={annotate}
                  onAnnotate={toggleAnnotate}
                  onSubmit={quickEditSubmit}
                />
              )}
            </div>
            {/* 左侧竖排工具条：垂直居中浮条（窄面板不挤压，主画布始终可见） */}
            <div className="sc-float pointer-events-auto absolute top-1/2 left-3 z-10 flex -translate-y-1/2 flex-col items-center gap-1 px-1.5 py-1.5">
              <BoardToolbar
                vertical
                store={store}
                pen={pen}
                hand={hand}
                drawTool={drawTool}
                annotate={annotate}
                onAnnotate={toggleAnnotate}
                onSelect={() => {
                  setPen(false);
                  setHand(false);
                  setDrawTool(null);
                  turnOffAnnotate();
                }}
                onHand={() => {
                  setPen(false);
                  setDrawTool(null);
                  turnOffAnnotate();
                  setHand((v) => !v);
                }}
                onPen={() => {
                  setHand(false);
                  setDrawTool(null);
                  turnOffAnnotate();
                  setPen((v) => !v);
                }}
                insert={insert}
                onDraw={toggleDraw}
                pickImage={() => fileRef.current?.click()}
                onLibrary={() => setLibOpen(true)}
              />
            </div>
          </>
        </div>

        <LibraryPicker open={libOpen} onOpenChange={setLibOpen} onPick={insertLibrary} />

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
        <div className="glass glass-sm pointer-events-none absolute right-3 bottom-14 z-30 max-w-[400px] animate-in fade-in slide-in-from-bottom-2 px-3 py-2 text-xs shadow-lg">
          {store.notice}
        </div>
      )}

      {/* 绑定档 JSON 损坏的持久横幅：不留神就不会像"插件打开是空的"那么莫名 */}
      {store.docCorrupt && (
        <div className="glass absolute left-1/2 top-3 z-40 flex w-[min(560px,calc(100%-24px))] -translate-x-1/2 items-center gap-3 rounded-2xl border border-red-500/40 px-4 py-2.5 text-xs shadow-lg">
          <TriangleAlertIcon className="size-4 shrink-0 text-red-500" />
          <span className="min-w-0 flex-1 leading-relaxed">
            文档 <b className="font-medium">{store.fileRel?.split("/").pop() ?? "当前档"}</b>{" "}
            的内容无法解析（多半是写坏了 JSON）。编辑器保持空档，<b className="font-medium">不会自动覆盖原文件</b>；
            可修复文件后回首页重开，或直接在画布上作画并保存来重建。
          </span>
          <Button size="sm" variant="secondary" className="h-7 shrink-0 text-xs" onClick={() => setHomeOpen(true)}>
            回首页
          </Button>
          <Button size="sm" variant="ghost" className="h-7 shrink-0 text-xs" onClick={() => store.dismissDocCorrupt()}>
            知道了
          </Button>
        </div>
      )}
      </div>
    </TooltipProvider>
  );
};
