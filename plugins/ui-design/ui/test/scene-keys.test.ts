/**
 * 场景 key 唯一性回归测试：patchTree 按 key 全局 diff，任何两个视觉件撞 key
 * 都会导致节点被“复用/偷取”——多画板时表现为背景/内容初始不渲染、拖动后才出现。
 * （回归源：frame 底色 paintChildren 曾用空 id → 所有画板共享 "#f0"/"#s0"。）
 */
import { describe, expect, test } from "bun:test";
import { parseDesignDoc, type DesignNode } from "../src/doc";
import { buildPageScene } from "../src/leafer/scene";

const measure = () => ({ width: 10, ascent: 8, descent: 2 });
const ctx = { measure, asset: () => ({ status: "missing" }) as const };

describe("场景 key 全局唯一", () => {
  test("多个画板（含子节点）不产生重复 key；frame 底色 key 带 frame id 前缀", () => {
    const res = parseDesignDoc(
      JSON.stringify({
        pages: [
          {
            id: "p1",
            nodes: [
              {
                id: "f1", type: "frame", name: "画板1", x: 0, y: 0, w: 200, h: 200,
                fills: [{ type: "solid", color: "#ffffff" }],
                children: [{ id: "a", type: "rect", name: "A", x: 0, y: 0, w: 50, h: 50 }],
              },
              {
                id: "f2", type: "frame", name: "画板2", x: 250, y: 0, w: 200, h: 200,
                fills: [{ type: "solid", color: "#ffffff" }],
                children: [{ id: "b", type: "ellipse", name: "B", x: 0, y: 0, w: 50, h: 50 }],
              },
            ],
          },
        ],
      }),
    );
    const doc = res.doc;
    const scene = buildPageScene(doc.pages[0]!, ctx);
    const keys: string[] = [];
    const walk = (list: { key: string; children?: { key: string; children?: unknown[] }[] }[]) => {
      for (const n of list) {
        keys.push(n.key);
        if (n.children) walk(n.children as never);
      }
    };
    walk(scene as never);
    expect(keys.length).toBe(new Set(keys).size);
    // frame 底色/描边的 key 必须带 frame id 前缀（曾经是空 → "#f0" 撞车）
    expect(keys).toContain("f1#f0");
    expect(keys).toContain("f2#f0");
  });

  test("多边形（path 类形状）的 d 必须传到视觉件（漏传 = 画布永远不渲染）", () => {
    const res = parseDesignDoc(
      JSON.stringify({
        pages: [{
          id: "p1",
          nodes: [{ id: "p", type: "pentagon", name: "五边形", x: 0, y: 0, w: 100, h: 100, fills: [{ type: "solid", color: "#d9d9d9" }] }],
        }],
      }),
    );
    const scene = buildPageScene(res.doc.pages[0]!, ctx);
    const group = scene[0]!;
    expect(group.tag).toBe("group");
    const paint = (group.children ?? [])[0]!;
    expect(paint.tag).toBe("path");
    const d = (paint.props as { path?: string }).path;
    expect(typeof d).toBe("string");
    expect((d as string).startsWith("M")).toBe(true);
    expect((d as string).length).toBeGreaterThan(10);
  });
});
