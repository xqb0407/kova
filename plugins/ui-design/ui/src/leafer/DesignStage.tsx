/**
 * DesignStage：Figma 式画布层（leafer canvas + @leafer-in/editor）。
 *
 * 结构：App（tree=world 场景 / sky=编辑器把手）。world Group 的 transform 与视口
 * view.{tx,ty,s} 同步；场景由 leafer/scene.ts 纯函数构建、按 key diff patch。
 *
 * 交互口径：
 *  - select 工具：editor 全接管（点选/⇧多选/框选/拖动/缩放/旋转/双击进入容器
 *    openInner:'double'）。leafer 的 editable 默认 false，仅节点根组带标记 →
 *    点中任何填充/描边/文字碎片都会爬到节点根（Figma 语义）。
 *  - 手势 END（tree 元素拖动与 sky 把手拖动都冒泡到 App 根）→ 逐目标读
 *    {x,y,scaleX,scaleY,rotation} → ledgerFor 映射回 doc 补丁 → 一次 applyLedger
 *    = 一个 undo 步；DragEvent.END/MoveEvent.END 双发用签名去重。
 *  - 视口：滚轮/触控板平移；⌘/Ctrl+滚轮以光标为锚缩放；空格/中键/抓手工具拖拽平移。
 *  - 创建工具（frame/形状/文字）：DOM 覆盖层拉框预览，松手 createBoxed 落节点。
 *  - 文本就地编辑：双击命中 text 节点 → DOM textarea 覆盖层（此时画布收指针关闭）。
 *    Esc 取消、blur/⌘Enter 提交；提交把草稿压回首个 run 的样式。
 *
 * 吸附参考线/距离标签在 P4 加（挂在 tryCommit 同层的 DragEvent/MoveEvent 监听上）。
 */
import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { App, DragEvent, Ellipse, Group, Image as LeaferImage, Line, MoveEvent, Path, Rect, Text } from "leafer-ui";
import "@leafer-ui/mask";
import { Editor, EditorEvent } from "@leafer-in/editor";
import { findNode, type LineDir, type NodeType } from "../doc";
import { hitAnchor, penPathD, penToNode, type Anchor } from "../pen";
import { uid, type DesignNode } from "../doc";
import {
  SNAP_PX,
  collectSnapBoxes,
  hitPoint,
  linesFromBoxes,
  resolveSnap,
  spacingLabels,
  unionBox,
  worldBoxOf,
  type Box,
  type SpacingLabel,
} from "../geometry";
import { ledgerFor, ledgerSignature, type EditorNodeTransform } from "./ledger";
import { buildPageScene, type MeasureFn, type SceneCtx, type SceneTag } from "./scene";
import { patchTree, type PatchEntry, type PatchNodeObj } from "./patch";
import { ensureAsset, getAssetState, useAssetsVersion } from "./assets";
import { makeMeasure } from "./measure";
import { ContextMenu, canvasMenu, nodeMenu } from "../chrome/ContextMenu";
import type { DesignStore } from "../state";

const ACCENT = "#0d99ff"; // Figma 蓝：选择框/把手/框选/创建预览共用

const TAGS: Record<SceneTag, new (props?: Record<string, unknown>) => unknown> = {
  group: Group,
  rect: Rect,
  ellipse: Ellipse,
  path: Path,
  line: Line,
  image: LeaferImage,
  text: Text,
};


/* ---------------- 场景 patch（按 key diff，命令式保引用稳定；实现在 leafer/patch.ts） ---------------- */

/** leafer 节点的宽松视图（属性走响应式 setter） */
type NodeObj = PatchNodeObj;
type Entry = PatchEntry;

/** 元素根组 key = 节点 id；含 # 的子视觉件不是选择目标（editable:false，编辑器爬不到它们） */
function nodeIdOfKey(key: string): string | null {
  if (!key || key.includes("#")) return null;
  return key;
}

/* ---------------- 键盘事件目标过滤（输入控件内不放全局快捷键） ---------------- */

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true);
}

/* ---------------- 组件 ---------------- */

