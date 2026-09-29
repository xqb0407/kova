/**
 * 自动布局单测（P0-B）：重排引擎（横/纵、gap/padding、grow、对齐、嵌套、祖先链）
 * 与 layout/grow 字段的容错解析、序列化幂等。
 */
import { describe, expect, test } from "bun:test";
import { parseDesignDoc, serializeDoc, type DesignDoc, type FrameNode } from "../src/doc";
import { applyLayoutDeep, applyLayoutToFrame, reflowWithin } from "../src/layout";

/** 从 raw JSON 建档并取第一个节点（断言为 frame） */
const frameOf = (nodeJson: unknown): { doc: DesignDoc; frame: FrameNode } => {
  const res = parseDesignDoc(JSON.stringify({ pages: [{ id: "p1", name: "页", nodes: [nodeJson] }] }));
  expect(res.fatal).toBe(false);
  const n = res.doc.pages[0]!.nodes[0]!;
  if (n.type !== "frame") throw new Error("not frame");
  return { doc: res.doc, frame: n };
};

const box = (n: { x: number; y: number; w: number; h: number }) => `${n.x},${n.y},${n.w},${n.h}`;

describe("重排引擎", () => {
  test("横向：gap + 内边距 + 默认交叉轴居首", () => {
    const { frame } = frameOf({
      id: "f", type: "frame", name: "F", x: 0, y: 0, w: 400, h: 100,
      layout: { mode: "h", gap: 10, padding: [8, 12, 8, 12] },
      children: [
        { id: "a", type: "rect", name: "A", x: 999, y: 999, w: 100, h: 20 },
        { id: "b", type: "rect", name: "B", x: 999, y: 999, w: 60, h: 20 },
      ],
    });
    expect(applyLayoutToFrame(frame)).toBe(true);
    expect(box(frame.children[0]!)).toBe("12,8,100,20");
    expect(box(frame.children[1]!)).toBe("122,8,60,20"); // 12+100+10
  });

  test("纵向：主轴累加 + 交叉轴 center", () => {
    const { frame } = frameOf({
      id: "f", type: "frame", name: "F", x: 0, y: 0, w: 200, h: 300,
      layout: { mode: "v", gap: 20, cross: "center" },
      children: [
        { id: "a", type: "rect", name: "A", x: 0, y: 0, w: 80, h: 60 },
        { id: "b", type: "rect", name: "B", x: 0, y: 0, w: 40, h: 30 },
      ],
    });
    applyLayoutToFrame(frame);
    expect(box(frame.children[0]!)).toBe("60,0,80,60"); // (200-80)/2 = 60
    expect(box(frame.children[1]!)).toBe("80,80,40,30"); // y=60+20, x=(200-40)/2
  });

  test("grow：按权重瓜分主轴剩余空间，固定子项不动，收尾者吃余数", () => {
    const { frame } = frameOf({
      id: "f", type: "frame", name: "F", x: 0, y: 0, w: 400, h: 100,
      layout: { mode: "h" },
      children: [
        { id: "a", type: "rect", name: "A", x: 0, y: 0, w: 50, h: 20, grow: 1 },
        { id: "b", type: "rect", name: "B", x: 0, y: 0, w: 70, h: 20, grow: 3 },
        { id: "c", type: "rect", name: "C", x: 0, y: 0, w: 30, h: 20 },
      ],
    });
    applyLayoutToFrame(frame);
    // free = 400 - 30 = 370 → a=92.5 b=277.5
    const [a, b, c] = frame.children;
    expect(a!.w).toBe(92.5);
    expect(b!.w).toBe(277.5);
    expect(c!.w).toBe(30);
    expect(a!.x).toBe(0);
    expect(b!.x).toBe(92.5);
    expect(c!.x).toBe(370);
  });

  test("主轴对齐：center / end / between（between 首尾贴边等分）", () => {
    const mk = (main: string) => frameOf({
      id: "f", type: "frame", name: "F", x: 0, y: 0, w: 400, h: 100,
      layout: { mode: "h", main },
      children: [
        { id: "a", type: "rect", name: "A", x: 0, y: 0, w: 100, h: 20 },
        { id: "b", type: "rect", name: "B", x: 0, y: 0, w: 100, h: 20 },
      ],
    });
    const center = mk("center");
    applyLayoutToFrame(center.frame);
    expect(box(center.frame.children[0]!)).toBe("100,0,100,20");
    const end = mk("end");
    applyLayoutToFrame(end.frame);
    expect(box(end.frame.children[0]!)).toBe("200,0,100,20");
    const between = mk("between");
    applyLayoutToFrame(between.frame);
    expect(box(between.frame.children[0]!)).toBe("0,0,100,20");
    expect(box(between.frame.children[1]!)).toBe("300,0,100,20"); // 400-100
  });

  test("交叉轴 stretch：子项交叉尺寸拉满内容区", () => {
    const { frame } = frameOf({
      id: "f", type: "frame", name: "F", x: 0, y: 0, w: 400, h: 100,
      layout: { mode: "h", padding: [10, 10, 10, 10], cross: "stretch" },
      children: [{ id: "a", type: "rect", name: "A", x: 0, y: 0, w: 50, h: 20 }],
    });
    applyLayoutToFrame(frame);
    expect(box(frame.children[0]!)).toBe("10,10,50,80");
  });

  test("隐藏子项不占位；rotation 保留；between 语义", () => {
    const { frame } = frameOf({
      id: "f", type: "frame", name: "F", x: 0, y: 0, w: 300, h: 100,
      layout: { mode: "h", gap: 10 },
      children: [
        { id: "a", type: "rect", name: "A", x: 0, y: 0, w: 50, h: 20, rotation: 15 },
        { id: "hid", type: "rect", name: "H", x: 0, y: 0, w: 100, h: 20, visible: false },
        { id: "b", type: "rect", name: "B", x: 0, y: 0, w: 50, h: 20 },
      ],
    });
    applyLayoutToFrame(frame);
    expect(frame.children[0]!.rotation).toBe(15);
    expect(frame.children[0]!.x).toBe(0);
    expect(frame.children[2]!.x).toBe(60); // 0 + 50 + 10（隐藏的不占位）
  });

  test("嵌套 deep：外层先定 grow 尺寸，内层布局随内容区重排", () => {
    const { frame } = frameOf({
      id: "outer", type: "frame", name: "O", x: 0, y: 0, w: 400, h: 200,
      layout: { mode: "h" },
      children: [
        {
          id: "inner", type: "frame", name: "I", x: 0, y: 0, w: 100, h: 100, grow: 1,
          layout: { mode: "v", gap: 5 },
          children: [
            { id: "x", type: "rect", name: "X", x: 0, y: 0, w: 30, h: 10 },
            { id: "y", type: "rect", name: "Y", x: 0, y: 0, w: 30, h: 10 },
          ],
        },
      ],
    });
    applyLayoutDeep(frame);
    const inner = frame.children[0]!;
    expect(inner.w).toBe(400); // grow 1 拿满
    expect(inner.children[0]!.y).toBe(0);
    expect(inner.children[1]!.y).toBe(15); // 10 + 5
  });

  test("reflowWithin：往内层加节点后，祖先链自顶向下重排", () => {
    const res = parseDesignDoc(
      JSON.stringify({
        pages: [{
          id: "p1",
          nodes: [{
            id: "outer", type: "frame", name: "O", x: 0, y: 0, w: 400, h: 100,
            layout: { mode: "h" },
            children: [
              { id: "fixed", type: "rect", name: "F", x: 0, y: 0, w: 100, h: 50 },
              { id: "inner", type: "frame", name: "I", x: 0, y: 0, w: 100, h: 50, grow: 1 },
            ],
          }],
        }],
      }),
    );
    expect(res.fatal).toBe(false);
    const page = res.doc.pages[0]!;
    // 模拟往 inner 里加节点（MCP add_nodes 后调用 reflowWithin(innerId)）
    const inner = page.nodes[0]!.type === "frame" ? (page.nodes[0] as FrameNode).children[1]! : null;
    if (inner?.type !== "frame") throw new Error("no inner");
    inner.children.push({ id: "k", type: "rect", name: "K", x: 0, y: 0, w: 20, h: 20 });
    expect(reflowWithin(page.nodes, "k")).toBe(true);
    const outer = page.nodes[0] as FrameNode;
    expect(outer.children[1]!.w).toBe(300); // inner grow 拿 400-100
    expect(outer.children[1]!.x).toBe(100); // 排在 fixed 之后
    expect(outer.children[0]!.x).toBe(0);
    // inner 自身没开布局：其子项不受重排影响
    expect(inner.children[0]!.x).toBe(0);
  });

  test("无布局画板重排 = 无操作；grow 无父布局时保留字段", () => {
    const { frame } = frameOf({
      id: "f", type: "frame", name: "F", x: 0, y: 0, w: 100, h: 100,
      children: [{ id: "a", type: "rect", name: "A", x: 5, y: 5, w: 10, h: 10, grow: 2 }],
    });
    expect(applyLayoutToFrame(frame)).toBe(false);
    expect(frame.children[0]!.x).toBe(5);
  });
});

