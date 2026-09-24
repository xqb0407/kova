/**
 * 编辑器行为外壳（自 App.tsx 拆出）：工具状态机、插入/导出/问AI、页面切换、全局快捷键。
 * App 只留布局；新增元素 kind 时在 editor/newEl.ts 加工厂 + 这里补快捷键，布局无需改动。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextHit, ZoomApi } from "@/CanvasStage";
import { containerEls, useDeck } from "@/state";
import { exportPptx } from "@/export";
import { exportHtml, exportSvgAll } from "@/export-svg";
import { bridge } from "@/bridge";
import { CANVAS_ROOT, docKindOf, isDarkColor, PAGE_SIZES, slideFrames, type El } from "@/doc";
import { setEmbedActive } from "@/render";
import { newEl, type EditorMode, type SelKind } from "./newEl";

export function useEditorShell() {
  const store = useDeck();
  const { doc, sel, activeFrame, setSel } = store;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [presenting, setPresenting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  const [pen, setPen] = useState(false);
  /** 画线工具（L 直线 / A 箭头 / 双箭头）：按下从起点拖到尾点成元素；null = 未启用 */
  const [drawTool, setDrawTool] = useState<"line" | "arrow" | "double-arrow" | null>(null);
  const [menuHit, setMenuHit] = useState<ContextHit | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const zoomApi = useRef<ZoomApi | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 首页（历史卡片墙）：无绑定文档时必显示；编辑器里点「全部画布」也可回到 */
  const [homeOpen, setHomeOpen] = useState(false);
  /** 抓手工具（H）：白板下拖拽即平移，与空格按住等效（参考 Excalidraw） */
  const [hand, setHand] = useState(false);
  /** 幻灯片空态的「模板起步」选择器 */
  const [emptyTplOpen, setEmptyTplOpen] = useState(false);

  /*
   * 模式：由文档自带的 meta.kind 决定（老档按内容亲和回退，见 docKindOf）。
   * 类型只在新建时选定，进入编辑器后不再有白板/幻灯片切换。
   */
  const docKind = docKindOf(doc);
  /** UI 设计档的编辑表面仍是无限画布（画板=页框），只是种子与徽标不同 */
  const effMode: EditorMode = docKind === "deck" ? "deck" : "board";
  /* store 的默认落位容器要感知模式（board 绝不落进不可见的页框） */
  const { setSurface } = store;
  useEffect(() => {
    setSurface(effMode);
  }, [setSurface, effMode]);
  /** deck 的当前页：选择所在页，否则第一页（与 stage 内 curFrameId 同规则） */
  const curFrameId = doc.frames.find((f) => f.id === sel?.containerId)?.id ?? doc.frames[0]?.id ?? null;
  const curIdx = doc.frames.findIndex((f) => f.id === curFrameId);
  const stepFrame = useCallback(
    (dir: -1 | 1) => {
      const frames = doc.frames;
      if (frames.length < 2 || curIdx < 0) return;
      setSel({ containerId: frames[Math.min(frames.length - 1, Math.max(0, curIdx + dir))]!.id, elIds: [] });
    },
    [doc.frames, curIdx, setSel],
  );
  /* 换页/进 deck：把当前页适配居中（PgUp/PgDn、缩略图、增删页共用此效果） */
  useEffect(() => {
    if (effMode === "deck" && curFrameId) zoomApi.current?.focusFrame(curFrameId);
  }, [effMode, curFrameId]);
  /* 进白板：画布盒从四栏夹缝涨回全窗口，重新适配全部 objects */
  useEffect(() => {
    if (effMode === "board") zoomApi.current?.fitAll();
  }, [effMode]);

  const onZoom = useCallback((s: number) => setZoomPct(Math.round(s * 100)), []);

  const selectedEl: El | null =
    sel && sel.elIds.length === 1 ? (containerEls(doc, sel.containerId)?.find((e) => e.id === sel.elIds[0]) ?? null) : null;

  /**
   * 插入落位（模式感知，defaultContainerId 已按 surface 收敛）：
   *   deck → 当前页居中插入；board → objects，落当前视口中心。
   *   deck 且 0 页时不静默丢进不可见的 objects，引导先建页。
   */
  const insert = useCallback(
    (kind: SelKind) => {
      setDrawTool(null); // 显式插入与拖拽画线互斥
      const containerId = store.defaultContainerId;
      const owner = doc.frames.find((f) => f.id === containerId);
      if (owner) {
        store.addEl(containerId, newEl(owner, kind, isDarkColor(owner.background)));
        return;
      }
      if (effMode === "deck") {
        store.notifyLater("幻灯片模式下请先新建一页（左侧缩略图栏底部）");
        return;
      }
      const el = newEl(PAGE_SIZES[doc.meta.pagePreset], kind);
      const c = zoomApi.current?.viewportCenter();
      if (c) Object.assign(el, { x: Math.round(c.x - el.w / 2), y: Math.round(c.y - el.h / 2) });
      store.addEl(CANVAS_ROOT, el);
    },
    [store, doc.frames, doc.meta.pagePreset, effMode],
  );

  /** 直线/箭头画线工具：与钢笔/抓手互斥；再次按同键（或 Esc/V）退出。启用后按下即从起点拖到尾点成元素 */
  const toggleDraw = useCallback((kind: "line" | "arrow" | "double-arrow") => {
    setPen(false);
    setHand(false);
    setDrawTool((v) => (v === kind ? null : kind));
  }, []);

  const askAI = useCallback(() => {
    if (selectedEl) {
      const at =
        sel?.containerId === CANVAS_ROOT
          ? "白板上的"
          : `幻灯片第 ${doc.frames.findIndex((f) => f.id === sel?.containerId) + 1} 页的`;
      bridge.prefill(
        `请修改画布文档${store.fileRel ? ` ${store.fileRel}` : ""}中${at}这个 ${selectedEl.kind} 元素` +
          `（先 read 该文件拿最新内容，再改动它；元素当前 JSON）：\n` +
          "```json\n" + JSON.stringify(selectedEl, null, 2) + "\n```\n我的要求：",
      );
    } else {
      const part = effMode === "deck" ? "幻灯片演示部分（frames 页框，放映/导出的内容）" : "白板部分（objects，不进 PPT）";
      bridge.prefill(
        `请帮我完善画布中打开的文档${store.fileRel ? ` ${store.fileRel}` : ""}的${part}。` +
          "先 read 现有内容（用户可能手动改过），再按 slides 技能的 schema 编辑：\n",
      );
    }
  }, [selectedEl, doc.frames, sel?.containerId, store.fileRel, effMode]);

  const doExport = useCallback(async () => {
    if (exporting) return;
    if (slideFrames(store.doc).length === 0) {
      store.notifyLater("没有幻灯片页可导出（白板内容不入 .pptx，请先在幻灯片模式建页）");
      return;
    }
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

  const doExportSvg = useCallback(async () => {
    if (exporting) return;
    if (slideFrames(store.doc).length === 0) {
      store.notifyLater("没有幻灯片页可导出（白板内容不入导出，请先在幻灯片模式建页）");
      return;
    }
    setExporting(true);
    try {
      const n = await exportSvgAll(store.doc, store.fileRel);
      store.notifyLater(bridge.standalone ? `已生成 ${n} 个 SVG（独立模式无宿主落盘，见控制台）` : `正在导出 ${n} 个 SVG（每页一个）`);
    } catch (err) {
      store.notifyLater(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
    }
  }, [exporting, store]);

  const doExportHtml = useCallback(async () => {
    if (exporting) return;
    if (slideFrames(store.doc).length === 0) {
      store.notifyLater("没有幻灯片页可导出（白板内容不入导出，请先在幻灯片模式建页）");
      return;
    }
    setExporting(true);
    try {
      await exportHtml(store.doc, store.fileRel);
      store.notifyLater(bridge.standalone ? "已生成 .html（独立模式无宿主落盘，见控制台）" : "正在生成 .html 自含放映页");
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
      } else if (mod && key === "g") {
        e.preventDefault();
        if (e.shiftKey) store.ungroupSelected();
        else store.groupSelected();
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
        if (selectedEl && sel && (selectedEl.kind === "text" || selectedEl.kind === "mermaid" || selectedEl.kind === "svg" || selectedEl.kind === "table" || selectedEl.kind === "chart")) {
          e.preventDefault();
          setEditingId(selectedEl.id);
        } else if (selectedEl && selectedEl.kind === "embed") {
          e.preventDefault();
          setEmbedActive(selectedEl.id);
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
        setHand(false);
        setDrawTool(null);
        setPen((v) => !v);
      } else if (!mod && !e.shiftKey && !e.altKey && key === "v") {
        setPen(false);
        setHand(false);
        setDrawTool(null);
      } else if (!mod && key === "h") {
        setPen(false);
        setDrawTool(null);
        setHand((v) => !v);
      } else if (!mod && !e.shiftKey && !e.altKey && key === "r") {
        insert("rect");
      } else if (!mod && !e.shiftKey && !e.altKey && key === "d") {
        insert("diamond");
      } else if (!mod && !e.shiftKey && !e.altKey && key === "o") {
        insert("ellipse");
      } else if (!mod && !e.shiftKey && !e.altKey && key === "a") {
        toggleDraw("arrow");
      } else if (!mod && !e.shiftKey && !e.altKey && key === "l") {
        toggleDraw("line");
      } else if (!mod && !e.shiftKey && !e.altKey && key === "t") {
        insert("text");
      } else if (!mod && !e.shiftKey && !e.altKey && key === "m") {
        insert("mermaid");
      } else if (!mod && !e.shiftKey && !e.altKey && key === "e") {
        insert("embed");
      } else if (!mod && !e.shiftKey && !e.altKey && key === "g") {
        insert("svg");
      } else if (e.key === "PageDown" || e.key === "PageUp") {
        if (effMode === "deck") {
          e.preventDefault();
          stepFrame(e.key === "PageDown" ? 1 : -1);
        }
      } else if (!mod && e.key === "Escape") {
        setEditingId(null);
        setEmbedActive(null);
        setSel(null);
        setPen(false);
        setHand(false);
        setDrawTool(null);
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
  }, [store, sel, setSel, doc.frames.length, presenting, selectedEl, effMode, curFrameId, curIdx, stepFrame]);

  return {
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
  };
}
