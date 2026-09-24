/**
 * 元素/画板渲染层（DOM 实现）：纯展示组件，画布、缩略图、放映三个场景复用。
 * 坐标全部是画板单位（元素层不感知缩放——缩放由外层 CSS transform 统一处理）。
 * 视觉派生逻辑（默认值/回退链/字体栈）一律来自 viewspec.ts，与 Leafer 渲染器同源。
 */
import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { bridge } from "./bridge";
import { currentMermaidTheme, mermaidErrorText, renderMermaid, retagSvg, svgCodeUrl, type MermaidResult } from "./mermaid";
import { PROVIDER_LABELS, resolveEmbed } from "./providers";
import { type CanvasDoc, type ChartEl, type DrawEl, type El, type EmbedEl, type Frame, type ImageEl, type MermaidEl, type ShapeEl, type SvgEl, type TableEl, type TextEl } from "./doc";
import {
  DEFAULT_TEXT_SIZE,
  FONT_STACK,
  TEXT_LINE_HEIGHT,
  chartSpec,
  drawSpec,
  elBox,
  imageFit,
  lineEnds,
  polygonPoints,
  resolveRuns,
  shapeSpec,
  strokeDash,
  tableSpec,
  textLayout,
  type PolyShape,
} from "./viewspec";

export { DEFAULT_TEXT_SIZE } from "./viewspec";

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

/** 非 hook 读取（Leafer 命令式渲染器用） */
export function getAssetState(path: string): AssetState | undefined {
  return assetCache.get(path);
}

/** 任一资产状态翻转 → tick 递增（Leafer 场景重建信号） */
export function useAssetsVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => subscribeAssets(() => setV((n) => n + 1)), []);
  return v;
}

/* ---------------- 元素渲染 ---------------- */

export function textRunsStyle(el: TextEl): { align: CSSProperties["textAlign"]; justifyContent: CSSProperties["justifyContent"] } {
  const { align, vAlign } = textLayout(el);
  return {
    align,
    justifyContent: vAlign === "middle" ? "center" : vAlign === "bottom" ? "flex-end" : "flex-start",
  };
}

export function TextElView({ el }: { el: TextEl }) {
  const { align, justifyContent } = textRunsStyle(el);
  const b = elBox(el);
  return (
    <div
      className="sc-el sc-el-text"
      style={{
        left: b.x,
        top: b.y,
        width: b.w,
        height: b.h,
        opacity: b.opacity,
        transform: b.rotation ? `rotate(${b.rotation}deg)` : undefined,
        display: "flex",
        flexDirection: "column",
        justifyContent,
      }}
    >
      <div style={{ textAlign: align, lineHeight: TEXT_LINE_HEIGHT, wordBreak: "break-word", fontFamily: FONT_STACK }}>
        {resolveRuns(el).map((r, i) => (
          <span
            key={i}
            style={{
              fontSize: r.fontSize,
              fontWeight: r.bold ? 700 : undefined,
              fontStyle: r.italic ? "italic" : undefined,
              textDecoration: r.underline ? "underline" : undefined,
              color: r.color,
              fontFamily: r.fontFamily === FONT_STACK ? undefined : r.fontFamily,
              whiteSpace: "pre-wrap",
            }}
          >
            {r.text}
          </span>
        ))}
      </div>
    </div>
  );
}

