/**
 * 富文本 runs ⇄ contentEditable DOM。
 *
 * 文档里的文本是一串 TextRun（每段自带粗斜下划线/字号/颜色/字体）。就地编辑若只用一个
 * textarea，提交时只能把整段塌缩成单 run——这是"改一个字丢全部格式"的根因。这里改成
 * 带样式 span 的 contentEditable：挂载时按 runs 生成 HTML，提交时按 DOM 实际样式重新切
 * 分 runs，格式在往返中保真。
 *
 * 纯函数（runsToHtml / styleOfRun / applyStyleToRuns / readRuns 的样式归一）与 DOM 工具
 * （readRuns / applyStyleToSelection / styleAtNode）分开放，前者可直接单测。
 */
import type { TextEl, TextRun } from "../doc";
import { DEFAULT_TEXT_COLOR, DEFAULT_TEXT_SIZE, FONT_STACK } from "../viewspec";

/** 零宽空格：折叠光标下承载"下一个字用什么样式"的占位符，序列化时剔除 */
export const ZWSP = "\u200B";

/** 工具栏/编辑器共用的完整文本样式（不含对齐——对齐是元素级属性） */
export type RunStyle = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
  size: number;
  /** 字体族名（"" = 系统默认栈） */
  font: string;
};

/** 可选字体（值为 doc run.font 的字体族名；缺省走系统栈）。
 *  与 skills/deck/SKILL.md 的字体白名单同源：跨平台可用且 .pptx 导出保真。 */
export const FONT_OPTIONS: readonly { label: string; value: string }[] = [
  { label: "系统默认", value: "" },
  { label: "苹方", value: "PingFang SC" },
  { label: "微软雅黑", value: "Microsoft YaHei" },
  { label: "思源黑体", value: "Noto Sans SC" },
  { label: "Arial", value: "Arial" },
  { label: "Georgia", value: "Georgia" },
  { label: "等宽", value: "Courier New" },
];

export function fontLabel(font: string): string {
  return FONT_OPTIONS.find((o) => o.value === font)?.label ?? (font || "系统默认");
}

/** 字体族 → 完整 CSS 栈（与 viewspec.resolveRuns 同口径） */
export function fontStack(font: string): string {
  return font ? `'${font}', ${FONT_STACK}` : FONT_STACK;
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 任意 CSS 颜色（#rgb/#rrggbb/rgb[a]()）→ #rrggbb；识别不了返回 null */
export function normalizeHex(input: string | undefined | null): string | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    const h = hex[1]!;
    return s.length === 4
      ? `#${h.charAt(0)}${h.charAt(0)}${h.charAt(1)}${h.charAt(1)}${h.charAt(2)}${h.charAt(2)}`
      : s;
  }
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s);
  if (!m) return null;
  const c = (v: string) => Math.max(0, Math.min(255, Math.round(Number(v)))).toString(16).padStart(2, "0");
  return `#${c(m[1]!)}${c(m[2]!)}${c(m[3]!)}`;
}

/** run → 完整样式（文档缺省值在这里补全） */
export function styleOfRun(run: TextRun | undefined): RunStyle {
  return {
    bold: run?.bold === true,
    italic: run?.italic === true,
    underline: run?.underline === true,
    color: normalizeHex(run?.color) ?? DEFAULT_TEXT_COLOR,
    size: run?.size && run.size > 0 ? run.size : DEFAULT_TEXT_SIZE,
    font: run?.font ?? "",
  };
}

/** 样式 → run（省略默认值，保持文档紧凑；字体/颜色显式写） */
export function runFromStyle(style: RunStyle, text: string): TextRun {
  const run: TextRun = { text };
  if (style.bold) run.bold = true;
  if (style.italic) run.italic = true;
  if (style.underline) run.underline = true;
  const color = normalizeHex(style.color);
  if (color) run.color = color;
  if (style.size > 0 && round1(style.size) !== DEFAULT_TEXT_SIZE) run.size = round1(style.size);
  if (style.font) run.font = style.font;
  return run;
}

/** 元素工具栏的展示态：粗/斜/下划线按"全部 run 都开"点亮，字号/颜色/字体取首 run */
export function toolbarStyleOf(el: TextEl): RunStyle {
  const base = styleOfRun(el.runs[0]);
  const all = (key: "bold" | "italic" | "underline") => el.runs.length > 0 && el.runs.every((r) => r[key] === true);
  return { ...base, bold: all("bold"), italic: all("italic"), underline: all("underline") };
}

