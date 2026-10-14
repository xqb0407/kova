/**
 * 素材库（stencils）：一格格现成的图形/部件，点一下落到画板（对标墨刀的「内置组件」面板）。
 *
 * 定位：**填结构**而不是"随便放个装饰"。凡是「每次都要手搓、搓法固定、搓错就难看」的
 * 东西都收在这里——流程图形、图表骨架、按钮、占位符、表格、滚动面板、状态栏/标签栏。
 * 复杂组合件（导航栏那种带交互语义的）由组件（components）或 run_design_script 负责。
 *
 * 产物是**节点规格数组**——一份 JSON，两个入口各用自己的转换器消化：
 *   · 面板插入：stencilNodes()（走 doc.ts 的 parseDesignDoc，即文件格式那套解析）
 *   · MCP 插入：insert_stencil（走 mcp/tools.ts 的 buildNode）
 * 所以规格必须写成**两边读法一致**的形式：形状内嵌标签一律写显式 `text.runs`
 * （不写 `text:"按钮" + size/color` 这种简写——MCP 侧认简写、文档解析侧不认，
 * 会变成"面板插出来是白字、工具插出来是黑字"）。test/stencils.test.ts 有等价性断言守着。
 *
 * 尺寸约定：每个素材有一个标称框（w×h），插入时按目标框**等比缩放**后居中——
 * 图表/图标被非等比拉伸会立刻变形，宁可留边也不拉。
 */
import { parseDesignDoc, type DesignNode, type TextRun } from "./doc";

export type StencilCategory = "基础" | "形状" | "流程" | "图表" | "界面";

export type StencilSpec = Record<string, unknown>;

export type Stencil = {
  id: string;
  name: string;
  category: StencilCategory;
  /** 标称尺寸（面板预览与缺省插入尺寸） */
  w: number;
  h: number;
  /** 关键词（检索用，中英文都放） */
  keys: string[];
  /** 生成器：给定外框与 id 工厂，产出规格数组（父容器局部坐标） */
  build: (box: Box, ids: IdFn) => StencilSpec[];
};

export type Box = { x: number; y: number; w: number; h: number };
type IdFn = (hint: string) => string;

/* ---------------- 配色（与插件中性色板一致） ---------------- */

const INK = "#111111";
const MUTED = "#8a8a8e";
const LINE = "#d9d9d9";
const SOFT = "#f5f5f5";
const ACCENT = "#0d99ff";
/** 流程图形统一色（类 UML 的中性深灰） */
const FLOW_LINE = "#4a5568";
const FLOW_INK = "#1a202c";

/* ---------------- 规格小工具 ---------------- */

type LabelStyle = { size?: number; weight?: number; color?: string; align?: "left" | "center" | "right"; vAlign?: "top" | "middle" | "bottom" };

/** 形状内嵌标签：显式 runs 形式（两个转换器都认） */
const shapeLabel = (content: string, st: LabelStyle = {}): Record<string, unknown> => {
  const run: TextRun = { text: content };
  if (st.size !== undefined) run.size = st.size;
  if (st.weight !== undefined) run.weight = st.weight;
  if (st.color !== undefined) run.color = st.color;
  const lt: Record<string, unknown> = { runs: [run] };
  if (st.align) lt.align = st.align;
  if (st.vAlign) lt.vAlign = st.vAlign;
  return lt;
};

const rect = (id: string, box: Box, extra: StencilSpec = {}): StencilSpec => ({ id, type: "rect", ...box, ...extra });

/** 形状（含内嵌标签） */
const labelled = (id: string, box: Box, name: string, content: string, extra: StencilSpec = {}): StencilSpec => ({
  id,
  type: "rect",
  name,
  ...box,
  ...extra,
  text: shapeLabel(content, extra as LabelStyle),
});

/** 文本节点（text 节点的 size/color/weight 是节点级简写，两个转换器都认） */
const text = (id: string, box: Box, content: string, extra: StencilSpec = {}): StencilSpec => ({
  id,
  type: "text",
  ...box,
  text: content,
  align: "center",
  vAlign: "middle",
  size: 13,
  color: INK,
  ...extra,
});

const icon = (id: string, box: Box, name: string, glyph: string, color = MUTED, strokeWidth = 2): StencilSpec => ({
  id,
  type: "icon",
  name,
  icon: glyph,
  ...box,
  color,
  strokeWidth,
});

/* ---------------- 基础 ---------------- */

const BUTTON: Stencil = {
  id: "button",
  name: "按钮",
  category: "基础",
  w: 120,
  h: 44,
  keys: ["button", "btn", "按钮", "主按钮", "cta"],
  build: (b, id) => [
    labelled(id("btn"), b, "按钮", "按钮", {
      radius: Math.min(b.h / 2, 22),
      fills: [{ type: "solid", color: ACCENT }],
      size: 15,
      weight: 600,
      color: "#ffffff",
    }),
  ],
};

