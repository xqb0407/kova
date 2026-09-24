/**
 * LeaferStage：Leafer canvas 渲染的元素层（与 DOM 内容层互斥的另一个渲染器）。
 *
 * 结构：一个填满 stage 的 canvas（pointer-events 关闭，命中/交互仍由 CanvasStage
 * 的纯几何代码负责）；world Group 的 transform 与视口 v.tx/v.ty/v.s 同步，
 * overlay（选中框/手柄/吸附线/文本编辑）继续用 DOM。
 * 场景构建在 leafer/scene.ts（纯函数）；这里只做 tag → class 映射 + 按 key diff patch。
 */
import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { Box, Ellipse, Group, Image as LeaferImage, Leafer, Line, Path, Rect, Text } from "leafer-ui";
import { bridge } from "../bridge";
import { currentMermaidTheme, isAnimatedSvg, renderMermaid, retagSvg, svgCodeUrl } from "../mermaid";
import { ensureAsset, getAssetState, useAssetsVersion } from "../render";
import { type CanvasDoc, type El, type Frame, type SvgEl } from "../doc";
import {
  buildScene,
  type AssetView,
  type FrameChrome,
  type FramePos,
  type MeasureFn,
  type MermaidView,
  type SceneCtx,
  type SceneNode,
  type SceneTag,
  type SvgView,
  type Surface,
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

/* ---------------- 主题色 → 页框 chrome（CSS 变量直读，随主题切换重建） ---------------- */

function readChrome(): FrameChrome {
  const cs = getComputedStyle(document.documentElement);
  const stroke = cs.getPropertyValue("--sc-artboard-border").trim() || "rgba(0,0,0,0.12)";
  const primary = cs.getPropertyValue("--primary").trim() || "#166534";
  const raw = cs.getPropertyValue("--artboard-shadow").trim();
  const m = /^(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px\s+(.+)$/.exec(raw);
  return {
    stroke,
    primary,
    shadow: m ? { x: Number(m[1]), y: Number(m[2]), blur: Number(m[3]), color: m[4]!.trim() } : null,
  };
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

export const LeaferStage: FC<{
  doc: CanvasDoc;
  surface: Surface;
  positions: FramePos[];
  view: { s: number; tx: number; ty: number };
  live?: Map<string, Partial<El>>;
  liveContainerId: string | null;
  /** 整体聚焦（选中页框但无元素）→ primary 描边，与 DOM 轨 .sc-artboard-active 对齐 */
  frameFocused?: string | null;
}> = ({ doc, surface, positions, view, live, liveContainerId, frameFocused }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<InstanceType<typeof Group> | null>(null);
  const nodesRef = useRef(new Map<string, Entry>());
  const measureRef = useRef<MeasureFn | null>(null);
  if (!measureRef.current) measureRef.current = makeMeasure();

  const assetsVersion = useAssetsVersion();
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => bridge.onTheme(() => setThemeTick((t) => t + 1)), []);

  // mermaid 异步缓存：code|theme|尺寸 → 视图（加载态先占位，出图后 bump 重建场景）
  const mermaidMap = useRef(new Map<string, MermaidView>());
  const [mermaidTick, setMermaidTick] = useState(0);
  useEffect(() => {
    const els = [...doc.objects, ...doc.frames.flatMap((f: Frame) => f.elements)].filter((e): e is Extract<El, { kind: "mermaid" }> => e.kind === "mermaid");
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
    const els = [...doc.objects, ...doc.frames.flatMap((f: Frame) => f.elements)].filter(
      (e): e is SvgEl => e.kind === "svg",
    );
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

  // 挂载：leafer canvas 跟随宿主元素尺寸（AutoBounds），交互整体关闭
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const leafer = new Leafer({ view: host, hittable: false });
    const world = new Group();
    leafer.add(world);
    worldRef.current = world;
    return () => {
      (leafer as unknown as { destroy?: () => void }).destroy?.();
      worldRef.current = null;
      nodesRef.current.clear();
    };
  }, []);

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
    return buildScene({ doc, surface, positions, live, liveContainerId, focusedFrameId: frameFocused, ctx });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, surface, positions, live, liveContainerId, frameFocused, view.s, assetsVersion, themeTick, mermaidTick, svgTick]);

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
  }, [scene, view.tx, view.ty, view.s]);

  return <div ref={hostRef} style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />;
};
