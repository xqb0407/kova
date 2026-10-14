/**
 * 内置模板库：主题 token × 版式原型 两层结构。
 *
 * 设计原则（原创、扁平）：
 * - 主题只是一组颜色/圆角 token（ThemeTokens），版式是纯函数 (tokens,w,h)=>El[]，
 *   两者正交：N 主题 × M 版式 = N×M 种页，新增主题或版式互不牵连。
 * - 走扁平瑞士平面路线：纯色块、字阶对比、留白、细线——画布元素模型
 *   （纯色填充 + 文本 + 线形）能 1:1 表达，所见即所得，导出不降级。
 * - 全部用占位文案，几何按 16:9（1280×720）设计，4:3/A4L 按 w/h 比例公式自适应。
 * - 纯函数、无 React/DOM 依赖，可单测（ui/test/templates.test.ts）。
 */

import { blankFrame, uid, type El, type Frame, type PagePreset, type ShapeEl, type TextEl, type TextRun } from "./doc";

/* ---------------- 主题 token ---------------- */

/** 一套主题的颜色语义：页面底色、文字三级、强调两级、面板两级、线、强调上的文字 */
export type ThemeTokens = {
  /** 页背景（纯色，保证 DOM/导出一致） */
  bg: string;
  /** 主文字 */
  ink: string;
  /** 次级文字 */
  sub: string;
  /** 弱化文字（页脚/来源） */
  faint: string;
  /** 主强调色 */
  accent: string;
  /** 副强调色（象限/对比的第二色） */
  accent2: string;
  /** 强调色的浅底（标签底/大数字底） */
  accentSoft: string;
  /** 卡片面板底 */
  panel: string;
  /** 交替面板底 */
  panelAlt: string;
  /** 分隔线 */
  line: string;
  /** 强调色块上的文字 */
  onAccent: string;
  /** mermaid 跟随建议 */
  mermaid: "default" | "dark" | "neutral";
  /** 卡片圆角 */
  radius: number;
};

export type TemplateTheme = {
  id: string;
  label: string;
  hint: string;
  tokens: ThemeTokens;
};

/** 晴川：白底蓝调商务，细线分区，冷静克制 */
const QINGCHUAN: ThemeTokens = {
  bg: "#ffffff", ink: "#17202a", sub: "#5d6b7a", faint: "#9aa7b5",
  accent: "#2563eb", accent2: "#0e7490", accentSoft: "#eaf1fe",
  panel: "#f5f7fa", panelAlt: "#edf1f6", line: "#e2e8f0",
  onAccent: "#ffffff", mermaid: "default", radius: 12,
};

/** 暖阳：奶油纸底 + 橘红强调，亲和有温度 */
const NUANYANG: ThemeTokens = {
  bg: "#faf5ee", ink: "#2b2118", sub: "#7a6a58", faint: "#ab9a82",
  accent: "#de5b26", accent2: "#a16207", accentSoft: "#fae8dc",
  panel: "#f3eae0", panelAlt: "#efe2d3", line: "#e6d9c8",
  onAccent: "#ffffff", mermaid: "default", radius: 16,
};

/** 夜航：深海军蓝 + 青色强调，科技感 */
const YEHANG: ThemeTokens = {
  bg: "#0b1526", ink: "#edf2f7", sub: "#9fb0c3", faint: "#5d7188",
  accent: "#38bdf8", accent2: "#a78bfa", accentSoft: "#12344b",
  panel: "#132238", panelAlt: "#182b47", line: "#223852",
  onAccent: "#06121d", mermaid: "dark", radius: 12,
};

/** 曜金：墨黑 + 鎏金，正式庄重 */
const YAOJIN: ThemeTokens = {
  bg: "#141311", ink: "#f2ebdd", sub: "#a79e8d", faint: "#6e675b",
  accent: "#d2a24c", accent2: "#8c7853", accentSoft: "#2e2415",
  panel: "#1e1c18", panelAlt: "#262219", line: "#312b21",
  onAccent: "#141311", mermaid: "dark", radius: 8,
};