const BUTTON_OUTLINE: Stencil = {
  id: "button-outline",
  name: "描边按钮",
  category: "基础",
  w: 120,
  h: 44,
  keys: ["button", "次要按钮", "outline", "ghost", "描边按钮"],
  build: (b, id) => [
    labelled(id("btn"), b, "描边按钮", "按钮", {
      radius: Math.min(b.h / 2, 22),
      fills: [{ type: "solid", color: "#ffffff" }],
      strokes: [{ color: ACCENT, width: 1.5, align: "inside" }],
      size: 15,
      weight: 600,
      color: ACCENT,
    }),
  ],
};

const TAG: Stencil = {
  id: "tag",
  name: "标签",
  category: "基础",
  w: 64,
  h: 24,
  keys: ["tag", "chip", "badge", "标签", "徽标"],
  build: (b, id) => [
    labelled(id("tag"), b, "标签", "标签", {
      radius: Math.min(b.h / 2, 12),
      fills: [{ type: "solid", color: "#eaf4ff" }],
      size: 12,
      color: ACCENT,
    }),
  ],
};

const PLACEHOLDER: Stencil = {
  id: "placeholder",
  name: "占位符",
  category: "基础",
  w: 160,
  h: 120,
  keys: ["placeholder", "占位", "图片占位", "image", "graybox"],
  build: (b, id) => {
    const s = Math.min(b.w, b.h) * 0.2;
    return [
      rect(id("ph"), b, {
        name: "占位符",
        radius: Math.min(8, s / 2),
        fills: [{ type: "solid", color: SOFT }],
        strokes: [{ color: LINE, width: 1, align: "inside", style: "dashed" }],
      }),
      icon(id("ic"), { x: b.x + (b.w - s) / 2, y: b.y + (b.h - s) / 2, w: s, h: s }, "图片", "image", MUTED, 1.5),
    ];
  },
};

const LINK_AREA: Stencil = {
  id: "link-area",
  name: "链接区域",
  category: "基础",
  w: 160,
  h: 44,
  keys: ["link", "hotspot", "热区", "链接区域", "点击区域"],
  build: (b, id) => [
    labelled(id("hot"), b, "链接区域", "链接区域", {
      radius: 6,
      fills: [{ type: "solid", color: "#f0f7ff" }],
      strokes: [{ color: ACCENT, width: 1, align: "inside", style: "dashed" }],
      size: 12,
      color: ACCENT,
    }),
  ],
};

const TABLE: Stencil = {
  id: "table",
  name: "表格",
  category: "基础",
  w: 320,
  h: 160,
  keys: ["table", "表格", "grid", "数据表"],
  build: (b, id) => {
    const rows = 4;
    const cols = 3;
    const rowH = b.h / rows;
    const colW = b.w / cols;
    const out: StencilSpec[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = { x: b.x + c * colW, y: b.y + r * rowH, w: colW, h: rowH };
        out.push(
          r === 0
            ? labelled(id(`h${c}`), cell, `表头${c + 1}`, c === 0 ? "名称" : c === 1 ? "数值" : "备注", {
                radius: 0,
                fills: [{ type: "solid", color: SOFT }],
                strokes: [{ color: LINE, width: 1, align: "inside" }],
                size: 12,
                weight: 600,
                color: INK,
              })
            : rect(id(`c${r}${c}`), cell, {
                name: `单元格${r}-${c + 1}`,
                radius: 0,
                fills: [{ type: "solid", color: "#ffffff" }],
                strokes: [{ color: LINE, width: 1, align: "inside" }],
              }),
        );
      }
    }
    return out;
  },
};

const SCROLL_PANEL: Stencil = {
  id: "scroll-panel",
  name: "滚动面板",
  category: "基础",
  w: 240,
  h: 200,
  keys: ["scroll", "滚动", "滚动区域", "scrollarea", "长页面"],
  build: (b, id) => {
    const barW = Math.max(3, b.w * 0.02);
    return [
      {
        id: id("sc"),
        type: "frame",
        name: "滚动面板",
        ...b,
        radius: 10,
        fills: [{ type: "solid", color: "#ffffff" }],
        strokes: [{ color: LINE, width: 1, align: "inside" }],
        scroll: "v",
        clip: true,
        children: [
          rect(id("body"), { x: 0, y: 0, w: b.w - barW * 3, h: b.h * 2 }, {
            name: "可滚动内容",
            radius: 0,
            fills: [{ type: "solid", color: "#fafafa" }],
          }),
          text(id("tip"), { x: 0, y: 10, w: b.w - barW * 3, h: 18 }, "内容区（预览里可滚）", { size: 11, color: MUTED }),
          rect(id("bar"), { x: b.w - barW - 2, y: 4, w: barW, h: b.h * 0.4 }, {
            name: "滚动条",
            radius: barW / 2,
            fills: [{ type: "solid", color: "#c9c9cf" }],
            strokes: [],
          }),
        ],
      },
    ];
  },
};

