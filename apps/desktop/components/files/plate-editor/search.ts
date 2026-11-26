"use client";

/**
 * Plate 查找/替换内核：
 * - 在文本节点内做大小写不敏感匹配（跨节点命中暂不处理）；
 * - 命中高亮由 FindReplacePlugin 的 search 选项负责，这里只负责区间与导航；
 * - 替换走 Slate transforms，可整体撤销。
 */

import {
  KEYS,
  type Path,
  type TElement,
  type TRange,
} from "platejs";
import type { PlateEditor } from "platejs/react";
import { FindReplacePlugin } from "@platejs/find-replace";
import { buildTocEntries } from "@/lib/markdown/toc";

const MAX_MATCHES = 2000;

const HEADING_TYPES = new Set<string>([
  KEYS.h1,
  KEYS.h2,
  KEYS.h3,
  KEYS.h4,
  KEYS.h5,
  KEYS.h6,
]);

export interface PlateHeading {
  id: string;
  element: TElement;
  path: Path;
  text: string;
  level: number;
}

/** 收集标题并按 buildTocEntries 的规则生成稳定 id */
export function collectPlateHeadings(editor: PlateEditor): PlateHeading[] {
  const headings: Omit<PlateHeading, "id">[] = [];
  for (const [node, path] of editor.api.nodes({
    at: [],
    match: (entry) =>
      "type" in entry && HEADING_TYPES.has(entry.type as string),
  })) {
    if (!("type" in node)) continue;
    const text = (editor.api.string(path) ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const level = Number(String(node.type).slice(1)) || 1;
    headings.push({ element: node as TElement, path, text, level });
  }
  const entries = buildTocEntries(
    headings.map(({ text, level }) => ({ text, level })),
  );
  return headings.map((heading, index) => ({
    ...heading,
    id: entries[index]?.id ?? `md-section-${index + 1}`,
  }));
}

export function collectPlateMatches(
  editor: PlateEditor,
  query: string,
): TRange[] {
  const needle = query.toLocaleLowerCase();
  if (!needle) return [];
  const matches: TRange[] = [];
  for (const [node, path] of editor.api.nodes({
    at: [],
    match: (entry) => "text" in entry && typeof entry.text === "string",
  })) {
    if (matches.length >= MAX_MATCHES) break;
    const text = "text" in node && typeof node.text === "string" ? node.text : "";
    if (!text) continue;
    const haystack = text.toLocaleLowerCase();
    let index = haystack.indexOf(needle);
    while (index >= 0 && matches.length < MAX_MATCHES) {
      matches.push({
        anchor: { path, offset: index },
        focus: { path, offset: index + needle.length },
      });
      index = haystack.indexOf(needle, index + needle.length);
    }
  }
  return matches;
}

/** 设置 FindReplacePlugin 的高亮文本；空串清除 */
export function setPlateSearchHighlight(
  editor: PlateEditor,
  query: string,
  redecorate: () => void,
): void {
  editor.setOption(FindReplacePlugin, "search", query);
  redecorate();
}

export function scrollPlateRangeIntoView(
  editor: PlateEditor,
  range: TRange,
  container: HTMLElement | null,
): void {
  const reduce =
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  const domRange = editor.api.toDOMRange(range);
  if (!domRange) return;
  const rect = domRange.getBoundingClientRect();
  if (container) {
    const top =
      container.scrollTop +
      rect.top -
      container.getBoundingClientRect().top -
      container.clientHeight / 2 +
      rect.height / 2;
    container.scrollTo({
      top: Math.max(0, top),
      behavior: reduce ? "auto" : "smooth",
    });
    return;
  }
  const node = domRange.startContainer;
  const el =
    node.nodeType === Node.TEXT_NODE
      ? node.parentElement
      : (node as Element | null);
  el?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
}

export function scrollPlateHeadingIntoView(
  editor: PlateEditor,
  heading: PlateHeading,
  container: HTMLElement | null,
): void {
  const dom = editor.api.toDOMNode(heading.element);
  if (!dom) return;
  const reduce =
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  if (container) {
    const top =
      container.scrollTop +
      dom.getBoundingClientRect().top -
      container.getBoundingClientRect().top -
      16;
    container.scrollTo({
      top: Math.max(0, top),
      behavior: reduce ? "auto" : "smooth",
    });
    return;
  }
  dom.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
}

/** 当前滚动位置下，最后一个越过容器顶部的标题 */
export function activePlateHeading(
  editor: PlateEditor,
  headings: readonly PlateHeading[],
  container: HTMLElement,
): string {
  const top = container.getBoundingClientRect().top + 24;
  let active = "";
  for (const heading of headings) {
    const dom = editor.api.toDOMNode(heading.element);
    if (!dom) continue;
    if (dom.getBoundingClientRect().top <= top) active = heading.id;
    else break;
  }
  return active;
}

/** 替换一个命中：删除区间并插入新文本 */
export function replacePlateRange(
  editor: PlateEditor,
  range: TRange,
  replacement: string,
): void {
  editor.tf.insertText(replacement, { at: range });
}