/** 青苔：白底 + 苔绿，清爽自然 */
const QINGTAI: ThemeTokens = {
  bg: "#fbfdfb", ink: "#14231c", sub: "#55685e", faint: "#8fa398",
  accent: "#0e9f6e", accent2: "#0f766e", accentSoft: "#e3f4ec",
  panel: "#f0f7f3", panelAlt: "#e6f1ea", line: "#dce8e1",
  onAccent: "#ffffff", mermaid: "default", radius: 16,
};

/** 雾蓝：冷灰蓝底 + 靛蓝，稳重内敛 */
const WULAN: ThemeTokens = {
  bg: "#f6f8fb", ink: "#1e293b", sub: "#64748b", faint: "#94a3b8",
  accent: "#4f46e5", accent2: "#0891b2", accentSoft: "#e0e7ff",
  panel: "#eef2f7", panelAlt: "#e5eaf2", line: "#dbe2ec",
  onAccent: "#ffffff", mermaid: "default", radius: 12,
};

/** 绯樱：樱粉底 + 玫红，消费与品牌感 */
const FEIYING: ThemeTokens = {
  bg: "#fff7f8", ink: "#2a1520", sub: "#8c6b76", faint: "#b99aa4",
  accent: "#e11d48", accent2: "#7c3aed", accentSoft: "#ffe4e9",
  panel: "#fdf0f2", panelAlt: "#fbe4e9", line: "#f4dde3",
  onAccent: "#ffffff", mermaid: "default", radius: 16,
};

/** 墨白：纯白 + 黑 + 瑞士红，直角极简 */
const MOBAI: ThemeTokens = {
  bg: "#ffffff", ink: "#141414", sub: "#57534e", faint: "#a8a29e",
  accent: "#d92626", accent2: "#141414", accentSoft: "#fdecec",
  panel: "#f5f5f4", panelAlt: "#ebebea", line: "#e5e5e3",
  onAccent: "#ffffff", mermaid: "neutral", radius: 0,
};

export const TEMPLATE_THEMES: TemplateTheme[] = [
  { id: "qingchuan", label: "晴川", hint: "白底蓝调 · 商务通用", tokens: QINGCHUAN },
  { id: "nuanyang", label: "暖阳", hint: "奶油橘 · 亲和汇报", tokens: NUANYANG },
  { id: "yehang", label: "夜航", hint: "深蓝青 · 科技发布", tokens: YEHANG },
  { id: "yaojin", label: "曜金", hint: "墨黑金 · 正式致辞", tokens: YAOJIN },
  { id: "qingtai", label: "青苔", hint: "苔绿 · 清爽轻快", tokens: QINGTAI },
  { id: "wulan", label: "雾蓝", hint: "靛蓝 · 稳重科技", tokens: WULAN },
  { id: "feiying", label: "绯樱", hint: "樱粉 · 消费品牌", tokens: FEIYING },
  { id: "mobai", label: "墨白", hint: "黑白红 · 极简锐利", tokens: MOBAI },
];

export const themeById = (id: string): TemplateTheme => TEMPLATE_THEMES.find((t) => t.id === id) ?? TEMPLATE_THEMES[0]!;

/* ---------------- 元素小工厂 ---------------- */

const text = (x: number, y: number, w: number, h: number, runs: TextRun[], align?: TextEl["align"], vAlign?: TextEl["vAlign"]): TextEl => ({
  kind: "text", id: uid("t"), x: r(x), y: r(y), w: r(w), h: r(h), runs,
  ...(align ? { align } : {}), ...(vAlign ? { vAlign } : {}),
});