const DIVIDER: Stencil = {
  id: "divider",
  name: "分割线",
  category: "基础",
  w: 240,
  h: 1,
  keys: ["divider", "hr", "separator", "分割线", "分隔线"],
  build: (b, id) => [
    { id: id("ln"), type: "line", name: "分割线", x: b.x, y: b.y, w: b.w, h: Math.max(0.5, b.h), dir: 0, strokes: [{ color: LINE, width: 1 }] },
  ],
};

/* ---------------- 形状 ---------------- */

const CAPSULE: Stencil = {
  id: "capsule",
  name: "胶囊",
  category: "形状",
  w: 120,
  h: 44,
  keys: ["capsule", "pill", "胶囊", "圆角矩形"],
  build: (b, id) => [rect(id("cap"), b, { name: "胶囊", radius: Math.min(b.h / 2, b.w / 2), fills: [{ type: "solid", color: SOFT }] })],
};

const POLYGON: Stencil = {
  id: "polygon",
  name: "多边形",
  category: "形状",
  w: 120,
  h: 120,
  keys: ["polygon", "hexagon", "多边形", "六边形"],
  build: (b, id) => [
    { id: id("pg"), type: "hexagon", name: "多边形", ...b, fills: [{ type: "solid", color: SOFT }], strokes: [{ color: MUTED, width: 1, align: "inside" }] },
  ],
};

const BUBBLE: Stencil = {
  id: "bubble",
  name: "气泡框",
  category: "形状",
  w: 160,
  h: 64,
  keys: ["bubble", "气泡", "对话框", "tooltip", "聊天气泡"],
  build: (b, id) => {
    const tail = Math.max(8, Math.min(14, b.h / 3.5));
    const bodyH = b.h - tail;
    return [
      labelled(id("body"), { x: b.x, y: b.y, w: b.w, h: bodyH }, "气泡", "气泡文字", {
        radius: 10,
        fills: [{ type: "solid", color: SOFT }],
        strokes: [{ color: LINE, width: 1, align: "inside" }],
        size: 13,
        color: INK,
      }),
      {
        id: id("tail"),
        type: "vector",
        name: "气泡尖",
        x: b.x + b.w * 0.12,
        y: b.y + bodyH - 1,
        w: tail,
        h: tail,
        path: `M0 0L${tail} 0L0 ${tail}Z`,
        fills: [{ type: "solid", color: SOFT }],
        strokes: [],
      },
    ];
  },
};

const WAVE: Stencil = {
  id: "wave",
  name: "波浪",
  category: "形状",
  w: 240,
  h: 40,
  keys: ["wave", "波浪", "曲线", "装饰"],
  build: (b, id) => {
    const steps = 4;
    const seg = b.w / (steps * 2);
    let d = `M0 ${b.h * 0.6}`;
    for (let i = 0; i < steps; i++) {
      d += ` Q${seg * (i * 2 + 0.5)} ${b.h * 0.05} ${seg * (i * 2 + 1)} ${b.h * 0.6}`;
      d += ` Q${seg * (i * 2 + 1.5)} ${b.h * 0.95} ${seg * (i * 2 + 2)} ${b.h * 0.6}`;
    }
    d += ` L${b.w} ${b.h} L0 ${b.h}Z`;
    return [{ id: id("wv"), type: "vector", name: "波浪", ...b, path: d, fills: [{ type: "solid", color: SOFT }], strokes: [] }];
  },
};

/* ---------------- 流程 ---------------- */

const FLOW: Stencil = {
  id: "flow-process",
  name: "流程",
  category: "流程",
  w: 140,
  h: 56,
  keys: ["process", "流程", "步骤", "矩形框"],
  build: (b, id) => [
    labelled(id("n"), b, "流程", "流程", {
      radius: 6,
      fills: [{ type: "solid", color: "#ffffff" }],
      strokes: [{ color: FLOW_LINE, width: 1.5, align: "inside" }],
      size: 13,
      color: FLOW_INK,
    }),
  ],
};

const FLOW_DECISION: Stencil = {
  id: "flow-decision",
  name: "判定",
  category: "流程",
  w: 140,
  h: 90,
  keys: ["decision", "judge", "判定", "菱形", "条件"],
  build: (b, id) => [
    {
      id: id("d"),
      type: "diamond",
      name: "判定",
      ...b,
      fills: [{ type: "solid", color: "#ffffff" }],
      strokes: [{ color: FLOW_LINE, width: 1.5, align: "inside" }],
      text: shapeLabel("条件？", { size: 12, color: FLOW_INK }),
    },
  ],
};

