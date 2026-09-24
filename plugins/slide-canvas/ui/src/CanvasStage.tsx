/**
 * 画布视口（双 surface，同一套几何/交互引擎）：DOM + CSS transform 的四层结构
 *   stage(屏幕事件宿主) → viewport(translate/scale，画布坐标)
 *     → 页框层（deck：只渲染当前一页；board：完全不渲染）
 *     → objects 层（board：画布级元素；deck：不渲染）
 *   + overlay(选择框/手柄/吸附线/框选矩形/文本编辑镜像，屏幕坐标)
 *
 * surface="board"（白板画布）：只呈现与命中 objects；页框不可见、不可选、不参与适配。
 * surface="deck"（幻灯片单页编辑）：只呈现与命中当前页（选择所在页，否则第一页）的
 *   artboard；objects 隐藏；框选/命中/适配全部围绕这一页。页框位置 x/y 两种模式都不
 *   提供拖拽 UI（deck 靠 focusFrame 适配居中，board 不画页框）。
 *
 * 几何约定：元素在「容器内局部坐标」——页框内元素相对框左上角，objects 即画布坐标。
 * 命中/选择/overlay 统一换算到画布空间比较（marquee 对页框元素先把 rect 平移进框局部）。
 *
 * 拖拽/缩放/旋转全程实时预览：进行中几何放 live Map 传入渲染，pointerup 一次性 commit。
 * 钢笔：board 落 objects；deck 只落当前页，出页丢弃并提示。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { ElView, SlideView, EmbedElView, SvgElView, getEmbedActive, setEmbedActive } from "./render";
import { isAnimatedSvg } from "./mermaid";
import { LeaferStage } from "./leafer/LeaferStage";
import { containerEls, type DeckStore, type Surface } from "./state";
import {
  CANVAS_ROOT,
  DRAW_MAX_POINTS,
  drawFromPoints,
  isDarkColor,
  uid,
  type Box,
  type DrawPoint,
  type El,
  type EmbedEl,
  type Frame,
  type LineDir,
  type ShapeEl,
  type SvgEl,
  type TextEl,
} from "./doc";
import { ChartEditor } from "./editor/ChartEditor";
import { TableEditor } from "./editor/TableEditor";
import {
  boxOf,
  boxesIntersect,
  expandGroup,
  norm,
  normalizeDeg,
  resizeBox,
  scaleGroup,
  snapDeg,
  unionBox,
} from "./geometry";

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
const SNAP_PX = 8;
const MARQUEE_THRESHOLD = 3;

/** 画线工具文案（出页提示用） */
const DRAW_LABEL: Record<"line" | "arrow" | "double-arrow", string> = { line: "直线", arrow: "箭头", "double-arrow": "双头箭头" };

/** 渲染器双轨开关（Leafer 迁移期）：像素 parity 全绿后默认 leafer；
 * 显式设 localStorage "slide-canvas.renderer" = "dom" 回退 DOM 渲染。
 * 只换元素渲染：命中/交互/overlay（选中框/手柄/吸附线/框选/文本编辑）两轨共用同一套 DOM 代码。 */
export const RENDERER_KEY = "slide-canvas.renderer";
function readRenderer(): "dom" | "leafer" {
  try {
    return localStorage.getItem(RENDERER_KEY) === "dom" ? "dom" : "leafer";
  } catch {
    return "leafer";
  }
}

export type View = { s: number; tx: number; ty: number };

/** 页框画布位置（直接读 doc：位置已入档，不再按网格重算） */
export type FramePos = { frame: Frame; x: number; y: number };

type DragState =
  | { mode: "pan"; sx: number; sy: number; orig: View }
  | {
      mode: "move";
      containerId: string;
      elIds: string[];
      /** 拖拽起点各选中元素几何（容器局部坐标，不变）；实时 = base + off */
      base: Map<string, Box>;
      sx: number;
      sy: number;
      off: { x: number; y: number };
      snapLines: SnapLine[];
    }
  | { mode: "resize"; containerId: string; elId: string; handle: number; sx: number; sy: number; orig: Box; ghost: Box | null }
  | {
      mode: "groupresize";
      containerId: string;
      elIds: string[];
      items: Map<string, Box>;
      origUnion: Box;
      handle: number;
      sx: number;
      sy: number;
      next: Box | null;
    }
  | { mode: "rotate"; containerId: string; elId: string; sx: number; sy: number; cx: number; cy: number; startDeg: number; origRot: number; rot: number | null }
  | {
      /** 钢笔模式一笔：画布坐标点列（采样限距，采样期就地抽稀） */
      mode: "pen";
      pts: DrawPoint[];
      lastX: number;
      lastY: number;
    }
  | {
      /** 画线工具一次拖拽：起点→尾点（画布坐标），方向随拖拽、尾点为箭头头 */
      mode: "draw";
      kind: "line" | "arrow" | "double-arrow";
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    }
  | {
      mode: "marquee";
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      /** 按下点所在页框（null = 画布空白） */
      containerId: string | null;
      /** 按下时的既有选择（Shift 累加基数） */
      baseSel: { containerId: string; elIds: string[] } | null;
      additive: boolean;
      sx: number;
      sy: number;
    };

type SnapLine = { x1: number; y1: number; x2: number; y2: number };

/** 右键命中上下文（App 据此渲染 ContextMenu 条目） */
export type ContextHit =
  | { kind: "element"; containerId: string; el: El }
  | { kind: "artboard"; containerId: string }
  | { kind: "canvas" };

/** 8 手柄序：nw n ne e se s sw w（bit 组决定新 bbox 哪边在动） */
const HANDLES: { idx: number; cursor: string }[] = [
  { idx: 0, cursor: "nwse-resize" },
  { idx: 1, cursor: "ns-resize" },
  { idx: 2, cursor: "nesw-resize" },
  { idx: 3, cursor: "ew-resize" },
  { idx: 4, cursor: "nwse-resize" },
  { idx: 5, cursor: "ns-resize" },
  { idx: 6, cursor: "nesw-resize" },
  { idx: 7, cursor: "ew-resize" },
];

function handlePos(i: number, l: number, t: number, w: number, h: number) {
  const x = l + (i === 1 || i === 5 ? w / 2 : i === 2 || i === 3 || i === 4 ? w : 0);
  const y = t + (i === 3 || i === 7 ? h / 2 : i === 4 || i === 5 || i === 6 ? h : 0);
  return { x, y };
}

export type ZoomApi = {
  fitAll: () => void;
  zoom100: () => void;
  zoomBy: (k: number) => void;
  /** 绝对缩放（以视口中心为锚） */
  zoomTo: (s: number) => void;
  /** 当前视口中心的画布坐标：无聚焦页框时插入元素落这里 */
  viewportCenter: () => { x: number; y: number };
  /** 居中并适配某页框 */
  focusFrame: (frameId: string) => void;
};

