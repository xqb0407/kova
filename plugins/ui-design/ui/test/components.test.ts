/**
 * 组件/实例层单测：解析（别名/哨兵/覆盖消毒）、instanceView 权威视图
 * （烘焙几何/缩放样式/id 重编/嵌套链）、patchInstancePath 逆烘焙不动点、
 * bakeInstanceNodes 深度烘焙、flattenInstances 静态展平、findNode "/" 寻址，
 * 以及下游消费者（CSS / 原型热点 / 工程包资产）的实例口径。
 */
import { describe, expect, test } from "bun:test";
import {
  bakeInstanceNodes,
  componentBounds,
  findComponent,
  findNode,
  flattenInstances,
  instanceView,
  parseDesignDoc,
  patchInstancePath,
  serializeDoc,
  type DesignDoc,
  type FrameNode,
  type InstanceNode,
} from "../src/doc";
import { flattenForCss, nodeToCss } from "../src/css";
import { planBundle } from "../src/bundle";
import { collectHotspots } from "../src/prototype";

const load = (json: unknown): DesignDoc => {
  const r = parseDesignDoc(JSON.stringify(json));
  expect(r.fatal).toBe(false);
  return r.doc;
};
const inst = (doc: DesignDoc, id: string): InstanceNode => findNode(doc, id)!.node as InstanceNode;

/* 基准档：按钮主档（包围盒原点 (10,20)，100×50）+ 页面实例 i1（200×100 → kx=ky=2） */
const btnDoc = (): DesignDoc =>
  load({
    version: 1,
    meta: { name: "t" },
    pages: [
      {
        id: "p1",
        name: "P",
        nodes: [
          { id: "i1", type: "instance", name: "按钮", componentId: "cBtn", x: 500, y: 500, w: 200, h: 100 },
          { id: "i0", type: "instance", name: "按钮副本", componentId: "cBtn", x: 0, y: 0 },
        ],
      },
    ],
    components: [
      {
        id: "cBtn",
        name: "按钮",
        nodes: [
          {
            id: "m1",
            type: "frame",
            x: 10,
            y: 20,
            w: 100,
            h: 50,
            radius: 8,
            fills: [{ type: "solid", color: "#0d99ff" }],
            children: [
              { id: "m2", type: "rect", x: 10, y: 10, w: 20, h: 20 },
              { id: "mt", type: "text", x: 0, y: 0, w: 40, h: 14, runs: [{ text: "旧", size: 8 }] },
            ],
          },
        ],
      },
    ],
  });

describe("组件/实例解析", () => {
  test("w/h 哨兵回填主档包围盒（页面与主档内部都扫）", () => {
    const doc = btnDoc();
    const i0 = inst(doc, "i0");
    expect(i0.w).toBe(100);
    expect(i0.h).toBe(50);
  });

  test("引用别名 component/ref/mainComponent；坏引用保留为占位实例", () => {
    const doc = load({
      version: 1,
      pages: [
        {
          id: "p",
          nodes: [
            { id: "a", type: "instance", component: "cX", x: 0, y: 0, w: 10, h: 10 },
            { id: "b", type: "instance", mainComponent: "gone", x: 0, y: 0, w: 10, h: 10 },
          ],
        },
      ],
      components: [{ id: "cX", name: "X", nodes: [{ id: "x1", type: "rect", x: 0, y: 0, w: 10, h: 10 }] }],
    });
    expect(inst(doc, "a").componentId).toBe("cX");
    expect(instanceView(doc, inst(doc, "b"))).toBeNull(); // 坏引用 → null → 渲染层占位
  });

  test("主档表消毒：缺 id 跳过、空主档跳过、重复 id 重发", () => {
    const r = parseDesignDoc(
      JSON.stringify({
        version: 1,
        pages: [{ id: "p", nodes: [] }],
        components: [
          { name: "no-id", nodes: [{ id: "n", type: "rect", x: 0, y: 0, w: 5, h: 5 }] },
          { id: "cE", name: "empty", nodes: [] },
          { id: "cD", nodes: [{ id: "d1", type: "rect", x: 0, y: 0, w: 5, h: 5 }] },
          { id: "cD", nodes: [{ id: "d2", type: "rect", x: 0, y: 0, w: 5, h: 5 }] },
        ],
      }),
    );
    const comps = r.doc.components ?? [];
    expect(comps).toHaveLength(2);
    expect(comps[0]!.id).toBe("cD"); // 首个保留原 id
    expect(comps[0]!.nodes[0]!.id).toBe("d1");
    expect(comps[1]!.id).not.toBe("cD"); // 重复 id 重发
    expect(comps[1]!.nodes[0]!.id).toBe("d2");
    expect(r.warnings.some((w) => /主档为空/.test(w))).toBe(true);
  });

  test("覆盖消毒：结构字段被拦，样式字段留存并可序列化往返", () => {
    const doc = btnDoc();
    const next = patchInstancePath(doc, inst(doc, "i1"), ["m2"], {
      id: "hack",
      type: "ellipse",
      children: [],
      visible: false,
      name: "改名",
    });
    expect(next).not.toBeNull();
    const ov = next!.overrides!.m2!;
    expect(ov.visible).toBe(false);
    expect(ov.name).toBe("改名");
    expect("id" in ov).toBe(false);
    expect("type" in ov).toBe(false);
    expect("children" in ov).toBe(false);
    // 写回文档 → 序列化 → 重解析：覆盖原样留存
    doc.pages[0]!.nodes[0] = next!;
    const back = parseDesignDoc(serializeDoc(doc));
    expect(back.fatal).toBe(false);
    const bi = inst(back.doc, "i1");
    expect(bi.overrides!.m2!.visible).toBe(false);
    const view = instanceView(back.doc, bi)!;
    expect((view[0] as FrameNode).children[0]!.type).toBe("rect"); // 拓扑永远来自主档
    expect((view[0] as FrameNode).children[0]!.visible).toBe(false);
  });
});