const FLOW_TERMINAL: Stencil = {
  id: "flow-terminal",
  name: "开始/结束",
  category: "流程",
  w: 140,
  h: 52,
  keys: ["terminal", "start", "end", "开始", "结束", "起止"],
  build: (b, id) => [
    labelled(id("t"), b, "开始/结束", "开始", {
      radius: b.h / 2,
      fills: [{ type: "solid", color: "#ffffff" }],
      strokes: [{ color: FLOW_LINE, width: 1.5, align: "inside" }],
      size: 13,
      color: FLOW_INK,
    }),
  ],
};

const FLOW_DOCUMENT: Stencil = {
  id: "flow-document",
  name: "文档",
  category: "流程",
  w: 140,
  h: 80,
  keys: ["document", "文档", "波浪底"],
  build: (b, id) => {
    const waveH = Math.max(8, Math.min(14, b.h * 0.2));
    const d =
      `M0 0 L${b.w} 0 L${b.w} ${b.h - waveH}` +
      ` Q${b.w * 0.75} ${b.h - waveH * 2.2} ${b.w * 0.5} ${b.h - waveH}` +
      ` Q${b.w * 0.25} ${b.h - waveH * 0.1} 0 ${b.h - waveH} Z`;
    return [
      { id: id("doc"), type: "vector", name: "文档", ...b, path: d, fills: [{ type: "solid", color: "#ffffff" }], strokes: [{ color: FLOW_LINE, width: 1.5 }] },
      text(id("t"), { x: b.x, y: b.y, w: b.w, h: b.h - waveH }, "文档", { size: 12, color: FLOW_INK }),
    ];
  },
};

const FLOW_DATA: Stencil = {
  id: "flow-data",
  name: "数据",
  category: "流程",
  w: 140,
  h: 64,
  keys: ["data", "io", "数据", "输入输出", "平行四边形"],
  build: (b, id) => {
    const skew = Math.max(10, Math.min(20, b.w * 0.16));
    return [
      {
        id: id("io"),
        type: "vector",
        name: "数据",
        ...b,
        path: `M${skew} 0 L${b.w} 0 L${b.w - skew} ${b.h} L0 ${b.h} Z`,
        fills: [{ type: "solid", color: "#ffffff" }],
        strokes: [{ color: FLOW_LINE, width: 1.5 }],
      },
      text(id("t"), { x: b.x + skew / 2, y: b.y, w: b.w - skew, h: b.h }, "数据", { size: 12, color: FLOW_INK }),
    ];
  },
};

const FLOW_SUBPROCESS: Stencil = {
  id: "flow-subprocess",
  name: "子流程",
  category: "流程",
  w: 140,
  h: 56,
  keys: ["subprocess", "子流程", "预定义流程"],
  build: (b, id) => {
    const rail = Math.max(1.5, b.w * 0.012);
    const inset = Math.max(6, b.w * 0.06);
    return [
      labelled(id("bg"), b, "子流程", "子流程", {
        radius: 6,
        fills: [{ type: "solid", color: "#ffffff" }],
        strokes: [{ color: FLOW_LINE, width: 1.5, align: "inside" }],
        size: 13,
        color: FLOW_INK,
      }),
      rect(id("l"), { x: b.x + inset, y: b.y, w: rail, h: b.h }, { name: "左边线", radius: 0, fills: [{ type: "solid", color: FLOW_LINE }], strokes: [] }),
      rect(id("r"), { x: b.x + b.w - inset - rail, y: b.y, w: rail, h: b.h }, { name: "右边线", radius: 0, fills: [{ type: "solid", color: FLOW_LINE }], strokes: [] }),
    ];
  },
};

/* ---------------- 图表 ---------------- */