/** 整元素套样式：保留每段文字，只改样式字段 */
export function applyStyleToRuns(runs: TextRun[], patch: Partial<RunStyle>): TextRun[] {
  if (runs.length === 0) return [{ ...runFromStyle({ ...styleOfRun(undefined), ...patch }, "") }];
  return runs.map((r) => runFromStyle({ ...styleOfRun(r), ...patch }, r.text));
}

/* ---------------- HTML 序列化（初始渲染） ---------------- */

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function cssDeclOfStyle(style: RunStyle, scale: number): string {
  return [
    `font-weight:${style.bold ? 700 : 400}`,
    `font-style:${style.italic ? "italic" : "normal"}`,
    `text-decoration:${style.underline ? "underline" : "none"}`,
    `color:${style.color}`,
    `font-size:${round1(style.size * scale)}px`,
    `font-family:${fontStack(style.font)}`,
  ].join(";");
}

/** runs → contentEditable 初始 HTML（每个 run 一个带完整样式的 span） */
export function runsToHtml(runs: TextRun[], scale: number): string {
  return runs
    .map((r) => `<span style="${cssDeclOfStyle(styleOfRun(r), scale)}">${escapeHtml(r.text)}</span>`)
    .join("");
}

/* ---------------- DOM → runs（提交时保真回写） ---------------- */

type Resolved = Partial<{
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
  sizePx: number;
  font: string;
}>;

/** CSS font-family 串 → 字体族名；系统栈/generic 归一为 "" */
function fontFromCss(value: string): string {
  const first = (value.split(",")[0] ?? "").trim().replace(/^['"]|['"]$/g, "");
  if (!first) return "";
  const known = FONT_OPTIONS.find((o) => o.value && o.value.toLowerCase() === first.toLowerCase());
  if (known) return known.value;
  if (/^(-apple-system|system-ui|sans-serif|serif|arial|helvetica|segoe ui|helvetica neue)$/i.test(first)) return "";
  return first;
}

function mergeElementStyle(el: HTMLElement, inherited: Resolved): Resolved {
  const next: Resolved = { ...inherited };
  const tag = el.tagName;
  if (tag === "B" || tag === "STRONG") next.bold = true;
  if (tag === "I" || tag === "EM") next.italic = true;
  if (tag === "U") next.underline = true;
  const st = el.style;
  if (st.fontWeight) next.bold = st.fontWeight === "bold" || Number(st.fontWeight) >= 600;
  if (st.fontStyle) next.italic = st.fontStyle === "italic";
  if (`${st.textDecorationLine} ${st.textDecoration}`.toLowerCase().includes("underline")) next.underline = true;
  const color = normalizeHex(st.color);
  if (color) next.color = color;
  const size = Number.parseFloat(st.fontSize);
  if (Number.isFinite(size) && size > 0) next.sizePx = size;
  if (st.fontFamily) next.font = fontFromCss(st.fontFamily);
  return next;
}

function resolvedToStyle(r: Resolved, scale: number): RunStyle {
  return {
    bold: r.bold === true,
    italic: r.italic === true,
    underline: r.underline === true,
    color: r.color ?? DEFAULT_TEXT_COLOR,
    size: r.sizePx && r.sizePx > 0 ? round1(r.sizePx / scale) : DEFAULT_TEXT_SIZE,
    font: r.font ?? "",
  };
}

function sameRunStyle(a: TextRun, b: TextRun): boolean {
  return (
    (a.bold === true) === (b.bold === true) &&
    (a.italic === true) === (b.italic === true) &&
    (a.underline === true) === (b.underline === true) &&
    (a.color ?? "") === (b.color ?? "") &&
    (a.size ?? 0) === (b.size ?? 0) &&
    (a.font ?? "") === (b.font ?? "")
  );
}

/**
 * contentEditable DOM → runs。以 base（元素首 run）为默认样式，与默认一致的字段省略；
 * 相邻同样式片段合并。浏览器插入的 <div>/<p>/<br> 都按换行处理（Enter 已由编辑器接管，
 * 这里只兜底原生粘贴/撤销留下的结构）。
 */
export function readRuns(root: HTMLElement, scale: number, base: TextRun): TextRun[] {
  const out: TextRun[] = [];
  // 空编辑器（只有占位结构）直接回空文本 run，避免把占位 <br> 当成换行
  const meaningful = (root.textContent ?? "").replace(new RegExp(ZWSP, "g"), "").trim().length > 0;
  if (!meaningful) return [{ ...base, text: "" }];

  const push = (rawText: string, resolved: Resolved) => {
    const text = rawText.replace(new RegExp(ZWSP, "g"), "").replace(/\u00A0/g, " ");
    if (!text) return;
    const run = runFromStyle(resolvedToStyle(resolved, scale), text);
    const prev = out[out.length - 1];
    if (prev && sameRunStyle(prev, run)) {
      prev.text += run.text;
      return;
    }
    out.push(run);
  };

  const walk = (node: Node, resolved: Resolved) => {
    if (node.nodeType === Node.TEXT_NODE) {
      push(node.textContent ?? "", resolved);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.tagName === "BR") {
      push("\n", resolved);
      return;
    }
    const block = el.tagName === "DIV" || el.tagName === "P";
    if (block && out.length > 0) push("\n", resolved);
    const st = mergeElementStyle(el, resolved);
    for (const child of Array.from(el.childNodes)) walk(child, st);
  };

  const rootStyle = mergeElementStyle(root, {});
  for (const child of Array.from(root.childNodes)) walk(child, rootStyle);

  return out.length > 0 ? out : [{ ...base, text: "" }];
}

/** 光标处（或最近祖先）的有效样式 */
export function styleAtNode(root: HTMLElement, node: Node, scale: number): RunStyle {
  const chain: HTMLElement[] = [];
  let cur: Node | null = node;
  while (cur && cur !== root) {
    if (cur.nodeType === Node.ELEMENT_NODE) chain.unshift(cur as HTMLElement);
    cur = cur.parentNode;
  }
  chain.unshift(root);
  let resolved: Resolved = {};
  for (const el of chain) resolved = mergeElementStyle(el, resolved);
  return resolvedToStyle(resolved, scale);
}

/** 选区内的文本节点（按 DOM 顺序） */
function textNodesInRange(root: HTMLElement, range: Range): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent) continue;
    if (!range.intersectsNode(n)) continue;
    out.push(n as Text);
  }
  return out;
}

