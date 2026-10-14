/**
 * 编辑器行为外壳（自 App.tsx 拆出）：工具状态机、插入/导出/问AI、全局快捷键。
 * App 只留布局；新增元素 kind 时在 editor/newEl.ts 加工厂 + 这里补快捷键，布局无需改动。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextHit, ZoomApi } from "@/CanvasStage";
import { containerEls, useCanvas } from "@/state";
import { exportCanvasPng, exportCanvasSvg } from "@/export-svg";
import { bridge } from "@/bridge";
import { CANVAS_ROOT, isDarkColor, type El, type ShapeKind } from "@/doc";
import { setEmbedActive } from "@/render";
import { newEl, type SelKind } from "./newEl";
import { librarySvg, type LibraryItem } from "./library";
import { uid } from "@/doc";

export function useEditorShell() {
  const store = useCanvas();
  const { doc, sel, setSel } = store;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  const [pen, setPen] = useState(false);
  /** 拖画工具（形状类全 kind：L/A/C、R/D/O 与「插入」面板按钮激活）：
   *  右键按住拖动（左键需空白处）起框/起线，抬手成元素；null = 未启用 */
  const [drawTool, setDrawTool] = useState<ShapeKind | null>(null);
  const [menuHit, setMenuHit] = useState<ContextHit | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const zoomApi = useRef<ZoomApi | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 首页（历史卡片墙）：无绑定文档时必显示；编辑器里点「全部画布」也可回到 */
  const [homeOpen, setHomeOpen] = useState(false);
  /** 抓手工具（H）：拖拽即平移，与空格按住等效（参考 Excalidraw） */
  const [hand, setHand] = useState(false);
  /** 图形库选择器 */
  const [libOpen, setLibOpen] = useState(false);

  const onZoom = useCallback((s: number) => setZoomPct(Math.round(s * 100)), []);

  const selectedEl: El | null =
    sel && sel.elIds.length === 1 ? (containerEls(doc, sel.containerId)?.find((e) => e.id === sel.elIds[0]) ?? null) : null;

  /** 插入落位：画布级 objects，落当前视口中心；默认色随宿主主题明暗 */
  const insert = useCallback(
    (kind: SelKind) => {
      setDrawTool(null); // 显式插入与拖拽画线互斥
      const el = newEl({ w: 1280, h: 720 }, kind, bridge.getTheme() === "dark");
      const c = zoomApi.current?.viewportCenter();
      if (c) Object.assign(el, { x: Math.round(c.x - el.w / 2), y: Math.round(c.y - el.h / 2) });
      store.addEl(CANVAS_ROOT, el);
    },
    [store],
  );

  /** 图形库插入：svg 元素落视口中心（currentColor 已按主题解析） */
  const insertLibrary = useCallback(
    (item: LibraryItem) => {
      const ink = bridge.getTheme() === "dark" ? "#f5f5f7" : "#1d1d1f";
      const { code, w, h } = librarySvg(item, ink);
      const c = zoomApi.current?.viewportCenter();
      const el = {
        kind: "svg" as const,
        id: uid("sv"),
        code,
        x: Math.round((c?.x ?? 0) - w / 2),
        y: Math.round((c?.y ?? 0) - h / 2),
        w,
        h,
      };
      store.addEl(CANVAS_ROOT, el);
    },
    [store],
  );

  /** 拖画工具（线类＋形状）：与钢笔/抓手互斥；再次按同键（或 Esc/V）退出。
   *  启用后右键按住从起点拖到尾点（形状＝拖出外接框）成元素 */
  const toggleDraw = useCallback((kind: ShapeKind) => {
    setPen(false);
    setHand(false);
    setDrawTool((v) => (v === kind ? null : kind));
  }, []);

  const askAI = useCallback(() => {
    if (selectedEl) {
      bridge.prefill(
        `请修改画布文档${store.fileRel ? ` ${store.fileRel}` : ""}中这个 ${selectedEl.kind} 元素` +
          `（先 read 该文件拿最新内容，再改动它；元素当前 JSON）：\n` +
          "```json\n" + JSON.stringify(selectedEl, null, 2) + "\n```\n我的要求：",
      );
    } else {
      bridge.prefill(
        `请帮我完善画布中打开的文档${store.fileRel ? ` ${store.fileRel}` : ""}。` +
          "先 read 现有内容（用户可能手动改过），再按 canvas 技能的 schema 编辑：\n",
      );
    }
  }, [selectedEl, store.fileRel]);

  /** 导出画布：scope=selection 时只导当前选中（未选退化提示） */
  const doExportSvg = useCallback(
    async (scope: "all" | "selection" = "all") => {
      if (exporting) return;
      const selEls = scope === "selection" ? store.selectedEls() : [];
      if (scope === "all" && store.doc.objects.length === 0) {
        store.notifyLater("画布还没有内容可导出");
        return;
      }
      if (scope === "selection" && selEls.length === 0) {
        store.notifyLater("先选中要导出的元素");
        return;
      }
      setExporting(true);
      try {
        await exportCanvasSvg(store.doc, store.fileRel, scope === "selection" ? selEls : undefined);
        store.notifyLater(
          bridge.standalone
            ? "已生成 .svg（独立模式无宿主落盘，见控制台）"
            : scope === "selection"
              ? `正在导出选中内容（${selEls.length} 个元素）SVG`
              : "正在导出整画布 SVG",
        );
      } catch (err) {
        store.notifyLater(`导出失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setExporting(false);
      }
    },
    [exporting, store],
  );

  const doExportPng = useCallback(
    async (scope: "all" | "selection" = "all") => {
      if (exporting) return;
      const selEls = scope === "selection" ? store.selectedEls() : [];
      if (scope === "all" && store.doc.objects.length === 0) {
        store.notifyLater("画布还没有内容可导出");
        return;
      }
      if (scope === "selection" && selEls.length === 0) {
        store.notifyLater("先选中要导出的元素");
        return;
      }
      setExporting(true);
      try {
        await exportCanvasPng(store.doc, store.fileRel, scope === "selection" ? selEls : undefined);
        store.notifyLater(
          bridge.standalone
            ? "已生成 .png（独立模式无宿主落盘，见控制台）"
            : scope === "selection"
              ? `正在导出选中内容（${selEls.length} 个元素）PNG`
              : "正在导出整画布 PNG（2×）",
        );
      } catch (err) {
        store.notifyLater(`导出失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setExporting(false);
      }
    },
    [exporting, store],
  );

  const onContextHit = useCallback((hit: ContextHit) => {
    setMenuHit(hit);
    setMenuOpen(true);
  }, []);

  /* ---------- 全局快捷键（输入框/文本编辑聚焦时让位） ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
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
        toggleDraw("rect");
      } else if (!mod && !e.shiftKey && !e.altKey && key === "d") {
        toggleDraw("diamond");
      } else if (!mod && !e.shiftKey && !e.altKey && key === "o") {
        toggleDraw("ellipse");
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
  }, [store, sel, setSel, selectedEl, insert, toggleDraw]);

  return {
    store,
    docKind: store.doc.meta.kind,
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
  };
}
