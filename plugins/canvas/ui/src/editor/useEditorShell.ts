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
  /** 标注模式：开启后新画的箭头/画笔/文字自动打 annotate.targetId=选中元素，
   *  由「标注并修改」归一化成结构化指令给 agent（Quick Edit 借鉴）。
   *  目标在进入标注模式时定格（用 ref），避免画完一条标注自动选中标注、
   *  目标漂移——参考项目以 annotationSessionId 贯穿整批标注的同一思路。 */
  const [annotate, setAnnotate] = useState(false);
  /** 标注目标 id（进入标注模式时从当前选中定格；selectedEl 每次 setSel 会变） */
  const annotateTargetRef = useRef<string | null>(null);

  const selectedEl: El | null =
    sel && sel.elIds.length === 1 ? (containerEls(doc, sel.containerId)?.find((e) => e.id === sel.elIds[0]) ?? null) : null;

  /** 标注模式开关：开=定格当前选中为目标，画下一条起都指向它；关=清目标 */
  const toggleAnnotate = useCallback(() => {
    setAnnotate((v) => {
      const next = !v;
      annotateTargetRef.current = next && selectedEl ? selectedEl.id : null;
      return next;
    });
  }, [selectedEl]);
  /** 关标注（其他工具/快捷键让位时） */
  const turnOffAnnotate = useCallback(() => {
    annotateTargetRef.current = null;
    setAnnotate(false);
  }, []);
  /** 图形库选择器 */
  const [libOpen, setLibOpen] = useState(false);

  const onZoom = useCallback((s: number) => setZoomPct(Math.round(s * 100)), []);

  /** 插入落位：画布级 objects，落当前视口中心；默认色随宿主主题明暗。
   *  连续插入「铺排」——新元素落上一个元素的右下（间隔 32px），绝不与上次精确叠放
   *  （大 svg 盖住底下文本导致"分不开"）；铺 4 级后回绕到中心重排；
   *  视口被平移后归零回中心。标注模式走小偏移（箭头/批注要贴近目标元素）。 */
  const insertRef = useRef<{ x: number; y: number; last: { x: number; y: number; w: number; h: number } | null; n: number } | null>(null);
  const insertPos = useCallback(
    (w: number, h: number, small = false) => {
      const c = zoomApi.current?.viewportCenter();
      const cx = Math.round(c?.x ?? 0);
      const cy = Math.round(c?.y ?? 0);
      const prev = insertRef.current;
      const moved = !prev || Math.abs(prev.x - cx) > 4 || Math.abs(prev.y - cy) > 4;
      if (moved) insertRef.current = { x: cx, y: cy, last: null, n: 0 };
      const st = insertRef.current!;
      let x: number, y: number;
      if (small) {
        // 标注/批注：中心附近每级 +16px，别把箭头推远
        x = cx - Math.round(w / 2) + (st.n % 4) * 16;
        y = cy - Math.round(h / 2) + (st.n % 4) * 16;
      } else if (st.last && st.n > 0 && st.n <= 4) {
        // 普通插入：铺到上一个右下，错开叠放
        x = st.last.x + st.last.w + 32;
        y = st.last.y + st.last.h + 32;
      } else {
        x = cx - Math.round(w / 2);
        y = cy - Math.round(h / 2);
      }
      st.last = { x, y, w, h };
      st.n = (st.n + 1) % 5;
      return { x, y };
    },
    [],
  );
  const insert = useCallback(
    (kind: SelKind) => {
      setDrawTool(null); // 显式插入与拖拽画线互斥
      const el = newEl({ w: 1280, h: 720 }, kind, bridge.getTheme() === "dark");
      const p = insertPos(el.w, el.h);
      Object.assign(el, { x: p.x, y: p.y });
      if (annotate && annotateTargetRef.current) {
        // 标注模式：新插入元素即一条指向目标元素的批注（note）
        (el as El).annotate = { targetId: annotateTargetRef.current, role: "note" };
      }
      store.addEl(CANVAS_ROOT, el);
    },
    [store, annotate, insertPos],
  );

  /** 图形库插入：svg 元素落视口中心（currentColor 已按主题解析） */
  const insertLibrary = useCallback(
    (item: LibraryItem) => {
      const ink = bridge.getTheme() === "dark" ? "#f5f5f7" : "#1d1d1f";
      const { code, w, h } = librarySvg(item, ink);
      const p = insertPos(w, h);
      const el = {
        kind: "svg" as const,
        id: uid("sv"),
        code,
        x: p.x,
        y: p.y,
        w,
        h,
      };
      store.addEl(CANVAS_ROOT, el);
    },
    [store, insertPos],
  );

  /** 拖画工具（线类＋形状）：与钢笔/抓手互斥；再次按同键（或 Esc/V）退出。
   *  启用后右键按住从起点拖到尾点（形状＝拖出外接框）成元素 */
  const toggleDraw = useCallback((kind: ShapeKind) => {
    setPen(false);
    setHand(false);
    setDrawTool((v) => (v === kind ? null : kind));
  }, []);

  const askAI = useCallback((req?: string) => {
    if (selectedEl) {
      bridge.prefill(
        `请修改画布文档${store.fileRel ? ` ${store.fileRel}` : ""}中这个 ${selectedEl.kind} 元素` +
          `（先 read 该文件拿最新内容，再改动它；元素当前 JSON）：\n` +
          "```json\n" + JSON.stringify(selectedEl, null, 2) + "\n```\n我的要求：" + (req ?? ""),
      );
    } else {
      bridge.prefill(
        `请帮我完善画布中打开的文档${store.fileRel ? ` ${store.fileRel}` : ""}。` +
          "先 read 现有内容（用户可能手动改过），再按 canvas 技能的 schema 编辑：\n" + (req ?? ""),
      );
    }
  }, [selectedEl, store.fileRel]);

  /** 标注并修改：把目标元素 + 画布上所有指向它的标注（箭头/画笔/文字）
   *  归一化成结构化指令给 agent；要求保留原元素做对照（Quick Edit 借鉴）。
   *  req 为 QuickEdit 浮窗里的自然语言要求（追加在文末）。 */
  const annotateAskAI = useCallback(
    (req?: string) => {
      if (!selectedEl) return;
      const target = selectedEl;
      const marks = containerEls(store.doc, CANVAS_ROOT)
        ?.filter((e) => e.annotate?.targetId === target.id && e.id !== target.id) ?? [];

      const lines: string[] = [];
      for (const m of marks) {
        const rel = (p: number, d: number) => `${Math.round((p / Math.max(1, d)) * 100)}%`;
        const inBox = (px: number, py: number) => `盒内(${rel(px - target.x, target.w)}, ${rel(py - target.y, target.h)})`;
        switch (m.kind) {
          case "draw":
            lines.push(`- 画笔遮罩「${m.annotate?.label || "圈出要改的区域"}」：覆盖于目标 ${inBox(m.x, m.y)} 附近`);
            break;
          case "shape": {
            if (m.shape === "line" || m.shape === "arrow" || m.shape === "double-arrow") {
              const tl = m.label ? `标签「${m.label}」` : "";
              lines.push(`- 箭头标注 ${tl}：指向目标 ${inBox(m.x + m.w, m.y + m.h / 2)}${m.shape === "double-arrow" ? "（双向）" : ""}`);
            } else {
              lines.push(`- 框选标注「${m.annotate?.label || m.fill ? "圈出要改的区域" : ""}」：覆盖目标 ${inBox(m.x + m.w / 2, m.y + m.h / 2)} 附近`);
            }
            break;
          }
          case "text":
            lines.push(`- 文字批注「${(m as { runs?: { text?: string }[] }).runs?.map((r) => r.text).join("") || ""}」：位于目标 ${inBox(m.x + m.w / 2, m.y + m.h / 2)} 附近`);
            break;
          default:
            lines.push(`- 标注「${m.annotate?.label || m.id}」：位于目标 ${inBox(m.x, m.y)} 附近`);
        }
      }

      const instruction =
        `请修改画布文档${store.fileRel ? ` ${store.fileRel}` : ""}中的目标元素，按下面的标注执行定向修改。` +
        (lines.length
          ? `\n\n画布上有 ${marks.length} 处标注指向上图目标（均已存储为带 annotate.targetId 的普通元素）：\n${lines.join("\n")}`
          : "\n\n（本次没有新增箭头/画笔/文字标注，仅凭下方的目标元素和你的要求修改。）") +
        `\n\n目标元素当前 JSON：\n\`\`\`json\n${JSON.stringify(target, null, 2)}\n\`\`\`` +
        `\n\n规则：\n1. 先 read ${store.fileRel || "目标文件"} 拿最新内容（用户可能手动改过）；\n2. 只修改目标元素（或按标注的语义新增/删除内容），不要动其他元素；\n` +
        `3. 修改后**把原目标元素复制一份**放到目标右侧（间隔 48px）并降透明度（opacity 0.35）+ 打上 label「改前」作为对照，新结果留在原位；\n` +
        `4. 标注元素本身保留（它们是人工批注，agent 不要删除）；\n我的要求：${req ?? ""}`;

      bridge.prefill(instruction);
    },
    [selectedEl, store.fileRel, store.doc],
  );

  /** QuickEdit 底部浮窗提交：有标注走「标注并修改」，否则走普通问 AI；
   *  提交后复位标注会话（浮窗输入清空由组件自持）。 */
  const quickEditSubmit = useCallback(
    (req: string) => {
      if (!selectedEl) return;
      const marks = containerEls(store.doc, CANVAS_ROOT)?.filter((e) => e.annotate?.targetId === selectedEl.id && e.id !== selectedEl.id) ?? [];
      const text = req.trim();
      if (!text && marks.length === 0) {
        store.notifyLater("先填一句要求，或先给目标画几笔标注");
        return;
      }
      if (marks.length > 0) annotateAskAI(text);
      else askAI(text);
      turnOffAnnotate();
    },
    [selectedEl, store.doc, annotateAskAI, askAI, store, turnOffAnnotate],
  );

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
        turnOffAnnotate();
        setPen((v) => !v);
      } else if (!mod && !e.shiftKey && !e.altKey && key === "v") {
        setPen(false);
        setHand(false);
        setDrawTool(null);
        turnOffAnnotate();
      } else if (!mod && key === "h") {
        setPen(false);
        setDrawTool(null);
        turnOffAnnotate();
        setHand((v) => !v);
      } else if (!mod && key === "q") {
        // Q：标注模式开关（Quick Edit 借鉴）；开启时定格当前选中为标注目标
        setPen(false);
        setHand(false);
        setDrawTool(null);
        toggleAnnotate();
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
        turnOffAnnotate();
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
  }, [store, sel, setSel, selectedEl, insert, toggleDraw, toggleAnnotate, turnOffAnnotate]);

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
    annotate,
    setAnnotate,
    /** 标注目标 id（进入标注模式时定格），供 CanvasStage 给拖画落点打标 */
    annotateTargetId: annotateTargetRef.current,
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
  };
}