const rect = (x: number, y: number, w: number, h: number, fill: string, radius = 0, opacity?: number): ShapeEl => ({
  kind: "shape", id: uid("s"), shape: "rect", x: r(x), y: r(y), w: r(w), h: r(h), fill,
  ...(radius ? { radius } : {}), ...(opacity !== undefined ? { opacity } : {}),
});

const ellipse = (x: number, y: number, w: number, h: number, fill: string): ShapeEl => ({
  kind: "shape", id: uid("s"), shape: "ellipse", x: r(x), y: r(y), w: r(w), h: r(h), fill,
});

/** 细分隔线：1.5px 高的矩形（线形 shape 是对角线语义，横线用矩形更稳） */
const rule = (x: number, y: number, w: number, stroke: string): ShapeEl => rect(x, y, w, 1.5, stroke);

const run = (text: string, size: number, color: string, bold = false): TextRun => ({ text, size, color, ...(bold ? { bold: true } : {}) });

const r = (v: number) => Math.round(v * 10) / 10;

/* ---------------- 版式原型 ---------------- */

/**
 * 十个版式 = 一套通用 PPT 语法：封面/目录/章节/三卡/四象限/时间轴/对比/数据/金句/结尾。
 * 每个版式是 (tokens, w, h) => El[]：只依赖 token 语义色，不感知具体主题。
 */

export type LayoutId =
  | "cover" | "toc" | "section" | "cards3" | "quadrant" | "timeline"
  | "compare" | "stats" | "list" | "process" | "faq" | "table"
  | "quote" | "end";

export const LAYOUT_META: { id: LayoutId; label: string; desc: string }[] = [
  { id: "cover", label: "封面", desc: "主标题 + 副标题" },
  { id: "toc", label: "目录", desc: "双栏六条目" },
  { id: "section", label: "章节页", desc: "大编号过渡页" },
  { id: "cards3", label: "三要点", desc: "三栏卡片" },
  { id: "quadrant", label: "四象限", desc: "2×2 网格" },
  { id: "timeline", label: "时间轴", desc: "四节点横轴" },
  { id: "compare", label: "对比", desc: "双栏 VS" },
  { id: "stats", label: "数据", desc: "三组大数字" },
  { id: "list", label: "要点列表", desc: "横向四条" },
  { id: "process", label: "流程", desc: "三步箭头" },
  { id: "faq", label: "问答", desc: "三组 Q&A" },
  { id: "table", label: "表格", desc: "指标简表" },
  { id: "quote", label: "金句", desc: "大字引用" },
  { id: "end", label: "结尾", desc: "致谢 / Q&A" },
];

/** 内容页公共参数：版心边距与页头（kicker + 页标题） */
const MX = 92; // 左右边距
const TOP = 76; // 页头起始
const CARD_GAP = 24;

type Ctx = { t: ThemeTokens; w: number; h: number };

/** 内容页页头：左上 kicker（accent 小字）+ 大标题 + 底部页脚线 */
function pageHeader(c: Ctx, kicker: string, title: string): El[] {
  const { t, w, h } = c;
  return [
    text(MX, TOP, w - MX * 2, 22, [run(kicker, 13, t.accent, true)]),
    text(MX, TOP + 28, w - MX * 2, 46, [run(title, 32, t.ink, true)]),
    rule(MX, h - 58, w - MX * 2, t.line),
    text(MX, h - 50, w - MX * 2 - 8, 20, [run("公司名 · 演示文稿", 11, t.faint)]),
  ];
}

/** 大色块圆角卡片（panel 底） */
function card(c: Ctx, x: number, y: number, w: number, h: number, fill?: string): ShapeEl {
  return rect(x, y, w, h, fill ?? c.t.panel, c.t.radius);
}

