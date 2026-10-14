/**
 * 就地编辑时画布必须隐藏该文字节点。
 *
 * 编辑浮层是背景透明的 textarea；不隐藏底下的画布渲染，双击后就会看到两份文字
 * （浮层一份、画布一份）。
 */
import { describe, expect, test } from "bun:test";
import { buildPageScene, type MeasureFn } from "../src/leafer/scene";
import type { DesignDoc, DesignNode, Page } from "../src/doc";

const measure: MeasureFn = (text, fontCss) => {
  const size = parseFloat(fontCss.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? "16") || 16;
  let w = 0;
  for (const ch of text) w += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.5;
  return { width: w, ascent: size * 0.8, descent: size * 0.2 };
};

const textNode = (id: string): DesignNode =>
  ({ id, type: "text", name: id, x: 20, y: 40, w: 200, h: 24, runs: [{ text: "文字", size: 14 }] }) as DesignNode;

const board = {
  id: "b1",
  type: "frame",
  name: "画板",
  x: 0,
  y: 0,
  w: 390,
  h: 844,
  fills: [],
  strokes: [],
  children: [textNode("t1"), textNode("t2")],
} as DesignNode;

const page: Page = { id: "p1", name: "P", nodes: [board] };
const doc: DesignDoc = { version: 1, meta: { name: "t", kind: "uidesign" }, activePage: "p1", pages: [page] };

function scene(hiddenNodeId: string | null) {
  const s = buildPageScene(page, { measure, asset: () => ({ status: "missing" }), doc, hiddenNodeId } as never);
  // 场景顶层 = 画板节点本身，其 children 才是画板内的可见层（文字节点的根组）
  return s.find((c) => c.key === "b1")!;
}

describe("就地编辑隐藏画布文字", () => {
  test("未编辑时所有文字节点可见", () => {
    const kids = scene(null).children!;
    for (const k of kids) expect(k.props.visible).not.toBe(false);
  });

  test("编辑中的节点 visible=false，其余不受影响", () => {
    const kids = scene("t1").children!;
    expect(kids.find((c) => c.key === "t1")!.props.visible).toBe(false);
    expect(kids.find((c) => c.key === "t2")!.props.visible).not.toBe(false);
  });

  test("隐藏靠 visible 而非删节点 —— key 仍在，patch 不会误卸载/重挂", () => {
    const before = scene(null).children!.map((c) => c.key);
    const after = scene("t1").children!.map((c) => c.key);
    expect(after).toEqual(before);
  });

  test("编辑中的节点画布上不带任何内容产物（占位也一并隐藏）", () => {
    const kids = scene("t1").children!;
    const t1 = kids.find((c) => c.key === "t1")!;
    // 字节点还在（key 稳定），但父组 visible=false 使其整体不绘制
    expect(t1.props.visible).toBe(false);
    expect(t1.children!.length).toBeGreaterThan(0);
  });
});