describe("layout/grow 解析与序列化", () => {
  test("别名归一：horizontal/row、space-between、alignItems、padding 数字", () => {
    const { frame } = frameOf({
      id: "f", type: "frame", name: "F", x: 0, y: 0, w: 100, h: 100,
      layout: { direction: "row", itemSpacing: 12, padding: 16, justifyContent: "space-between", alignItems: "stretch" },
      children: [],
    });
    expect(frame.layout).toEqual({ mode: "h", gap: 12, padding: [16, 16, 16, 16], main: "between", cross: "stretch" });
  });

  test("mode 缺失整条丢弃；padding 四元组保留；grow 钳 0..100", () => {
    const res = parseDesignDoc(JSON.stringify({
      pages: [{
        id: "p1",
        nodes: [
          { id: "f", type: "frame", x: 0, y: 0, w: 10, h: 10, layout: { gap: 8 } },
          { id: "g", type: "rect", x: 0, y: 0, w: 10, h: 10, grow: 500 },
        ],
      }],
    }));
    const [f, g] = res.doc.pages[0]!.nodes;
    expect(f?.type === "frame" && f.layout).toBeUndefined();
    expect(g?.grow).toBe(100);
  });

  test("序列化往返幂等（layout/grow 保留）", () => {
    const res = parseDesignDoc(JSON.stringify({
      pages: [{
        id: "p1",
        nodes: [{
          id: "f", type: "frame", name: "F", x: 0, y: 0, w: 100, h: 100,
          layout: { mode: "v", gap: 8, padding: [4, 4, 4, 4], main: "between", cross: "center" },
          children: [{ id: "a", type: "rect", name: "A", x: 0, y: 0, w: 10, h: 10, grow: 1 }],
        }],
      }],
    }));
    const once = serializeDoc(res.doc);
    expect(serializeDoc(parseDesignDoc(once).doc)).toBe(once);
    expect(once).toContain('"layout"');
    expect(once).toContain('"grow": 1');
  });
});