function cover(c: Ctx): El[] {
  const { t, w, h } = c;
  return [
    // 右下大圆装饰：浅强调底，出血裁切
    ellipse(w - 210, h - 210, 360, 360, t.accentSoft),
    ellipse(w - 130, h - 300, 90, 90, t.panel),
    // 左上：标识占位
    rect(MX, TOP + 8, 30, 30, t.accent, 8),
    text(MX + 42, TOP + 8, 320, 30, [run("LOGO / 团队名", 14, t.sub)], "left", "middle"),
    // 标题块
    text(MX, h * 0.3, w * 0.72, 26, [run("QUARTERLY REPORT", 14, t.accent, true)]),
    text(MX, h * 0.36, w * 0.78, 150, [run("在这里写下主标题", 54, t.ink, true)], "left", "top"),
    text(MX, h * 0.58, w * 0.66, 32, [run("副标题：一句话说明这次分享的主题与受众", 19, t.sub)]),
    // 底部信息
    rule(MX, h - 92, w * 0.4, t.line),
    text(MX, h - 80, 400, 24, [run("汇报人 姓名 · 2026.09", 13, t.faint)]),
  ];
}

function toc(c: Ctx): El[] {
  const { t, w, h } = c;
  const els: El[] = pageHeader(c, "CONTENTS", "目录");
  const colW = (w - MX * 2 - CARD_GAP * 2) / 2;
  const rowH = 92;
  const items = ["项目背景与目标", "现状与问题分析", "解决方案总览", "关键数据与验证", "落地计划与排期", "风险与所需支持"];
  items.forEach((label, i) => {
    const col = Math.floor(i / 3);
    const row = i % 3;
    const x = MX + col * (colW + CARD_GAP);
    const y = 210 + row * rowH;
    els.push(
      text(x, y, 64, 40, [run(`0${i + 1}`, 26, t.accent, true)]),
      text(x + 66, y + 2, colW - 66, 26, [run(label, 19, t.ink, true)]),
      text(x + 66, y + 32, colW - 66, 22, [run("本章节的一句话概述占位", 13, t.sub)]),
    );
    if (row < 2) els.push(rule(x, y + rowH - 26, colW - 8, t.line));
  });
  return els;
}

function section(c: Ctx): El[] {
  const { t, w, h } = c;
  return [
    // 背景大编号（浅底色，作装饰水印）
    text(w - 430, h * 0.16, 380, 260, [run("01", 210, t.accentSoft, true)], "right"),
    rect(MX, h * 0.34, 56, 8, t.accent, 4),
    text(MX, h * 0.4, w * 0.62, 66, [run("章节标题占位", 44, t.ink, true)]),
    text(MX, h * 0.54, w * 0.56, 56, [run("这一章要回答的问题、覆盖的范围，\n以及接下来的展开顺序。", 16, t.sub)]),
    text(MX, h - 92, 300, 24, [run("SECTION 01", 13, t.faint, true)]),
  ];
}

function cards3(c: Ctx): El[] {
  const { t, w, h } = c;
  const els: El[] = pageHeader(c, "KEY POINTS", "这一页讲三件事");
  const cardW = (w - MX * 2 - CARD_GAP * 2) / 3;
  const cardY = 220;
  const cardH = h - cardY - 120;
  const titles = ["要点标题一", "要点标题二", "要点标题三"];
  titles.forEach((title, i) => {
    const x = MX + i * (cardW + CARD_GAP);
    els.push(card(c, x, cardY, cardW, cardH, i === 1 ? t.panelAlt : t.panel));
    els.push(rect(x + 28, cardY + 30, 30, 6, t.accent, 3));
    els.push(text(x + 28, cardY + 52, cardW - 56, 30, [run(title, 20, t.ink, true)]));
    els.push(
      text(
        x + 28,
        cardY + 92,
        cardW - 56,
        cardH - 120,
        [run("支撑这个要点的说明文字放在这里，\n建议两到三行讲清楚，\n不要把整段话直接贴进来。", 14, t.sub)],
      ),
    );
    els.push(text(x + 28, cardY + cardH - 40, 60, 24, [run(`0${i + 1}`, 15, t.faint, true)]));
  });
  return els;
}

