/**
 * StencilPanel：素材库面板（左侧栏第三个页签，对标墨刀左栏的「内置组件」）。
 *
 * 一格 = 一个素材，点一下就插到当前画板：**有选中的画板就插进去**（局部坐标、
 * 落在画板可视区中央），否则落在当前页靠下（absolute 坐标）。插完自动选中新节点，
 * 于是可以立刻按方向键挪、或在右侧改属性。
 *
 * 预览缩略图不渲染真图：用一个按素材分类画的简单示意（grid 里的小图标 + 名称），
 * 真 SVG 预览会带来一堆异步资产与尺寸适配问题，收益不值——用户点一下就能看到真效果，
 * 而点击是可撤销的一步。
 */
import { useMemo, useRef, useState, type FC } from "react";
import { Search, X } from "lucide-react";
import { findNode, type DesignNode, type FrameNode } from "../doc";
import { STENCIL_CATEGORIES, STENCILS, searchStencils, type Stencil } from "../stencils";
import type { DesignStore } from "../state";

export const StencilPanel: FC<{ store: DesignStore }> = ({ store }) => {
  const { doc, selIds } = store;
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<string>("全部");
  /**
   * 上一次插入的落点：连点几个素材时依次往下排开。否则它们会精确叠在同一处，
   * 看着像"只插进去一个"。换画板（或首次插入）时从锚点重新开始。
   */
  const lastRef = useRef<{ key: string; bottom: number } | null>(null);

  const list = useMemo(() => {
    const base = query.trim() ? searchStencils(query, 200) : STENCILS;
    return cat === "全部" ? base : base.filter((s) => s.category === cat);
  }, [query, cat]);

  /** 插入目标：选中的画板（含选中节点所在画板）→ 否则页面顶层 */
  const target = useMemo((): { parent: DesignNode | null; frame: FrameNode | null } => {
    for (const id of selIds) {
      let loc = findNode(doc, id);
      while (loc && loc.parent) loc = findNode(doc, loc.parent.id);
      if (loc && loc.node.type === "frame") return { parent: loc.node, frame: loc.node as FrameNode };
    }
    const first = store.page.nodes.find((n): n is FrameNode => n.type === "frame");
    return { parent: first ?? null, frame: first ?? null };
  }, [doc, selIds, store.page]);

  const insert = (s: Stencil) => {
    const frame = target.frame;
    const anchor = frame
      ? { x: Math.round((frame.w - s.w) / 2), y: Math.max(24, Math.round(frame.h * 0.16)) }
      : { x: 0, y: 0 };
    // 连点排开：接着上一个的下沿 + 16 往下放；换画板/换页就回到锚点
    const key = frame ? frame.id : `page:${store.page.id}`;
    const last = lastRef.current;
    const y = last && last.key === key ? last.bottom + 16 : anchor.y;
    const w = s.w;
    const h = s.h;
    lastRef.current = { key, bottom: y + h };
    store.insertStencilSpecs(s, { x: anchor.x, y, w, h }, frame ? frame.id : null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 检索 */}
      <div className="flex shrink-0 items-center gap-1.5 px-2 pb-2">
        <div
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2"
          style={{ background: "var(--secondary)" }}
        >
          <Search size={12} style={{ color: "var(--muted-foreground)" }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜素材（按钮 / 饼图 / 判定…）"
            className="min-w-0 flex-1 bg-transparent text-[11px] outline-none"
            style={{ color: "var(--foreground)" }}
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} className="shrink-0" title="清空">
              <X size={11} style={{ color: "var(--muted-foreground)" }} />
            </button>
          )}
        </div>
      </div>

      {/* 分类 */}
      <div className="flex shrink-0 gap-1 overflow-x-auto px-2 pb-2">
        {["全部", ...STENCIL_CATEGORIES].map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCat(c)}
            className="h-6 shrink-0 rounded-full px-2 text-[10px] font-medium transition-colors"
            style={{
              background: cat === c ? "var(--accent)" : "var(--secondary)",
              color: cat === c ? "var(--accent-foreground)" : "var(--muted-foreground)",
            }}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <div className="text-[10px] leading-4" style={{ color: "var(--muted-foreground)" }}>
          {target.frame ? `插入到「${target.frame.name}」` : "插入到页面（先在画板上选中可插进画板）"}
        </div>
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          {list.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => insert(s)}
              title={`${s.name} · ${s.category} · ${s.w}×${s.h}\n${s.keys.join(" / ")}`}
              className="flex flex-col items-center gap-1 rounded-lg p-2 transition-colors hover:bg-[var(--secondary)]"
              style={{ background: "color-mix(in srgb, var(--foreground) 4%, transparent)" }}
            >
              <StencilThumb stencil={s} />
              <span className="w-full truncate text-center text-[10px]" style={{ color: "var(--foreground)" }}>
                {s.name}
              </span>
            </button>
          ))}
        </div>
        {list.length === 0 && (
          <div className="px-2 py-6 text-center text-[11px]" style={{ color: "var(--muted-foreground)" }}>
            没有匹配的素材
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * 缩略示意：按分类画一个小图形（不是真渲染）。
 * 真渲染要跑一遍 SVG 管线 + 资产等待，一个九宫格面板里代价过高，示意足够表意。
 */
const StencilThumb: FC<{ stencil: Stencil }> = ({ stencil }) => {
  const { category, id } = stencil;
  const stroke = "var(--muted-foreground)";
  const common = { fill: "none", stroke, strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg width="34" height="26" viewBox="0 0 34 26" aria-hidden>
      {category === "图表" && id.includes("pie") && (
        <>
          <circle cx="17" cy="13" r="9" {...common} />
          <path d="M17 13 L17 4 A9 9 0 0 1 25 17 Z" fill={stroke} opacity="0.35" stroke="none" />
        </>
      )}
      {category === "图表" && id.includes("donut") && (
        <>
          <circle cx="17" cy="13" r="9" {...common} strokeWidth="3.4" />
          <circle cx="17" cy="13" r="5.4" {...common} strokeWidth="0" />
        </>
      )}
      {category === "图表" && id.includes("progress") && (
        <>
          <circle cx="17" cy="13" r="8" {...common} opacity="0.35" />
          <path d="M17 5 A8 8 0 0 1 24.6 16" {...common} strokeWidth="2.6" />
        </>
      )}
      {category === "图表" && id.includes("bar") && (
        <>
          <path d="M6 21 H29" {...common} opacity="0.5" />
          <rect x="8" y="13" width="4" height="8" rx="1" fill={stroke} opacity="0.35" />
          <rect x="15" y="7" width="4" height="14" rx="1" fill={stroke} opacity="0.7" />
          <rect x="22" y="15" width="4" height="6" rx="1" fill={stroke} opacity="0.35" />
        </>
      )}
      {category === "图表" && id.includes("area") && (
        <>
          <path d="M6 20 L13 12 L20 16 L28 7" {...common} />
          <path d="M6 20 L13 12 L20 16 L28 7 L28 22 L6 22 Z" fill={stroke} opacity="0.18" stroke="none" />
        </>
      )}
      {category === "图表" && id.includes("radar") && (
        <path d="M17 4 L27 11 L23 22 L11 22 L7 11 Z" {...common} />
      )}
      {category === "流程" && id === "flow-process" && <rect x="7" y="8" width="20" height="10" rx="2" {...common} />}
      {category === "流程" && id === "flow-decision" && <path d="M17 5 L28 13 L17 21 L6 13 Z" {...common} />}
      {category === "流程" && id === "flow-terminal" && <rect x="6" y="9" width="22" height="8" rx="4" {...common} />}
      {category === "流程" && id === "flow-document" && (
        <path d="M7 7 H27 V18 Q22 22 17 18 Q12 14 7 18 Z" {...common} />
      )}
      {category === "流程" && id === "flow-data" && <path d="M11 8 H28 L23 18 H6 Z" {...common} />}
      {category === "流程" && id === "flow-subprocess" && (
        <>
          <rect x="6" y="9" width="22" height="10" rx="2" {...common} />
          <path d="M11 9 V19 M23 9 V19" {...common} />
        </>
      )}
      {category === "界面" && id === "status-bar" && (
        <>
          <path d="M6 9 H28" {...common} opacity="0.5" />
          <path d="M7 9 V4" {...common} />
          <rect x="20" y="9" width="8" height="5" rx="1.5" {...common} />
        </>
      )}
      {category === "界面" && id === "nav-bar" && (
        <>
          <path d="M11 9 L7 13 L11 17" {...common} />
          <path d="M14 13 H24" {...common} opacity="0.6" />
        </>
      )}
      {category === "界面" && id === "tab-bar" && (
        <>
          <path d="M6 8 H28" {...common} opacity="0.5" />
          {[9, 15, 21].map((x) => (
            <rect key={x} x={x} y="12" width="4" height="4" rx="1" fill={stroke} opacity="0.5" />
          ))}
        </>
      )}
      {category === "界面" && id === "search-bar" && (
        <>
          <rect x="4" y="9" width="26" height="9" rx="4.5" {...common} />
          <circle cx="11" cy="13.5" r="2" {...common} />
          <path d="M12.5 15 L14.5 17" {...common} />
        </>
      )}
      {category === "界面" && id === "list-item" && (
        <>
          <path d="M6 9 H14 M6 13 H18 M6 17 H12" {...common} opacity="0.6" />
          <path d="M26 11 L29 13.5 L26 16" {...common} />
        </>
      )}
      {category === "界面" && id === "card" && (
        <>
          <rect x="5" y="7" width="24" height="13" rx="2.5" {...common} />
          <rect x="20" y="10" width="7" height="7" rx="2" fill={stroke} opacity="0.35" />
          <path d="M8 11 H17" {...common} opacity="0.6" />
        </>
      )}
      {category === "基础" && id === "button" && (
        <>
          <rect x="6" y="9" width="22" height="9" rx="4.5" fill={stroke} opacity="0.7" stroke="none" />
          <path d="M13 13.5 H21" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
        </>
      )}
      {category === "基础" && id === "button-outline" && <rect x="6" y="9" width="22" height="9" rx="4.5" {...common} />}
      {category === "基础" && id === "tag" && <rect x="10" y="9" width="14" height="8" rx="4" {...common} />}
      {category === "基础" && id === "placeholder" && (
        <>
          <rect x="6" y="6" width="22" height="15" rx="2" {...common} strokeDasharray="3 2.5" />
          <path d="M13 11 L21 16 M21 11 L13 16" {...common} />
        </>
      )}
      {category === "基础" && id === "link-area" && <rect x="6" y="8" width="22" height="11" rx="2" {...common} strokeDasharray="3 2.5" />}
      {category === "基础" && id === "table" && (
        <>
          <rect x="6" y="6" width="22" height="15" rx="1.5" {...common} />
          <path d="M6 11 H28 M6 16 H28 M13.3 6 V21 M20.6 6 V21" {...common} opacity="0.7" />
        </>
      )}
      {category === "基础" && id === "scroll-panel" && (
        <>
          <rect x="8" y="5" width="18" height="16" rx="2" {...common} />
          <path d="M10 9 H24 M10 13 H20 M10 17 H22" {...common} opacity="0.45" />
          <path d="M24.5 8 V15" {...common} strokeWidth="2.4" opacity="0.6" />
        </>
      )}
      {category === "基础" && id === "divider" && <path d="M5 13 H29" {...common} />}
      {category === "形状" && id === "capsule" && <rect x="6" y="9" width="22" height="9" rx="4.5" {...common} />}
      {category === "形状" && id === "polygon" && <path d="M14 5 L23 9.5 L23 17.5 L14 22 L5 17.5 L5 9.5 Z" {...common} />}
      {category === "形状" && id === "bubble" && <path d="M6 7 H28 V17 H14 L9 21 V17 H6 Z" {...common} />}
      {category === "形状" && id === "wave" && <path d="M4 16 Q9 6 14 16 Q19 6 24 16 Q27 21 30 16" {...common} />}
      {/* 兜底：还没专门画示意的（新增素材时不至于空白） */}
      {!THUMBED.has(id) && <rect x="7" y="8" width="20" height="10" rx="2" {...common} strokeDasharray="3 2.5" />}
    </svg>
  );
};

/** 有专属示意的素材 id（与上面的分支一一对应；新增分支时记得加进来） */
const THUMBED = new Set([
  "chart-pie", "chart-donut", "chart-progress-ring", "chart-bar", "chart-area", "chart-radar",
  "flow-process", "flow-decision", "flow-terminal", "flow-document", "flow-data", "flow-subprocess",
  "status-bar", "nav-bar", "tab-bar", "search-bar", "list-item", "card",
  "button", "button-outline", "tag", "placeholder", "link-area", "table", "scroll-panel", "divider",
  "capsule", "polygon", "bubble", "wave",
]);