/** 极坐标取点（角度制，0° = 12 点方向，顺时针） */
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function sectorPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const [x1, y1] = polar(cx, cy, r, from);
  const [x2, y2] = polar(cx, cy, r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M${cx} ${cy} L${x1} ${y1} A${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
}

const CHART_PIE: Stencil = {
  id: "chart-pie",
  name: "饼状图",
  category: "图表",
  w: 160,
  h: 160,
  keys: ["pie", "饼图", "饼状图", "占比"],
  build: (b, id) => {
    const cx = b.w / 2;
    const cy = b.h / 2;
    const r = Math.min(b.w, b.h) / 2;
    const cuts = [0, 140, 250, 360];
    const colors = [ACCENT, "#7a5cff", "#ff9f43", "#e6e6e6"];
    return cuts.slice(0, -1).map((from, i) => ({
      id: id(`s${i}`),
      type: "vector",
      name: `扇区${i + 1}`,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      path: sectorPath(cx, cy, r, from, cuts[i + 1]!),
      fills: [{ type: "solid", color: colors[i]! }],
      strokes: [{ color: "#ffffff", width: 2 }],
    }));
  },
};

const CHART_DONUT: Stencil = {
  id: "chart-donut",
  name: "环形图",
  category: "图表",
  w: 160,
  h: 160,
  keys: ["donut", "环形图", "圆环图", "占比"],
  build: (b, id) => {
    const r = Math.min(b.w, b.h) / 2;
    const thick = Math.max(10, r * 0.36);
    return [
      { id: id("ring"), type: "ellipse", name: "底环", ...b, fills: [], strokes: [{ color: "#eaf2ff", width: thick, align: "inside" }] },
      { id: id("arc"), type: "ellipse", name: "数据环", ...b, fills: [], strokes: [{ color: ACCENT, width: thick, align: "inside" }] },
    ];
  },
};

const CHART_PROGRESS_RING: Stencil = {
  id: "chart-progress-ring",
  name: "进度圆环",
  category: "图表",
  w: 120,
  h: 120,
  keys: ["progress", "ring", "进度圆环", "loading", "百分比"],
  build: (b, id) => {
    const r = Math.min(b.w, b.h) / 2;
    const thick = Math.max(8, r * 0.16);
    return [
      { id: id("bg"), type: "ellipse", name: "底环", ...b, fills: [], strokes: [{ color: "#eef0f3", width: thick, align: "inside" }] },
      { id: id("fg"), type: "ellipse", name: "进度", ...b, fills: [], strokes: [{ color: ACCENT, width: thick, align: "inside" }] },
      text(id("t"), b, "68%", { size: Math.max(12, Math.round(r * 0.42)), weight: 600, color: INK }),
    ];
  },
};

const CHART_BAR: Stencil = {
  id: "chart-bar",
  name: "柱状图",
  category: "图表",
  w: 200,
  h: 140,
  keys: ["bar", "column", "柱状图", "条形图"],
  build: (b, id) => {
    const series = [0.45, 0.75, 0.35, 0.9, 0.6];
    const gap = b.w * 0.04;
    const barW = (b.w - gap * (series.length - 1)) / series.length;
    const out: StencilSpec[] = [
      { id: id("axis"), type: "line", name: "基线", x: b.x, y: b.y + b.h, w: b.w, h: 0.5, dir: 1, strokes: [{ color: LINE, width: 1 }] },
    ];
    series.forEach((v, i) => {
      const h = Math.max(2, b.h * v);
      out.push(
        rect(id(`b${i}`), { x: b.x + i * (barW + gap), y: b.y + b.h - h, w: barW, h }, {
          name: `柱${i + 1}`,
          radius: 3,
          fills: [{ type: "solid", color: i === 3 ? ACCENT : "#b9dcff" }],
        }),
      );
    });
    return out;
  },
};

const CHART_AREA: Stencil = {
  id: "chart-area",
  name: "面积图",
  category: "图表",
  w: 200,
  h: 140,
  keys: ["area", "line", "面积图", "折线图", "趋势"],
  build: (b, id) => {
    const vals = [0.3, 0.55, 0.4, 0.8, 1];
    const step = b.w / (vals.length - 1);
    const yOf = (v: number) => b.h - b.h * v;
    let line = `M0 ${yOf(vals[0]!)}`;
    for (let i = 1; i < vals.length; i++) line += ` L${step * i} ${yOf(vals[i]!)}`;
    return [
      { id: id("area"), type: "vector", name: "面积", ...b, path: `${line} L${b.w} ${b.h} L0 ${b.h}Z`, fills: [{ type: "solid", color: "#e3f0ff" }], strokes: [] },
      { id: id("ln"), type: "vector", name: "折线", ...b, path: line, fills: [], strokes: [{ color: ACCENT, width: 2 }] },
    ];
  },
};

const CHART_RADAR: Stencil = {
  id: "chart-radar",
  name: "雷达图",
  category: "图表",
  w: 160,
  h: 160,
  keys: ["radar", "spider", "雷达图", "综合评价"],
  build: (b, id) => {
    const cx = b.w / 2;
    const cy = b.h / 2;
    const r = Math.min(b.w, b.h) / 2;
    const n = 5;
    const out: StencilSpec[] = [];
    for (let ring = 3; ring >= 1; ring--) {
      const rad = (r * ring) / 3;
      let d = "";
      for (let i = 0; i < n; i++) {
        const [x, y] = polar(cx, cy, rad, (360 / n) * i);
        d += `${i === 0 ? "M" : "L"}${x} ${y}`;
      }
      out.push({
        id: id(`g${ring}`),
        type: "vector",
        name: `网格${ring}`,
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        path: `${d}Z`,
        fills: [],
        strokes: [{ color: ring === 1 ? LINE : "#e9e9ec", width: 1 }],
      });
    }
    const shape = [1, 0.72, 0.9, 0.55, 0.8];
    let d = "";
    for (let i = 0; i < n; i++) {
      const [x, y] = polar(cx, cy, r * shape[i]!, (360 / n) * i);
      d += `${i === 0 ? "M" : "L"}${x} ${y}`;
    }
    out.push({
      id: id("data"),
      type: "vector",
      name: "数据",
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      path: `${d}Z`,
      fills: [{ type: "solid", color: "#0d99ff33" }],
      strokes: [{ color: ACCENT, width: 2 }],
    });
    return out;
  },
};

/* ---------------- 界面 ---------------- */

const STATUS_BAR: Stencil = {
  id: "status-bar",
  name: "状态栏",
  category: "界面",
  w: 390,
  h: 44,
  keys: ["status", "状态栏", "信号", "电量", "ios"],
  build: (b, id) => {
    const pad = Math.round(b.w * 0.06);
    const dot = Math.min(b.h * 0.34, 16);
    return [
      rect(id("bg"), b, { name: "状态栏", radius: 0, fills: [{ type: "solid", color: "#ffffff" }], strokes: [] }),
      text(id("time"), { x: b.x + pad, y: b.y, w: 60, h: b.h }, "9:41", { align: "left", size: Math.round(dot * 1.1), weight: 600, color: INK }),
      icon(id("sig"), { x: b.x + b.w - pad - dot * 3.2, y: b.y + (b.h - dot) / 2, w: dot, h: dot }, "信号", "signal", INK, 2.4),
      icon(id("wifi"), { x: b.x + b.w - pad - dot * 2.1, y: b.y + (b.h - dot) / 2, w: dot, h: dot }, "无线", "wifi", INK, 2.4),
      rect(id("bat"), { x: b.x + b.w - pad - dot, y: b.y + (b.h - dot * 0.62) / 2, w: dot, h: dot * 0.62 }, {
        name: "电量",
        radius: 2,
        fills: [{ type: "solid", color: INK }],
        strokes: [],
      }),
    ];
  },
};

const NAV_BAR: Stencil = {
  id: "nav-bar",
  name: "导航栏",
  category: "界面",
  w: 390,
  h: 48,
  keys: ["nav", "navbar", "导航栏", "标题栏", "顶栏", "appbar"],
  build: (b, id) => {
    const a = Math.min(b.h * 0.34, 20);
    return [
      rect(id("bg"), b, { name: "导航栏", radius: 0, fills: [{ type: "solid", color: "#ffffff" }], strokes: [] }),
      labelled(id("t"), b, "标题", "标题", { fills: [], size: 16, weight: 600, color: INK }),
      { id: id("back"), type: "arrow", name: "返回", x: b.x + b.w * 0.035, y: b.y + (b.h - a) / 2, w: a, h: a, dir: 2, strokes: [{ color: INK, width: 2 }] },
    ];
  },
};

const TAB_BAR: Stencil = {
  id: "tab-bar",
  name: "底部标签栏",
  category: "界面",
  w: 390,
  h: 64,
  keys: ["tab", "tabbar", "标签栏", "底部导航", "bottomnav"],
  build: (b, id) => {
    const items = [
      { glyph: "home", name: "首页" },
      { glyph: "search", name: "发现" },
      { glyph: "heart", name: "收藏" },
      { glyph: "user", name: "我的" },
    ];
    const colW = b.w / items.length;
    const s = Math.min(b.h * 0.3, 24);
    const out: StencilSpec[] = [
      rect(id("bg"), b, { name: "标签栏", radius: 0, fills: [{ type: "solid", color: "#ffffff" }], strokes: [] }),
      { id: id("ln"), type: "line", name: "上边线", x: b.x, y: b.y, w: b.w, h: 0.5, dir: 0, strokes: [{ color: LINE, width: 1 }] },
    ];
    items.forEach((it, i) => {
      const cx = b.x + colW * (i + 0.5);
      const active = i === 0;
      const color = active ? ACCENT : MUTED;
      out.push(icon(id(`i${i}`), { x: cx - s / 2, y: b.y + b.h * 0.18, w: s, h: s }, it.name, it.glyph, color, 2));
      out.push(text(id(`t${i}`), { x: cx - colW / 2, y: b.y + b.h * 0.6, w: colW, h: b.h * 0.24 }, it.name, { size: 10, color }));
    });
    return out;
  },
};

const SEARCH_BAR: Stencil = {
  id: "search-bar",
  name: "搜索框",
  category: "界面",
  w: 240,
  h: 36,
  keys: ["search", "搜索框", "搜索栏", "searchbar"],
  build: (b, id) => {
    const s = Math.min(b.h * 0.42, 18);
    return [
      rect(id("bg"), b, { name: "搜索框", radius: Math.min(b.h / 2, 18), fills: [{ type: "solid", color: SOFT }], strokes: [] }),
      icon(id("ic"), { x: b.x + b.h * 0.3, y: b.y + (b.h - s) / 2, w: s, h: s }, "搜索", "search", MUTED, 2),
      text(id("t"), { x: b.x + b.h * 0.3 + s + 6, y: b.y, w: b.w - b.h - s, h: b.h }, "搜索", { align: "left", size: 13, color: MUTED }),
    ];
  },
};

const LIST_ITEM: Stencil = {
  id: "list-item",
  name: "列表项",
  category: "界面",
  w: 390,
  h: 56,
  keys: ["listitem", "cell", "列表项", "设置项", "行"],
  build: (b, id) => {
    const s = Math.min(b.h * 0.34, 20);
    const pad = Math.min(16, b.w * 0.05);
    return [
      rect(id("bg"), b, { name: "列表项", radius: 0, fills: [{ type: "solid", color: "#ffffff" }], strokes: [] }),
      text(id("t"), { x: b.x + pad, y: b.y, w: b.w - pad * 2 - s - 8, h: b.h }, "列表项标题", { align: "left", size: 15, color: INK }),
      icon(id("c"), { x: b.x + b.w - pad - s, y: b.y + (b.h - s) / 2, w: s, h: s }, "箭头", "chevron-right", MUTED, 2),
      { id: id("ln"), type: "line", name: "下边线", x: b.x + pad, y: b.y + b.h - 0.5, w: b.w - pad, h: 0.5, dir: 0, strokes: [{ color: "#efeff1", width: 1 }] },
    ];
  },
};

const CARD: Stencil = {
  id: "card",
  name: "卡片",
  category: "界面",
  w: 320,
  h: 104,
  keys: ["card", "卡片", "内容卡", "thumbnail"],
  build: (b, id) => {
    const pad = Math.round(Math.min(b.w, b.h) * 0.09);
    const thumb = Math.min(b.h - pad * 2, b.w * 0.28);
    const textW = Math.max(20, b.w - thumb - pad * 3);
    return [
      rect(id("bg"), b, {
        name: "卡片",
        radius: 14,
        fills: [{ type: "solid", color: "#ffffff" }],
        strokes: [],
        effects: [{ type: "drop-shadow", color: "#00000014", x: 0, y: 2, blur: 10 }],
      }),
      rect(id("thumb"), { x: b.x + b.w - pad - thumb, y: b.y + (b.h - thumb) / 2, w: thumb, h: thumb }, {
        name: "缩略图",
        radius: Math.min(10, thumb / 3),
        fills: [{ type: "linear", angle: 135, stops: [{ at: 0, color: "#ff9f43" }, { at: 1, color: "#ff5c8a" }] }],
        strokes: [],
      }),
      text(id("t"), { x: b.x + pad, y: b.y + b.h * 0.24, w: textW, h: b.h * 0.26 }, "卡片标题", { align: "left", size: 15, weight: 600, color: INK }),
      text(id("s"), { x: b.x + pad, y: b.y + b.h * 0.54, w: textW, h: b.h * 0.26 }, "一句话说明文字", { align: "left", size: 12, color: MUTED }),
    ];
  },
};

/* ---------------- 注册表 ---------------- */

export const STENCILS: Stencil[] = [
  BUTTON,
  BUTTON_OUTLINE,
  TAG,
  PLACEHOLDER,
  LINK_AREA,
  TABLE,
  SCROLL_PANEL,
  DIVIDER,
  CAPSULE,
  POLYGON,
  BUBBLE,
  WAVE,
  FLOW,
  FLOW_DECISION,
  FLOW_TERMINAL,
  FLOW_DOCUMENT,
  FLOW_DATA,
  FLOW_SUBPROCESS,
  CHART_PIE,
  CHART_DONUT,
  CHART_PROGRESS_RING,
  CHART_BAR,
  CHART_AREA,
  CHART_RADAR,
  STATUS_BAR,
  NAV_BAR,
  TAB_BAR,
  SEARCH_BAR,
  LIST_ITEM,
  CARD,
];

export const STENCIL_CATEGORIES: StencilCategory[] = ["基础", "形状", "流程", "图表", "界面"];

export const findStencil = (id: string): Stencil | undefined => STENCILS.find((s) => s.id === id);

/**
 * 关键词检索：id/名称精确 > 前缀 > 关键词精确 > 子串 > 分类命中。
 * 中英文都能搜（"按钮" 与 "button" 命中同一条）。
 */
export function searchStencils(query: string, limit = 60): Stencil[] {
  const q = query.trim().toLowerCase();
  if (!q) return STENCILS.slice(0, limit);
  const scored: { s: Stencil; score: number }[] = [];
  for (const s of STENCILS) {
    let score = 0;
    if (s.id === q) score = 100;
    else if (s.name.toLowerCase() === q) score = 90;
    else if (s.id.startsWith(q)) score = 70;
    else if (s.name.toLowerCase().startsWith(q)) score = 60;
    else if (s.keys.some((k) => k.toLowerCase() === q)) score = 50;
    else if (s.name.toLowerCase().includes(q)) score = 30;
    else if (s.keys.some((k) => k.toLowerCase().includes(q))) score = 20;
    else if (s.category.includes(q)) score = 10;
    if (score > 0) scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
  return scored.slice(0, limit).map((x) => x.s);
}

/* ---------------- 生成 ---------------- */

/**
 * 按目标框生成规格。三步分明，避免"缩放两次"这类错：
 *   ① 在**标称尺寸**、原点 (0,0) 处生成（生成器内部的 pad/thick 派生量全按标称算，
 *      量纲唯一）；
 *   ② 整体等比缩放 k（不做非等比拉伸——图表/图标一拉就变形，宁可留边）；
 *   ③ 只把**顶层**节点平移到目标框（居中留边；子节点是父容器局部坐标，不能平移）。
 */
export function buildStencilSpecs(
  stencil: Stencil,
  box: { x: number; y: number; w?: number; h?: number },
  idFn: IdFn,
): StencilSpec[] {
  const w = Math.max(4, Math.round(box.w || stencil.w));
  const h = Math.max(1, Math.round(box.h || stencil.h));
  const k = Math.min(w / stencil.w, h / stencil.h);
  const specs = scaleSpecs(stencil.build({ x: 0, y: 0, w: stencil.w, h: stencil.h }, idFn), k);
  const ox = Math.round((box.x + (w - stencil.w * k) / 2) * 10) / 10;
  const oy = Math.round((box.y + (h - stencil.h * k) / 2) * 10) / 10;
  if (ox === 0 && oy === 0) return specs;
  return specs.map((s) => ({
    ...s,
    x: Math.round(((typeof s.x === "number" ? s.x : 0) + ox) * 10) / 10,
    y: Math.round(((typeof s.y === "number" ? s.y : 0) + oy) * 10) / 10,
  }));
}

/** 几何/字号/描边/圆角/阴影按 k 缩放（等比，故一个系数够用）。只缩放，不平移。 */
function scaleSpecs(specs: StencilSpec[], k: number): StencilSpec[] {
  if (k === 1) return specs;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return specs.map((s) => {
    const out: StencilSpec = { ...s };
    for (const key of ["x", "y", "w", "h"] as const) {
      const v = out[key];
      if (typeof v === "number") out[key] = r1(v * k);
    }
    if (typeof out.radius === "number") out.radius = r1(out.radius);
    else if (Array.isArray(out.radius)) out.radius = (out.radius as number[]).map(r1);
    if (Array.isArray(out.strokes)) {
      out.strokes = (out.strokes as Record<string, unknown>[]).map((st) =>
        typeof st.width === "number" ? { ...st, width: Math.max(0.5, r1(st.width * k)) } : st,
      );
    }
    if (Array.isArray(out.effects)) {
      out.effects = (out.effects as Record<string, unknown>[]).map((fx) => {
        const o = { ...fx };
        for (const key of ["x", "y", "blur"] as const) if (typeof o[key] === "number") o[key] = r1((o[key] as number) * k);
        return o;
      });
    }
    if (typeof out.size === "number") out.size = Math.max(6, Math.round(out.size * k));
    if (typeof out.strokeWidth === "number") out.strokeWidth = Math.max(0.5, r1(out.strokeWidth * k));
    // 形状内嵌标签：字号随比例走，否则大按钮配小字
    if (out.text && typeof out.text === "object" && !Array.isArray(out.text)) {
      const lt = out.text as { runs?: { size?: number }[] };
      if (Array.isArray(lt.runs)) {
        out.text = { ...lt, runs: lt.runs.map((r) => (typeof r.size === "number" ? { ...r, size: Math.max(6, Math.round(r.size * k)) } : r)) };
      }
    }
    if (Array.isArray(out.children)) out.children = scaleSpecs(out.children as StencilSpec[], k);
    return out;
  });
}

/**
 * 素材 → 真正的设计节点（**面板插入路径**）。
 *
 * 走 doc.ts 的 parseDesignDoc：这是文件格式的权威解析器，别名容错/字段校验/坐标夹取
 * 全都在里面。合成一份只有这一页的临时文档给它，产出的节点与"用户自己写了这份 JSON
 * 再打开"完全一致——面板不需要第二套 spec→node 逻辑。
 */
export function stencilNodes(
  stencil: Stencil,
  box: { x: number; y: number; w?: number; h?: number },
  idFn: IdFn,
): DesignNode[] {
  const specs = buildStencilSpecs(stencil, box, idFn);
  const tmp = {
    version: 1,
    meta: { name: "stencil", kind: "uidesign" },
    activePage: "s",
    pages: [{ id: "s", name: "stencil", nodes: specs }],
  };
  const res = parseDesignDoc(JSON.stringify(tmp));
  return res.doc.pages[0]?.nodes ?? [];
}

/** 素材里用到的节点类型（测试与文档用） */
export function stencilTypes(): string[] {
  const out = new Set<string>();
  for (const s of STENCILS) {
    for (const spec of s.build({ x: 0, y: 0, w: s.w, h: s.h }, (hint) => hint)) {
      if (typeof spec.type === "string") out.add(spec.type);
    }
  }
  return [...out];
}