function quadrant(c: Ctx): El[] {
  const { t, w, h } = c;
  const els: El[] = pageHeader(c, "OVERVIEW", "四个维度看全貌");
  const gw = (w - MX * 2 - CARD_GAP) / 2;
  const gh = (h - 210 - 118 - CARD_GAP) / 2;
  const cells = [
    { title: "维度一", body: "这个维度下的结论占位，一句话说清。", fill: t.panel, dot: t.accent },
    { title: "维度二", body: "这个维度下的结论占位，一句话说清。", fill: t.panelAlt, dot: t.accent2 },
    { title: "维度三", body: "这个维度下的结论占位，一句话说清。", fill: t.panelAlt, dot: t.accent2 },
    { title: "维度四", body: "这个维度下的结论占位，一句话说清。", fill: t.panel, dot: t.accent },
  ];
  cells.forEach((cell, i) => {
    const x = MX + (i % 2) * (gw + CARD_GAP);
    const y = 210 + Math.floor(i / 2) * (gh + CARD_GAP);
    els.push(card(c, x, y, gw, gh, cell.fill));
    els.push(ellipse(x + 28, y + 30, 14, 14, cell.dot));
    els.push(text(x + 52, y + 22, gw - 80, 30, [run(cell.title, 19, t.ink, true)]));
    els.push(text(x + 28, y + 64, gw - 56, gh - 84, [run(cell.body, 14, t.sub)]));
  });
  return els;
}

function timeline(c: Ctx): El[] {
  const { t, w, h } = c;
  const els: El[] = pageHeader(c, "ROADMAP", "推进节奏与里程碑");
  const axisY = h * 0.52;
  const span = w - MX * 2 - 80;
  const step = span / 3;
  els.push(rule(MX + 40, axisY, span, t.line));
  const stages = [
    { time: "Q1", title: "阶段一", body: "调研与立项，\n明确目标与范围。" },
    { time: "Q2", title: "阶段二", body: "方案设计与评审，\n产出原型验证。" },
    { time: "Q3", title: "阶段三", body: "开发与灰度，\n小范围试跑迭代。" },
    { time: "Q4", title: "阶段四", body: "全量上线，\n复盘与沉淀。" },
  ];
  stages.forEach((s, i) => {
    const cx = MX + 40 + i * step;
    els.push(ellipse(cx - 9, axisY - 8, 18, 18, i === stages.length - 1 ? t.accent : t.accentSoft));
    els.push(text(cx - 70, axisY - 74, 140, 26, [run(s.time, 16, t.accent, true)], "center"));
    els.push(text(cx - 70, axisY - 48, 140, 24, [run(s.title, 15, t.ink, true)], "center"));
    els.push(text(cx - 90, axisY + 28, 180, 64, [run(s.body, 13, t.sub)], "center"));
  });
  return els;
}

function compare(c: Ctx): El[] {
  const { t, w, h } = c;
  const els: El[] = pageHeader(c, "COMPARISON", "两条路径怎么选");
  const colW = (w - MX * 2 - 64) / 2;
  const panelY = 212;
  const panelH = h - panelY - 118;
  const bullets = ["评估维度占位：成本与周期", "评估维度占位：团队能力", "评估维度占位：长期演进"];
  // 左：中性面板
  els.push(card(c, MX, panelY, colW, panelH, t.panel));
  els.push(text(MX + 30, panelY + 28, colW - 60, 34, [run("方案 A · 占位", 22, t.ink, true)]));
  bullets.forEach((b, i) => {
    els.push(rect(MX + 30, panelY + 92 + i * 46, 8, 8, t.accent2, 4), text(MX + 50, panelY + 82 + i * 46, colW - 84, 28, [run(b, 14.5, t.sub)]));
  });
  // 右：强调面板
  const rx = MX + colW + 64;
  els.push(card(c, rx, panelY, colW, panelH, t.accent));
  els.push(text(rx + 30, panelY + 28, colW - 60, 34, [run("方案 B · 占位", 22, t.onAccent, true)]));
  bullets.forEach((b, i) => {
    els.push(rect(rx + 30, panelY + 92 + i * 46, 8, 8, t.onAccent, 4), text(rx + 50, panelY + 82 + i * 46, colW - 84, 28, [run(b, 14.5, t.onAccent)]));
  });
  // 中间 VS 徽章
  els.push(ellipse(w / 2 - 30, panelY + panelH / 2 - 30, 60, 60, t.ink));
  els.push(text(w / 2 - 30, panelY + panelH / 2 - 30, 60, 60, [run("VS", 18, t.bg, true)], "center", "middle"));
  // 底部结论条
  els.push(text(MX, h - 92, w - MX * 2, 26, [run("结论占位：建议选择方案 B，理由一句话。", 15, t.ink, true)], "center"));
  return els;
}