export const CanvasStage: FC<{
  store: DeckStore;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  zoomApi: { current: ZoomApi | null };
  onZoom: (s: number) => void;
  onContextHit?: (hit: ContextHit) => void;
  /** 选中内容上方的浮动工具条（屏幕坐标由 stage 定位；拖拽/编辑时自动隐藏） */
  selToolbar?: ReactNode;
  /** 钢笔模式：按下即起笔采样，抬起提交 draw（board→objects；deck→当前页，出页丢弃提示） */
  penMode?: boolean;
  /** 画线工具：按下从起点拖到尾点，抬起提交 line/arrow/double-arrow（默认色随页背景明暗；deck 出页丢弃提示） */
  drawTool?: "line" | "arrow" | "double-arrow" | null;
  /** 抓手工具（H）：与按住空格等效，拖拽即平移 */
  handMode?: boolean;
  /** 绑定文档标识（workspace 相对路径）：变化即"换档"，按表面重适配视口 */
  refitKey?: string | null;
  /** 外壳模式：board 只见 objects；deck 只见当前页框。默认 board */
  surface?: Surface;
  ref?: Ref<HTMLDivElement>;
}> = ({ store, editingId, setEditingId, zoomApi, onZoom, onContextHit, selToolbar, penMode, drawTool, handMode, refitKey, surface = "board", ref }) => {
  const { doc, sel, setSel, updateEl, setContainerElements, insertImageFromFile } = store;
  const hostRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ s: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  /** 程序化适配意图（fitAll / 聚焦某页框）；用户手动平移/缩放后清除 */
  const fitIntentRef = useRef<{ kind: "all" } | { kind: "frame"; id: string } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const spaceRef = useRef(false);
  const [spaceCursor, setSpaceCursor] = useState(false);
  const [dropHint, setDropHint] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  /* ---------- 容器尺寸（ResizeObserver，适配计算唯一输入） ---------- */

  const [hostSize, setHostSize] = useState({ w: 800, h: 600 });
  const [measured, setMeasured] = useState(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) {
        setHostSize({ w: r.width, h: r.height });
        setMeasured(true);
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  /* ---------- 拖拽实时重绘（rAF，仅拖拽期间转圈） ---------- */

  const [dragTick, setDragTick] = useState(0);
  const rafId = useRef(0);
  const startBump = useCallback(() => {
    if (rafId.current) return;
    const step = () => {
      if (!dragRef.current) {
        rafId.current = 0;
        return;
      }
      setDragTick((t) => t + 1);
      rafId.current = requestAnimationFrame(step);
    };
    rafId.current = requestAnimationFrame(step);
  }, []);

  /* ---------- 布局与适配（随 surface 过滤：deck 只当前页 / board 只 objects） ---------- */

  /** deck 的当前页 id：选择所在页，否则第一页；无页 null */
  const curFrameId =
    surface === "deck" ? (doc.frames.find((f) => f.id === sel?.containerId)?.id ?? doc.frames[0]?.id ?? null) : null;

  const layout = useMemo(() => {
    const positions: FramePos[] =
      surface === "deck" && curFrameId
        ? doc.frames.filter((f) => f.id === curFrameId).map((f) => ({ frame: f, x: f.x, y: f.y }))
        : [];
    const items: Box[] = [
      ...positions.map((p) => ({ x: p.x, y: p.y, w: p.frame.w, h: p.frame.h })),
      ...(surface === "board" ? doc.objects.map((o) => boxOf(o)) : []),
    ];
    const u = unionBox(items);
    const bbox: Box = u ? { x: u.x - 80, y: u.y - 80, w: u.w + 160, h: u.h + 160 } : { x: 0, y: 0, w: 1, h: 1 };
    return { positions, bbox };
  }, [surface, curFrameId, doc.frames, doc.objects]);
  const positions = layout.positions;
  const posById = useMemo(() => {
    const m = new Map<string, FramePos>();
    for (const p of positions) m.set(p.frame.id, p);
    return m;
  }, [positions]);

  /** 容器局部坐标 → 画布坐标的偏移（root 恒 0；页框不存在的死选择返回 null） */
  const offOf = useCallback(
    (containerId: string): { x: number; y: number } | null =>
      containerId === CANVAS_ROOT ? { x: 0, y: 0 } : posById.get(containerId) ?? null,
    [posById],
  );

  /**
   * 实时盒尺寸：dock（幻灯片四栏）与浮层（白板）切换会让 stage 盒改变大小，
   * ResizeObserver 的状态要等下一次渲染才更新；适配/缩放按调用时刻读 rect。
   */
  const hostWH = useCallback(
    (): { w: number; h: number } => {
      const r = hostRef.current?.getBoundingClientRect();
      return r && r.width > 0 && r.height > 0 ? { w: r.width, h: r.height } : hostSize;
    },
    [hostSize],
  );

  const fitAll = useCallback(() => {
    const { w, h } = hostWH();
    const { bbox } = layout;
    const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((w - 40) / bbox.w, (h - 40) / bbox.h, 1)));
    fitIntentRef.current = { kind: "all" };
    setView({
      s,
      tx: (w - bbox.w * s) / 2 - bbox.x * s,
      ty: (h - bbox.h * s) / 2 - bbox.y * s,
    });
  }, [hostWH, layout]);

  /** 居中并适配某页框（记录意图：容器尺寸变动后按最新尺寸重应用） */
  const focusFrameImpl = useCallback(
    (frameId: string) => {
      const p = posById.get(frameId);
      if (!p) return;
      const { w, h } = hostWH();
      const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((w - 120) / p.frame.w, (h - 120) / p.frame.h, 2)));
      fitIntentRef.current = { kind: "frame", id: frameId };
      setView({ s, tx: w / 2 - (p.x + p.frame.w / 2) * s, ty: h / 2 - (p.y + p.frame.h / 2) * s });
    },
    [posById, hostWH],
  );

  /** 打开文档后一次性适配全部（等 ResizeObserver 量到真实容器再算） */
  const didFitRef = useRef(false);
  useEffect(() => {
    if (!measured || didFitRef.current || (doc.frames.length === 0 && doc.objects.length === 0)) return;
    didFitRef.current = true;
    // App 层已给出程序化适配意图（进 deck 聚焦当前页 / 进白板 fitAll）时让位，
    // 否则 RO 提交时序会决定谁最后落值，视口随渲染分支漂移。
    if (!fitIntentRef.current) fitAll();
  }, [measured, doc.frames.length, doc.objects.length, fitAll]);

  /**
   * 换档重适配（新建 / 从首页打开另一份）：绑定文档变化后按表面重算视口，
   * 否则新内容会落在上一份的视口外、看着像空白。写在 stage 里而不是 App：
   * 只有这里知道容器是否量过（measured），时机才不会打空。
   */
  const lastRefitKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!refitKey) return;
    if (lastRefitKeyRef.current === refitKey) return;
    lastRefitKeyRef.current = refitKey;
    const run = () => {
      if (surface === "deck") {
        const f = doc.frames[0];
        if (f) focusFrameImpl(f.id);
      } else {
        fitAll();
      }
    };
    // 立刻一次 + 下一帧再一次：容器测量与 doc.open 的提交次序不定，
    // 只赌一次容易落在 measured=false / 空 layout 上（新建档看不到画板就是这么来的）
    run();
    const t = setTimeout(run, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refitKey, surface]);

  /**
   * 挂载首帧常量到未落定的旧宽度（dock/侧栏布局后 ResizeObserver 还会再报尺寸），
   * 那一刻算出的 s/tx 会一直错着——容器尺寸每变一次，按当前程序化适配意图重应用。
   */
  const lastFitSizeRef = useRef({ w: 0, h: 0 });
  useEffect(() => {
    if (!measured) return;
    if (hostSize.w === lastFitSizeRef.current.w && hostSize.h === lastFitSizeRef.current.h) return;
    lastFitSizeRef.current = hostSize;
    const it = fitIntentRef.current;
    if (!it) return;
    if (it.kind === "all") fitAll();
    else focusFrameImpl(it.id);
  }, [measured, hostSize, fitAll, focusFrameImpl]);

  useEffect(() => {
    zoomApi.current = {
      fitAll,
      zoom100: () => {
        fitIntentRef.current = null;
        const { w, h } = hostWH();
        const v = viewRef.current;
        const k = 1 / v.s;
        setView({ s: 1, tx: w / 2 - (w / 2 - v.tx) * k, ty: h / 2 - (h / 2 - v.ty) * k });
      },
      zoomBy: (k: number) => {
        const { w, h } = hostWH();
        zoomAt(w / 2, h / 2, k);
      },
      zoomTo: (target: number) => {
        fitIntentRef.current = null;
        const { w, h } = hostWH();
        const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, target));
        setView((v) => {
          const r = s / v.s;
          return { s, tx: w / 2 - (w / 2 - v.tx) * r, ty: h / 2 - (h / 2 - v.ty) * r };
        });
      },
      viewportCenter: () => {
        const { w, h } = hostWH();
        const vv = viewRef.current;
        return { x: (w / 2 - vv.tx) / vv.s, y: (h / 2 - vv.ty) / vv.s };
      },
      focusFrame: focusFrameImpl,
    };
  }, [fitAll, hostWH, focusFrameImpl, zoomApi]);

  useEffect(() => onZoom(view.s), [view.s, onZoom]);

  /** 锚点缩放：s'=clamp(s·k); t' = p - (p - t)·(s'/s) */
  function zoomAt(px: number, py: number, k: number) {
    fitIntentRef.current = null; // 用户缩放：程序化适配意图失效
    setView((v) => {
      const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.s * k));
      const r = s / v.s;
      return { s, tx: px - (px - v.tx) * r, ty: py - (py - v.ty) * r };
    });
  }

  const screenToDoc = useCallback((sx: number, sy: number) => {
    const rect = hostRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    const x = (sx - (rect?.left ?? 0) - v.tx) / v.s;
    const y = (sy - (rect?.top ?? 0) - v.ty) / v.s;
    return { x, y };
  }, []);

  const hitFrame = useCallback(
    (dx: number, dy: number): FramePos | undefined => {
      for (const p of positions)
        if (dx >= p.x && dx <= p.x + p.frame.w && dy >= p.y && dy <= p.y + p.frame.h) return p;
      return undefined;
    },
    [positions],
  );

  /** 容器局部坐标命中（数组尾=顶层优先；2px 容差） */
  const hitElIn = useCallback((els: El[], x: number, y: number): El | undefined => {
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      if (x >= e.x - 2 && x <= e.x + e.w + 2 && y >= e.y - 2 && y <= e.y + e.h + 2) return e;
    }
    return undefined;
  }, []);

  /* ---------- 拖拽中的实时几何（live Map，渲染与 overlay 共用） ---------- */

  const liveMap = useMemo(() => {
    void dragTick;
    const m = new Map<string, Partial<El>>();
    const d = dragRef.current;
    if (!d || d.mode === "pan" || d.mode === "pen" || d.mode === "draw" || d.mode === "marquee") return m;
    if (d.mode === "move") {
      for (const [id, b] of d.base) m.set(id, { x: Math.round(b.x + d.off.x), y: Math.round(b.y + d.off.y) });
    } else if (d.mode === "resize") {
      if (d.ghost) m.set(d.elId, d.ghost);
    } else if (d.mode === "groupresize") {
      if (d.next) for (const [id, b] of scaleGroup(d.origUnion, d.next, [...d.items].map(([id2, box]) => ({ id: id2, box })))) m.set(id, b);
    } else {
      if (d.rot !== null) m.set(d.elId, { rotation: d.rot } as Partial<El>);
    }
    return m;
  }, [dragTick]);
  const liveContainerId = (() => {
    const d = dragRef.current;
    return d && "containerId" in d && d.mode !== "marquee" ? d.containerId : null;
  })();
  /** 钢笔进行中的一笔实时预览（画布坐标点串，viewport 内 SVG 直接描） */
  const penPreview = (() => {
    void dragTick;
    const d = dragRef.current;
    return d && d.mode === "pen" ? d.pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ") : null;
  })();
  /** 画线工具进行中的一条实时预览（画布坐标起终点） */
  const drawPreview = (() => {
    void dragTick;
    const d = dragRef.current;
    return d && d.mode === "draw" ? d : null;
  })();
  const drawPreviewSvg = drawPreview ? (
    <svg style={{ position: "absolute", left: 0, top: 0, width: 1, height: 1, overflow: "visible", pointerEvents: "none" }}>
      <line
        x1={drawPreview.x0}
        y1={drawPreview.y0}
        x2={drawPreview.x1}
        y2={drawPreview.y1}
        stroke="var(--foreground)"
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray="6 4"
      />
      {drawPreview.kind !== "line" &&
        (() => {
          const a = Math.atan2(drawPreview.y1 - drawPreview.y0, drawPreview.x1 - drawPreview.x0);
          const L = 14;
          const head = (tipX: number, tipY: number, ang: number): string => {
            const p = (ang2: number): string => `${(tipX - L * Math.cos(ang2)).toFixed(1)},${(tipY - L * Math.sin(ang2)).toFixed(1)}`;
            return `M${tipX.toFixed(1)},${tipY.toFixed(1)} L${p(ang - 0.5)} L${p(ang + 0.5)} Z`;
          };
          const ds: string[] = [head(drawPreview.x1, drawPreview.y1, a)];
          if (drawPreview.kind === "double-arrow") ds.push(head(drawPreview.x0, drawPreview.y0, a + Math.PI));
          return <path d={ds.join(" ")} fill="var(--foreground)" />;
        })()}
    </svg>
  ) : null;

  /** 元素当前显示几何（live 覆盖后，容器局部坐标） */
  const geo = useCallback(
    (el: El): Box => {
      const p = liveMap.get(el.id);
      return p
        ? { x: p.x ?? el.x, y: p.y ?? el.y, w: p.w ?? el.w, h: p.h ?? el.h }
        : boxOf(el);
    },
    [liveMap],
  );

  /* ---------- pointer 交互 ---------- */

  /** 元素按下公共逻辑：Shift/⌘ 加选、点已选成员保持整组，其余单选；挂 move 拖拽。
   *  组联动：点到组成员即整组入选（移出成员除外，允许单独摘选）。 */
  const armElementDrag = (e: ReactPointerEvent, containerId: string, el: El) => {
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const els = containerEls(doc, containerId) ?? [];
    let ids: string[];
    if (additive && sel?.containerId === containerId) {
      ids = sel.elIds.includes(el.id)
        ? sel.elIds.filter((i) => i !== el.id)
        : expandGroup(els, [...sel.elIds, el.id]);
    } else if (!additive && sel?.containerId === containerId && sel.elIds.includes(el.id)) {
      ids = sel.elIds; // 点到已选集合成员：保持整组，便于拖动
    } else {
      ids = expandGroup(els, [el.id]);
    }
    setSel({ containerId, elIds: ids });
    if (ids.length > 0) {
      const base = new Map<string, Box>();
      for (const id of ids) {
        const t = els.find((q) => q.id === id);
        if (t) base.set(id, boxOf(t));
      }
      dragRef.current = {
        mode: "move",
        containerId,
        elIds: ids,
        base,
        sx: e.clientX,
        sy: e.clientY,
        off: { x: 0, y: 0 },
        snapLines: [],
      };
      startBump();
    }
  };

  const onStagePointerDown = (e: ReactPointerEvent) => {
    if (e.button === 2) return;
    const { x: dx, y: dy } = screenToDoc(e.clientX, e.clientY);
    // 文本编辑中点击外部 → 收尾提交（textarea 自身的 mousedown 焦点默认动作在其后，blur 只影响别处）
    if (editingId) {
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }
    if (spaceRef.current || handMode || e.button === 1) {
      dragRef.current = { mode: "pan", sx: e.clientX, sy: e.clientY, orig: viewRef.current };
      e.preventDefault();
      return;
    }
    if (penMode) {
      if (e.button !== 0) return;
      e.preventDefault();
      const p = screenToDoc(e.clientX, e.clientY);
      dragRef.current = { mode: "pen", pts: [[p.x, p.y]], lastX: p.x, lastY: p.y };
      startBump();
      return;
    }
    // 画线工具：按下即起点，拖到尾点抬起提交（方向随拖拽向量）
    if (drawTool && e.button === 0) {
      e.preventDefault();
      dragRef.current = { mode: "draw", kind: drawTool, x0: dx, y0: dy, x1: dx, y1: dy };
      startBump();
      return;
    }
    // 命中序：board 只有 objects；deck 只有当前页（hitFrame 已按 surface 过滤）
    const rootEl = surface === "board" ? hitElIn(doc.objects, dx, dy) : undefined;
    if (rootEl) {
      armElementDrag(e, CANVAS_ROOT, rootEl);
      return;
    }
    const sp = hitFrame(dx, dy);
    const el = sp ? hitElIn(sp.frame.elements, dx - sp.x, dy - sp.y) : undefined;
    if (!el) {
      // 空白（页框内或画布）按下：先做点击语义（聚焦页框/清选），再挂 marquee 等待拖动
      const baseSel =
        e.shiftKey && sp && sel?.containerId === sp.frame.id ? sel : sp ? { containerId: sp.frame.id, elIds: [] as string[] } : sel;
      if (sp && !e.shiftKey) setSel({ containerId: sp.frame.id, elIds: [] });
      else if (!sp && !e.shiftKey) setSel(null);
      dragRef.current = {
        mode: "marquee",
        x0: dx,
        y0: dy,
        x1: dx,
        y1: dy,
        containerId: sp?.frame.id ?? null,
        baseSel: baseSel ?? null,
        additive: e.shiftKey,
        sx: e.clientX,
        sy: e.clientY,
      };
      startBump();
      return;
    }
    armElementDrag(e, sp!.frame.id, el);
  };

  /** 手柄按下公共前置：返回 false 表示应放弃本次拖拽 */
  const startElDrag = (e: ReactPointerEvent) => {
    e.stopPropagation();
    if (editingId) return false;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    return true;
  };

  const onHandlePointerDown = (e: ReactPointerEvent, containerId: string, el: El, handle: number) => {
    if (!startElDrag(e)) return;
    dragRef.current = {
      mode: "resize",
      containerId,
      elId: el.id,
      handle,
      sx: e.clientX,
      sy: e.clientY,
      orig: geo(el),
      ghost: null,
    };
    startBump();
  };

  const onGroupHandlePointerDown = (e: ReactPointerEvent, containerId: string, items: Map<string, Box>, handle: number) => {
    if (!startElDrag(e)) return;
    const origUnion = unionBox([...items.values()])!;
    dragRef.current = {
      mode: "groupresize",
      containerId,
      elIds: [...items.keys()],
      items,
      origUnion,
      handle,
      sx: e.clientX,
      sy: e.clientY,
      next: null,
    };
    startBump();
  };

  const onRotatePointerDown = (e: ReactPointerEvent, containerId: string, el: El, center: { x: number; y: number }) => {
    if (!startElDrag(e)) return;
    const p = screenToDoc(e.clientX, e.clientY);
    dragRef.current = {
      mode: "rotate",
      containerId,
      elId: el.id,
      sx: e.clientX,
      sy: e.clientY,
      cx: center.x,
      cy: center.y,
      startDeg: (Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI,
      origRot: el.rotation ?? 0,
      rot: null,
    };
    startBump();
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.mode === "pan") {
        fitIntentRef.current = null; // 用户平移：程序化适配意图失效
        setView({ s: d.orig.s, tx: d.orig.tx + (e.clientX - d.sx), ty: d.orig.ty + (e.clientY - d.sy) });
        return;
      }
      if (d.mode === "marquee") {
        const { x, y } = screenToDoc(e.clientX, e.clientY);
        d.x1 = x;
        d.y1 = y;
        return;
      }
      if (d.mode === "pen") {
        const { x, y } = screenToDoc(e.clientX, e.clientY);
        // 限距采样（画布单位 ≈2 屏幕 px）；超长就地隔点抽稀，封顶在提交处还有兜底
        if (Math.hypot(x - d.lastX, y - d.lastY) >= 2 / viewRef.current.s) {
          d.pts.push([x, y]);
          d.lastX = x;
          d.lastY = y;
          if (d.pts.length > DRAW_MAX_POINTS) {
            const kept: DrawPoint[] = [];
            for (let i = 0; i < d.pts.length; i += 2) kept.push(d.pts[i]!);
            d.pts = kept;
          }
        }
        return;
      }
      if (d.mode === "draw") {
        const { x, y } = screenToDoc(e.clientX, e.clientY);
        d.x1 = x;
        d.y1 = y;
        return;
      }
      const v = viewRef.current;
      const ddx = (e.clientX - d.sx) / v.s;
      const ddy = (e.clientY - d.sy) / v.s;
      if (d.mode === "move") {
        const off = offOf(d.containerId);
        if (!off) return;
        const cur = store.docRef.current;
        const els = containerEls(cur, d.containerId);
        if (!els) return;
        // 吸附目标：容器内其他元素边/中线；页框容器再加画板边/中线（objects 不比页框，避免全画布两两比较）
        const targetsX: number[] = [];
        const targetsY: number[] = [];
        let bounds: Box | null = null;
        if (d.containerId !== CANVAS_ROOT) {
          const fr = cur.frames.find((f) => f.id === d.containerId);
          if (!fr) return;
          targetsX.push(off.x, off.x + fr.w / 2, off.x + fr.w);
          targetsY.push(off.y, off.y + fr.h / 2, off.y + fr.h);
          bounds = { x: off.x, y: off.y, w: fr.w, h: fr.h };
        }
        const moving = new Set(d.elIds);
        for (const o of els) {
          if (moving.has(o.id)) continue;
          targetsX.push(off.x + o.x, off.x + o.x + o.w / 2, off.x + o.x + o.w);
          targetsY.push(off.y + o.y, off.y + o.y + o.h / 2, off.y + o.y + o.h);
        }
        const th = SNAP_PX / v.s;
        // 移动集合的并盒三候选线（画布空间）
        const ub = unionBox([...d.base.values()].map((b) => ({ ...b, x: b.x + off.x + ddx, y: b.y + off.y + ddy })));
        let sxOff = 0;
        let syOff = 0;
        const lines: SnapLine[] = [];
        if (ub) {
          const candsX = [ub.x, ub.x + ub.w / 2, ub.x + ub.w];
          let best = { d: th, off: 0, at: 0 };
          candsX.forEach((cv) =>
            targetsX.forEach((t) => {
              const dd = Math.abs(cv - t);
              if (dd < best.d) best = { d: dd, off: t - cv, at: t };
            }),
          );
          if (best.d < th) {
            sxOff = best.off;
            const x = best.at;
            const span = bounds ?? { y: ub.y - 60, h: ub.h + 120 };
            lines.push({ x1: x, y1: span.y, x2: x, y2: span.y + span.h });
          }
          const candsY = [ub.y, ub.y + ub.h / 2, ub.y + ub.h];
          let bestY = { d: th, off: 0, at: 0 };
          candsY.forEach((cv) =>
            targetsY.forEach((t) => {
              const dd = Math.abs(cv - t);
              if (dd < bestY.d) bestY = { d: dd, off: t - cv, at: t };
            }),
          );
          if (bestY.d < th) {
            syOff = bestY.off;
            const y = bestY.at;
            const span = bounds ?? { x: ub.x - 60, w: ub.w + 120 };
            lines.push({ x1: span.x, y1: y, x2: span.x + span.w, y2: y });
          }
        }
        // off = 指针累计位移 + 吸附修正（每次从不变的 base 重算，不叠加）
        d.off = { x: Math.round(ddx + sxOff), y: Math.round(ddy + syOff) };
        d.snapLines = lines;
      } else if (d.mode === "resize") {
        d.ghost = resizeBox(d.orig, d.handle, ddx, ddy, e.shiftKey, e.altKey);
      } else if (d.mode === "groupresize") {
        d.next = resizeBox(d.origUnion, d.handle, ddx, ddy, e.shiftKey, e.altKey);
      } else {
        const p = screenToDoc(e.clientX, e.clientY);
        const deg = (Math.atan2(p.y - d.cy, p.x - d.cx) * 180) / Math.PI;
        d.rot = normalizeDeg(snapDeg(d.origRot + (deg - d.startDeg), e.shiftKey));
      }
    };
    const onUp = () => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      setDragTick((t) => t + 1); // 浮条可见性读 dragRef（ref 不触发渲染），拖后补一帧
      if (d.mode === "pen") {
        const PEN_STYLE = { stroke: "#1d1d1f", strokeWidth: 3 };
        const b = drawFromPoints(d.pts, PEN_STYLE);
        if (!b) return; // 单击（<2 采样点）不产生笔迹
        // deck：hitFrame 只认当前页——中心出页则丢弃提示；board：无框可命中，恒落 objects
        const sp = hitFrame(b.x + b.w / 2, b.y + b.h / 2);
        if (sp) {
          const local = b.points.map(([x, y]) => [x + b.x - sp.x, y + b.y - sp.y] as DrawPoint);
          const el = drawFromPoints(local, PEN_STYLE);
          if (el) store.addEl(sp.frame.id, el);
        } else if (surface === "deck") {
          store.notifyLater("手绘笔迹请画在页面内（此笔未保存）");
        } else {
          store.addEl(CANVAS_ROOT, b);
        }
        return;
      }
      if (d.mode === "draw") {
        const dxv = d.x1 - d.x0;
        const dyv = d.y1 - d.y0;
        let x: number, y: number, w: number, h: number;
        let dir: LineDir;
        let cx: number, cy: number;
        if (Math.hypot(dxv, dyv) * viewRef.current.s < 6) {
          // 单击未拖拽：点击处作起点，默认 360×2 横向元素（与旧版插入同尺寸，向后兼容）
          x = Math.round(d.x0);
          y = Math.round(d.y0) - 1;
          w = 360;
          h = 2;
          dir = 0;
          cx = x + 180;
          cy = d.y0;
        } else {
          x = Math.round(Math.min(d.x0, d.x1));
          y = Math.round(Math.min(d.y0, d.y1));
          w = Math.max(1, Math.round(Math.abs(dxv)));
          h = Math.max(1, Math.round(Math.abs(dyv)));
          dir = dxv >= 0 ? (dyv >= 0 ? 0 : 1) : dyv >= 0 ? 3 : 2;
          cx = x + w / 2;
          cy = y + h / 2;
        }
        // deck：hitFrame 只认当前页（中点出页则丢弃提示）；board：恒落 objects。默认色随页背景明暗自适应
        const sp = hitFrame(cx, cy);
        const stroke = isDarkColor(sp?.frame.background) ? "#f5f5f7" : "#1d1d1f";
        const el: ShapeEl = {
          kind: "shape",
          id: uid("s"),
          shape: d.kind,
          x,
          y,
          w,
          h,
          ...(dir ? { dir } : {}),
          stroke,
          strokeWidth: 3,
        };
        if (sp) {
          el.x -= sp.x;
          el.y -= sp.y;
          store.addEl(sp.frame.id, el);
        } else if (surface === "deck") {
          store.notifyLater(`请将${DRAW_LABEL[d.kind]}画在页面内（此次未保存）`);
        } else {
          store.addEl(CANVAS_ROOT, el);
        }
        return;
      }
      if (d.mode === "move") {
        const { off } = d;
        if (off.x === 0 && off.y === 0) return; // 纯点击不产生历史
        const els = containerEls(store.docRef.current, d.containerId);
        if (!els) return;
        const elements: El[] = els.map((el) => {
          const g = d.base.get(el.id);
          return g ? ({ ...el, x: Math.round(g.x + off.x), y: Math.round(g.y + off.y) } as El) : el;
        });
        setContainerElements(d.containerId, elements);
      } else if (d.mode === "resize") {
        const g = d.ghost;
        if (g && (g.x !== d.orig.x || g.y !== d.orig.y || g.w !== d.orig.w || g.h !== d.orig.h))
          updateEl(d.containerId, d.elId, g as Partial<El>);
      } else if (d.mode === "groupresize") {
        if (!d.next) return;
        const scaled = scaleGroup(d.origUnion, d.next, [...d.items].map(([id, box]) => ({ id, box })));
        const els = containerEls(store.docRef.current, d.containerId);
        if (!els) return;
        const elements: El[] = els.map((el) => {
          const b = scaled.get(el.id);
          return b ? ({ ...el, ...b } as El) : el;
        });
        setContainerElements(d.containerId, elements);
      } else if (d.mode === "rotate") {
        if (d.rot !== null && d.rot !== (d.origRot ?? 0)) updateEl(d.containerId, d.elId, { rotation: d.rot } as Partial<El>);
      } else if (d.mode === "marquee") {
        const rect = norm({ x: d.x0, y: d.y0, w: d.x1 - d.x0, h: d.y1 - d.y0 });
        const dragged = Math.hypot(d.x1 - d.x0, d.y1 - d.y0) * viewRef.current.s > MARQUEE_THRESHOLD;
        if (!dragged) return; // 视作普通点击（按下时已做聚焦/清选）
        const cur = store.docRef.current;
        const merge = (containerId: string, hitIds: string[]) => {
          const ids = expandGroup(containerEls(cur, containerId) ?? [], hitIds); // 框选组联动
          if (d.additive && d.baseSel && d.baseSel.containerId === containerId) {
            setSel({ containerId, elIds: [...new Set([...d.baseSel.elIds, ...ids])] });
          } else {
            setSel({ containerId, elIds: ids });
          }
        };
        // 1) board：画布级 objects（顶层）优先，rect 即画布坐标直接比；deck 不选不可见的 objects
        if (surface === "board") {
          const objIds = cur.objects.filter((e) => boxesIntersect(boxOf(e), rect)).map((e) => e.id);
          if (objIds.length > 0) {
            merge(CANVAS_ROOT, objIds);
            return;
          }
        }
        // 2) 页框：起点框优先；画布外起拖取相交面积最大的框
        let p = d.containerId && d.containerId !== CANVAS_ROOT ? posById.get(d.containerId) : undefined;
        if (!p) {
          let bestArea = 0;
          for (const cand of positions) {
            if (!boxesIntersect({ x: cand.x, y: cand.y, w: cand.frame.w, h: cand.frame.h }, rect)) continue;
            const ox = Math.min(cand.x + cand.frame.w, rect.x + rect.w) - Math.max(cand.x, rect.x);
            const oy = Math.min(cand.y + cand.frame.h, rect.y + rect.h) - Math.max(cand.y, rect.y);
            if (ox * oy > bestArea) {
              bestArea = ox * oy;
              p = cand;
            }
          }
        }
        if (!p) {
          if (!d.additive) setSel(null);
          return;
        }
        // 框内元素是局部坐标：把画布 rect 平移进框再比（修旧版漏选 bug）
        const localRect = { x: rect.x - p.x, y: rect.y - p.y, w: rect.w, h: rect.h };
        merge(
          p.frame.id,
          p.frame.elements.filter((e) => boxesIntersect(boxOf(e), localRect)).map((e) => e.id),
        );
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [posById, positions, hitFrame, offOf, setContainerElements, updateEl, screenToDoc, store, surface, startBump]);

  /** 钢笔/画线模式中途关闭（如 Esc）：丢掉未提交的这一笔/这一条 */
  useEffect(() => {
    if (!penMode && dragRef.current?.mode === "pen") dragRef.current = null;
  }, [penMode]);
  useEffect(() => {
    if (!drawTool && dragRef.current?.mode === "draw") dragRef.current = null;
  }, [drawTool]);

  /* ---------- 悬停高亮（无拖拽时；objects 优先） ---------- */

  const onStageHoverMove = (e: ReactMouseEvent) => {
    if (dragRef.current || editingId || penMode) return;
    const { x: dx, y: dy } = screenToDoc(e.clientX, e.clientY);
    const rootEl = surface === "board" ? hitElIn(doc.objects, dx, dy) : undefined;
    if (rootEl) {
      setHoveredId(rootEl.id);
      return;
    }
    const sp = hitFrame(dx, dy);
    const el = sp ? hitElIn(sp.frame.elements, dx - sp.x, dy - sp.y) : undefined;
    setHoveredId(el?.id ?? null);
  };

  /* ---------- 右键命中上报 ---------- */

  const onStageContextMenu = (e: ReactMouseEvent) => {
    const { x: dx, y: dy } = screenToDoc(e.clientX, e.clientY);
    let hit: ContextHit;
    const rootEl = surface === "board" ? hitElIn(doc.objects, dx, dy) : undefined;
    if (rootEl) {
      if (!sel || sel.containerId !== CANVAS_ROOT || !sel.elIds.includes(rootEl.id))
        setSel({ containerId: CANVAS_ROOT, elIds: expandGroup(doc.objects, [rootEl.id]) });
      hit = { kind: "element", containerId: CANVAS_ROOT, el: rootEl };
    } else {
      const sp = hitFrame(dx, dy);
      const el = sp ? hitElIn(sp.frame.elements, dx - sp.x, dy - sp.y) : undefined;
      if (el) {
        if (!sel || sel.containerId !== sp!.frame.id || !sel.elIds.includes(el.id))
          setSel({ containerId: sp!.frame.id, elIds: expandGroup(sp!.frame.elements, [el.id]) });
        hit = { kind: "element", containerId: sp!.frame.id, el };
      } else if (sp) {
        setSel({ containerId: sp.frame.id, elIds: [] });
        hit = { kind: "artboard", containerId: sp.frame.id };
      } else {
        hit = { kind: "canvas" };
      }
    }
    // 不要 preventDefault：让事件冒泡到外层 ContextMenuTrigger（span）由它
    // 记录触发点并自行取消浏览器默认菜单；这里 prevent 只会丢点位
    onContextHit?.(hit);
  };

  /* ---------- 滚轮：捏合缩放 / 普通平移 ---------- */

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = host.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      if (e.ctrlKey || e.metaKey) {
        zoomAt(px, py, Math.exp(-e.deltaY * 0.0015));
      } else if (Math.abs(e.deltaX) > 0 || Math.abs(e.deltaY) > 0) {
        fitIntentRef.current = null; // 用户平移：程序化适配意图失效
        setView((v) => ({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY }));
      }
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, []);

  /* ---------- 空格平移模式（按住=手抓光标） ---------- */

  useEffect(() => {
    /** 输入态不劫持空格：文本框/可编辑区里空格是打字或触发控件 */
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLTextAreaElement ||
      t instanceof HTMLInputElement ||
      (t instanceof HTMLElement && t.isContentEditable);
    const kd = (e: KeyboardEvent) => {
      if (e.code === "Space" && !typing(e.target)) {
        spaceRef.current = true;
        setSpaceCursor(true);
        e.preventDefault();
      }
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceRef.current = false;
        setSpaceCursor(false);
      }
    };
    // 切窗/失焦时不会再收到 keyup，若不复位手抓光标会卡住
    const reset = () => {
      spaceRef.current = false;
      setSpaceCursor(false);
    };
    const onHidden = () => {
      if (document.hidden) reset();
    };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, []);

  /* ---------- 图片落盘 / URL 嵌入（拖入/粘贴；图片核心逻辑在 store.insertImageFromFile） ---------- */

  /** 落点选容器：board 优先命中的页框，否则 objects；deck 恒当前页（夹进页内） */
  const dropContainerAt = (x: number, y: number): { containerId: string; x: number; y: number } => {
    if (surface === "deck") {
      const p = layout.positions[0];
      if (!p) return { containerId: CANVAS_ROOT, x, y };
      return { containerId: p.frame.id, x: Math.min(Math.max(x - p.x, 0), p.frame.w), y: Math.min(Math.max(y - p.y, 0), p.frame.h) };
    }
    const sp = hitFrame(x, y);
    return sp ? { containerId: sp.frame.id, x: x - sp.x, y: y - sp.y } : { containerId: CANVAS_ROOT, x, y };
  };

  /** 在容器落点插一个 embed 元素并选中（贴 URL 即嵌入，Miro/tldraw 式） */
  const insertEmbedAt = useCallback(
    (url: string, at?: { containerId: string; x: number; y: number }) => {
      const pos = at ?? (() => {
        // 无落点（系统粘贴）：视口中心；deck 夹进当前页
        const cx = (hostSize.w / 2 - view.tx) / view.s;
        const cy = (hostSize.h / 2 - view.ty) / view.s;
        return dropContainerAt(cx, cy);
      })();
      const el: EmbedEl = {
        kind: "embed",
        id: uid("em"),
        url,
        x: Math.round(pos.x - 320),
        y: Math.round(pos.y - 200),
        w: 640,
        h: 400,
      };
      setContainerElements(pos.containerId, [...(containerEls(doc, pos.containerId) ?? []), el]);
      setSel({ containerId: pos.containerId, elIds: [el.id] });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setContainerElements, setSel, doc, hostSize, view.tx, view.ty, view.s, surface, layout.positions, hitFrame],
  );

  const firstUrl = (s: string | null | undefined): string | null => {
    if (!s) return null;
    const line = s.split(/\r?\n/).find((l) => /^https?:\/\//i.test(l.trim()));
    return line ? line.trim() : null;
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDropHint(false);
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
      const { x, y } = screenToDoc(e.clientX, e.clientY);
      if (files.length === 0) {
        // 拖入链接（浏览器标签/地址栏拖拽）：text/uri-list 优先
        const url = firstUrl(e.dataTransfer?.getData("text/uri-list")) ?? firstUrl(e.dataTransfer?.getData("text/plain"));
        if (url) insertEmbedAt(url, dropContainerAt(x, y));
        return;
      }
      if (surface === "deck") {
        // deck：落点夹进当前页（root objects 在页视图下不可见）；无页则引导先建页
        const p = layout.positions[0];
        if (!p) {
          store.notifyLater("请先新建一页幻灯片，再拖入图片");
          return;
        }
        for (const f of files)
          void insertImageFromFile(f, {
            containerId: p.frame.id,
            x: Math.min(Math.max(x - p.x, 0), p.frame.w),
            y: Math.min(Math.max(y - p.y, 0), p.frame.h),
          });
        return;
      }
      const sp = hitFrame(x, y); // board：positions 为空 → 恒落 objects（画布坐标即落点）
      for (const f of files)
        void insertImageFromFile(
          f,
          sp ? { containerId: sp.frame.id, x: x - sp.x, y: y - sp.y } : { containerId: CANVAS_ROOT, x, y },
        );
    };
    const onOver = (e: DragEvent) => {
      const types = Array.from(e.dataTransfer?.types ?? []);
      if (types.includes("Files") || types.includes("text/uri-list")) {
        e.preventDefault();
        setDropHint(true);
      }
    };
    const onLeave = () => setDropHint(false);
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (files.length > 0) {
        e.preventDefault();
        for (const f of files) void insertImageFromFile(f);
        return;
      }
      // 剪贴板是 http(s) 链接（画布未聚焦输入框时）→ 贴链接即嵌入
      const text = e.clipboardData?.getData("text/plain");
      if (text && !editingId) {
        const url = firstUrl(text);
        if (url) {
          e.preventDefault();
          insertEmbedAt(url);
        }
      }
    };
    host.addEventListener("drop", onDrop);
    host.addEventListener("dragover", onOver);
    host.addEventListener("dragleave", onLeave);
    document.addEventListener("paste", onPaste);
    return () => {
      host.removeEventListener("drop", onDrop);
      host.removeEventListener("dragover", onOver);
      host.removeEventListener("dragleave", onLeave);
      document.removeEventListener("paste", onPaste);
    };
  }, [insertImageFromFile, hitFrame, screenToDoc, surface, layout.positions, store.notifyLater, insertEmbedAt, editingId]);

  /* ---------- 双击进文本编辑 / embed 交互（objects 与页框内一致） ---------- */

  const onDoubleClick = (e: ReactMouseEvent) => {
    if (penMode) return;
    const { x: dx, y: dy } = screenToDoc(e.clientX, e.clientY);
    const editable = (el: El) =>
      el.kind === "text" || el.kind === "mermaid" || el.kind === "svg" || el.kind === "table" || el.kind === "chart";
    const rootEl = surface === "board" ? hitElIn(doc.objects, dx, dy) : undefined;
    if (rootEl && (editable(rootEl) || rootEl.kind === "embed")) {
      setSel({ containerId: CANVAS_ROOT, elIds: [rootEl.id] });
      if (rootEl.kind === "embed") setEmbedActive(rootEl.id);
      else setEditingId(rootEl.id);
      return;
    }
    const sp = hitFrame(dx, dy);
    const el = sp ? hitElIn(sp.frame.elements, dx - sp.x, dy - sp.y) : undefined;
    if (el && (editable(el) || el.kind === "embed")) {
      setSel({ containerId: sp!.frame.id, elIds: [el.id] });
      if (el.kind === "embed") setEmbedActive(el.id);
      else setEditingId(el.id);
    }
  };

  /* ---------- 渲染 ---------- */

  const v = view;
  const dotSize = v.s < 0.25 ? 0 : v.s < 0.8 ? 12 : 24;
  /** 页框整体聚焦（选中框、无元素） */
  const frameFocused = sel && sel.elIds.length === 0 ? sel.containerId : null;
  const selected = useMemo(() => {
    if (!sel) return [];
    const off = offOf(sel.containerId);
    if (!off) return [];
    const els = containerEls(doc, sel.containerId) ?? [];
    return sel.elIds
      .map((id) => els.find((e) => e.id === id))
      .filter((e): e is El => !!e)
      .map((el) => {
        const b = geo(el);
        return { el, rect: { x: off.x + b.x, y: off.y + b.y, w: b.w, h: b.h } };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, doc, offOf, geo]);

  const groupItems = useMemo(() => {
    const m = new Map<string, Box>();
    if (selected.length > 1) for (const { el, rect } of selected) m.set(el.id, { x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    return m;
  }, [selected]);
  const groupBox = groupItems.size > 0 ? unionBox([...groupItems.values()]) : null;
  const hovered = useMemo(() => {
    if (!hoveredId) return null;
    if (sel?.elIds.includes(hoveredId)) return null;
    const o = doc.objects.find((e) => e.id === hoveredId);
    if (o) return { el: o, rect: boxOf(o) };
    for (const p of positions) {
      const el = p.frame.elements.find((e) => e.id === hoveredId);
      if (el) return { el, rect: { x: p.x + el.x, y: p.y + el.y, w: el.w, h: el.h } };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredId, sel, doc.objects, positions]);

  const marquee = dragRef.current?.mode === "marquee" ? dragRef.current : null;
  const snapLines = dragRef.current?.mode === "move" ? dragRef.current.snapLines : [];

  // 浮动工具条锚点：选中并盒的屏幕坐标（上沿不足空间时翻到下沿）
  const selAnchor = useMemo(() => {
    if (selected.length === 0) return null;
    const u = unionBox(selected.map((s) => s.rect));
    if (!u) return null;
    return {
      cx: (u.x + u.w / 2) * v.s + v.tx,
      top: u.y * v.s + v.ty,
      bottom: (u.y + u.h) * v.s + v.ty,
    };
  }, [selected, v]);

  const editingEl = useMemo(() => {
    if (!editingId || !sel) return null;
    return containerEls(doc, sel.containerId)?.find((e) => e.id === editingId) ?? null;
  }, [editingId, sel, doc]);

  /** 渲染器双轨（挂载时定；切档后刷新页面生效） */
  const renderer = useMemo(readRenderer, []);

  // 外部 ref（Radix ContextMenuTrigger asChild 需要）与内部 hostRef 合并
  const setHost = (node: HTMLDivElement | null) => {
    hostRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) (ref as { current: HTMLDivElement | null }).current = node;
  };

  return (
    <div
      ref={setHost}
      className={[
        surface === "deck" ? "sc-stage sc-stage-deck" : "sc-stage",
        // 空格平移：类名让 CSS 把画布子元素（Leafer canvas 等）的光标一起压住；
        // 平移中（空格或中键起拖）都要"抓紧"手感，不依赖空格状态
        dragRef.current?.mode === "pan" ? "sc-pan-active" : spaceCursor || handMode ? "sc-pan-ready" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        cursor: dragRef.current?.mode === "pan" ? "grabbing" : spaceCursor || handMode ? "grab" : penMode || drawTool ? "crosshair" : "default",
        // 点阵是白板的"无限"暗示；只设 background-image，不重置 .sc-stage
        // 类的 background-color（shorthand 会把底色清成透明，body 底透出）
        backgroundImage:
          dotSize > 0 && surface === "board"
            ? `radial-gradient(circle, var(--sc-dot) 1px, transparent 1px)`
            : undefined,
        backgroundSize:
          dotSize > 0 && surface === "board"
            ? `${dotSize * v.s}px ${dotSize * v.s}px`
            : undefined,
        backgroundPosition: `${v.tx}px ${v.ty}px`,
      }}
      onPointerDown={onStagePointerDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onStageContextMenu}
      onMouseMove={onStageHoverMove}
      onMouseLeave={() => setHoveredId(null)}
    >
      {/* 内容层双轨：dom = CSS transform 里的 DOM 元素；leafer = canvas 场景 +
          钢笔实时笔画仍走 DOM svg（画布坐标，变换层里直描） */}
      {renderer === "leafer" ? (
        <>
          <LeaferStage
            doc={doc}
            surface={surface}
            positions={positions}
            view={v}
            live={liveMap}
            liveContainerId={liveContainerId}
            frameFocused={frameFocused}
          />
          {/* embed DOM 浮层：iframe 进不了 canvas，网页元素在两种轨道下都经此层渲染。
              层自身 pointer-events 关闭；iframe/角标激活时显式 auto。
              事件语义与 DOM 轨一致：双击命中 embed → stage 分发激活。 */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              transform: `translate(${v.tx}px, ${v.ty}px) scale(${v.s})`,
              transformOrigin: "0 0",
              pointerEvents: "none",
            }}
          >
            {positions.map((p) => (
              <div
                key={p.frame.id}
                style={{ position: "absolute", left: p.x, top: p.y, width: p.frame.w, height: p.frame.h, overflow: "hidden" }}
              >
                {p.frame.elements.map((el0) => {
                  if (el0.kind === "embed") {
                    const patch = liveContainerId === p.frame.id ? liveMap.get(el0.id) : undefined;
                    return <EmbedElView key={el0.id} el={patch ? ({ ...el0, ...patch } as EmbedEl) : el0} isLive={!!patch} mode="canvas" />;
                  }
                  // 动画 SVG：canvas 光栅化会冻帧，DOM <img> 才能播——浮层直渲染
                  if (el0.kind === "svg" && isAnimatedSvg(el0.code)) {
                    const patch = liveContainerId === p.frame.id ? liveMap.get(el0.id) : undefined;
                    return <SvgElView key={el0.id} el={patch ? ({ ...el0, ...patch } as SvgEl) : el0} />;
                  }
                  return null;
                })}
              </div>
            ))}
            {surface === "board" &&
              doc.objects.map((el0) => {
                if (el0.kind === "embed") {
                  const patch = liveContainerId === CANVAS_ROOT ? liveMap.get(el0.id) : undefined;
                  return <EmbedElView key={el0.id} el={patch ? ({ ...el0, ...patch } as EmbedEl) : el0} isLive={!!patch} mode="canvas" />;
                }
                if (el0.kind === "svg" && isAnimatedSvg(el0.code)) {
                  const patch = liveContainerId === CANVAS_ROOT ? liveMap.get(el0.id) : undefined;
                  return <SvgElView key={el0.id} el={patch ? ({ ...el0, ...patch } as SvgEl) : el0} />;
                }
                return null;
              })}
          </div>
          {penPreview && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                transform: `translate(${v.tx}px, ${v.ty}px) scale(${v.s})`,
                transformOrigin: "0 0",
                pointerEvents: "none",
              }}
            >
              <svg style={{ position: "absolute", left: 0, top: 0, width: 1, height: 1, overflow: "visible" }}>
                <polyline
                  points={penPreview}
                  fill="none"
                  stroke="#1d1d1f"
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            </div>
          )}
          {drawPreview && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                transform: `translate(${v.tx}px, ${v.ty}px) scale(${v.s})`,
                transformOrigin: "0 0",
                pointerEvents: "none",
              }}
            >
              {drawPreviewSvg}
            </div>
          )}
        </>
      ) : (
        <div
          style={{
            position: "absolute",
            inset: 0,
            transform: `translate(${v.tx}px, ${v.ty}px) scale(${v.s})`,
            transformOrigin: "0 0",
            willChange: "transform",
          }}
        >
          {/* artboard 层：deck 只有当前一页（layout.positions 已过滤）；board 为空 */}
          {positions.map((p) => (
            <div
              key={p.frame.id}
              className={frameFocused === p.frame.id ? "sc-artboard sc-artboard-active" : "sc-artboard"}
              style={{
                position: "absolute",
                left: p.x,
                top: p.y,
                width: p.frame.w,
                height: p.frame.h,
                contentVisibility: "auto",
                containIntrinsicSize: `${p.frame.w}px ${p.frame.h}px`,
              }}
            >
              <SlideView slide={p.frame} live={p.frame.id === liveContainerId ? liveMap : undefined} />
            </div>
          ))}
          {/* objects 层：仅白板模式绘制（deck 不渲染 objects） */}
          {surface === "board" && (
            <div style={{ position: "absolute", left: 0, top: 0 }}>
              {doc.objects.map((el) => {
                const patch = liveContainerId === CANVAS_ROOT ? liveMap.get(el.id) : undefined;
                return <ElView key={el.id} el={patch ? ({ ...el, ...patch } as El) : el} isLive={!!patch} />;
              })}
            </div>
          )}
          {/* 钢笔实时笔画（画布坐标直描；non-scaling-stroke 与提交后渲染一致） */}
          {penPreview && (
            <svg
              style={{ position: "absolute", left: 0, top: 0, width: 1, height: 1, overflow: "visible", pointerEvents: "none" }}
            >
              <polyline
                points={penPreview}
                fill="none"
                stroke="#1d1d1f"
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          )}
          {drawPreviewSvg}
        </div>
      )}

      {/* overlay：屏幕坐标，不受 viewport transform 影响（页框名称标签已随两模式拆分退役） */}
      <div className="sc-overlay">
        {hovered && (
          <div
            className="sc-selbox"
            style={{
              left: hovered.rect.x * v.s + v.tx,
              top: hovered.rect.y * v.s + v.ty,
              width: hovered.rect.w * v.s,
              height: hovered.rect.h * v.s,
              opacity: 0.4,
            }}
          />
        )}
        {selected.map(({ el, rect }) => {
          const l = rect.x * v.s + v.tx;
          const t = rect.y * v.s + v.ty;
          const w = rect.w * v.s;
          const h = rect.h * v.s;
          const single = sel && sel.elIds.length === 1 && el.id === sel.elIds[0];
          return (
            <div key={el.id}>
              <div className="sc-selbox" style={{ left: l, top: t, width: w, height: h }} />
              {/* 画笔/画线工具激活时隐藏手柄：手柄在 overlay 上，pointerdown 不会落到 stage 的绘制分支 */}
              {single && !marquee && !penMode && !drawTool && (
                <>
                  {HANDLES.map((hd, i) => {
                    const { x: hx, y: hy } = handlePos(i, l, t, w, h);
                    return (
                      <div
                        key={i}
                        className="sc-handle"
                        style={{ left: hx - 3.5, top: hy - 3.5, cursor: hd.cursor }}
                        onPointerDown={(e) => onHandlePointerDown(e, sel!.containerId, el, i)}
                      />
                    );
                  })}
                  {/* 旋转手柄：顶边中点上方 */}
                  <div
                    className="sc-rotate-stem"
                    style={{ left: l + w / 2 - 0.5, top: t - 22, width: 1, height: 22 }}
                  />
                  <div
                    className="sc-rotate-handle"
                    style={{ left: l + w / 2 - 4.5, top: t - 26, cursor: "grab" }}
                    onPointerDown={(e) =>
                      onRotatePointerDown(e, sel!.containerId, el, {
                        x: rect.x + rect.w / 2,
                        y: rect.y + rect.h / 2,
                      })
                    }
                  />
                </>
              )}
            </div>
          );
        })}
        {/* 多选组包围盒（虚线 + 8 手柄整体等比缩放） */}
        {selected.length > 1 && groupBox && !marquee && !penMode && !drawTool && (
          <>
            <div
              className="sc-groupbox"
              style={{
                left: groupBox.x * v.s + v.tx,
                top: groupBox.y * v.s + v.ty,
                width: groupBox.w * v.s,
                height: groupBox.h * v.s,
              }}
            />
            {HANDLES.map((hd, i) => {
              const { x: hx, y: hy } = handlePos(
                i,
                groupBox.x * v.s + v.tx,
                groupBox.y * v.s + v.ty,
                groupBox.w * v.s,
                groupBox.h * v.s,
              );
              return (
                <div
                  key={`g${i}`}
                  className="sc-handle"
                  style={{ left: hx - 3.5, top: hy - 3.5, cursor: hd.cursor }}
                  onPointerDown={(e) => onGroupHandlePointerDown(e, sel!.containerId, groupItems, i)}
                />
              );
            })}
          </>
        )}
        {snapLines.map((ln, i) => (
          <div
            key={`snap${i}`}
            className="sc-snappoint"
            style={{
              left: ln.x1 * v.s + v.tx - 1,
              top: ln.y1 * v.s + v.ty - 1,
              width: Math.max(2, (ln.x2 - ln.x1) * v.s),
              height: Math.max(2, (ln.y2 - ln.y1) * v.s),
            }}
          />
        ))}
        {marquee && (
          <div
            className="sc-marquee"
            style={{
              left: Math.min(marquee.x0, marquee.x1) * v.s + v.tx,
              top: Math.min(marquee.y0, marquee.y1) * v.s + v.ty,
              width: Math.abs(marquee.x1 - marquee.x0) * v.s,
              height: Math.abs(marquee.y1 - marquee.y0) * v.s,
            }}
          />
        )}
        {selToolbar && selAnchor && !editingId && !dragRef.current && (
          <div
            className="pointer-events-auto absolute -translate-x-1/2"
            // 浮动条按下不得漏给舞台：舞台 pointerdown 会对按钮下方的页框/元素做
            // 清选/聚焦/起拖，工具条在 click 送达前就被卸载（按钮点击全部落空）。
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
            style={{
              // board 的 Inspector 是浮卡（宽 304 + 右边距 12），压在舞台右侧；
              // 浮动条右限要停在浮卡左侧，否则右半截被面板盖住点不到（面板加宽时这里要跟着改）。
              left: Math.min(Math.max(selAnchor.cx, 190), hostSize.w - 190 - (surface === "board" ? 316 : 0)),
              top: selAnchor.top > 46 ? selAnchor.top - 44 : selAnchor.bottom + 10,
            }}
          >
            {selToolbar}
          </div>
        )}
        {editingId && editingEl?.kind === "table" && sel && offOf(sel.containerId) && (
          <TableEditor
            key={editingId}
            el={editingEl}
            view={v}
            off={offOf(sel.containerId)!}
            onCommit={(p) => updateEl(sel.containerId, editingEl.id, p, true)}
            onClose={() => setEditingId(null)}
          />
        )}
        {editingId && editingEl?.kind === "chart" && sel && offOf(sel.containerId) && (
          <ChartEditor
            key={editingId}
            el={editingEl}
            view={v}
            off={offOf(sel.containerId)!}
            onCommit={(p) => updateEl(sel.containerId, editingEl.id, p, true)}
            onClose={() => setEditingId(null)}
          />
        )}
        {editingId && (
          <TextEditor
            key={editingId}
            el={editingEl}
            view={v}
            off={sel ? offOf(sel.containerId) : null}
            onCommit={(text) => {
              if (sel && editingEl?.kind === "text") {
                const first = editingEl.runs[0] ?? {};
                updateEl(sel.containerId, editingEl.id, {
                  runs: [{ ...structuredClone(first), text }],
                } as Partial<TextEl>);
              } else if (sel && editingEl?.kind === "mermaid") {
                updateEl(sel.containerId, editingEl.id, { code: text });
              }
              setEditingId(null);
            }}
            onCancel={() => setEditingId(null)}
          />
        )}
      </div>
      {dropHint && <div className="sc-drophint">松开以添加图片（自动落盘到资产目录）</div>}
    </div>
  );
};

