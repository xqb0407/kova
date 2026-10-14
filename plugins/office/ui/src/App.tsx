/**
 * Office 外壳：幻灯片 PPT（deck）单模式，固定四栏布局——
 *   顶栏（插入工具 · 全部画布 · 文档名 · 问AI/放映/导出）、左缩略图栏（border-r）、
 *   中央画布盒（当前页 fit 于此）、右 Inspector（border-l）、底部状态条（左翻页 · 右缩放）。
 * 引擎（state/CanvasStage）仍保留白板能力以兼容历史文档解析，但 office 不再进
 * 无限画布模式：effMode 恒为 deck，绑到白板/UI 档时渲染引导页指向 canvas 面板。
 * 右键菜单（选中元素的操作走属性面板） · 撤销栈/防抖保存/桥。交互原语全来自 @/components/ui。
 * 外壳之外的功能块已拆至 ./editor/*（元素工厂 / 工具条 / 右键菜单 / 缩略图栏 / 属性面板 / 表单件）。
 */
import { type FC } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  DownloadIcon,
  FrameIcon,
  LayoutTemplateIcon,
  MaximizeIcon,
  MinusIcon,
  PlayIcon,
  PlusIcon,
  SparklesIcon,
  TriangleAlertIcon,
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
import { CanvasContextMenu } from "./editor/CanvasContextMenu";
import { SlidesRail } from "./editor/SlidesRail";
import { Inspector } from "./editor/inspector";

/* ---------------- 外壳 ---------------- */

export const App: FC<{ onHome?: () => void }> = ({ onHome }) => {
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
    askAI,
    doExport,
    doExportSvg,
    doExportHtml,
    onContextHit,
    onZoom,
  } = useEditorShell();
  const { doc, activeFrame } = store;

  /** 回首页入口：聚合外壳传入 onHome 时冒泡给统一首页（含表格/文档），否则回 deck 自己的首页。
   *  必须先于下方分支定义（引导页/坏档横幅都用它）。 */
  const goHome = onHome ?? (() => setHomeOpen(true));

  /* ---------- 未绑定文档 ---------- */
  if (!store.connected) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        正在连接工作区…
      </div>
    );
  }
  if (!store.hasDoc || homeOpen) return <Home store={store} currentPath={store.fileRel} onEnter={() => setHomeOpen(false)} />;

  /* office 只做幻灯片：绑到白板/UI 档时显示引导页，绝不渲染无限画布外壳 */
  if (docKind !== "deck") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-[14px] font-medium">这份文档是{docKind === "ui" ? "旧「UI 设计」档" : "白板档"}，Office 只编辑幻灯片</p>
        <p className="text-muted-foreground max-w-[420px] text-[12px] leading-relaxed">
          {docKind === "ui"
            ? "UI 设计已拆分为独立的「UI 设计」面板（*.uidesign.json）；这份旧档请去「无限画布」面板编辑，也可以在那里点「让 AI 迁移」转成新格式。"
            : "objects 无限画布（白板）由「无限画布」面板（canvas）负责编辑，在这里改会打乱文档语义。"}
        </p>
        <Button className="mt-3" size="sm" variant="secondary" onClick={goHome}>
          返回幻灯片首页
        </Button>
      </div>
    );
  }

  const deck = effMode === "deck";

  /* ---------- 共用 chrome 片段：deck 固定四栏与 board 浮层复用同一批控件 ---------- */

  const docTitle = (
    <>
      <span className="bg-secondary text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[10px]">{docKind === "deck" ? "幻灯片" : docKind === "ui" ? "UI 设计（旧）" : "白板"}</span>
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

  // 与表格/文档视图同款返回样式：← 箭头 + 灰字（一致性 > 局部花样）
  const homeBtn = (
    <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={goHome} aria-label="全部文档">
      <ArrowLeftIcon className="size-4" />
      全部文档
    </Button>
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
            <div className="shrink-0">{homeBtn}</div>
            <span className="sc-divider" />
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
                  onDrawDone={() => setDrawTool(null)}
                  refitKey={store.fileRel}
                  surface={effMode}
                />
              </ContextMenuTrigger>
              <CanvasContextMenu store={store} hit={menuHit} insert={insert} askAI={askAI} zoomApi={zoomApi} deck={deck} />
            </ContextMenu>

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
          <Button size="sm" variant="secondary" className="h-7 shrink-0 text-[11px]" onClick={goHome}>
            回首页
          </Button>
          <Button size="sm" variant="ghost" className="h-7 shrink-0 text-[11px]" onClick={() => store.dismissDocCorrupt()}>
            知道了
          </Button>
        </div>
      )}

      {presenting && <Presentation store={store} onClose={() => setPresenting(false)} />}
      </div>
    </TooltipProvider>
  );
};
