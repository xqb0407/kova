/**
 * App：Figma 式编辑器外壳装配。
 *   路由：宿主无绑定档 / 主动回首页 → Home 卡片墙；其余 = 编辑器
 *   （左侧 FileMenu+图层 | 画布 | 右侧检视；底部悬浮工具栏 + 右下缩放条）。
 * 快捷键全景：工具 / ⌘A 全选 / ⌘Z·⌘⇧Z / ⌘C·⌘X·⌘V / ⌘⇧C 复制 CSS / ⌘D / ⌘G·⌘⇧G /
 *   ⌘]·⌘[ 移层（⇧ 到顶到底）/ ⌘⇧H 显隐 / ⌘⇧L 锁定 / Delete / 方向键 /
 *   ⌘0 适配 / ⌘1 100% / ⇧⌘1 缩放到选区 / P 预览交互原型 / Escape（回移动工具·退出文本编辑·关预览）。
 */
import { useEffect, useRef, useState } from "react";
import { PanelLeft, PanelLeftClose, PanelLeftOpen, PanelRight, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useDesign, type DesignStore, type Tool } from "./state";
import { findNode } from "./doc";
import { nodeToCss } from "./css";
import { copyText } from "./lib/clipboard";
import { toggleFlagAll } from "./chrome/ContextMenu";
import { DesignStage } from "./leafer/DesignStage";
import { IconBtn } from "./chrome/ui";
import { FileMenu } from "./chrome/FileMenu";
import { LayersPanel } from "./chrome/LayersPanel";
import { Inspector } from "./chrome/Inspector";
import { Toolbar } from "./chrome/Toolbar";
import { ZoomBar } from "./chrome/ZoomBar";
import { PrototypePreview } from "./chrome/PrototypePreview";
import { firstPlayableFrame } from "./prototype";
import { bridge } from "./bridge";
import { Home } from "./Home";

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true);
}

function useHotkeys(store: DesignStore, active: boolean, onPreview?: () => void) {
  const ref = useRef(store);
  ref.current = store;
  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const st = ref.current;
      if (isTypingTarget(e.target) || st.editingTextId) {
        // 文本就地编辑中只放行 Escape（由 overlay 处理提交，这里兜底关编辑）
        if (e.key === "Escape" && st.editingTextId && !isTypingTarget(e.target)) st.setEditingTextId(null);
        return;
      }
      const k = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
        return;
      }
      if (mod && k === "y") {
        e.preventDefault();
        st.redo();
        return;
      }
      if (mod && k === "c") {
        if (e.shiftKey) {
          e.preventDefault(); // ⌘⇧C：复制选中图层 CSS（单选）
          const n = st.selIds[0] ? findNode(st.doc, st.selIds[0])?.node : null;
          if (n)
            void copyText(nodeToCss(n)).then((ok) => bridge.notify(ok ? "已复制该图层的 CSS" : "复制失败", ok ? undefined : "error"));
        } else st.copySelected();
        return;
      }
      if (mod && k === "x") {
        e.preventDefault();
        st.cutSelected();
        return;
      }
      if (mod && k === "v") {
        e.preventDefault();
        st.pasteClipboard();
        return;
      }
      if (mod && k === "a") {
        e.preventDefault();
        st.setSel(st.page.nodes.map((n) => n.id)); // 全选本页顶层节点
        return;
      }
      if (mod && (e.code === "BracketRight" || e.code === "BracketLeft")) {
        e.preventDefault(); // ⌘]/⌘[ 移层；⇧ = 到顶/到底（用物理键码，Mac 上 ⇧ 会把 e.key 变成 } {）
        const up = e.code === "BracketRight";
        st.reorderSelected(e.shiftKey ? (up ? "front" : "back") : up ? "up" : "down");
        return;
      }
      if (mod && e.shiftKey && (k === "h" || k === "l")) {
        e.preventDefault(); // ⌘⇧H 显隐 / ⌘⇧L 锁定（混合选择整组取反，与右键菜单同逻辑）
        toggleFlagAll(st, st.selIds, k === "h" ? "visible" : "locked");
        return;
      }
      if (mod && k === "d") {
        e.preventDefault();
        st.duplicateSelected();
        return;
      }
      if (mod && k === "g") {
        e.preventDefault();
        if (e.shiftKey) st.ungroupSelected();
        else st.groupSelected();
        return;
      }
      if (mod && (k === "0" || e.key === "0")) {
        e.preventDefault();
        st.fitView();
        return;
      }
      if (mod && e.shiftKey && (e.key === "1" || e.code === "Digit1")) {
        e.preventDefault(); // ⇧⌘1 缩放到选区（无选中时 fitSelection 自身退化为适配画布）
        st.fitSelection();
        return;
      }
      if (mod && e.key === "1") {
        e.preventDefault();
        st.zoomTo(1);
        return;
      }
      if (e.key === "Escape") {
        st.setSel([]);
        st.setTool("select");
        return;
      }
      if (mod || e.altKey) return;
      if (k === "p") {
        e.preventDefault();
        previewRef.current?.();
        return;
      }
      const map: Record<string, Tool> = {
        v: "select",
        h: "hand",
        f: "frame",
        r: "rect",
        o: "ellipse",
        l: "line",
        a: "arrow",
        t: "text",
      };
      if (map[k]) {
        st.setTool(map[k]!);
        return;
      }
      if (k === "backspace" || k === "delete") {
        e.preventDefault();
        st.deleteSelected();
        return;
      }
      if (k.startsWith("arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        st.nudge(
          k === "arrowleft" ? -step : k === "arrowright" ? step : 0,
          k === "arrowup" ? -step : k === "arrowdown" ? step : 0,
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}

/** 容器宽度测量：宿主面板可拖宽窄，外壳按实时宽度自适应（不用视口宽） */
function useShellWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(() => (typeof window === "undefined" ? 1280 : window.innerWidth));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr) setW(cr.width);
    });
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return { ref, width: w };
}