describe("wrap 自动换行", () => {
  test("横向：放不下折行，行距 = gap，逐行交叉对齐", () => {
    const { frame } = frameOf({
      id: "f", type: "frame", name: "F", x: 0, y: 0, w: 260, h: 300,
      layout: { mode: "h", gap: 10, wrap: true, cross: "center" },
      children: [
        { id: "a", type: "rect", name: "A", x: 0, y: 0, w: 100, h: 40 },
        { id: "b", type: "rect", name: "B", x: 0, y: 0, w: 100, h: 60 },
        { id: "c", type: "rect", name: "C", x: 0, y: 0, w: 100, h: 30 },
      ],
    });
    applyLayoutToFrame(frame);
    // 第一行 a+b（210），c 折第二行；行高 = 行内最大
    const [a, b, c] = frame.children;
    expect(`${a!.x},${a!.y}`).toBe("0,10"); // 行高 60，center → (60-40)/2=10
    expect(`${b!.x},${b!.y}`).toBe("110,0");
    expect(`${c!.x},${c!.y}`).toBe("0,70"); // 第二行 y = 60+10，行高 30 → y=70
  });

  test("wrap + stretch：子项高度拉到所在行高", () => {
    const { frame } = frameOf({
      id: "f", type: "frame", name: "F", x: 0, y: 0, w: 260, h: 300,
      layout: { mode: "h", gap: 10, wrap: true, cross: "stretch" },
      children: [
        { id: "a", type: "rect", name: "A", x: 0, y: 0, w: 100, h: 20 },
        { id: "b", type: "rect", name: "B", x: 0, y: 0, w: 100, h: 60 },
        { id: "c", type: "rect", name: "C", x: 0, y: 0, w: 100, h: 20 },
      ],
    });
    applyLayoutToFrame(frame);
    expect(frame.children[0]!.h).toBe(60); // 第一行行高 60，a 拉满
    expect(frame.children[2]!.y).toBe(70);
    expect(frame.children[2]!.h).toBe(20); // 第二行只有 c，行高 = 自身 20
  });

  test("wrap 下 hug 主轴被忽略（换行需要固定宽度），交叉轴照常收缩", () => {
    const { frame } = frameOf({
      id: "f", type: "frame", name: "F", x: 0, y: 0, w: 260, h: 300,
      layout: { mode: "h", gap: 10, wrap: true, hug: "main" },
      children: [
        { id: "a", type: "rect", name: "A", x: 0, y: 0, w: 100, h: 40 },
        { id: "b", type: "rect", name: "B", x: 0, y: 0, w: 100, h: 40 },
      ],
    });
    applyLayoutToFrame(frame);
    expect(frame.w).toBe(260); // 主轴 hug 无效（换行需要固定宽）
    expect(frame.h).toBe(300); // 交叉轴没开 hug → 尺寸保持
  });
});