describe("instanceView 权威视图", () => {
  test("几何烘焙到实例局部 + id 重编 + 数值样式按均比缩放", () => {
    const doc = btnDoc();
    const view = instanceView(doc, inst(doc, "i1"))!;
    const m1 = view[0]!;
    expect(m1.id).toBe("i1/m1");
    expect(m1.x).toBe(0); // (10 − 包围盒 10) × 2
    expect(m1.w).toBe(200);
    expect(m1.h).toBe(100);
    const m2 = (m1 as FrameNode).children[0]!;
    expect(m2.id).toBe("i1/m2");
    expect(m2.x).toBe(20); // 深层只缩放：10 × 2
    expect(m2.w).toBe(40);
    expect(m1.radius).toBe(16); // 8 × kAvg(2)
    const mt = (m1 as FrameNode).children[1]! as { runs: { text: string; size: number }[] };
    expect(mt.runs[0]!.size).toBe(16);
  });

  test("覆盖生效：text 速记整层替换、字段整体覆盖，主档本体不动", () => {
    const doc = btnDoc();
    (doc.pages[0]!.nodes[0] as InstanceNode).overrides = { mt: { text: "新" } };
    const view = instanceView(doc, inst(doc, "i1"))!;
    const mt = (view[0] as FrameNode).children[1]! as { runs: { text: string; size: number }[] };
    expect(mt.runs[0]!.text).toBe("新");
    expect(mt.runs[0]!.size).toBe(16); // 速记沿用首段样式（8×kAvg）
    expect(findComponent(doc, "cBtn")!.nodes[0]).not.toBeUndefined();
    const raw = findNode(doc, "mt"); // 主档节点不在页面树
    expect(raw).toBeNull();
  });

  test("坏引用 → null", () => {
    const doc = btnDoc();
    expect(instanceView(doc, { ...(inst(doc, "i1") as InstanceNode), componentId: "nope" })).toBeNull();
  });
});

describe("patchInstancePath 逆烘焙", () => {
  test("根层/深层坐标补丁 → 存储主档口径，视图读回不动点", () => {
    const doc = btnDoc();
    const i1 = inst(doc, "i1");
    const root = patchInstancePath(doc, i1, ["m1"], { x: 4 })!;
    expect(root.overrides!.m1!.x).toBe(12); // 4 ÷ 2 + 包围盒 10
    const deep = patchInstancePath(doc, i1, ["m2"], { x: 30 })!;
    expect(deep.overrides!.m2!.x).toBe(15); // 深层无平移：30 ÷ 2
    const styled = patchInstancePath(doc, i1, ["m1"], { radius: 10 })!;
    expect(styled.overrides!.m1!.radius).toBe(5); // ÷ kAvg
    // 不动点：补丁后视图坐标 = 补丁坐标
    const after = instanceView(doc, {
      ...i1,
      overrides: { ...root.overrides, ...deep.overrides, m1: { ...root.overrides!.m1, ...styled.overrides!.m1 } },
    })!;
    expect(after[0]!.x).toBe(4);
    expect(after[0]!.radius).toBe(10);
    expect((after[0] as FrameNode).children[0]!.x).toBe(30);
  });

  test("文本 runs 补丁按均比逆缩放", () => {
    const doc = btnDoc();
    const next = patchInstancePath(doc, inst(doc, "i1"), ["mt"], {
      runs: [{ text: "提交", size: 24 }],
    })!;
    expect((next.overrides!.mt!.runs as { size: number }[])[0]!.size).toBe(12); // 24 ÷ kAvg(2)
  });

  test("断路径/超长链 → null", () => {
    const doc = btnDoc();
    expect(patchInstancePath(doc, inst(doc, "i1"), ["nope"], { x: 1 })).toBeNull();
    expect(patchInstancePath(doc, inst(doc, "i1"), ["m2", "deeper"], { x: 1 })).toBeNull(); // m2 非容器
    expect(patchInstancePath(doc, inst(doc, "i1"), [], { x: 1 })).toBeNull();
  });
});