/** 面板开合偏好持久化：手动折叠跨刷新/重开档保留（localStorage，本地草稿同源） */
const PANELS_KEY = "ui-design-panels";
function loadPanels(): { layers: boolean; inspector: boolean } {
  try {
    const raw = localStorage.getItem(PANELS_KEY);
    if (raw) {
      const o = JSON.parse(raw) as { l?: unknown; i?: unknown };
      return { layers: o.l !== false, inspector: o.i !== false };
    }
  } catch {
    /* 无持久化环境 → 默认全开 */
  }
  return { layers: true, inspector: true };
}
function savePanels(p: { layers: boolean; inspector: boolean }) {
  try {
    localStorage.setItem(PANELS_KEY, JSON.stringify({ l: p.layers, i: p.inspector }));
  } catch {
    /* 忽略 */
  }
}

/**
 * EditorShell 自适应两态（断点 = 外壳容器宽 1040px）：
 *   docked（≥1040）：三栏停靠 —— 左 232（FileMenu+图层）| 画布 | 右 272 属性（含 8px 滚动条留白）；
 *     底部：工具栏居中 + 缩放条右下。两栏可手动收起（面板头部按钮），收起后画布
 *     边缘出现半高小把手再展开；开合状态 localStorage 持久化，任何宽度下都尊重手动选择。
 *   drawers（<1040）：画布通栏；左上角悬浮胶囊（文件菜单 + 图层/属性抽屉开关）；
 *     两个面板变浮层抽屉；底部缩放条叠在工具栏上方，避免横向挤压。
 */