function applyStyleToElement(el: HTMLElement, style: RunStyle, scale: number): void {
  el.style.fontWeight = style.bold ? "700" : "400";
  el.style.fontStyle = style.italic ? "italic" : "normal";
  el.style.textDecoration = style.underline ? "underline" : "none";
  el.style.color = style.color;
  el.style.fontSize = `${round1(style.size * scale)}px`;
  el.style.fontFamily = fontStack(style.font);
}

/**
 * 给当前选区套样式（编辑器内调用）。
 * - 有选区：按文本节点切分并逐个包一层 span（不会破坏未选中部分的样式）；
 * - 折叠光标：插入零宽空格 span 承载"下一个字"的样式，序列化时剔除。
 */
export function applyStyleToSelection(root: HTMLElement, patch: Partial<RunStyle>, scale: number): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;

  if (range.collapsed) {
    const style = { ...styleAtNode(root, range.startContainer, scale), ...patch };
    const span = document.createElement("span");
    applyStyleToElement(span, style, scale);
    span.textContent = ZWSP;
    const caret = range.cloneRange();
    caret.insertNode(span);
    const after = document.createRange();
    after.setStart(span.firstChild!, 1);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    return;
  }

  const nodes = textNodesInRange(root, range);
  if (nodes.length === 0) return;
  const wrapped: HTMLElement[] = [];

  for (const node of nodes) {
    const nodeRange = document.createRange();
    nodeRange.selectNodeContents(node);
    const startsBefore = range.compareBoundaryPoints(Range.START_TO_START, nodeRange) < 0;
    const endsAfter = range.compareBoundaryPoints(Range.END_TO_END, nodeRange) > 0;
    let start = 0;
    if (!startsBefore) start = range.startContainer === node ? range.startOffset : node.textContent!.length;
    let end = node.textContent!.length;
    if (!endsAfter) end = range.endContainer === node ? range.endOffset : end;
    if (end <= start) continue;

    let target: Text = node;
    if (start > 0) target = target.splitText(start);
    const len = target.textContent!.length;
    const localEnd = Math.min(len, end - start);
    if (localEnd < len) target.splitText(localEnd);

    const style = { ...styleAtNode(root, target, scale), ...patch };
    const span = document.createElement("span");
    applyStyleToElement(span, style, scale);
    target.parentNode!.insertBefore(span, target);
    span.appendChild(target);
    wrapped.push(span);
  }

  if (wrapped.length === 0) return;
  // 选区还原成"第一个包裹片段 → 最后一个包裹片段"
  const firstText = wrapped[0]!.firstChild;
  const lastSpan = wrapped[wrapped.length - 1]!;
  const lastText = lastSpan.lastChild;
  if (!firstText || !lastText) return;
  const next = document.createRange();
  next.setStart(firstText, 0);
  next.setEnd(lastText, lastText.textContent?.length ?? 0);
  sel.removeAllRanges();
  sel.addRange(next);
}