export function ShapeElView({ el }: { el: ShapeEl }) {
  const s = shapeSpec(el);
  const b = elBox(el);
  const base: CSSProperties = {
    left: b.x,
    top: b.y,
    width: b.w,
    height: b.h,
    opacity: b.opacity,
    transform: b.rotation ? `rotate(${b.rotation}deg)` : undefined,
  };
  if (el.shape === "rect" || el.shape === "ellipse") {
    return (
      <div
        className="sc-el"
        style={{
          ...base,
          position: "absolute",
          background: s.fill ?? "transparent",
          border: s.stroke ? `${s.strokeWidth}px ${el.strokeStyle ?? "solid"} ${s.stroke}` : undefined,
          borderRadius: el.shape === "ellipse" ? "50%" : el.radius,
        }}
      />
    );
  }
  // 线类：对角线穿过 bbox（方向随 el.dir），箭头端用 marker；double-arrow 两端都有头
  const svgBase: CSSProperties = { ...base, position: "absolute", overflow: "visible" };
  const dash = strokeDash(el).length ? { strokeDasharray: strokeDash(el).join(" ") } : {};
  if (el.shape === "line" || el.shape === "arrow" || el.shape === "double-arrow") {
    const markerId = `sc-arrow-${el.id}`;
    const ends = lineEnds(el.w, el.h, el.dir);
    return (
      <svg className="sc-el" style={svgBase}>
        <defs>
          <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={s.lineColor} />
          </marker>
        </defs>
        <line
          x1={ends.x1}
          y1={ends.y1}
          x2={ends.x2}
          y2={ends.y2}
          stroke={s.lineColor}
          strokeWidth={s.strokeWidth}
          strokeLinecap="round"
          {...dash}
          {...(el.shape === "arrow" || el.shape === "double-arrow" ? { markerEnd: `url(#${markerId})` } : {})}
          {...(el.shape === "double-arrow" ? { markerStart: `url(#${markerId})` } : {})}
        />
      </svg>
    );
  }
  // 菱形 / 多边形：polygon（顶点几何与 leafer 的 path 同源 viewspec）
  const points =
    el.shape === "diamond"
      ? `${el.w / 2},0 ${el.w},${el.h / 2} ${el.w / 2},${el.h} 0,${el.h / 2}`
      : polygonPoints(el.shape as PolyShape, el.w, el.h)
          .map(([x, y]) => `${x},${y}`)
          .join(" ");
  return (
    <svg className="sc-el" style={svgBase}>
      <polygon
        points={points}
        fill={s.fill ?? "transparent"}
        stroke={s.stroke ?? s.lineColor}
        strokeWidth={s.strokeWidth}
        strokeLinejoin="round"
        {...dash}
      />
    </svg>
  );
}