function EditorShell({ store, onGoHome, onPreview }: { store: DesignStore; onGoHome: () => void; onPreview: () => void }) {
  const [conflictOpen, setConflictOpen] = useState(false);
  useEffect(() => {
    setConflictOpen(!!store.conflict);
  }, [store.conflict]);

  const { ref, width } = useShellWidth<HTMLDivElement>();
  const docked = width >= 1040;
  const [panels, setPanels] = useState(loadPanels);
  const togglePanel = (key: "layers" | "inspector") =>
    setPanels((p) => {
      const n = { ...p, [key]: !p[key] };
      savePanels(n);
      return n;
    });

  return (
    <div ref={ref} className="relative flex h-full w-full overflow-hidden" style={{ background: "var(--canvas)" }}>
      {docked && panels.layers && (
        /* 左栏：顶部 FileMenu 条（右端收起钮）+ 图层面板（竖排，不互相遮挡） */
        <div className="z-20 flex w-[232px] shrink-0 flex-col border-r" style={{ borderColor: "var(--border)", background: "var(--background)" }}>
          <div className="flex h-11 shrink-0 items-center gap-1 px-2">
            <div className="min-w-0 flex-1">
              <FileMenu store={store} onGoHome={onGoHome} onPreview={onPreview} />
            </div>
            <IconBtn tip="收起面板" size={26} tipSide="bottom" onClick={() => togglePanel("layers")}>
              <PanelLeftClose size={14} />
            </IconBtn>
          </div>
          <div className="min-h-0 flex-1">
            <LayersPanel store={store} />
          </div>
        </div>
      )}

      {/* 中央画布（含悬浮工具栏 / 缩放条 / 浮层） */}
      <div className="relative min-w-0 flex-1">
        <DesignStage store={store} />

        {/* 停靠态面板收起后：画布左右边缘的半高小把手，点一下重新展开 */}
        {docked && !panels.layers && (
          <button
            type="button"
            title="展开图层面板"
            onClick={() => togglePanel("layers")}
            className="absolute left-0 top-1/2 z-20 flex h-16 w-[18px] -translate-y-1/2 items-center justify-center rounded-r-lg border"
            style={{ borderColor: "var(--border)", background: "var(--background)", color: "var(--muted-foreground)", boxShadow: "var(--sh-float)" }}
          >
            <PanelLeftOpen size={13} />
          </button>
        )}
        {docked && !panels.inspector && (
          <button
            type="button"
            title="展开属性面板"
            onClick={() => togglePanel("inspector")}
            className="absolute right-0 top-1/2 z-20 flex h-16 w-[18px] -translate-y-1/2 items-center justify-center rounded-l-lg border"
            style={{ borderColor: "var(--border)", background: "var(--background)", color: "var(--muted-foreground)", boxShadow: "var(--sh-float)" }}
          >
            <PanelRightOpen size={13} />
          </button>
        )}

        {/* 窄态：左上悬浮胶囊 = 文件菜单 + 两个抽屉开关 */}
        {!docked && (
          <div className="pointer-events-auto absolute left-2 top-2 z-30 flex items-center gap-0.5 rounded-full p-1" style={{ background: "var(--background)", boxShadow: "var(--sh-float)" }}>
            <FileMenu store={store} onGoHome={onGoHome} onPreview={onPreview} />
            <div className="mx-1 h-5 w-px" style={{ background: "var(--border)" }} />
            <IconBtn tip="图层面板" size={28} tipSide="bottom" active={panels.layers} onClick={() => togglePanel("layers")}>
              <PanelLeft size={15} />
            </IconBtn>
            <IconBtn tip="属性面板" size={28} tipSide="bottom" active={panels.inspector} onClick={() => togglePanel("inspector")}>
              <PanelRight size={15} />
            </IconBtn>
          </div>
        )}
        {/* 窄态抽屉：图层（左）/ 属性（右），浮在画布上互不占位 */}
        {!docked && panels.layers && (
          <div className="absolute bottom-24 left-2 top-14 z-30 flex w-[min(268px,calc(100%-16px))] flex-col overflow-hidden rounded-xl border" style={{ borderColor: "var(--border)", background: "var(--background)", boxShadow: "var(--sh-float)" }}>
            <LayersPanel store={store} />
          </div>
        )}
        {!docked && panels.inspector && (
          <div className="absolute bottom-24 right-2 top-2 z-30 w-[min(280px,calc(100%-16px))] overflow-hidden rounded-xl border" style={{ borderColor: "var(--border)", background: "var(--background)", boxShadow: "var(--sh-float)" }}>
            <Inspector store={store} onPreview={onPreview} />
          </div>
        )}

        {docked ? (
          <>
            <div className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2">
              <Toolbar store={store} />
            </div>
            <div className="absolute bottom-4 right-3 z-20">
              <ZoomBar store={store} />
            </div>
          </>
        ) : (
          /* 窄态：缩放条叠在工具栏上方，底部纵向合并，避免横向相撞 */
          <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 flex-col items-center gap-1.5">
            <div className="pointer-events-auto">
              <ZoomBar store={store} />
            </div>
            <div className="pointer-events-auto">
              <Toolbar store={store} />
            </div>
          </div>
        )}

        {store.notice && (
          <div
            className="absolute left-1/2 top-4 z-30 -translate-x-1/2 whitespace-nowrap rounded-full px-3.5 py-1.5 text-[12px]"
            style={{ background: "var(--popover)", color: "var(--popover-foreground)", boxShadow: "var(--sh-float)" }}
          >
            {store.notice}
          </div>
        )}
        {store.docCorrupt && (
          <div
            className="absolute left-1/2 top-4 z-30 max-w-[calc(100%-24px)] -translate-x-1/2 rounded-full px-3.5 py-1.5 font-medium"
            style={{ background: "#fdecea", color: "#b3261e", boxShadow: "var(--sh-float)" }}
          >
            文件不是有效的设计档：已保持盘上内容不变（不回写）
          </div>
        )}
        {conflictOpen && store.conflict && (
          <div className="absolute inset-0 z-40 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.35)" }}>
            <div className="w-[min(360px,calc(100%-32px))] rounded-2xl p-4" style={{ background: "var(--popover)", boxShadow: "var(--sh-warm), var(--sh-outline)" }}>
              <div className="text-[14px] font-medium">检测到外部修改</div>
              <div className="mt-1.5 leading-relaxed" style={{ color: "var(--muted-foreground)" }}>
                Agent/磁盘写入了一版新内容，且本地有未保存改动。选择保留哪一版：
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  className="rounded-full border px-3.5 py-1.5 transition-colors hover:bg-[var(--secondary)]"
                  style={{ borderColor: "var(--border)", color: "var(--foreground)" }}
                  onClick={() => {
                    store.resolveConflict("keep");
                    setConflictOpen(false);
                  }}
                >
                  保留本地
                </button>
                <button
                  className="rounded-full px-3.5 py-1.5 font-medium"
                  style={{ background: "var(--accent)", color: "var(--accent-foreground)" }}
                  onClick={() => {
                    store.resolveConflict("reload");
                    setConflictOpen(false);
                  }}
                >
                  载入外部版本
                </button>
              </div>
            </div>
          </div>
        )}
        {!store.docLoaded && !store.docCorrupt && (
          <div
            className="absolute inset-0 z-30 flex items-center justify-center text-[13px]"
            style={{ background: "var(--canvas)", color: "var(--muted-foreground)" }}
          >
            {store.connected ? "正在打开文档…" : "等待宿主连接…"}
          </div>
        )}
      </div>

      {docked && panels.inspector && (
        /* 右栏：属性检视（右上角悬浮收起钮） */
        <div className="relative z-10 flex w-[272px] shrink-0 flex-col border-l" style={{ borderColor: "var(--border)", background: "var(--background)" }}>
          <div className="absolute right-1 top-1.5 z-30">
            <IconBtn tip="收起面板" size={26} tipSide="bottom" tipAlign="end" onClick={() => togglePanel("inspector")}>
              <PanelRightClose size={14} />
            </IconBtn>
          </div>
          <Inspector store={store} onPreview={onPreview} />
        </div>
      )}
    </div>
  );
}