function stats(c: Ctx): El[] {
  const { t, w, h } = c;
  const els: El[] = pageHeader(c, "HIGHLIGHTS", "用数据说话");
  const colW = (w - MX * 2 - CARD_GAP * 2) / 3;
  const top = 226;
  const nums = ["86%", "3.2x", "¥1200w"];
  const labels = ["核心指标一：转化提升", "核心指标二：效率倍数", "核心指标三：年度节省"];
  nums.forEach((n, i) => {
    const x = MX + i * (colW + CARD_GAP);
    els.push(text(x, top, colW, 78, [run(n, 60, t.accent, true)]));
    els.push(text(x, top + 88, colW, 26, [run(labels[i] ?? "", 15, t.ink, true)]));
    // 迷你条形：底条 + 按序递减的强调条
    els.push(rect(x, top + 130, colW - 40, 8, t.panelAlt, 4));
    els.push(rect(x, top + 130, (colW - 40) * (1 - i * 0.28), 8, t.accent, 4));
    els.push(text(x, top + 152, colW - 20, 44, [run("口径与统计范围的一句话说明，\n避免数字被误读。", 12.5, t.sub)]));
    if (i < 2) els.push(rule(x + colW + CARD_GAP / 2, top + 8, 1.5, t.line));
  });
  return els;
}

function quote(c: Ctx): El[] {
  const { t, w, h } = c;
  return [
    ellipse(w - 260, -120, 420, 420, t.accentSoft),
    text(MX, h * 0.2, 160, 130, [run("“", 150, t.accent, true)]),
    text(MX + 88, h * 0.34, w * 0.7, 140, [run("把最重要的一句话放在这里，\n让人带走一个观点。", 34, t.ink, true)]),
    rule(MX + 88, h * 0.66, 56, t.accent),
    text(MX + 88, h * 0.71, 400, 28, [run("—— 出处 / 姓名 · 头衔占位", 15, t.sub)]),
    text(MX, h - 92, 300, 24, [run("QUOTE", 13, t.faint, true)]),
  ];
}

function end(c: Ctx): El[] {
  const { t, w, h } = c;
  return [
    ellipse(-140, -140, 340, 340, t.accentSoft),
    rect(w / 2 - 28, h * 0.3, 56, 8, t.accent, 4),
    text(w * 0.2, h * 0.38, w * 0.6, 80, [run("谢谢观看", 52, t.ink, true)], "center"),
    text(w * 0.25, h * 0.56, w * 0.5, 30, [run("Q&A · 欢迎交流讨论", 18, t.sub)], "center"),
    text(w * 0.25, h * 0.64, w * 0.5, 26, [run("联系人 姓名/name@example.com", 13, t.faint)], "center"),
  ];
}

