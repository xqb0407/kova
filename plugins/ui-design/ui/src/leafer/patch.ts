/**
 * leafer/patch.ts — 场景 spec → leafer 节点树的按 key diff patch（纯逻辑，duck-type 可单测）。
 *
 * 关键契约：
 *  - 同 key 复用节点（引用稳定），属性按差量 setter（消失的键置 undefined）
 *  - **换容器必须重新挂载**：成组/解组/拖入画板等 reparent 场景下节点 id（=key）不变，
 *    但 leafer 节点必须从旧父级摘出、挂到新父级（add 自带先摘除）——漏了这一步，
 *    节点会留在旧容器里拿着新容器的局部坐标渲染（成组散开/选框错位的根因）
 *  - 根组（key 不含 "#"）每轮强制归一 scaleX/scaleY（编辑器缩放手势直写在节点上，spec 恒 1）
 *  - zIndex 按同层 spec 序写入
 */
import type { SceneNode, SceneTag } from "./scene";

export type PatchNodeObj = {
  add?: (n: unknown) => void;
  remove?: () => void;
  zIndex?: number;
  parent?: unknown;
  __elKey?: string;
} & Record<string, unknown>;

export type PatchEntry = { node: PatchNodeObj; tag: SceneTag; props: Record<string, unknown> };

function setNodeProps(node: Record<string, unknown>, oldProps: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(next)) {
    if (oldProps[k] !== v) node[k] = v;
  }
  for (const k of Object.keys(oldProps)) {
    if (!(k in next)) node[k] = undefined;
  }
}

export function patchTree(
  parent: PatchNodeObj,
  specs: SceneNode[],
  map: Map<string, PatchEntry>,
  seen: Set<string>,
  tags: Record<SceneTag, new () => PatchNodeObj>,
): void {
  specs.forEach((spec, index) => {
    seen.add(spec.key);
    let ent = map.get(spec.key);
    if (!ent || ent.tag !== spec.tag) {
      ent?.node.remove?.();
      const node = new tags[spec.tag]();
      node.__elKey = spec.key;
      setNodeProps(node, {}, spec.props);
      parent.add?.(node);
      ent = { node, tag: spec.tag, props: { ...spec.props } };
      map.set(spec.key, ent);
    } else {
      setNodeProps(ent.node, ent.props, spec.props);
      ent.props = { ...spec.props };
      // 换容器（成组/解组/跨画板拖动）：重新挂到当前 spec 的父级（leafer add 自带先摘除）
      if (ent.node.parent !== parent) parent.add?.(ent.node);
    }
    // 编辑器缩放手势（editSize:'scale'）把 scale 直写在节点根组上，而 spec 恒为 1：
    // diff 只比上次 spec、看不见这种外部改动，提交后必须强制归一，
    // 否则 scale 残留叠加已吸收进 w/h 的缩放 → 双重放大
    if (!spec.key.includes("#")) {
      const sx = spec.props.scaleX;
      const sy = spec.props.scaleY;
      if (sx !== undefined) ent.node.scaleX = sx;
      if (sy !== undefined) ent.node.scaleY = sy;
    }
    ent.node.zIndex = index;
    if (spec.children) patchTree(ent.node, spec.children, map, seen, tags);
  });
}
