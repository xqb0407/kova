"use client";

/**
 * DOM 文本查找工具（资料库查看器 Ctrl+F 用）：从 thread-find.tsx 的
 * TreeWalker + CSS Custom Highlight API 管线抽取的通用版。
 *
 * 高亮走 Highlight API（Chromium 支持）而不往渲染树里插 <mark>：不侵入
 * Streamdown 的 markdown DOM，流式/懒加载重渲染也不会把高亮节点拆掉。
 * ::highlight() 不在 Lightning CSS 的伪元素表里，写进 .css 文件会让
 * `next build` 报 "not recognized as a valid pseudo-element"——样式随注册
 * 在运行时注入 <style>，绕开构建管线。
 */

/** 非空注册名集合（防重复注入样式 + 关闭时清理用） */
const installedStyles = new Set<string>();

function registry(): HighlightRegistryLike | undefined {
  return (
    (globalThis.CSS as unknown as { highlights?: HighlightRegistryLike } | undefined)
      ?.highlights
  );
}

type HighlightRegistryLike = {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
};
type HighlightCtor = new (...ranges: Range[]) => unknown;

/** 构造 Highlight 实例（DOM lib 类型可用的环境直接 new；运行时缺失返回 null） */
function makeHighlight(ranges: Range[]): unknown | null {
  const Ctor = (
    globalThis as unknown as { Highlight?: HighlightCtor }
  ).Highlight;
  return Ctor ? new Ctor(...ranges) : null;
}

/** 高亮样式随首个查询注入（注册名隔离，与 thread-find 互不影响） */
function ensureHighlightStyle(name: string): void {
  if (installedStyles.has(name) || typeof document === "undefined") return;
  installedStyles.add(name);
  // dev HMR 会重新求值模块、模块级集合归零：复用已有 style 并刷新内容
  const slot = `dom-find-highlight-${name}`;
  const existing = document.querySelector<HTMLStyleElement>(
    `style[data-slot="${slot}"]`,
  );
  const css = `
::highlight(${name}) {
  background-color: color-mix(in oklab, oklch(0.86 0.17 90) 55%, transparent);
  color: inherit;
}
.dark ::highlight(${name}) {
  background-color: color-mix(in oklab, oklch(0.75 0.16 85) 38%, transparent);
  color: inherit;
}
`;
  if (existing) {
    existing.textContent = css;
    return;
  }
  const style = document.createElement("style");
  style.dataset.slot = slot;
  style.textContent = css;
  document.head.appendChild(style);
}

/** 清掉某注册名的全部高亮（关闭查找/切文件/卸载时调） */
export function clearDomFindHighlight(name: string): void {
  registry()?.delete(name);
}

/** 把若干 Range 注册为某名字的当前命中高亮（Highlight 不可用时静默跳过） */
export function setDomFindHighlight(name: string, ranges: Range[]): void {
  const highlight = makeHighlight(ranges);
  if (highlight) registry()?.set(name, highlight);
}

/**
 * 在 root 里扫描 query 的全部命中，返回 { 起点偏移数组, 总数 }。
 * 偏移基于 TreeWalker 拼接出的全文，供 Range 定位与滚动定位共用。
 * maxHits 截断返回的命中（总数仍全量统计）；query 为空返回零命中。
 */
function scanText(
  root: HTMLElement,
  query: string,
  maxHits: number,
): { offsets: number[]; count: number; nodes: Text[]; starts: number[]; text: string } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (!parent || parent.closest("script,style")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    starts.push(text.length);
    nodes.push(node as Text);
    text += (node as Text).data;
  }
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const offsets: number[] = [];
  if (q) {
    for (
      let at = lower.indexOf(q);
      at >= 0;
      at = lower.indexOf(q, at + q.length)
    ) {
      if (offsets.length < maxHits) offsets.push(at);
      // 只累计总数，继续扫（上限之外的不再存偏移）
      if (offsets.length === maxHits) {
        let extra = 0;
        for (
          let rest = lower.indexOf(q, at + q.length);
          rest >= 0;
          rest = lower.indexOf(q, rest + q.length)
        ) {
          extra += 1;
        }
        return { offsets, count: maxHits + extra, nodes, starts, text };
      }
    }
  }
  return { offsets, count: offsets.length, nodes, starts, text };
}

/** 拼接全文里的偏移 → 具体文本节点与节点内偏移（跨节点命中靠 Range 天然支持） */
function locate(
  nodes: Text[],
  starts: number[],
  offset: number,
): { node: Text; offset: number } | null {
  for (let i = 0; i < nodes.length; i++) {
    const length = nodes[i].data.length;
    if (offset <= starts[i]! + length) {
      return { node: nodes[i]!, offset: offset - starts[i]! };
    }
  }
  return null;
}

/** 单次高亮的 Range 上限：长文里点一个高频词不该把整屏都染色。
 *  超出上限的部分只计数/可导航，不再染色（当前命中仍夹在范围内高亮） */
export const DOM_FIND_MAX_RANGES = 2000;

export type DomFindResult = {
  /** 全文命中总数（不受高亮上限截断） */
  count: number;
  /** 每个命中的 Range（上限 DOM_FIND_MAX_RANGES，顺序即文档顺序） */
  ranges: Range[];
};

/**
 * 扫描 + 注册高亮：命中全部挂 `::highlight(name)`，第 index 个（越界夹取）
 * 不挂——由调用方通过 second name 单独高亮“当前命中”。
 * query 为空或无命中时清掉注册名并返回零命中。
 */
export function findInDom(
  root: HTMLElement,
  name: string,
  query: string,
): DomFindResult {
  const reg = registry();
  const Highlight = (
    globalThis as unknown as { Highlight?: HighlightCtor }
  ).Highlight;
  const q = query.trim();
  if (!q || !reg || !Highlight) {
    clearDomFindHighlight(name);
    return { count: 0, ranges: [] };
  }
  const { offsets, count, nodes, starts } = scanText(
    root,
    q,
    DOM_FIND_MAX_RANGES,
  );
  if (offsets.length === 0) {
    clearDomFindHighlight(name);
    return { count: 0, ranges: [] };
  }
  const ranges: Range[] = [];
  for (const at of offsets) {
    const start = locate(nodes, starts, at);
    const end = locate(nodes, starts, at + q.length);
    if (!start || !end) continue;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    ranges.push(range);
  }
  if (ranges.length === 0) {
    clearDomFindHighlight(name);
    return { count: 0, ranges: [] };
  }
  ensureHighlightStyle(name);
  reg.set(name, new Highlight(...ranges));
  return { count, ranges };
}

/** 把某个命中 Range 滚进容器视口（贴顶留 16px；reduced-motion 直跳） */
export function scrollRangeIntoView(
  container: HTMLElement,
  range: Range,
): void {
  const reduce =
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  const rect = range.getBoundingClientRect();
  if (rect.height === 0 && rect.width === 0) return;
  const box = container.getBoundingClientRect();
  const target =
    container.scrollTop + rect.top - box.top - 16;
  container.scrollTo({
    top: Math.max(0, target),
    behavior: reduce ? "auto" : "smooth",
  });
}