export function ImageElView({ el }: { el: ImageEl }) {
  const state = useAssetState(el.src);
  const url = state?.status === "ready" ? state.url : null;
  const objectFit = imageFit(el) as CSSProperties["objectFit"];
  const b = elBox(el);
  return (
    <div
      className="sc-el"
      style={{
        left: b.x,
        top: b.y,
        width: b.w,
        height: b.h,
        opacity: b.opacity,
        transform: b.rotation ? `rotate(${b.rotation}deg)` : undefined,
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
          mermaid 语法错误：{mermaidErrorText(el.code, res.error)}（双击编辑代码）
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
  const s = drawSpec(el);
  const b = elBox(el);
  return (
    <svg
      className="sc-el"
      style={{
        position: "absolute",
        left: b.x,
        top: b.y,
        width: b.w,
        height: b.h,
        opacity: b.opacity,
        transform: b.rotation ? `rotate(${b.rotation}deg)` : undefined,
        overflow: "visible",
        pointerEvents: "none",
      }}
      viewBox={`0 0 ${s.naturalW} ${s.naturalH}`}
      preserveAspectRatio="none"
    >
      <polyline
        points={s.points}
        fill="none"
        stroke={s.color}
        strokeWidth={s.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/* ---------------- 内嵌 SVG（源码即内容，经 <img> 沙箱化渲染） ---------------- */

export function SvgElView({ el }: { el: SvgEl }) {
  const b = elBox(el);
  const src = useMemo(() => svgCodeUrl(el.code), [el.code]);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <div
      className="sc-el"
      style={{
        position: "absolute",
        left: b.x,
        top: b.y,
        width: b.w,
        height: b.h,
        opacity: b.opacity,
        transform: b.rotation ? `rotate(${b.rotation}deg)` : undefined,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {failed ? (
        <div
          style={{
            color: "#ff3b30",
            fontSize: Math.min(16, Math.max(10, el.w / 30)),
            padding: 12,
            wordBreak: "break-word",
            textAlign: "center",
          }}
        >
          SVG 无法渲染：可能含 foreignObject/脚本等 &lt;img&gt; 加载不支持的特性
        </div>
      ) : (
        <img
          src={src}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
        />
      )}
    </div>
  );
}

/* ---------------- 内嵌网页（iframe + 双击激活交互，tldraw 同款模式） ---------------- */

/**
 * 激活中的 embed（模块级单例：同一时刻至多一个 embed 处于交互态）。
 * 退出路径：Esc（画布层转发）/ 点画布任意处 / 点角标退出按钮 / 元素被拖拽。
 */
let activeEmbedId: string | null = null;
const embedActiveListeners = new Set<() => void>();

export function setEmbedActive(id: string | null): void {
  if (activeEmbedId === id) return;
  activeEmbedId = id;
  for (const l of embedActiveListeners) l();
}

export function getEmbedActive(): string | null {
  return activeEmbedId;
}

function useEmbedActive(): string | null {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    embedActiveListeners.add(l);
    return () => {
      embedActiveListeners.delete(l);
    };
  }, []);
  return activeEmbedId;
}

const EMBED_CHIP: CSSProperties = {
  position: "absolute",
  right: 6,
  bottom: 6,
  maxWidth: "60%",
  padding: "2px 8px",
  borderRadius: 999,
  background: "rgba(14,15,12,0.62)",
  color: "#fff",
  fontSize: 11,
  lineHeight: "16px",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  pointerEvents: "none",
  userSelect: "none",
};

export function EmbedElView({
  el,
  isLive = false,
  mode = "canvas",
}: {
  el: EmbedEl;
  /** 拖拽/缩放进行中：iframe 换 ghost，避免 WKWebView 下变换时的重绘卡顿 */
  isLive?: boolean;
  /** present（放映）直接可交互；canvas 需双击激活 */
  mode?: "canvas" | "present";
}) {
  const b = elBox(el);
  const target = useMemo(() => resolveEmbed(el.url), [el.url]);
  const label = el.title || PROVIDER_LABELS[target.provider];
  const active = mode === "canvas" && useEmbedActive() === el.id;
  const interactive = mode === "present" || active;

  // 激活期间监听父文档 pointerdown（捕获）：点画布/其他元素即退出。
  // iframe 内部的点击不会进入父文档，正好保持交互态。
  useEffect(() => {
    if (!active) return;
    const off = () => setEmbedActive(null);
    window.addEventListener("pointerdown", off, true);
    return () => window.removeEventListener("pointerdown", off, true);
  }, [active]);
  // 元素卸载/换 URL 时收掉激活态
  useEffect(() => () => {
    if (getEmbedActive() === el.id) setEmbedActive(null);
  }, [el.id, el.url]);

  if (isLive) {
    return (
      <div
        className="sc-el"
        style={{
          position: "absolute",
          left: b.x,
          top: b.y,
          width: b.w,
          height: b.h,
          opacity: b.opacity,
          transform: b.rotation ? `rotate(${b.rotation}deg)` : undefined,
          background: "#eef0ec",
          border: "1.5px dashed #b7bcb2",
          borderRadius: 6,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#8a9086",
          fontSize: Math.min(20, Math.max(10, el.w / 20)),
        }}
      >
        {label}
      </div>
    );
  }

  return (
    <div
      className="sc-el"
      style={{
        position: "absolute",
        left: b.x,
        top: b.y,
        width: b.w,
        height: b.h,
        opacity: b.opacity,
        transform: b.rotation ? `rotate(${b.rotation}deg)` : undefined,
        background: "#f6f7f4",
        border: "1px solid rgba(0,0,0,0.08)",
        overflow: "hidden",
      }}
    >
      <iframe
        key={target.embedUrl}
        src={target.embedUrl}
        title={label}
        // 面板本身是 sandbox=allow-scripts 的不透明源，嵌套 iframe 继承其标志；
        // 这串 token 只在 standalone（浏览器直开，无父沙箱）下完整生效。
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        allow="fullscreen; autoplay; clipboard-write"
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        style={{
          width: "100%",
          height: "100%",
          border: "none",
          display: "block",
          pointerEvents: interactive ? "auto" : "none",
        }}
      />
      {mode === "canvas" && !interactive && (
        <>
          {/* 交互闸：盖住 iframe，双击（stage 层分发）才放行；保证画布平移/框选/选中可用 */}
          <div style={{ position: "absolute", inset: 0 }} />
          <div style={{ ...EMBED_CHIP, opacity: 0.85 }}>{label} · 双击交互</div>
        </>
      )}
      {active && (
        <div
          style={{
            ...EMBED_CHIP,
            background: "#0a84ff",
            pointerEvents: "auto",
            cursor: "pointer",
          }}
          onPointerDown={(e: ReactMouseEvent) => {
            e.stopPropagation();
            setEmbedActive(null);
          }}
        >
          退出交互
        </div>
      )}
    </div>
  );
}

/* ---------------- 表格（绝对定位单元格：colX/rowH 与 leafer/SVG 导出同源 tableSpec） ---------------- */

export function TableElView({ el }: { el: TableEl }) {
  const t = tableSpec(el);
  const b = elBox(el);
  const pad = Math.min(10, t.size * 0.6);
  return (
    <div
      className="sc-el"
      style={{
        position: "absolute",
        left: b.x,
        top: b.y,
        width: b.w,
        height: b.h,
        opacity: b.opacity,
        transform: b.rotation ? `rotate(${b.rotation}deg)` : undefined,
      }}
    >
      {t.rows.map((row, r) => {
        const isHead = r === 0 && t.header;
        return Array.from({ length: t.cols }, (_, c) => {
          const cx = t.colX[c] ?? 0;
          const cw = (t.colX[c + 1] ?? el.w) - cx;
          return (
            <div
              key={`${r}-${c}`}
              style={{
                position: "absolute",
                left: cx,
                top: r * t.rowH,
                width: cw,
                height: t.rowH,
                background: isHead ? t.headerFill : t.fill,
                border: `1px solid ${t.stroke}`,
                boxSizing: "border-box",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: `0 ${pad}px`,
                overflow: "hidden",
                whiteSpace: "nowrap",
                fontSize: t.size,
                lineHeight: `${t.size}px`,
                color: t.color,
                fontWeight: isHead ? 700 : undefined,
                fontFamily: FONT_STACK,
              }}
            >
              {row[c] ?? ""}
            </div>
          );
        });
      })}
    </div>
  );
}

/* ---------------- 数据图表（chartSpec 图元 → SVG；pptx 导出走原生 addChart） ---------------- */

export function ChartElView({ el }: { el: ChartEl }) {
  const b = elBox(el);
  const prims = chartSpec(el);
  const kids = prims.map((p, i) => {
    const key = `p${i}`;
    switch (p.t) {
      case "rect":
        return <rect key={key} x={p.x} y={p.y} width={p.w} height={p.h} fill={p.fill} />;
      case "line":
        return <line key={key} x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} stroke={p.stroke} strokeWidth={p.strokeWidth} />;
      case "poly":
        return (
          <polyline
            key={key}
            points={p.points.map(([x, y]) => `${x},${y}`).join(" ")}
            fill="none"
            stroke={p.stroke}
            strokeWidth={p.strokeWidth}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        );
      case "path":
        return <path key={key} d={p.d} fill={p.fill} />;
      case "circle":
        return <circle key={key} cx={p.cx} cy={p.cy} r={p.r} fill={p.fill} />;
      case "text":
        return (
          <text
            key={key}
            x={p.x}
            y={p.y}
            fill={p.color}
            fontSize={p.size}
            fontFamily={FONT_STACK}
            fontWeight={p.bold ? 700 : undefined}
            textAnchor={p.anchor}
            dominantBaseline="central"
          >
            {p.text}
          </text>
        );
    }
  });
  return (
    <svg
      className="sc-el"
      style={{
        position: "absolute",
        left: b.x,
        top: b.y,
        width: b.w,
        height: b.h,
        opacity: b.opacity,
        transform: b.rotation ? `rotate(${b.rotation}deg)` : undefined,
      }}
      viewBox={`0 0 ${el.w} ${el.h}`}
    >
      {kids}
    </svg>
  );
}

export function ElView({ el, isLive, embedMode }: { el: El; isLive?: boolean; embedMode?: "canvas" | "present" }) {
  if (el.kind === "text") return <TextElView el={el} />;
  if (el.kind === "shape") return <ShapeElView el={el} />;
  if (el.kind === "mermaid") return <MermaidElView el={el} />;
  if (el.kind === "draw") return <DrawElView el={el} />;
  if (el.kind === "svg") return <SvgElView el={el} />;
  if (el.kind === "embed") return <EmbedElView el={el} isLive={isLive} mode={embedMode} />;
  if (el.kind === "table") return <TableElView el={el} />;
  if (el.kind === "chart") return <ChartElView el={el} />;
  return <ImageElView el={el} />;
}

/* ---------------- 画板渲染（背景 + 元素，scale 仅用于缩略图/放映） ---------------- */

export function SlideView({
  slide,
  scale = 1,
  className,
  style,
  live,
  embedMode,
}: {
  /** Frame 只用到 w/h/background/elements——页框渲染与画布位置无关 */
  slide: Frame;
  scale?: number;
  className?: string;
  style?: CSSProperties;
  /** 拖拽/缩放/旋转进行中的几何覆盖（id → 部分字段）：只影响实时预览，pointerup 才写回文档 */
  live?: Map<string, Partial<El>>;
  /** embed 元素交互模式：放映直接可交互；画布轨默认要双击激活 */
  embedMode?: "canvas" | "present";
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
        return (
          <ElView
            key={el.id}
            el={patch ? ({ ...el, ...patch } as El) : el}
            isLive={!!patch}
            embedMode={embedMode}
          />
        );
      })}
    </div>
  );
}
