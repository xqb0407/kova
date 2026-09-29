/**
 * LeaferStage：Leafer canvas 渲染的元素层（与 DOM 内容层互斥的另一个渲染器）。
 *
 * 结构：一个填满 stage 的 canvas；world Group 的 transform 与视口 v.tx/v.ty/v.s 同步。
 * 交互双态：
 *   默认（interact 关）——canvas pointer-events 关闭 + app hittable:false，
 *     命中/交互仍由 CanvasStage 的纯几何代码负责，overlay 用 DOM；
 *   editor 轨（interact 开）——@leafer-in/editor 全接管：点选/多选/框选/拖动/缩放/旋转
 *     在 canvas 内完成，选择框把手是编辑器画的（sky 屏幕空间层，不随缩放放大）。
 *     键盘仍留 stage 层（keyEvent:false）；就地编辑仍走 DOM（openInner 关）。
 *     回写协议见 editorLedger：拖动中只动节点，END 才映射回 doc 提交。
 * 场景构建在 leafer/scene.ts（纯函数）；这里只做 tag → class 映射 + 按 key diff patch。
 */
import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { App, Box, DragEvent, Ellipse, Group, Image as LeaferImage, Line, MoveEvent, Path, Rect, Text } from "leafer-ui";
import { Editor, EditorEvent } from "@leafer-in/editor";
import { bridge } from "../bridge";
import { currentMermaidTheme, isAnimatedSvg, renderMermaid, retagSvg, svgCodeUrl } from "../mermaid";
import { ensureAsset, getAssetState, useAssetsVersion } from "../render";
import { type CanvasDoc, type El, type SvgEl } from "../doc";
import { editorPatchIfChanged, type EditorNodeTransform } from "./editorLedger";
import { bindSlideEditHost, getCustomGesture } from "./editTools";
import type { Vec } from "./editTools";
import {
  buildScene,
  type AssetView,
  type MeasureFn,
  type MermaidView,
  type SceneChrome,
  type SceneCtx,
  type SceneNode,
  type SceneTag,
  type SvgView,
} from "./scene";

const TAGS: Record<SceneTag, new (props?: Record<string, unknown>) => unknown> = {
  group: Group,
  box: Box,
  rect: Rect,
  ellipse: Ellipse,
  line: Line,
  path: Path,
  image: LeaferImage,
  text: Text,
};

/* ---------------- 字体测量（canvas 与 DOM 同一字体引擎） ---------------- */

function makeMeasure(): MeasureFn {
  const ctx = document.createElement("canvas").getContext("2d");
  const widthCache = new Map<string, number>();
  const metricsCache = new Map<string, { ascent: number; descent: number }>();
  return (text, fontCss) => {
    const size = parseFloat(fontCss.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? "16") || 16;
    if (!ctx) return { width: text.length * size * 0.5, ascent: size * 0.8, descent: size * 0.2 };
    if (ctx.font !== fontCss) ctx.font = fontCss;
    let width = widthCache.get(text + "\u0000" + fontCss);
    if (width === undefined) {
      width = ctx.measureText(text).width;
      widthCache.set(text + "\u0000" + fontCss, width);
    }
    let metrics = metricsCache.get(fontCss);
    if (!metrics) {
      const m = ctx.measureText("\u00A0");
      metrics = {
        ascent: m.fontBoundingBoxAscent ?? size * 0.8,
        descent: m.fontBoundingBoxDescent ?? size * 0.2,
      };
      metricsCache.set(fontCss, metrics);
    }
    return { width, ascent: metrics.ascent, descent: metrics.descent };
  };
}

/* ---------------- 主题色 → 场景 chrome（CSS 变量直读，随主题切换重建） ---------------- */

function readChrome(): SceneChrome {
  const cs = getComputedStyle(document.documentElement);
  const ink = cs.getPropertyValue("--ink").trim() || "#1d1d1f";
  return { ink };
}

/* ---------------- mermaid SVG → 等比适配 PNG（对齐 DOM 的 meet 居中） ---------------- */