export function App() {
  const store = useDesign();
  const [homeOpen, setHomeOpen] = useState(false);
  const [previewFrameId, setPreviewFrameId] = useState<string | null>(null);
  // 预览原型：从选区所在画板（或当前页/全档第一个画板）起播；无画板时提示
  const openPreview = () => {
    const f = firstPlayableFrame(store.doc, store.selIds);
    if (!f) {
      bridge.notify("还没有画板：先用 F 画一块再预览", "error");
      return;
    }
    setPreviewFrameId(f.id);
  };
  // 首页不劫持键：设计首页的输入框/按钮要正常响应；编辑器快捷键仅编辑器在场时挂
  // （预览浮层在场时也不挂：Esc/方向键归浮层自己处理）
  useHotkeys(store, !homeOpen && !previewFrameId, openPreview);
  // 宿主推档打开（doc.request → doc.open / bind 后）即从首页进编辑器：
  // 冷启动自动接上绑定档；首页点卡片的 bindDoc 路径则直接 onEnter，这条兜住 agent 写盘自动开板
  const loadedRef = useRef(store.docLoaded);
  useEffect(() => {
    if (store.docLoaded && !loadedRef.current) setHomeOpen(false);
    loadedRef.current = store.docLoaded;
  }, [store.docLoaded]);

  if (!store.docLoaded || homeOpen) {
    return <Home store={store} currentPath={store.fileRel} onEnter={() => setHomeOpen(false)} />;
  }
  return (
    <>
      <EditorShell store={store} onGoHome={() => setHomeOpen(true)} onPreview={openPreview} />
      {previewFrameId && (
        <PrototypePreview store={store} startFrameId={previewFrameId} onClose={() => setPreviewFrameId(null)} />
      )}
    </>
  );
}