/* 嵌套组件档：cA（frame 含实例 a2 → cB），页面实例 i9 缩放 2× */
const nestedDoc = (): DesignDoc =>
  load({
    version: 1,
    pages: [{ id: "p", nodes: [{ id: "i9", type: "instance", componentId: "cA", x: 0, y: 0, w: 200, h: 200 }] }],
    components: [
      {
        id: "cA",
        name: "卡片",
        nodes: [
          {
            id: "a1",
            type: "frame",
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            children: [{ id: "a2", type: "instance", componentId: "cB", x: 10, y: 10, w: 40, h: 40 }],
          },
        ],
      },
      {
        id: "cB",
        name: "徽标",
        nodes: [{ id: "b1", type: "rect", x: 0, y: 0, w: 20, h: 20, fills: [{ type: "solid", color: "#ff0000" }] }],
      },
    ],
  });

describe("嵌套实例", () => {
  test("视图 id 链式重编 + findNode 多级寻址", () => {
    const doc = nestedDoc();
    const view = instanceView(doc, inst(doc, "i9"))!;
    const a2 = (view[0] as FrameNode).children[0]! as InstanceNode;
    expect(a2.id).toBe("i9/a2");
    expect(a2.w).toBe(80);
    const inner = instanceView(doc, a2)!;
    expect(inner[0]!.id).toBe("i9/a2/b1");
    const loc = findNode(doc, "i9/a2/b1")!;
    expect(loc.node.id).toBe("i9/a2/b1");
    expect(loc.parent!.id).toBe("i9/a2"); // 真实容器链
  });

  test("穿嵌套写覆盖：merge 进外层实例的 overrides 表", () => {
    const doc = nestedDoc();
    const next = patchInstancePath(doc, inst(doc, "i9"), ["a2", "b1"], { x: 10 })!;
    const a2ov = next.overrides!.a2!;
    // 穿嵌套按内层有效比例回推（外层 2× 已烤进 a2 的视图盒 → 内层 kx=4）：10÷4=2.5 主档口径
    expect((a2ov.overrides as Record<string, Record<string, unknown>>).b1.x).toBe(2.5);
    // 视图读回不动点
    const view2 = instanceView(doc, next)!;
    const inner2 = instanceView(doc, (view2[0] as FrameNode).children[0]! as InstanceNode)!;
    expect(inner2[0]!.x).toBe(10);
  });

  test("bakeInstanceNodes 深度烘焙：嵌套展开 + 平移拼位；坏内层保留占位实例", () => {
    const doc = nestedDoc();
    const baked = bakeInstanceNodes(doc, inst(doc, "i9"))!;
    const flat: string[] = [];
    const walk = (list: typeof baked) => {
      for (const n of list) {
        flat.push(n.id);
        if ("children" in n) walk(n.children);
      }
    };
    walk(baked);
    expect(flat).toContain("i9/a1");
    expect(flat.some((id) => id === "i9/a2/b1")).toBe(true); // 已展开，不再是实例
    const a1 = baked[0] as FrameNode;
    const b1 = a1.children.find((c) => c.id === "i9/a2/b1")!;
    expect(b1.x).toBeCloseTo(20, 1); // 内层视图 0 + 外层 a2 烘焙位 20
    // 删掉 cB：内层烘焙不出来 → 保留为实例占位节点，内容不静默丢
    const broken = nestedDoc();
    broken.components = broken.components!.filter((c) => c.id !== "cB");
    const baked2 = bakeInstanceNodes(broken, inst(broken, "i9"))!;
    const a2kept = (baked2[0] as FrameNode).children.find((c) => c.id === "i9/a2")!;
    expect(a2kept.type).toBe("instance");
  });
});

describe("flattenInstances 静态展平", () => {
  test("展平页面 + 剥离 components；坏引用保留实例节点走占位", () => {
    const doc = load({
      version: 1,
      pages: [
        {
          id: "p",
          nodes: [
            {
              id: "f1",
              type: "frame",
              x: 0,
              y: 0,
              w: 200,
              h: 100,
              children: [
                { id: "i1", type: "instance", componentId: "cBtn", x: 0, y: 0, w: 100, h: 50 },
                { id: "ix", type: "instance", componentId: "gone", x: 0, y: 60, w: 40, h: 20 },
              ],
            },
          ],
        },
      ],
      components: [
        { id: "cBtn", name: "按钮", nodes: [{ id: "m1", type: "rect", x: 0, y: 0, w: 100, h: 50 }] },
      ],
    });
    const flat = flattenInstances(doc);
    expect(flat.components).toBeUndefined();
    const kids = (flat.pages[0]!.nodes[0] as FrameNode).children;
    expect(kids[0]!.id).toBe("i1/m1");
    expect(kids[0]!.type).toBe("rect");
    expect(kids[1]!.type).toBe("instance"); // 坏引用不丢
    // 无组件档 = 原对象直通
    const plain: DesignDoc = { ...doc, components: undefined };
    expect(flattenInstances(plain)).toBe(plain);
  });
});