function svgToPngFit(svg: string, w: number, h: number, scale = 2): Promise<string | null> {
  return new Promise((res) => {
    const cw = Math.max(2, Math.round(w * scale));
    const ch = Math.max(2, Math.round(h * scale));
    // 根标签属性统一由 retagSvg 改写：重复的 preserveAspectRatio 会让 SVG 非法（onerror）
    const sized = retagSvg(svg, { width: cw, height: ch, preserveAspectRatio: "xMidYMid meet" });
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext("2d");
        if (!ctx) return res(null);
        ctx.drawImage(img, 0, 0, cw, ch);
        res(canvas.toDataURL("image/png"));
      } catch {
        res(null);
      }
    };
    img.onerror = () => res(null);
    img.src = url;
  });
}

const mermaidKey = (code: string, theme: string, w: number, h: number) =>
  `${code}|${theme}|${Math.round(w)}x${Math.round(h)}`;

/** svg 源码元素：源码 → 等比光栅化 PNG（透明底，所见即所得），key 只随 code 变 */
const svgElKey = (code: string) => `svg|${code.length}|${hash32(code)}`;

function hash32(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/* ---------------- 场景 patch（按 key diff，命令式保引用稳定） ---------------- */

/** leafer 节点的宽松视图（属性走响应式 setter） */
type NodeObj = { add?: (n: unknown) => void; remove?: () => void; zIndex?: number } & Record<string, unknown>;
type Entry = { node: NodeObj; tag: SceneTag; props: Record<string, unknown> };

function setNodeProps(node: Record<string, unknown>, oldProps: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(next)) {
    if (oldProps[k] !== v) node[k] = v;
  }
  for (const k of Object.keys(oldProps)) {
    if (!(k in next)) node[k] = undefined;
  }
}

function patchTree(parent: NodeObj, specs: SceneNode[], map: Map<string, Entry>, seen: Set<string>): void {
  specs.forEach((spec, index) => {
    seen.add(spec.key);
    let ent = map.get(spec.key);
    if (!ent || ent.tag !== spec.tag) {
      ent?.node.remove?.();
      const node = new (TAGS[spec.tag] as unknown as new () => NodeObj)();
      // 定制编辑工具（editTools.ts）不经 nodesRef 反查，直接读节点上的元素 key
      node.__elKey = spec.key;
      setNodeProps(node, {}, spec.props);
      parent.add?.(node);
      ent = { node, tag: spec.tag, props: { ...spec.props } };
      map.set(spec.key, ent);
    } else {
      setNodeProps(ent.node, ent.props, spec.props);
      ent.props = { ...spec.props };
    }
    ent.node.zIndex = index;
    if (spec.children) patchTree(ent.node, spec.children, map, seen);
  });
}

/* ---------------- 组件 ---------------- */

/** 场景节点 key → 元素 elId：元素根 group 的 key 就是 el.id；"world"/"objects"/"ab:"页框/含 # 的子节点都不是 */
export function elIdOfKey(key: string): string | null {
  if (key === "world" || key === "objects" || key.startsWith("ab:") || key.includes("#")) return null;
  return key;
}

