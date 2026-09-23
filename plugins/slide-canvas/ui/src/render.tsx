/**
 * 元素/画板渲染层：纯展示组件，画布、缩略图、放映三个场景复用。
 * 坐标全部是画板单位（元素层不感知缩放——缩放由外层 CSS transform 统一处理）。
 */
import { useEffect, useState, type CSSProperties } from "react";
import { bridge } from "./bridge";
import { currentMermaidTheme, renderMermaid, type MermaidResult } from "./mermaid";
import { drawNaturalBox, type CanvasDoc, type DrawEl, type El, type Frame, type ImageEl, type MermaidEl, type ShapeEl, type TextEl } from "./doc";

/* ---------------- 图片资产缓存（path → dataURL | null(缺失)） ---------------- */

type AssetState = { status: "loading" | "ready"; url: string | null };
const assetCache = new Map<string, AssetState>();
const assetListeners = new Set<() => void>();

function subscribeAssets(cb: () => void): () => void {
  assetListeners.add(cb);
  return () => assetListeners.delete(cb);
}

export function ensureAsset(path: string): void {
  if (assetCache.has(path)) return;
  assetCache.set(path, { status: "loading", url: null });
  void bridge.requestAsset(path).then((b64) => {
    let url: string | null = null;
    if (b64) {
      const mime = MIME_BY_EXT(path) ?? "image/png";
      url = `data:${mime};base64,${b64}`;
    }
    assetCache.set(path, { status: "ready", url });
    for (const l of assetListeners) l();
  });
}

/** 预注册资产（agent 写盘后重开 doc 时由 state 层统一喂）：页框 + 画布级 objects 都算 */
export function preloadDocAssets(doc: CanvasDoc): void {
  for (const el of [...doc.objects, ...doc.frames.flatMap((f) => f.elements)])
    if (el.kind === "image") ensureAsset(el.src);
}

function MIME_BY_EXT(p: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(p);
  if (!m) return null;
  return (
    { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif" }[
      m[1].toLowerCase()
    ] ?? null
  );
}

/** 导出用：等待资产就绪取 dataURL（缺失/超时返回 null） */
export function assetDataUrl(path: string): Promise<string | null> {
  ensureAsset(path);
  const cur = assetCache.get(path);
  if (cur?.status === "ready") return Promise.resolve(cur.url);
  return new Promise((res) => {
    const unsub = subscribeAssets(() => {
      const s = assetCache.get(path);
      if (s?.status === "ready") {
        unsub();
        res(s.url);
      }
    });
    setTimeout(() => {
      unsub();
      const s = assetCache.get(path);
      res(s?.status === "ready" ? s.url : null);
    }, 16000);
  });
}

/** 订阅某资产状态（渲染组件用）；loading 与缺失分开呈现 */
export function useAssetState(path: string): AssetState | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    ensureAsset(path);
    return subscribeAssets(() => bump((n) => n + 1));
  }, [path]);
  return assetCache.get(path);
}

/* ---------------- 元素渲染 ---------------- */

export const DEFAULT_TEXT_SIZE = 24;
const FONT_STACK =
  "-apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', Arial, sans-serif";

export function textRunsStyle(el: TextEl): { align: CSSProperties["textAlign"]; justifyContent: CSSProperties["justifyContent"] } {
  return {
    align: el.align ?? "left",
    justifyContent: el.vAlign === "middle" ? "center" : el.vAlign === "bottom" ? "flex-end" : "flex-start",
  };
}