export const DesignStage: FC<{ store: DesignStore }> = ({ store }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<InstanceType<typeof App> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const worldRef = useRef<NodeObj | null>(null);
  const nodesRef = useRef(new Map<string, Entry>());
  const measureRef = useRef<MeasureFn | null>(null);
  if (!measureRef.current) measureRef.current = makeMeasure();
  // 挂载期闭包只认最新渲染的引用：store 整体走 ref
  const S = useRef(store);
  S.current = store;
  /** 最近一次与 editor 交换过的选择集（回环抑制：SELECT 与 push 共用） */
  const selSyncRef = useRef("");
  /** 文本编辑草稿（editingTextId 变化时从 runs 重灌） */
  const [draft, setDraft] = useState("");
  const draftIdRef = useRef<string | null>(null);
  /** 空格临时平移 */
  const [space, setSpace] = useState(false);
  /** 创建工具拖框（host 屏幕坐标） */
  const [drawRect, setDrawRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** 拖动吸附参考线 + 间距标签（屏幕坐标；null=不显示） */
  const [guides, setGuides] = useState<{ segs: { x1: number; y1: number; x2: number; y2: number; dashed: boolean }[]; labels: { x: number; y: number; text: string }[] } | null>(null);
  /** 拖动手势中的吸附基准（DRAG_START 记录，DRAG 每拍重算，END 清空） */
  const dragSnapRef = useRef<{
    starts: Map<unknown, { x: number; y: number }>;
    box0: Box;
    cand: ReturnType<typeof linesFromBoxes>;
    candBoxes: Box[];
  } | null>(null);
  /** 右键菜单：屏幕坐标 + 种类（置灰图片用；null=关） */
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; kind: "node" | "canvas" } | null>(null);
  /** 最近一次右键的世界坐标（隐藏 input 选完图后落点用；异步回调读它而非 ctxMenu） */
  const ctxPosRef = useRef({ x: 0, y: 0 });
  /** 隐藏的图片文件选择器（"置入图片…"触发 click） */
  const imgInputRef = useRef<HTMLInputElement>(null);

  const { doc, page, view, tool, selIds, editingTextId, docLoaded, fileRel } = store;
  const createMode = tool !== "select" && tool !== "hand";
  const panMode = tool === "hand" || space;
  const panModeRef = useRef(panMode);
  panModeRef.current = panMode;

  const assetsVersion = useAssetsVersion();

  /* ---------------- 挂载：App + world + editor + 手势/滚轮/双击/尺寸 ---------------- */

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // sky 层必须显式请求才存在（App 只建配置点名的层）：Editor 挂 sky = 屏幕空间，
    // 画布缩放时选择框/把手恒定大小；漏了它 app.sky 为 undefined，编辑器根本不进层
    const app = new App({ view: host, tree: { hittable: true }, sky: {} });
    const world = new Group() as unknown as NodeObj;
    app.tree.add(world);
    appRef.current = app;
    worldRef.current = world;

    const editor = new Editor({
      keyEvent: false, // 键盘（删除/撤销/方向键/复制）留在 App 层统一走 store 动作
      openInner: "double", // 双击进入 frame/group（原生 findDeepOne 深选）
      hover: true,
      boxSelect: true, // 空白拖框 = 框选
      stroke: ACCENT,
      strokeWidth: 1,
      pointFill: "#ffffff",
      pointSize: 8,
      pointRadius: 1.5,
      rotateGap: 15, // 旋转 15° 步进吸附（按住 ⌘ 自由转由 editor 自带修饰键逻辑）
      skewable: false, // 文档模型无斜切概念：关掉编辑器斜切把手，避免回写丢 skew
      // 缩放把手写 scaleX/scaleY 而非烘焙子元素矩阵：默认 'size' 模式下
      // @leafer-in/resize 对 Group 走 scaleResizeGroup（逐子 transform），
      // 既绕过 ledger 的 scale 回写（缩放丢失），又污染 dashPattern 曲线缓存（描边错位）
      editSize: "scale",
      area: { fill: "rgba(13, 153, 255, 0.08)", stroke: ACCENT, strokeWidth: 1 },
    });
    // sky = 屏幕空间层：画布缩放时把手恒定大小
    app.sky?.add(editor);
    editorRef.current = editor;
    // 开发态探针：window 上暴露 leafer 实例，供自动化脚本/控制台直查场景图
    (window as unknown as Record<string, unknown>).__designLeafer = { app, editor, nodes: nodesRef.current };

    const nodeIdOfNode = (node: object): string | null => {
      for (const [key, ent] of nodesRef.current) if (ent.node === node) return nodeIdOfKey(key);
      return null;
    };

    editor.on(EditorEvent.SELECT, (e: EditorEvent) => {
      if (S.current.editingTextId) return; // 文本编辑中画布已关，忽略残余事件
      const ids: string[] = [];
      for (const t of e.list) {
        const id = t ? nodeIdOfNode(t as unknown as object) : null;
        if (id) ids.push(id);
      }
      selSyncRef.current = ids.join(",");
      S.current.setSel(ids);
    });

    // 几何回写：拖动中 editor 只动节点、零提交；END 把节点终值经 ledger 映射回 doc。
    // DragEvent.END（tree 拖动）与 MoveEvent.END（sky 把手）同一手势可能双发 → 签名去重。
    const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
    let lastSig = "";
    const tryCommit = () => {
      const patches: { id: string; patch: Record<string, unknown> }[] = [];
      for (const t of editor.list) {
        const id = t ? nodeIdOfNode(t as unknown as object) : null;
        if (!id) continue;
        const loc = findNode(S.current.docRef.current, id);
        if (!loc) continue;
        const n = t as unknown as NodeObj;
        const tr: EditorNodeTransform = {
          x: num(n.x),
          y: num(n.y),
          scaleX: num(n.scaleX, 1),
          scaleY: num(n.scaleY, 1),
          rotation: num(n.rotation),
        };
        const p = ledgerFor(loc.node, tr);
        if (p) patches.push({ id, patch: p.patch });
      }
      if (patches.length === 0) return;
      const sig = ledgerSignature(patches);
      if (sig === lastSig) return;
      lastSig = sig;
      S.current.applyLedger(patches);
    };
    app.on(DragEvent.END, tryCommit);
    app.on(MoveEvent.END, tryCommit);

    /* ---- 拖动智能吸附：START 记基准 → DRAG 每拍求修正并画参考线/间距 → END 清理。
     * leafer 拖拽每拍按"起点+总位移"写绝对坐标，我们的 snap 偏移每拍重加、不会累积。 ---- */
    const findRootOf = (target: unknown): unknown | null => {
      let cur = target as (NodeObj & { parent?: unknown }) | null;
      while (cur) {
        if (editor.list.includes(cur as never)) return cur;
        cur = (cur.parent ?? null) as typeof cur;
      }
      return null;
    };
    app.on(DragEvent.START, (ev) => {
      const st = S.current;
      const root = findRootOf((ev as unknown as { target: unknown }).target);
      if (st.tool !== "select" || !root || editor.list.length === 0) {
        dragSnapRef.current = null;
        setGuides(null);
        return;
      }
      const ids = new Set<string>();
      const starts = new Map<unknown, { x: number; y: number }>();
      const boxes: Box[] = [];
      for (const n of editor.list) {
        const id = n ? nodeIdOfNode(n as unknown as object) : null;
        if (!id) continue;
        ids.add(id);
        const nn = n as unknown as NodeObj;
        starts.set(n, { x: num(nn.x), y: num(nn.y) });
        const wb = worldBoxOf(st.docRef.current, id);
        if (wb) boxes.push(wb);
      }
      const box0 = unionBox(boxes);
      if (!box0 || ids.size === 0) {
        dragSnapRef.current = null;
        return;
      }
      const candBoxes = collectSnapBoxes(st.docRef.current, st.page, ids);
      dragSnapRef.current = { starts, box0, cand: linesFromBoxes(candBoxes), candBoxes };
    });
    app.on(DragEvent.DRAG, () => {
      const ds = dragSnapRef.current;
      if (!ds) return;
      const st = S.current;
      const { s, tx, ty } = st.view;
      let dx = 0;
      let dy = 0;
      let found = false;
      for (const n of editor.list) {
        const sp = ds.starts.get(n);
        if (!sp) continue;
        const nn = n as unknown as NodeObj;
        dx = num(nn.x) - sp.x;
        dy = num(nn.y) - sp.y;
        found = true;
        break;
      }
      if (!found) return;
      const raw: Box = { x: ds.box0.x + dx, y: ds.box0.y + dy, w: ds.box0.w, h: ds.box0.h };
      const res = resolveSnap(raw, ds.cand, SNAP_PX / s);
      if (res.dx !== 0 || res.dy !== 0) {
        for (const n of editor.list) {
          const sp = ds.starts.get(n);
          if (!sp) continue;
          const nn = n as unknown as NodeObj;
          nn.x = sp.x + dx + res.dx;
          nn.y = sp.y + dy + res.dy;
        }
      }
      const moved: Box = { ...raw, x: raw.x + res.dx, y: raw.y + res.dy };
      const alignSegs = [
        ...res.vLines.map((l) => ({ x1: l.at * s + tx, y1: l.a * s + ty, x2: l.at * s + tx, y2: l.b * s + ty, dashed: false })),
        ...res.hLines.map((l) => ({ x1: l.a * s + tx, y1: l.at * s + ty, x2: l.b * s + tx, y2: l.at * s + ty, dashed: false })),
      ];
      const sp = spacingLabels(moved, ds.candBoxes, 240 / s);
      const gapSegs = sp.map((l) => ({ x1: l.x1 * s + tx, y1: l.y1 * s + ty, x2: l.x2 * s + tx, y2: l.y2 * s + ty, dashed: true }));
      const labels = sp.map((l) => ({ x: ((l.x1 + l.x2) / 2) * s + tx, y: ((l.y1 + l.y2) / 2) * s + ty, text: l.text }));
      const segs = [...alignSegs, ...gapSegs];
      setGuides(segs.length || labels.length ? { segs, labels } : null);
    });
    app.on(DragEvent.END, () => {
      dragSnapRef.current = null;
      setGuides(null);
    });

    // 双击文本 → 就地编辑（DOM overlay）。画布坐标系：screen = world·s + (tx,ty)
    const onDblClick = (ev: MouseEvent) => {
      const st = S.current;
      if (st.tool !== "select") return;
      const d = st.docRef.current;
      const pg = (d.pages.find((p) => p.id === d.activePage) ?? d.pages[0])!;
      const r = host.getBoundingClientRect();
      const wx = (ev.clientX - r.left - st.view.tx) / st.view.s;
      const wy = (ev.clientY - r.top - st.view.ty) / st.view.s;
      const hit = hitPoint(d, pg, { x: wx, y: wy });
      if (!hit) return;
      const loc = findNode(d, hit);
      if (loc && loc.node.type === "text" && !loc.node.locked) {
        st.setSel([hit]);
        st.setEditingTextId(hit);
      }
    };
    host.addEventListener("dblclick", onDblClick);

    // 视口：滚轮/触控板平移；⌘/Ctrl+滚轮以光标为锚缩放（触控板捏合即 ctrlKey）
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const st = S.current;
      const r = host.getBoundingClientRect();
      if (ev.ctrlKey || ev.metaKey) {
        st.zoomAt(Math.exp(-ev.deltaY * 0.0015), ev.clientX - r.left, ev.clientY - r.top);
      } else {
        const k = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 100 : 1;
        let dx = ev.deltaX * k;
        let dy = ev.deltaY * k;
        if (ev.shiftKey && dx === 0) {
          dx = dy;
          dy = 0;
        }
        st.setView((prev) => ({ ...prev, tx: prev.tx - dx, ty: prev.ty - dy }));
      }
    };
    host.addEventListener("wheel", onWheel, { passive: false });

    // 平移手势：空格/抓手工具左键、任意模式滚轮中键（此时 canvas hittable 已关/不响应中键）
    let pan: { x: number; y: number } | null = null;
    const onPointerDown = (ev: PointerEvent) => {
      if (!(panModeRef.current && ev.button === 0) && ev.button !== 1) return;
      ev.preventDefault();
      pan = { x: ev.clientX, y: ev.clientY };
      host.setPointerCapture(ev.pointerId);
    };
    const onPointerMove = (ev: PointerEvent) => {
      if (!pan) return;
      const dx = ev.clientX - pan.x;
      const dy = ev.clientY - pan.y;
      pan = { x: ev.clientX, y: ev.clientY };
      S.current.setView((prev) => ({ ...prev, tx: prev.tx + dx, ty: prev.ty + dy }));
    };
    const onPointerUp = (ev: PointerEvent) => {
      if (!pan) return;
      pan = null;
      try {
        host.releasePointerCapture(ev.pointerId);
      } catch {}
    };
    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerup", onPointerUp);
    host.addEventListener("pointercancel", onPointerUp);

    // 右键：命中节点（未在选中集则先改选）开节点菜单，空白开画布菜单。
    // 条目在渲染时按最新 store 现算，这里只记坐标与种类（闭包里的 selIds 会过期）
    const onContextMenu = (ev: MouseEvent) => {
      ev.preventDefault();
      const st = S.current;
      if (st.editingTextId) return;
      const d = st.docRef.current;
      const pg = (d.pages.find((p) => p.id === d.activePage) ?? d.pages[0])!;
      const r = host.getBoundingClientRect();
      const wx = (ev.clientX - r.left - st.view.tx) / st.view.s;
      const wy = (ev.clientY - r.top - st.view.ty) / st.view.s;
      const hit = hitPoint(d, pg, { x: wx, y: wy });
      if (hit && !st.selIds.includes(hit)) st.setSel([hit]);
      ctxPosRef.current = { x: wx, y: wy };
      setCtxMenu({ x: ev.clientX, y: ev.clientY, kind: hit ? "node" : "canvas" });
    };
    host.addEventListener("contextmenu", onContextMenu);

    // 视口尺寸上报（fitView/zoomTo 锚点用）
    const ro = new ResizeObserver(() => S.current.setViewportSize(host.clientWidth, host.clientHeight));
    ro.observe(host);
    S.current.setViewportSize(host.clientWidth, host.clientHeight);

    return () => {
      ro.disconnect();
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("dblclick", onDblClick);
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("pointercancel", onPointerUp);
      host.removeEventListener("contextmenu", onContextMenu);
      editor.destroy();
      app.destroy();
      worldRef.current = null;
      appRef.current = null;
      editorRef.current = null;
      nodesRef.current.clear();
    };
  }, []);

  // dev 探针：E2E 脚本读编辑器实时状态用（仅 DEV，生产零暴露）
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as NodeObj).__designProbe = () => ({
      sel: S.current.selIds,
      view: S.current.view,
      tool: S.current.tool,
      editor: editorRef.current,
      app: appRef.current,
      nodes: nodesRef.current,
    });
    return () => {
      delete (window as unknown as NodeObj).__designProbe;
    };
  }, []);

  /* ---------------- 空格临时平移 ---------------- */

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !isTypingTarget(e.target)) {
        e.preventDefault();
        setSpace(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpace(false);
    };
    const blur = () => setSpace(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  /* ---------------- 工具模式 → 画布命中/编辑器可见性 ---------------- */

  useEffect(() => {
    const app = appRef.current;
    if (!app) return;
    const ed = editorRef.current;
    const canvasActive = tool === "select" && !editingTextId && !space;
    (app as unknown as NodeObj).hittable = canvasActive;
    if (ed) (ed as unknown as NodeObj).visible = tool === "select" && !editingTextId;
  }, [tool, editingTextId, space]);

  /* ---------------- 场景构建 + patch + 视口同步 ---------------- */

  const scene = useMemo(() => {
    const ctx: SceneCtx = {
      measure: measureRef.current!,
      asset: (path) => {
        ensureAsset(path);
        const st = getAssetState(path);
        if (!st || st.status === "loading") return { status: "loading" };
        return st.url ? { status: "ready", url: st.url } : { status: "missing" };
      },
      // 实例 live 解析要全档：依赖必须含 doc——改主档只动 doc.components、不动页引用，
      // 只依赖 page 的话实例不会重绘
      doc,
    };
    return buildPageScene(page, ctx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, assetsVersion, doc]);

  // 视口变换独立 effect：平移/缩放只动 world，不重跑场景 patch。
  // ⚠️ 编辑器选框在独立图层、不随 world 平移——视口变化后必须刷新选中框。
  //    且多选的大框不是画在节点上，而是画在 editor.simulateTarget 上：
  //    它是选中瞬间对目标并集包围盒的快照，ed.update() 只按快照重摆、框会漂；
  //    必须 updateEditBox()（多选时先 simulate() 重新量快照再 update）。headless 实测过。
  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    world.x = view.tx;
    world.y = view.ty;
    world.scaleX = view.s;
    world.scaleY = view.s;
    editorRef.current?.updateEditBox();
  }, [view.tx, view.ty, view.s]);

  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    const map = nodesRef.current;
    const seen = new Set<string>();
    patchTree(world, scene, map, seen, TAGS as unknown as Record<SceneTag, new () => PatchNodeObj>);
    for (const [key, ent] of map) {
      if (!seen.has(key)) {
        ent.node.remove?.();
        map.delete(key);
      }
    }
    // 提交/undo/删节点后节点引用可能更换：把 editor 选中集裁剪到存活节点并刷新把手
    const ed = editorRef.current;
    if (ed) {
      const mounted = new Set<unknown>();
      for (const ent of map.values()) mounted.add(ent.node);
      const list = ed.list as unknown[];
      if (list.length) {
        const alive = list.filter((n) => mounted.has(n));
        // select/cancel 内部 waitLeafer→updateEditTool 自己会刷新把手；
        // 同帧再调 ed.update() 会踩 editing:true 但 editTool:null 的空窗崩溃
        if (alive.length === 0) ed.cancel();
        else if (alive.length !== list.length) ed.select(alive as Parameters<typeof ed.select>[0]);
        else ed.updateEditBox(); // 多选大框按快照摆位，update() 不重量快照（见视口 effect 注释）
      }
    }
  }, [scene]);

  /* ---------------- 选择集外部驱动同步（图层面板点选/undo 清选等） ---------------- */

  const selKey = selIds.join(",");
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (selKey === selSyncRef.current) return;
    selSyncRef.current = selKey;
    const targets = selIds.map((id) => nodesRef.current.get(id)?.node).filter((n): n is NodeObj => !!n);
    if (targets.length === 0) ed.cancel();
    else ed.select(targets as unknown as Parameters<typeof ed.select>[0]);
    // 不在此处 ed.update()：select/cancel 的编辑工具装载走 waitLeafer 异步收尾，
    // 同帧 update() 会命中 editTool 尚未 reload 的空窗（leafer 2.2.11 内部直接崩）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, scene]);

  /* ---------------- 首开自动适配视口（每个文档一次） ---------------- */

  const fitKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!docLoaded) return;
    const key = fileRel ?? "local";
    if (fitKeyRef.current === key) return;
    fitKeyRef.current = key;
    const raf = requestAnimationFrame(() => store.fitView());
    return () => cancelAnimationFrame(raf);
  }, [docLoaded, fileRel, store]);

  /* ---------------- 文本就地编辑（DOM overlay） ---------------- */

  const editingNode = useMemo(() => {
    if (!editingTextId) return null;
    const loc = findNode(doc, editingTextId);
    return loc && loc.node.type === "text" ? loc.node : null;
  }, [editingTextId, doc]);
  // id 变了就从 runs 重灌草稿；节点没了（被删/undo）就关掉编辑态
  useEffect(() => {
    if (draftIdRef.current === editingTextId) return;
    draftIdRef.current = editingTextId;
    if (editingTextId) setDraft(editingNode ? editingNode.runs.map((r) => r.text).join("") : "");
  }, [editingTextId, editingNode]);
  useEffect(() => {
    if (editingTextId && !editingNode) store.setEditingTextId(null);
  }, [editingTextId, editingNode, store]);

  const commitText = () => {
    if (editingTextId && editingNode) {
      const base = editingNode.runs[0];
      store.setTextRuns(editingTextId, [
        {
          text: draft,
          ...(base?.color ? { color: base.color } : {}),
          ...(base?.size ? { size: base.size } : {}),
          ...(base?.weight ? { weight: base.weight } : {}),
          ...(base?.italic ? { italic: true } : {}),
          ...(base?.underline ? { underline: true } : {}),
          ...(base?.font ? { font: base.font } : {}),
        },
      ]);
    }
    store.setEditingTextId(null);
  };

  let tbox: { left: number; top: number; width: number; height: number } | null = null;
  if (editingNode && editingTextId) {
    const wb = worldBoxOf(doc, editingTextId);
    if (wb) {
      tbox = {
        left: wb.x * view.s + view.tx,
        top: wb.y * view.s + view.ty,
        width: Math.max(40, wb.w * view.s),
        height: Math.max(24, wb.h * view.s),
      };
    }
  }

  /* ---------------- 创建工具拖框 ---------------- */

  const creationStart = (ev: React.PointerEvent) => {
    const r = hostRef.current!.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    setDrawRect({ x0: x, y0: y, x1: x, y1: y });
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
  };
  const creationMove = (ev: React.PointerEvent) => {
    if (!drawRect) return;
    const r = hostRef.current!.getBoundingClientRect();
    let x1 = ev.clientX - r.left;
    let y1 = ev.clientY - r.top;
    if (ev.shiftKey && tool !== "text") {
      const dx = x1 - drawRect.x0;
      const dy = y1 - drawRect.y0;
      if (tool === "line" || tool === "arrow") {
        // 45° 步进锁向
        const step = Math.PI / 4;
        const a = Math.round(Math.atan2(dy, dx) / step) * step;
        const len = Math.hypot(dx, dy);
        x1 = drawRect.x0 + Math.cos(a) * len;
        y1 = drawRect.y0 + Math.sin(a) * len;
      } else {
        // 正方约束（形状/画板）
        const side = Math.max(Math.abs(dx), Math.abs(dy));
        x1 = drawRect.x0 + (dx < 0 ? -side : side);
        y1 = drawRect.y0 + (dy < 0 ? -side : side);
      }
    }
    setDrawRect({ ...drawRect, x1, y1 });
  };
  const creationEnd = () => {
    const st = S.current;
    const rect = drawRect;
    setDrawRect(null);
    if (!rect) return;
    const wx = (sx: number) => (sx - st.view.tx) / st.view.s;
    const wy = (sy: number) => (sy - st.view.ty) / st.view.s;
    let box = {
      x: wx(Math.min(rect.x0, rect.x1)),
      y: wy(Math.min(rect.y0, rect.y1)),
      w: wx(Math.max(rect.x0, rect.x1)) - wx(Math.min(rect.x0, rect.x1)),
      h: wy(Math.max(rect.y0, rect.y1)) - wy(Math.min(rect.y0, rect.y1)),
    };
    if (tool === "text") {
      if (box.w < 8) box = { x: box.x, y: box.y, w: 160, h: 24 }; // 点击即建默认文本框
    } else if (box.w < 3 || box.h < 3) {
      return; // 误点忽略（形状需要拉框）
    }
    let dir: LineDir | undefined;
    if (tool === "line" || tool === "arrow") {
      const rdx = rect.x1 - rect.x0;
      const rdy = rect.y1 - rect.y0;
      dir = rdy <= 0 ? (rdx >= 0 ? 1 : 2) : rdx >= 0 ? 0 : 3; // 0↘ 1 2↖ 3↙
    }
    const id = st.createBoxed(tool as NodeType | "frame", box, undefined, dir);
    if (tool === "text") st.setEditingTextId(id);
  };

  /* ---------------- 钢笔工具：点=直角锚 · 按拖=平滑柄 · 点首锚闭合 · Enter 收笔 ---------------- */

  type PenDraft = { pts: Anchor[]; closed: boolean; cur: [number, number] | null; down: boolean };
  const [pen, setPen] = useState<PenDraft | null>(null);
  const penRef = useRef<PenDraft | null>(null);
  penRef.current = pen;

  const penWorld = (ev: React.PointerEvent): [number, number] => {
    const st = S.current;
    const r = hostRef.current!.getBoundingClientRect();
    // 读渲染端真值（leafer world 实时变换）：滚轮缩放/平移后 store view 与画面存在
    // 一帧级不同步窗口，落点必须跟随"看得见的"世界，而不是状态里的 view
    const w = worldRef.current;
    const s = w && typeof w.scaleX === "number" ? (w.scaleX as number) : st.view.s;
    const ox = w && typeof w.x === "number" ? (w.x as number) : st.view.tx;
    const oy = w && typeof w.y === "number" ? (w.y as number) : st.view.ty;
    return [(ev.clientX - r.left - ox) / s, (ev.clientY - r.top - oy) / s];
  };

  /** 当前渲染缩放（worldRef 真值）：所有按屏幕像素计的命中/阈值判定都用它换算 */
  const penS = () => {
    const w = worldRef.current;
    return w && typeof w.scaleX === "number" ? (w.scaleX as number) : S.current.view.s;
  };

  /** 收笔落 vector 节点（≥2 锚才落；单次 addNode = 一步可撤销） */
  const penCommit = (draft: { pts: Anchor[]; closed: boolean }) => {
    const st = S.current;
    setPen(null);
    if (draft.pts.length < 2) return;
    const { x, y, w, h, path } = penToNode(draft.pts, draft.closed);
    // 闭合成形 → 形状语义（Figma 同款默认灰填充，不带描边）；开放线稿 → 描边
    st.addNode({
      id: uid("v"), type: "vector", name: "钢笔",
      x, y, w, h, path,
      fills: draft.closed ? [{ type: "solid", color: "#d9d9d9" }] : [],
      strokes: draft.closed ? [] : [{ color: "#111111", width: 2 }],
    } as DesignNode);
  };
  const penFinish = () => {
    const draft = penRef.current;
    if (draft) penCommit(draft);
  };

  const penDown = (ev: React.PointerEvent) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const p = penWorld(ev);
    setPen((prev) => {
      if (!prev) return { pts: [{ p }], closed: false, cur: p, down: true };
      // 点中首锚（8px 屏幕半径）→ 闭合成形收笔
      if (prev.pts.length >= 3 && hitAnchor(prev.pts, p, 8 / penS()) === 0) {
        // setPen 内不能依赖 penRef 新值 → 微任务延后收笔（closedDraft 立即定格）
        const closedDraft = { pts: prev.pts, closed: true };
        setTimeout(() => penCommit(closedDraft), 0);
        return { ...prev, closed: true, cur: null, down: false };
      }
      return { pts: [...prev.pts, { p }], closed: false, cur: p, down: true };
    });
  };

  const penMove = (ev: React.PointerEvent) => {
    const p = penWorld(ev);
    setPen((prev) => {
      if (!prev) return prev;
      const pts = prev.pts.slice();
      // 按住拖 = 给刚落的锚拉平滑柄（出柄 = 拖点 − 锚，入柄镜像）
      if (prev.down && pts.length > 0 && (ev.buttons & 1) === 1) {
        const last = pts[pts.length - 1]!;
        const hout: [number, number] = [p[0] - last.p[0], p[1] - last.p[1]];
        if (Math.hypot(hout[0], hout[1]) * penS() > 2) {
          pts[pts.length - 1] = { ...last, hout, hin: [-hout[0], -hout[1]] };
        }
      }
      return { ...prev, pts, cur: p };
    });
  };

  const penUp = () => {
    setPen((prev) => (prev ? { ...prev, down: false } : null));
  };

  // Enter 收笔 / Esc 取消 / Backspace 撤上一锚（capture 抢在 App 热键前）
  useEffect(() => {
    if (!pen) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        penFinish();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setPen(null);
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        e.stopPropagation();
        setPen((prev) => (prev ? { ...prev, pts: prev.pts.slice(0, -1) } : null));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pen !== null]);

  /* ---------------- 文件拖放导入 ---------------- */

  const onDragOverFiles = (ev: React.DragEvent) => {
    if (ev.dataTransfer.types.includes("Files")) ev.preventDefault();
  };
  const onDropFiles = (ev: React.DragEvent) => {
    const files = [...ev.dataTransfer.files];
    if (files.length === 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const st = S.current;
    const r = hostRef.current?.getBoundingClientRect();
    const at = r
      ? { x: (ev.clientX - r.left - st.view.tx) / st.view.s, y: (ev.clientY - r.top - st.view.ty) / st.view.s }
      : undefined;
    void st.importFiles(files, at);
  };

  /* ---------------- 渲染 ---------------- */

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }} onDragOver={onDragOverFiles} onDrop={onDropFiles}>
      <div
        ref={hostRef}
        style={{ position: "absolute", inset: 0, cursor: panMode ? "grab" : createMode ? "crosshair" : "default" }}
      />
      {createMode && tool !== "pen" && (
        <div
          style={{ position: "absolute", inset: 0, cursor: "crosshair", touchAction: "none" }}
          onPointerDown={creationStart}
          onPointerMove={creationMove}
          onPointerUp={creationEnd}
          onPointerCancel={() => setDrawRect(null)}
        />
      )}
      {tool === "pen" && (() => {
        // 预览整层是屏幕坐标：路径必须跟锚点方块/橡皮筋同款换算
        // （直接输出世界坐标 = 视口非恒等时线段与落点整体偏移）
        const w = worldRef.current;
        const s = w && typeof w.scaleX === "number" ? (w.scaleX as number) : S.current.view.s;
        const tx = w && typeof w.x === "number" ? (w.x as number) : S.current.view.tx;
        const ty = w && typeof w.y === "number" ? (w.y as number) : S.current.view.ty;
        const sx = (v: number) => v * s + tx;
        const sy = (v: number) => v * s + ty;
        const toScr = (a: Anchor): Anchor => ({
          p: [sx(a.p[0]), sy(a.p[1])] as [number, number],
          ...(a.hin ? { hin: [a.hin[0] * s, a.hin[1] * s] as [number, number] } : {}),
          ...(a.hout ? { hout: [a.hout[0] * s, a.hout[1] * s] as [number, number] } : {}),
        });
        const cur = pen?.cur ?? null;
        // PS 式回路悬浮：游标悬进首锚屏幕 8px 半径（且 ≥3 锚）→ 显示"点下即闭合成形"的原型
        const closing = pen !== null && !pen.closed && cur !== null && pen.pts.length >= 3 && hitAnchor(pen.pts, cur, 8 / s) === 0;
        const firstX = pen && pen.pts.length ? sx(pen.pts[0]!.p[0]) : 0;
        const firstY = pen && pen.pts.length ? sy(pen.pts[0]!.p[1]) : 0;
        return (
          <div
            data-pen-overlay=""
            style={{ position: "absolute", inset: 0, cursor: closing ? "cell" : "crosshair", touchAction: "none" }}
            onPointerDown={penDown}
            onPointerMove={penMove}
            onPointerUp={penUp}
            onDoubleClick={() => penFinish()}
            onPointerLeave={() => setPen((prev) => (prev ? { ...prev, cur: null, down: false } : null))}
          >
            {pen && pen.pts.length > 0 && (() => {
              const d = penPathD({ pts: pen.pts.map(toScr), closed: pen.closed });
              const last = pen.pts[pen.pts.length - 1]!;
              const rubber = !pen.closed && cur ? `M ${sx(last.p[0])} ${sy(last.p[1])} L ${sx(cur[0])} ${sy(cur[1])}` : "";
              // 成形悬浮预览：锚点 + 游标按闭合对待的面（随光标实时变形）
              const closeD = closing && cur ? penPathD({ pts: [...pen.pts.map(toScr), { p: [sx(cur[0]), sy(cur[1])] }], closed: true }) : "";
              return (
                <svg width="100%" height="100%" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                  {closeD !== "" && <path data-pen-preview="close" d={closeD} fill="rgba(13, 153, 255, 0.12)" stroke="none" />}
                  <path data-pen-preview="line" d={d} fill="none" stroke="#0d99ff" strokeWidth={1.5} />
                  {rubber && <path d={rubber} fill="none" stroke="#0d99ff" strokeWidth={1} strokeDasharray="4 3" opacity={0.7} />}
                  {pen.pts.map((a, i) => (
                    <rect key={i} x={sx(a.p[0]) - 3.5} y={sy(a.p[1]) - 3.5} width={7} height={7}
                      fill={i === 0 && pen.pts.length >= 3 ? "#ffffff" : "#0d99ff"}
                      stroke="#0d99ff" strokeWidth={1} />
                  ))}
                  {cur && !pen.closed && !closing && (
                    <rect x={firstX - 4.5} y={firstY - 4.5} width={9} height={9} fill="none" stroke="#0d99ff" strokeWidth={1.5} />
                  )}
                  {closing && (
                    <g data-pen-preview="target">
                      <circle cx={firstX} cy={firstY} r={8} fill="none" stroke="#0d99ff" strokeWidth={1.5} />
                      <circle cx={firstX} cy={firstY} r={2.5} fill="#0d99ff" />
                    </g>
                  )}
                </svg>
              );
            })()}
          </div>
        );
      })()}
      {createMode && drawRect && (
        <div
          style={{
            position: "absolute",
            left: Math.min(drawRect.x0, drawRect.x1),
            top: Math.min(drawRect.y0, drawRect.y1),
            width: Math.abs(drawRect.x1 - drawRect.x0),
            height: Math.abs(drawRect.y1 - drawRect.y0),
            border: `1px solid ${ACCENT}`,
            background: "rgba(13, 153, 255, 0.06)",
            pointerEvents: "none",
          }}
        />
      )}
      {guides && (
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}>
          <svg width="100%" height="100%" style={{ position: "absolute", inset: 0 }}>
            {guides.segs.map((sg, i) => (
              <line
                key={i}
                x1={sg.x1}
                y1={sg.y1}
                x2={sg.x2}
                y2={sg.y2}
                stroke="#fd4cff"
                strokeWidth={1}
                strokeDasharray={sg.dashed ? "3 3" : undefined}
                opacity={sg.dashed ? 0.75 : 1}
              />
            ))}
          </svg>
          {guides.labels.map((lb, i) => (
            <span
              key={i}
              style={{
                position: "absolute",
                left: lb.x,
                top: lb.y,
                transform: "translate(-50%,-50%)",
                background: "#fd4cff",
                color: "#fff",
                fontSize: 10,
                lineHeight: "14px",
                padding: "0 4px",
                borderRadius: 4,
                whiteSpace: "nowrap",
              }}
            >
              {lb.text}
            </span>
          ))}
        </div>
      )}
      {editingNode && tbox && (
        <div style={{ position: "absolute", inset: 0 }} onPointerDown={() => commitText()}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={() => commitText()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                store.setEditingTextId(null);
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commitText();
              }
              e.stopPropagation(); // 编辑期按键不外逃（全局快捷键挂在 App 层）
            }}
            autoFocus
            style={{
              position: "absolute",
              left: tbox.left,
              top: tbox.top,
              width: tbox.width,
              height: tbox.height,
              border: `1px solid ${ACCENT}`,
              outline: "none",
              resize: "none",
              padding: 2,
              margin: 0,
              background: "transparent",
              overflow: "hidden",
              fontSize: (editingNode.runs[0]?.size ?? 14) * view.s,
              fontFamily: editingNode.runs[0]?.font,
              fontWeight: (editingNode.runs[0]?.weight ?? 400) >= 600 ? 700 : 400,
              fontStyle: editingNode.runs[0]?.italic ? "italic" : "normal",
              color: editingNode.runs[0]?.color ?? "#111111",
              textAlign: editingNode.align ?? "left",
              lineHeight: editingNode.lineHeight ?? 1.4,
              letterSpacing: editingNode.letterSpacing ? editingNode.letterSpacing * view.s : undefined,
            }}
          />
        </div>
      )}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenu.kind === "node" ? nodeMenu(store, store.selIds) : canvasMenu(store, () => imgInputRef.current?.click())}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {/* 隐藏图片选择器：canvasMenu「置入图片…→ insertImageFile(右键处) */}
      <input
        ref={imgInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          const at = ctxPosRef.current;
          void S.current.insertImageFile(f, { x: at.x - 160, y: at.y - 120 });
        }}
      />
    </div>
  );
};

  // __PART3__