describe("HUG 随内容收缩", () => {
  test("hug main + padding：画板宽 = 内容 + gap + 内边距", () => {
    const { frame } = frameOf({
      id: "f", type: "frame", name: "F", x: 0, y: 0, w: 400, h: 60,
      layout: { mode: "h", gap: 10, padding: [8, 12, 8, 12], hug: "main" },
      children: [
        { id: "a", type: "rect", name: "A", x: 0, y: 0, w: 100, h: 40 },
        { id: "b", type: "rect", name: "B", x: 0, y: 0, w: 60, h: 40 },
      ],
    });
    applyLayoutToFrame(frame);
    expect(frame.w).toBe(100 + 10 + 60 + 12 + 12); // 194
    expect(frame.h).toBe(60); // 未 hug 交叉轴
    expect(frame.children[0]!.x).toBe(12);
  });

  test("hug 向上传播：内层 hug 后外层 grow 收敛不振荡（applyLayoutDeep）", () => {
    const res = parseDesignDoc(
      JSON.stringify({
        pages: [{
          id: "p1",
          nodes: [{
            id: "outer", type: "frame", name: "O", x: 0, y: 0, w: 400, h: 100,
            layout: { mode: "h" },
            children: [
              {
                id: "inner", type: "frame", name: "I", x: 0, y: 0, w: 10, h: 50,
                layout: { mode: "h", gap: 10, hug: "main" },
                children: [
                  { id: "x", type: "rect", name: "X", x: 0, y: 0, w: 50, h: 40 },
                  { id: "y", type: "rect", name: "Y", x: 0, y: 0, w: 50, h: 40 },
                ],
              },
              { id: "fixed", type: "rect", name: "F", x: 0, y: 0, w: 100, h: 50, grow: 1 },
            ],
          }],
        }],
      }),
    );
    const page = res.doc.pages[0]!;
    const outer = page.nodes[0] as FrameNode;
    applyLayoutDeep(outer);
    // inner 沿外层主轴 HUG → 外层 grow 跳过它（grow 在 fixed 上）：inner 收缩为内容宽 110
    const inner = outer.children[0]!;
    expect(inner.w).toBe(110);
    expect(outer.children[1]!.w).toBe(290); // fixed(grow) 拿剩余
    expect(outer.children[1]!.x).toBe(110);
    expect(inner.children[1]!.x).toBe(60); // inner 自身内容排布
  });

  test("hug 交叉轴 + 外层 stretch：外层 stretch 跳过 hug 子画板", () => {
    const res = parseDesignDoc(
      JSON.stringify({
        pages: [{
          id: "p1",
          nodes: [{
            id: "outer", type: "frame", name: "O", x: 0, y: 0, w: 400, h: 200,
            layout: { mode: "h", cross: "stretch" },
            children: [
              {
                id: "inner", type: "frame", name: "I", x: 0, y: 0, w: 100, h: 60,
                layout: { mode: "h", hug: "cross" },
                children: [{ id: "x", type: "rect", name: "X", x: 0, y: 0, w: 80, h: 30 }],
              },
            ],
          }],
        }],
      }),
    );
    const page = res.doc.pages[0]!;
    applyLayoutDeep(page.nodes[0] as FrameNode);
    const inner = (page.nodes[0] as FrameNode).children[0]!;
    expect(inner.h).toBe(30); // hug 交叉轴生效：随内容收缩（初始 60 被重写）；外层 stretch 跳过 hug 子画板
  });
});