export const LeaferStage: FC<{
  doc: CanvasDoc;
  view: { s: number; tx: number; ty: number };
  live?: Map<string, Partial<El>>;
  /** editor 轨（挂载时随 track 定，中途不翻转）：@leafer-in/editor 全接管交互 */
  interact?: boolean;
  /** editor 轨下画布是否收指针（笔/画线/抓手/空格/就地编辑时关，让位给 stage） */
  interactive?: boolean;
  /** editor 选中集变化 → 元素 elId 列表（回灌 store 选中态；空数组 = 点空白取消） */
  onEditorSelect?: (elIds: string[]) => void;
  /** 手势 END 的几何回写：elId → doc 补丁（一次手势 = 一个 Map = 一次 commit = 一个 undo 步）；
   *  gesture = 线端点拖拽的新端点（容器坐标），CanvasStage 据此做 Excalidraw 式重锚/解绑 */
  onEditorCommit?: (patches: Map<string, Partial<El>>, gesture?: { elId: string; start: Vec; end: Vec }) => void;
  /** 定制工具（线端点/折点）拖动中的实时几何（null = 清除）：宿主并进 liveMap，零历史 */
  onEditorLive?: (elId: string, patch: Partial<El> | null) => void;
}> = ({ doc, view, live, interact, interactive, onEditorSelect, onEditorCommit, onEditorLive }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<InstanceType<typeof Group> | null>(null);
  const nodesRef = useRef(new Map<string, Entry>());
  const measureRef = useRef<MeasureFn | null>(null);
  if (!measureRef.current) measureRef.current = makeMeasure();
  // END 回写要拿"提交前"的 doc 现值算 diff：挂载期 effect 闭包只认最新渲染的引用
  const docRef = useRef(doc);
  docRef.current = doc;

  const assetsVersion = useAssetsVersion();
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => bridge.onTheme(() => setThemeTick((t) => t + 1)), []);

  // mermaid 异步缓存：code|theme|尺寸 → 视图（加载态先占位，出图后 bump 重建场景）
  const mermaidMap = useRef(new Map<string, MermaidView>());
  const [mermaidTick, setMermaidTick] = useState(0);
  useEffect(() => {
    const els = doc.objects.filter((e): e is Extract<El, { kind: "mermaid" }> => e.kind === "mermaid");
    let dirty = false;
    for (const el of els) {
      const theme = currentMermaidTheme(el.theme);
      const key = mermaidKey(el.code, theme, el.w, el.h);
      if (mermaidMap.current.has(key)) continue;
      mermaidMap.current.set(key, { status: "loading" });
      dirty = true;
      void (async () => {
        const r = await renderMermaid(el.code, theme);
        const map = mermaidMap.current;
        if (r.error) map.set(key, { status: "error", message: r.error });
        else if (r.svg) {
          const png = await svgToPngFit(r.svg, el.w, el.h);
          map.set(key, png ? { status: "ready", url: png } : { status: "error", message: "mermaid 光栅化失败" });
        } else map.set(key, { status: "error", message: "mermaid 渲染无输出" });
        setMermaidTick((t) => t + 1);
      })();
    }
    if (dirty) setMermaidTick((t) => t + 1);
  }, [doc, themeTick]);

  // svg 源码元素异步光栅化：与 mermaid 同管线（源码 → data-url → <img> → 透明底 PNG）
  const svgMap = useRef(new Map<string, SvgView>());
  const [svgTick, setSvgTick] = useState(0);
  useEffect(() => {
    const els = doc.objects.filter((e): e is SvgEl => e.kind === "svg");
    let dirty = false;
    for (const el of els) {
      // 动画源码不进光栅化缓存：光栅化只留第一帧，动画由 DOM 浮层 <img> 播放
      if (isAnimatedSvg(el.code)) continue;
      const key = svgElKey(el.code);
      if (svgMap.current.has(key)) continue;
      svgMap.current.set(key, { status: "loading" });
      dirty = true;
      void (async () => {
        const map = svgMap.current;
        try {
          const png = await new Promise<string | null>((res) => {
            const img = new Image();
            img.onload = () => {
              try {
                const cw = Math.max(2, Math.round(el.w * 2));
                const ch = Math.max(2, Math.round(el.h * 2));
                const canvas = document.createElement("canvas");
                canvas.width = cw;
                canvas.height = ch;
                const ctx2 = canvas.getContext("2d");
                if (!ctx2) return res(null);
                ctx2.drawImage(img, 0, 0, cw, ch);
                res(canvas.toDataURL("image/png"));
              } catch {
                res(null);
              }
            };
            img.onerror = () => res(null);
            img.src = svgCodeUrl(el.code);
          });
          map.set(key, png ? { status: "ready", url: png } : { status: "error", message: "可能含 foreignObject/脚本等 <img> 不支持的特性" });
        } catch {
          svgMap.current.set(key, { status: "error", message: "源码无法解析为图像" });
        }
        setSvgTick((t) => t + 1);
      })();
    }
    if (dirty) setSvgTick((t) => t + 1);
  }, [doc]);

  // 挂载：leafer canvas 跟随宿主元素尺寸（AutoBounds）；editor 轨再挂一个编辑器实例
  const leaferRef = useRef<InstanceType<typeof App> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const onEditorSelectRef = useRef(onEditorSelect);
  onEditorSelectRef.current = onEditorSelect;
  const onEditorCommitRef = useRef(onEditorCommit);
  onEditorCommitRef.current = onEditorCommit;
  const onEditorLiveRef = useRef(onEditorLive);
  onEditorLiveRef.current = onEditorLive;
  // 定制工具摆放把手要读"屏幕真实值"（doc+live），挂载期闭包只认最新渲染的引用
  const liveValRef = useRef(live);
  liveValRef.current = live;
  // 同一元素 editOuter 中途变化（折线塌缩 3→2 等）→ 编辑器缓存的还是旧工具，需显式换装
  const lastOuterRef = useRef("");
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // 必须用 App（不是 plain Leafer）：tree/sky 分层是 App 的能力，Editor 依赖 sky 层、
    // 手势 END 事件从 tree（元素拖动）与 sky（把手拖动）各自冒泡到 App 根（见官方 editor 文档）
    const app = new App({
      view: host,
      hittable: !!interact,
      tree: { hittable: !!interact },
      ...(interact ? { sky: {} } : null),
    });
    const world = new Group();
    app.tree.add(world);
    leaferRef.current = app;
    worldRef.current = world;
    let editor: Editor | null = null;
    if (interact) {
      editor = new Editor({
        keyEvent: false, // 键盘（删除/撤销/复制/nudge）留在 stage 层走现有 store 动作
        openInner: false as unknown as "double", // 运行时假值即关内置 InnerEditor；就地编辑走 DOM（双击路由）
        stroke: readChrome().ink, // 选择框描边与 DOM 轨 .sc-selbox 同色（--ink）
        strokeWidth: 1,
        pointSize: 8,
        pointRadius: 2, // 方头小把手，贴近 .sc-handle 的观感
        hover: true,
        rotateGap: 15, // 旋转吸附 15°，对齐线/折线的方向吸附口径
        skewable: false, // doc 无斜切概念：关掉编辑器斜切把手，避免回写丢 skew
      });
      // sky = 屏幕空间层：画布缩放时把手恒定大小（App 建 sky 层，Creator.editor 同款挂法）
      app.sky?.add(editor);
      const elIdOfNode = (node: object): string | null => {
        for (const [key, ent] of nodesRef.current) if (ent.node === node) return elIdOfKey(key);
        return null;
      };
      const ed = editor;
      editor.on(EditorEvent.SELECT, (e: EditorEvent) => {
        const ids: string[] = [];
        for (const t of e.list) {
          const id = t ? elIdOfNode(t as unknown as object) : null;
          if (id) ids.push(id);
        }
        onEditorSelectRef.current?.(ids);
      });
      // 几何回写：拖动中 editor 直接改节点、零提交；松手把节点终值经 editorLedger 映射回 doc。
      // DragEvent.END 与 MoveEvent.END 同一手势可能双发 → 用补丁签名去重，防双 commit 双 undo 步。
      const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
      const elAt = (id: string): El | null => {
        const d = docRef.current;
        return d.objects.find((e) => e.id === id) ?? null;
      };
      // 定制工具（sc-line/sc-poly，见 editTools.ts）的宿主桥：手势快照读 doc、把手摆放读 doc+live、
      // live 补丁与 alt 删点即时提交回调给 React 侧（CanvasStage 合入 liveMap / 走 commit 管线）
      bindSlideEditHost(ed, {
        getDocEl: elAt,
        getMergedEl: (id) => {
          const el = elAt(id);
          if (!el) return null;
          const p = liveValRef.current?.get(id);
          return p ? ({ ...el, ...p } as El) : el;
        },
        setLive: (id, patch) => onEditorLiveRef.current?.(id, patch),
        commitNow: (id, patch) => onEditorCommitRef.current?.(new Map<string, Partial<El>>([[id, patch]])),
      });
      let lastSig = "";
      const tryCommit = () => {
        const patches = new Map<string, Partial<El>>();
        // 定制工具手势（端点/折点）：live 已把节点几何改到位，END 取 finishGesture 的最终 patch；
        // 该元素跳过通用节点变换映射（live 改过 bbox 中心/点列，group transform 不再编码增量）
        const fin = getCustomGesture(ed)?.finishGesture() ?? null;
        let gesture: { elId: string; start: Vec; end: Vec } | undefined;
        if (fin) {
          patches.set(fin.elId, fin.patch);
          if (fin.endpoints) gesture = { elId: fin.elId, start: fin.endpoints.start, end: fin.endpoints.end };
        }
        for (const t of ed.list) {
          const elId = t ? elIdOfNode(t as unknown as object) : null;
          if (!elId || elId === fin?.elId) continue;
          const el = elAt(elId);
          if (!el) continue;
          const n = t as unknown as NodeObj;
          const tr: EditorNodeTransform = {
            x: num(n.x),
            y: num(n.y),
            scaleX: num(n.scaleX, 1),
            scaleY: num(n.scaleY, 1),
            rotation: num(n.rotation),
          };
          const p = editorPatchIfChanged(el, tr);
          if (p) patches.set(elId, p);
        }
        if (!patches.size) return;
        const sig = JSON.stringify([...patches]); // gesture 端点由 patch 几何推出，不入签名
        if (sig === lastSig) return;
        lastSig = sig;
        onEditorCommitRef.current?.(patches, gesture);
      };
      // tree（元素拖动）与 sky（把手拖动）的事件都沿目标链冒泡到 App 根：一处监听两类手势 END
      app.on(DragEvent.END, tryCommit);
      app.on(MoveEvent.END, tryCommit);
    }
    editorRef.current = editor;
    return () => {
      editor?.destroy();
      app.destroy();
      worldRef.current = null;
      leaferRef.current = null;
      editorRef.current = null;
      nodesRef.current.clear();
    };
  }, [interact]);

  // 场景构建：doc/拖拽 live/视口/资源/主题/mermaid 任一变化都重算（纯函数，diff 才落到节点上）
  const scene = useMemo<SceneNode>(() => {
    const ctx: SceneCtx = {
      measure: measureRef.current!,
      asset: (path: string): AssetView => {
        ensureAsset(path);
        const st = getAssetState(path);
        if (!st || st.status === "loading") return { status: "loading" };
        return st.url ? { status: "ready", url: st.url } : { status: "missing" };
      },
      mermaid: (el) => mermaidMap.current.get(mermaidKey(el.code, currentMermaidTheme(el.theme), el.w, el.h)) ?? { status: "loading" },
      svg: (el) => svgMap.current.get(svgElKey(el.code)) ?? { status: "loading" },
      chrome: readChrome(),
      zoom: view.s,
    };
    return buildScene({ doc, live, ctx });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, live, view.s, assetsVersion, themeTick, mermaidTick, svgTick]);

  // patch：world transform 同步视口 + 场景树 diff
  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    const w = world as unknown as NodeObj;
    w.x = view.tx;
    w.y = view.ty;
    w.scaleX = view.s;
    w.scaleY = view.s;
    const map = nodesRef.current;
    const seen = new Set<string>();
    patchTree(w, scene.children ?? [], map, seen);
    for (const [key, ent] of map) {
      if (!seen.has(key)) {
        ent.node.remove?.();
        map.delete(key);
      }
    }
    // doc 提交/undo/删元素后节点引用会变：把 editor 选中集裁剪到存活节点并刷新把手，
    // 保证「松手收敛」闭环（补丁回灌后选择框与新几何对齐，不残留死引用）
    if (interact && editorRef.current) {
      const ed = editorRef.current;
      // editOuter 换装：同一节点属性变了（塌缩 sc-poly→sc-line / 反向），编辑器缓存的还是
      // 旧工具（updateEditTool 只在换目标时跑）→ 对比上一帧值，变了就显式换装
      const eb = ed.editBox as unknown as { target?: { editOuter?: string } | null } | undefined;
      if (eb?.target) {
        const outer = eb.target.editOuter ?? "";
        if (outer !== lastOuterRef.current) {
          lastOuterRef.current = outer;
          ed.updateEditTool();
        }
      }
      const mounted = new Set<unknown>();
      for (const ent of map.values()) mounted.add(ent.node);
      const list = ed.list as unknown[];
      if (list.length) {
        const alive = list.filter((n) => mounted.has(n));
        if (alive.length !== list.length) {
          if (!alive.length) ed.cancel();
          else ed.select(alive as Parameters<typeof ed.select>[0]);
        }
        ed.update();
      }
    }
  }, [scene, view.tx, view.ty, view.s]);

  return <div ref={hostRef} style={{ position: "absolute", inset: 0, pointerEvents: interact && interactive ? "auto" : "none" }} />;
};
