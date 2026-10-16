"use client";

/**
 * 页面元素引用表（"选择元素" → 对话框芯片的落点）。
 *
 * 数据流：浏览器面板拾取页面元素 → 结果写进这里（键 = CSS 选择器，也就是
 * 芯片 `:element[label]{name=选择器}` 的 name 槽）→ 芯片插进 composer；
 * 用户点芯片 → 派发 OPEN_ELEMENT_REF_EVENT（detail = 选择器）→ 详情 Dialog
 * 从本表取出完整载荷（截图/HTML/文本）展示。
 *
 * 模块级 Map 即可：同页同选择器重复拾取视为同一引用（覆盖为最新），
 * 生命周期跟随页面刷新，不落盘。
 */

export type ElementRefPayload = {
  /** 芯片可见文案：`tag#id` / `tag.class` / 文本片段 */
  label: string;
  /** CSS 选择器（芯片 name 槽、表的键） */
  selector: string;
  tag: string;
  id: string;
  classes: string[];
  text: string;
  html: string;
  url: string;
  title: string;
  rect: { x: number; y: number; width: number; height: number } | null;
  /** 元素区域截图（dataURL）；超限或失败为 null */
  shot: string | null;
};

const refs = new Map<string, ElementRefPayload>();

/** 打开详情 Dialog 的事件名：detail = selector */
export const OPEN_ELEMENT_REF_EVENT = "kova:element-ref-open";

export function putElementRef(payload: ElementRefPayload): void {
  refs.set(payload.selector || payload.label, payload);
}

export function getElementRef(key: string): ElementRefPayload | undefined {
  return refs.get(key);
}
