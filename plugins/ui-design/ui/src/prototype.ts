/**
 * 原型交互共享逻辑：画板 → 可点击热点（onTap 节点在画板局部坐标系里的盒子）。
 * 预览覆盖层与 HTML 导出共用同一份收集函数，保证"预览所见 = 导出所得"。
 * 约定：hidden（visible=false）子树整支跳过；rotation 暂不参与热点盒换算（取未旋转盒，
 * 原型按钮绝大多数不转，v1 取舍）；嵌套 frame 也深入（弹窗画板套按钮的场景）。
 */
import { findNode, type DesignDoc, type DesignNode, type FrameNode } from "./doc";
import type { Box } from "./geometry";

export type Hotspot = {
  nodeId: string;
  name: string;
  /** 目标画板 id（可能已删——渲染侧自行降级） */
  to: string;
  /** 相对所属画板左上角的点击盒 */
  box: Box;
};

export function collectHotspots(frame: FrameNode): Hotspot[] {
  const out: Hotspot[] = [];
  const walk = (list: DesignNode[], ox: number, oy: number) => {
    for (const n of list) {
      if (n.visible === false) continue;
      const x = ox + n.x;
      const y = oy + n.y;
      if (n.onTap) out.push({ nodeId: n.id, name: n.name, to: n.onTap.to, box: { x, y, w: n.w, h: n.h } });
      if ("children" in n) walk(n.children, x, y);
    }
  };
  walk(frame.children, 0, 0);
  return out;
}

/** 热点目标解析：frame id → 画板（跨页）；死链返回 null */
export function resolveTargetFrame(doc: DesignDoc, id: string): FrameNode | null {
  const loc = findNode(doc, id);
  return loc && loc.node.type === "frame" && !loc.parent ? (loc.node as FrameNode) : null;
}

/** 选中节点向上爬到的顶层画板（自身即顶层画板也算）；不在画板内返回 null */
export function topLevelFrameOf(doc: DesignDoc, nodeId: string): FrameNode | null {
  let loc = findNode(doc, nodeId);
  while (loc && loc.parent) loc = findNode(doc, loc.parent.id);
  return loc && loc.node.type === "frame" ? (loc.node as FrameNode) : null;
}

/** 起始画板：优先选中节点所在顶层画板 → 当前页第一个 → 全档第一个 */
export function firstPlayableFrame(doc: DesignDoc, selIds: string[]): FrameNode | null {
  for (const id of selIds) {
    const f = topLevelFrameOf(doc, id);
    if (f) return f;
  }
  const page = doc.pages.find((x) => x.id === doc.activePage) ?? doc.pages[0];
  const inPage = page?.nodes.find((n) => n.type === "frame");
  if (inPage) return inPage as FrameNode;
  for (const p of doc.pages) {
    const f = p.nodes.find((n) => n.type === "frame");
    if (f) return f as FrameNode;
  }
  return null;
}