describe("下游消费者实例口径", () => {
  test("CSS：flattenForCss 单根借实例身份、多根裹隐式 frame、坏引用退化为空盒", () => {
    const doc = btnDoc();
    const i1 = inst(doc, "i1");
    const css = nodeToCss(i1, doc);
    expect(css).toContain("#0d99ff"); // 主档填充进入 CSS
    expect(css).toContain("/* 按钮 */"); // 选择器注释用实例名
    expect(css).toContain("left: 500px"); // 实例位置（父局部）
    // 多根主档 → 隐式 frame 包裹
    const multi = load({
      version: 1,
      pages: [{ id: "p", nodes: [{ id: "iz", type: "instance", componentId: "cM", x: 0, y: 0, w: 50, h: 20 }] }],
      components: [
        {
          id: "cM",
          name: "多根",
          nodes: [
            { id: "r1", type: "rect", x: 0, y: 0, w: 20, h: 20 },
            { id: "r2", type: "rect", x: 30, y: 0, w: 20, h: 20 },
          ],
        },
      ],
    });
    const wrapped = flattenForCss(inst(multi, "iz"), multi);
    expect(wrapped.type).toBe("frame");
    expect(nodeToCss(inst(multi, "iz"), multi)).toContain("transparent");
    // 坏引用：不崩，按实例盒直出
    expect(nodeToCss(i1, { ...doc, components: undefined })).toContain("position: absolute");
  });

  test("原型热点：实例内部 onTap 烤成画板局部盒", () => {
    const doc = load({
      version: 1,
      pages: [
        {
          id: "p",
          nodes: [
            {
              id: "fA",
              type: "frame",
              x: 0,
              y: 0,
              w: 300,
              h: 300,
              children: [{ id: "i7", type: "instance", componentId: "cT", x: 20, y: 20, w: 100, h: 50 }],
            },
            { id: "fB", type: "frame", x: 400, y: 0, w: 100, h: 100 },
          ],
        },
      ],
      components: [
        {
          id: "cT",
          name: "导航",
          nodes: [
            {
              id: "t1",
              type: "frame",
              x: 0,
              y: 0,
              w: 100,
              h: 50,
              children: [
                { id: "btn", type: "rect", x: 10, y: 10, w: 80, h: 30, onTap: { to: "fB" } },
              ],
            },
          ],
        },
      ],
    });
    const frame = findNode(doc, "fA")!.node as FrameNode;
    const hs = collectHotspots(frame, doc);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.nodeId).toBe("i7/btn");
    expect(hs[0]!.box).toEqual({ x: 30, y: 30, w: 80, h: 30 });
    // 不传 doc：老行为（实例整体无 onTap → 无热点，不崩）
    expect(collectHotspots(frame)).toEqual([]);
  });

  test("工程包：实例内部位图进 assets 清单", () => {
    const doc = load({
      version: 1,
      pages: [
        {
          id: "p",
          name: "P",
          nodes: [
            {
              id: "f1",
              type: "frame",
              x: 0,
              y: 0,
              w: 200,
              h: 100,
              children: [{ id: "i5", type: "instance", componentId: "cI", x: 0, y: 0, w: 100, h: 50 }],
            },
          ],
        },
      ],
      components: [
        {
          id: "cI",
          name: "头像",
          nodes: [
            {
              id: "mi",
              type: "frame",
              x: 0,
              y: 0,
              w: 100,
              h: 50,
              children: [{ id: "av", type: "image", x: 0, y: 0, w: 50, h: 50, src: "assets/avatar.png" }],
            },
          ],
        },
      ],
    });
    const plan = planBundle(doc, doc.pages[0]!, ["f1"], "comp");
    expect(plan.assets.map((a) => a.src)).toEqual(["assets/avatar.png"]);
  });

  test("componentBounds：多根取外包", () => {
    const b = componentBounds({
      id: "c",
      name: "n",
      nodes: [
        { id: "a", type: "rect", x: -10, y: 5, w: 20, h: 10 },
        { id: "b", type: "rect", x: 0, y: 0, w: 5, h: 30 },
      ],
    });
    expect(b).toEqual({ x: -10, y: 0, w: 20, h: 30 });
  });
});
