/**
 * 场景 patch 回归测试：按 key diff 的复用/重建、属性差量、z 序，
 * 以及换容器重挂载（成组/解组/跨画板移动时节点必须从旧父级摘出挂到新父级——
 * 漏了这一步 = 成组后元素散开、选框错位的根因）。
 */
import { describe, expect, test } from "bun:test";
import { patchTree, type PatchNodeObj } from "../src/leafer/patch";
import type { SceneNode, SceneTag } from "../src/leafer/scene";

/** 假 leafer 节点：记录 add/remove，维护 parent 指针 */
class FakeNode implements PatchNodeObj {
  parent: unknown = null;
  zIndex?: number;
  __elKey?: string;
  [k: string]: unknown;
  private kids: FakeNode[] = [];
  add(n: unknown): void {
    const node = n as FakeNode;
    node.removeFromParent();
    node.parent = this;
    this.kids.push(node);
  }
  remove(): void {
    this.removeFromParent();
  }
  removeFromParent(): void {
    if (this.parent instanceof FakeNode) this.parent.kids = this.parent.kids.filter((k) => k !== this);
    this.parent = null;
  }
  get children(): FakeNode[] {
    return this.kids;
  }
}

const TAGS = {
  group: FakeNode,
  rect: FakeNode,
  ellipse: FakeNode,
  path: FakeNode,
  line: FakeNode,
  image: FakeNode,
  text: FakeNode,
} as unknown as Record<SceneTag, new () => PatchNodeObj>;

const spec = (key: string, props: Record<string, unknown> = {}, children?: SceneNode[]): SceneNode =>
  ({ key, tag: "group", props: { x: 0, y: 0, ...props }, ...(children ? { children } : {}) }) as SceneNode;

/** 模拟真实调用方：每轮 fresh seen + patch 后 prune 失效节点 */
function run(root: FakeNode, map: Map<string, PatchNodeObj extends never ? never : { node: FakeNode; tag: SceneTag; props: Record<string, unknown> }>, specs: SceneNode[]): void {
  const seen = new Set<string>();
  patchTree(root as unknown as PatchNodeObj, specs, map as never, seen, TAGS);
  for (const [key, ent] of map) {
    if (!seen.has(key)) {
      (ent.node as unknown as FakeNode).remove();
      map.delete(key);
    }
  }
}

describe("patchTree", () => {
  test("创建/更新/属性差量（消失键置 undefined）", () => {
    const root = new FakeNode();
    const map = new Map();
    run(root, map, [spec("a", { x: 10, opacity: 1 })]);
    const a = root.children[0]!;
    expect((a as { x: number }).x).toBe(10);
    // 二轮：改 x、删 opacity
    run(root, map, [spec("a", { x: 30 })]);
    expect((a as { x: number }).x).toBe(30);
    expect((a as { opacity: number | undefined }).opacity).toBeUndefined();
    expect(root.children).toHaveLength(1); // 复用而非重建
  });

  test("成组：已存在的节点换到新父级（重挂载），位置改为组局部坐标", () => {
    const root = new FakeNode();
    const map = new Map();
    // 第一轮：a、b 是页面顶层
    run(root, map, [spec("a", { x: 100 }), spec("b", { x: 200 })]);
    const a = root.children[0]!;
    expect(a.parent).toBe(root);
    // 第二轮：a、b 进组 g（key 不变，坐标变组局部）
    run(root, map, [spec("g", { x: 0 }, [spec("a", { x: 0 }), spec("b", { x: 100 })])]);
    const g = root.children[0]!;
    expect(g.children).toHaveLength(2);
    expect(a.parent).toBe(g); // ★ 必须重挂载进组
    expect((a as { x: number }).x).toBe(0); // 组局部坐标
    expect(root.children).toHaveLength(1); // 页面层只剩组
  });

  test("解组：子节点回到页面层同样重挂载", () => {
    const root = new FakeNode();
    const map = new Map();
    run(root, map, [spec("g", {}, [spec("a", { x: 5 })])]);
    run(root, map, [spec("a", { x: 55 })]);
    const a = root.children[0]!;
    expect(a.parent).toBe(root);
    expect((a as { x: number }).x).toBe(55);
  });

  test("stale 清理由调用方完成（不在本轮 spec 的节点被 prune）", () => {
    const root = new FakeNode();
    const map = new Map();
    run(root, map, [spec("a")]);
    expect(root.children).toHaveLength(1);
    run(root, map, [spec("b")]);
    expect(root.children.map((c) => c.__elKey)).toEqual(["b"]);
  });

  test("tag 变化重建节点；zIndex 按 spec 序", () => {
    const root = new FakeNode();
    const map = new Map();
    const tagSpec = (key: string, tag: SceneTag): SceneNode => ({ key, tag, props: {} }) as SceneNode;
    run(root, map, [tagSpec("x", "rect"), tagSpec("y", "text")]);
    const first = map.get("x")!.node;
    run(root, map, [tagSpec("x", "text"), tagSpec("y", "rect")]);
    expect(map.get("x")!.node).not.toBe(first); // tag 变了 → 重建
    expect(root.children[0]!.__elKey).toBe("x");
    expect(root.children[0]!.zIndex).toBe(0);
    expect(root.children[1]!.zIndex).toBe(1);
  });
});