/** 纵向要点列表：编号 | 标题 | 一句话说明，隔行细线 */
function list(c: Ctx): El[] {
  const { t, w } = c;
  const els: El[] = pageHeader(c, "AGENDA", "四个要点讲清楚");
  const rows = [
    { t2: "要点标题占位一", d: "一句话说明这个要点的结论或动作。" },
    { t2: "要点标题占位二", d: "一句话说明这个要点的结论或动作。" },
    { t2: "要点标题占位三", d: "一句话说明这个要点的结论或动作。" },
    { t2: "要点标题占位四", d: "一句话说明这个要点的结论或动作。" },
  ];
  rows.forEach((row, i) => {
    const y = 216 + i * 98;
    els.push(text(MX, y, 56, 30, [run(`0${i + 1}`, 20, t.accent, true)]));
    els.push(text(MX + 62, y, 380, 28, [run(row.t2, 18, t.ink, true)]));
    els.push(text(MX + 470, y + 3, w - MX * 2 - 470, 24, [run(row.d, 14, t.sub)]));
    if (i < rows.length - 1) els.push(rule(MX, y + 68, w - MX * 2, t.line));
  });
  return els;
}

/** 三步流程：圆角卡片 + 箭头串联，中间步骤浅强调底 */
function process(c: Ctx): El[] {
  const { t, w } = c;
  const els: El[] = pageHeader(c, "PROCESS", "三步走完闭环");
  const cardW = 300;
  const cardH = 190;
  const gap = 68;
  const y = 300;
  const x0 = (w - (cardW * 3 + gap * 2)) / 2;
  const steps = [
    { t2: "目标对齐", d: "明确要解决的问题，与\n衡量是否做成的标准。" },
    { t2: "方案落地", d: "小步快跑做出可用版本，\n在真实场景里验证。" },
    { t2: "复盘放大", d: "把验证过的做法沉淀成\n流程，推广到更多团队。" },
  ];
  steps.forEach((s, i) => {
    const x = x0 + i * (cardW + gap);
    els.push(card(c, x, y, cardW, cardH, i === 1 ? t.accentSoft : t.panel));
    els.push(text(x + 26, y + 24, 90, 20, [run(`STEP 0${i + 1}`, 12, t.accent, true)]));
    els.push(text(x + 26, y + 50, cardW - 52, 30, [run(s.t2, 20, t.ink, true)]));
    els.push(text(x + 26, y + 92, cardW - 52, 70, [run(s.d, 13.5, t.sub)]));
    if (i < 2)
      els.push({ kind: "shape", id: uid("s"), shape: "arrow", x: x + cardW + 14, y: y + cardH / 2 - 1, w: gap - 28, h: 2, stroke: t.accent, strokeWidth: 2.5 });
  });
  return els;
}

/** 问答：Q 徽标 + 问句 + 回答，组间细线 */
function faq(c: Ctx): El[] {
  const { t, w } = c;
  const els: El[] = pageHeader(c, "Q&A", "常见疑问一次说清");
  const qa = [
    { q: "这个方案要投入多少人力？", a: "核心投入集中在前八周，之后维持一人兼职维护即可。" },
    { q: "做不成怎么办？", a: "每六周设一次检查点，不达标就收缩范围或及时止损。" },
    { q: "和现有流程冲突吗？", a: "前两个月并行试跑，确认无损后再切换，老流程随时可回退。" },
  ];
  qa.forEach((item, i) => {
    const y = 214 + i * 124;
    els.push(rect(MX, y, 30, 30, t.accentSoft, 8));
    els.push(text(MX, y, 30, 30, [run("Q", 15, t.accent, true)], "center", "middle"));
    els.push(text(MX + 44, y, w - MX * 2 - 44, 28, [run(item.q, 17, t.ink, true)]));
    els.push(text(MX + 44, y + 38, w - MX * 2 - 44, 24, [run(item.a, 14, t.sub)]));
    if (i < qa.length - 1) els.push(rule(MX + 44, y + 90, w - MX * 2 - 44, t.line));
  });
  return els;
}