export function TextElView({ el }: { el: TextEl }) {
  const { align, justifyContent } = textRunsStyle(el);
  return (
    <div
      className="sc-el sc-el-text"
      style={{
        left: el.x,
        top: el.y,
        width: el.w,
        height: el.h,
        opacity: el.opacity,
        transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
        display: "flex",
        flexDirection: "column",
        justifyContent,
      }}
    >
      <div style={{ textAlign: align, lineHeight: 1.35, wordBreak: "break-word", fontFamily: FONT_STACK }}>
        {el.runs.map((r, i) => {
          const size = r.size ?? DEFAULT_TEXT_SIZE;
          return (
            <span
              key={i}
              style={{
                fontSize: size,
                fontWeight: r.bold ? 700 : undefined,
                fontStyle: r.italic ? "italic" : undefined,
                textDecoration: r.underline ? "underline" : undefined,
                color: r.color ?? "#111827",
                fontFamily: r.font ? `'${r.font}', ${FONT_STACK}` : undefined,
                whiteSpace: "pre-wrap",
              }}
            >
              {r.text}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function ShapeElView({ el }: { el: ShapeEl }) {
  const sw = el.strokeWidth ?? (el.shape === "line" || el.shape === "arrow" ? 2 : 1);
  const stroke = el.stroke && el.stroke !== "none" ? el.stroke : sw > 0 && el.fill !== "none" ? el.fill ?? "transparent" : "transparent";
  const base: CSSProperties = {
    left: el.x,
    top: el.y,
    width: el.w,
    height: el.h,
    opacity: el.opacity,
    transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
  };
  if (el.shape === "rect" || el.shape === "ellipse") {
    return (
      <div
        className="sc-el"
        style={{
          ...base,
          position: "absolute",
          background: el.fill && el.fill !== "none" ? el.fill : "transparent",
          border: stroke !== "transparent" ? `${sw}px solid ${stroke}` : undefined,
          borderRadius: el.shape === "ellipse" ? "50%" : el.radius,
        }}
      />
    );
  }
  // line / arrow：对角线穿过 bbox（文档几何恒正，方向左上→右下）
  const markerId = `sc-arrow-${el.id}`;
  const color = (el.stroke && el.stroke !== "none" ? el.stroke : el.fill) ?? "#111827";
  return (
    <svg className="sc-el" style={{ ...base, position: "absolute", overflow: "visible" }}>
      <defs>
        <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill={color} />
        </marker>
      </defs>
      <line
        x1={0}
        y1={0}
        x2={el.w}
        y2={el.h}
        stroke={color}
        strokeWidth={sw}
        strokeLinecap="round"
        {...(el.shape === "arrow" ? { markerEnd: `url(#${markerId})` } : {})}
      />
    </svg>
  );
}

export function ImageElView({ el }: { el: ImageEl }) {
  const state = useAssetState(el.src);
  const url = state?.status === "ready" ? state.url : null;
  const fit = el.fit ?? "cover";
  const objectFit: CSSProperties["objectFit"] = fit === "stretch" ? "fill" : fit;
  return (
    <div
      className="sc-el"
      style={{
        left: el.x,
        top: el.y,
        width: el.w,
        height: el.h,
        opacity: el.opacity,
        transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
        borderRadius: el.radius,
        overflow: "hidden",
        position: "absolute",
      }}
    >
      {url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          style={{ width: "100%", height: "100%", objectFit, display: "block" }}
        />
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            background: "repeating-linear-gradient(45deg,#e5e7eb,#e5e7eb 8px,#f3f4f6 8px,#f3f4f6 16px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#9ca3af",
            fontSize: Math.min(18, Math.max(10, el.w / 12)),
          }}
        >
          {state?.status === "loading" ? "加载中…" : "∅ 图片缺失"}
        </div>
      )}
    </div>
  );
}

/** 主题翻转计数（宿主 theme.update → 重新按当前主题渲染） */
function useThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => bridge.onTheme(() => setTick((n) => n + 1)), []);
  return tick;
}

export function MermaidElView({ el }: { el: MermaidEl }) {
  const themeTick = useThemeTick();
  const theme = currentMermaidTheme(el.theme);
  const [res, setRes] = useState<MermaidResult | null>(null);
  useEffect(() => {
    let alive = true;
    void renderMermaid(el.code, theme).then((r) => {
      if (alive) setRes(r);
    });
    return () => {
      alive = false;
    };
  }, [el.code, theme, themeTick]);
  return (
    <div
      className="sc-el sc-mermaid"
      style={{
        left: el.x,
        top: el.y,
        width: el.w,
        height: el.h,
        opacity: el.opacity,
        transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {res?.error ? (
        <div
          style={{
            color: "#ff3b30",
            fontSize: Math.min(16, Math.max(10, el.w / 30)),
            padding: 12,
            wordBreak: "break-word",
            textAlign: "center",
          }}
        >
          mermaid 语法错误：{res.error.split("\n")[0]}（双击编辑代码）
        </div>
      ) : res?.svg ? (
        <div className="sc-mermaid-svg" dangerouslySetInnerHTML={{ __html: res.svg }} />
      ) : (
        <div style={{ color: "#9ca3af", fontSize: 14 }}>图表渲染中…</div>
      )}
    </div>
  );
}

/**
 * 钢笔手绘：points 落在「自然点盒」(0..maxPoint) 里，viewBox 取点盒、拉伸填满 el.w×el.h
 * （preserveAspectRatio=none）→ 调整大小只改 w/h，点集不动，拖拽全程所见即所得。
 */
export function DrawElView({ el }: { el: DrawEl }) {
  const color = el.stroke && el.stroke !== "none" ? el.stroke : "#1d1d1f";
  const sw = el.strokeWidth ?? 2;
  const pts = el.points.map(([x, y]) => `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`).join(" ");
  const { w: nw, h: nh } = drawNaturalBox(el);
  return (
    <svg
      className="sc-el"
      style={{
        position: "absolute",
        left: el.x,
        top: el.y,
        width: el.w,
        height: el.h,
        opacity: el.opacity,
        transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
        overflow: "visible",
        pointerEvents: "none",
      }}
      viewBox={`0 0 ${nw} ${nh}`}
      preserveAspectRatio="none"
    >
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function ElView({ el }: { el: El }) {
  if (el.kind === "text") return <TextElView el={el} />;
  if (el.kind === "shape") return <ShapeElView el={el} />;
  if (el.kind === "mermaid") return <MermaidElView el={el} />;
  if (el.kind === "draw") return <DrawElView el={el} />;
  return <ImageElView el={el} />;
}

/* ---------------- 画板渲染（背景 + 元素，scale 仅用于缩略图/放映） ---------------- */

export function SlideView({
  slide,
  scale = 1,
  className,
  style,
  live,
}: {
  /** Frame 只用到 w/h/background/elements——页框渲染与画布位置无关 */
  slide: Frame;
  scale?: number;
  className?: string;
  style?: CSSProperties;
  /** 拖拽/缩放/旋转进行中的几何覆盖（id → 部分字段）：只影响实时预览，pointerup 才写回文档 */
  live?: Map<string, Partial<El>>;
}) {
  return (
    <div
      className={className}
      style={{
        width: slide.w,
        height: slide.h,
        background: slide.background || "#ffffff",
        position: "relative",
        overflow: "hidden",
        transform: scale === 1 ? undefined : `scale(${scale})`,
        transformOrigin: "top left",
        ...style,
      }}
    >
      {slide.elements.map((el) => {
        const patch = live?.get(el.id);
        return <ElView key={el.id} el={patch ? ({ ...el, ...patch } as El) : el} />;
      })}
    </div>
  );
}