/* ---------------- 文本/mermaid 就地编辑（表格/图表走 editor/ 下的结构化编辑层） ---------------- */

const TextEditor: FC<{
  el: El | null;
  view: View;
  /** 选择容器的画布偏移（root = {0,0}） */
  off: { x: number; y: number } | null;
  onCommit: (text: string) => void;
  onCancel: () => void;
}> = ({ el, view, off, onCommit, onCancel }) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  /** 等宽编辑：mermaid 源码（表格/图表已拆到 editor/TableEditor・ChartEditor） */
  const isMono = el?.kind === "mermaid";
  const initial =
    el?.kind === "text"
      ? el.runs.map((r) => r.text).join("")
      : el?.kind === "mermaid"
        ? el.code
        : "";
  useEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.focus();
    t.select();
  }, []);
  if (!el || !off) return null;
  if (!isMono && el.kind !== "text") return null;
  const firstRun = el.kind === "text" ? el.runs[0] : undefined;
  return (
    <textarea
      ref={ref}
      className="sc-textedit"
      defaultValue={initial}
      spellCheck={false}
      style={
        isMono
          ? {
              left: (off.x + el.x) * view.s + view.tx,
              top: (off.y + el.y) * view.s + view.ty,
              width: el.w * view.s,
              height: el.h * view.s,
              fontSize: Math.max(9, 13 * view.s),
              lineHeight: 1.5,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              color: "#111",
            }
          : {
              left: (off.x + el.x) * view.s + view.tx,
              top: (off.y + el.y) * view.s + view.ty,
              width: el.w * view.s,
              height: el.h * view.s,
              fontSize: (firstRun?.size ?? 24) * view.s,
              fontWeight: firstRun?.bold ? 700 : undefined,
              fontStyle: firstRun?.italic ? "italic" : undefined,
              color: firstRun?.color ?? "#111827",
              textAlign: el.kind === "text" ? (el.align ?? "left") : undefined,
            }
      }
      onBlur={(e) => onCommit(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onCancel();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onCommit(e.currentTarget.value);
      }}
    />
  );
};