/** 指标简表：强调色表头 + 隔行面板底，四列 */
function table(c: Ctx): El[] {
  const { t, w } = c;
  const els: El[] = pageHeader(c, "DATA TABLE", "关键指标一览");
  const cols = [
    { x: MX + 24, w: 280, label: "指标" },
    { x: MX + 340, w: 150, label: "当前值" },
    { x: MX + 520, w: 150, label: "目标值" },
    { x: MX + 700, w: w - MX * 2 - 724, label: "说明" },
  ];
  const headY = 212;
  const headH = 46;
  const rowH = 54;
  els.push(rect(MX, headY, w - MX * 2, headH, t.accent, 8));
  cols.forEach((col) => els.push(text(col.x, headY, col.w, headH, [run(col.label, 13.5, t.onAccent, true)], "left", "middle")));
  const rows = [
    { a: "指标名称占位一", b: "86%", v: "90%", d: "口径：按月滚动统计" },
    { a: "指标名称占位二", b: "3.2x", v: "4.0x", d: "口径：季度均值" },
    { a: "指标名称占位三", b: "¥1200w", v: "¥2000w", d: "口径：年度累计" },
    { a: "指标名称占位四", b: "12 分钟", v: "8 分钟", d: "口径：端到端耗时" },
  ];
  rows.forEach((row, i) => {
    const y = headY + headH + i * rowH;
    if (i % 2 === 1) els.push(rect(MX, y, w - MX * 2, rowH, t.panel));
    const cells: { v: string; color: string; bold?: boolean }[] = [
      { v: row.a, color: t.ink },
      { v: row.b, color: t.accent, bold: true },
      { v: row.v, color: t.ink },
      { v: row.d, color: t.sub },
    ];
    cells.forEach((cell, j) =>
      els.push(text(cols[j]!.x, y, cols[j]!.w, rowH, [run(cell.v, j === 0 ? 14.5 : 13.5, cell.color, cell.bold)], "left", "middle")),
    );
  });
  return els;
}

const BUILDERS: Record<LayoutId, (c: Ctx) => El[]> = {
  cover, toc, section, cards3, quadrant, timeline, compare, stats,
  list, process, faq, table, quote, end,
};

/* ---------------- 构造入口 ---------------- */

const layoutById = (id: string): { id: LayoutId; label: string } | undefined => LAYOUT_META.find((l) => l.id === id);

/** 主题 + 版式 → 一页（局部坐标元素已就位，background 用主题底色） */
export function buildTemplateFrame(themeId: string, layoutId: string, preset: PagePreset = "16:9", at?: { x: number; y: number }): Frame | null {
  const theme = TEMPLATE_THEMES.find((t) => t.id === themeId);
  const layout = layoutById(layoutId);
  if (!theme || !layout) return null;
  const f = blankFrame(preset, at);
  f.background = theme.tokens.bg;
  f.name = `${theme.label} · ${layout.label}`;
  const { w, h } = f;
  f.elements = BUILDERS[layout.id]({ t: theme.tokens, w, h });
  return f;
}

/** 整套起步：封面 → 目录 → 章节 → 三要点 → 数据 → 结尾（整齐横排落位） */
export const STARTER_DECK_LAYOUTS: LayoutId[] = ["cover", "toc", "section", "cards3", "stats", "end"];

export function buildStarterDeck(themeId: string, preset: PagePreset = "16:9", start: { x: number; y: number } = { x: 80, y: 80 }): Frame[] {
  const { w, h } = preset === "4:3" ? { w: 1024, h: 768 } : preset === "A4L" ? { w: 1123, h: 794 } : { w: 1280, h: 720 };
  return STARTER_DECK_LAYOUTS.map((layoutId, i) =>
    buildTemplateFrame(themeId, layoutId, preset, {
      x: start.x + i * (w + 56),
      y: start.y,
    }),
  ).filter((f): f is Frame => !!f);
}
