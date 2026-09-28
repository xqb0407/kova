/**
 * 原型交互测试：onTap 字段的容错解析与序列化往返、allFrames 汇总、
 * collectHotspots（嵌套偏移累加/隐藏子树跳过）、目标解析与起始画板选择。
 */
import { describe, expect, test } from "bun:test";
import { allFrames, parseDesignDoc, serializeDoc, type FrameNode } from "../src/doc";
import { collectHotspots, firstPlayableFrame, resolveTargetFrame, topLevelFrameOf } from "../src/prototype";

const rect = (id: string, over: Record<string, unknown> = {}) => ({ id, type: "rect", x: 0, y: 0, w: 10, h: 10, ...over });
const frame = (id: string, children: unknown[] = [], over: Record<string, unknown> = {}) => ({
  id,
  type: "frame",
  x: 0,
  y: 0,
  w: 300,
  h: 600,
  children,
  ...over,
});
const build = (json: unknown) => parseDesignDoc(JSON.stringify(json)).doc;
const doc2 = build({
  version: 1,
  meta: { name: "原型" },
  activePage: "pB",
  pages: [
    {
      id: "pA",
      name: "A",
      nodes: [
        frame("f1", [
          rect("btn1", { onTap: { to: "f2" } }),
          rect("ghost", { visible: false, onTap: { to: "f2" } }),
          { ...frame("f1c", [rect("deep", { onTap: { to: "f3" } })], { x: 20, y: 40, w: 100, h: 80 }) },
          rect("hiddenBranch", { visible: false }, ),
        ]),
      ],
    },
    {
      id: "pB",
      name: "B",
      nodes: [frame("f2", [rect("x1", { onTap: { to: "nope" } })]), frame("f3")],
    },
  ],
});

describe("onTap 解析容错与往返", () => {
  test("合法 onTap 保留并序列化往返", () => {
    const doc = build({
      version: 1,
      meta: { name: "t" },
      pages: [{ id: "p", name: "P", nodes: [rect("a", { onTap: { to: "f9" } }), frame("f9")] }],
    });
    const n = doc.pages[0]!.nodes[0]!;
    expect(n.onTap).toEqual({ to: "f9" });
    const again = parseDesignDoc(serializeDoc(doc)).doc;
    expect(again.pages[0]!.nodes[0]!.onTap).toEqual({ to: "f9" });
    expect(parseDesignDoc(serializeDoc(doc)).warnings).toEqual([]);
  });

  test("坏 onTap 丢弃：非对象 / to 非串 / 空 to；超长 to 截 120", () => {
    const doc = build({
      version: 1,
      meta: { name: "t" },
      pages: [{ id: "p", name: "P", nodes: [
        rect("a", { onTap: "f1" }),
        rect("b", { onTap: { to: 7 } }),
        rect("c", { onTap: { to: "" } }),
        rect("d", { onTap: { to: "x".repeat(300) } }),
      ] }],
    });
    const ns = doc.pages[0]!.nodes;
    expect(ns[0]!.onTap).toBeUndefined();
    expect(ns[1]!.onTap).toBeUndefined();
    expect(ns[2]!.onTap).toBeUndefined();
    expect(ns[3]!.onTap!.to.length).toBe(120);
  });
});

describe("allFrames / collectHotspots", () => {
  test("allFrames 只收顶层画板、按页面顺序", () => {
    expect(allFrames(doc2).map((f) => f.frame.id)).toEqual(["f1", "f2", "f3"]);
    expect(allFrames(doc2).map((f) => f.pageId)).toEqual(["pA", "pB", "pB"]);
  });

  test("热点：跨组偏移累加、隐藏节点及其子树跳过、嵌套 frame 深入", () => {
    const f1 = allFrames(doc2).find((f) => f.frame.id === "f1")!.frame as FrameNode;
    const hs = collectHotspots(f1);
    const byId = Object.fromEntries(hs.map((h) => [h.nodeId, h]));
    expect(hs.map((h) => h.nodeId)).toEqual(["btn1", "deep"]); // ghost 隐藏、nope 目标在别的屏
    expect(byId["btn1"]!.box).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    // 嵌套画板 f1c 在 (20,40)，deep 相对它 (0,0) → 累加成画板局部 (20,40)
    expect(byId["deep"]!.box).toEqual({ x: 20, y: 40, w: 10, h: 10 });
    expect(byId["deep"]!.to).toBe("f3");
  });

  test("死链目标保留在数据里（渲染侧自行降级）", () => {
    const f2 = allFrames(doc2).find((f) => f.frame.id === "f2")!.frame as FrameNode;
    expect(collectHotspots(f2)[0]!.to).toBe("nope");
  });
});

describe("目标解析与起始画板", () => {
  test("resolveTargetFrame：只认顶层画板，非画板/死链/嵌套画板都算失败", () => {
    expect(resolveTargetFrame(doc2, "f3")!.id).toBe("f3");
    expect(resolveTargetFrame(doc2, "btn1")).toBeNull();
    expect(resolveTargetFrame(doc2, "nope")).toBeNull();
    expect(resolveTargetFrame(doc2, "f1c")).toBeNull(); // 嵌套 frame 不是可跳转屏
  });

  test("topLevelFrameOf：深层节点爬到所在顶层画板；页级游离节点为 null", () => {
    expect(topLevelFrameOf(doc2, "deep")!.id).toBe("f1");
    expect(topLevelFrameOf(doc2, "f1")!.id).toBe("f1");
    const doc3 = build({ version: 1, meta: { name: "t" }, pages: [{ id: "p", name: "P", nodes: [rect("free")] }] });
    expect(topLevelFrameOf(doc3, "free")).toBeNull();
  });

  test("firstPlayableFrame：选中→当前页第一→全档第一→null", () => {
    expect(firstPlayableFrame(doc2, ["deep"])!.id).toBe("f1");
    expect(firstPlayableFrame(doc2, [])!.id).toBe("f2"); // activePage=pB 的第一个
    expect(firstPlayableFrame(doc2, ["gone"])!.id).toBe("f2");
    const empty = build({ version: 1, meta: { name: "t" }, pages: [{ id: "p", name: "P", nodes: [rect("r")] }] });
    expect(firstPlayableFrame(empty, ["r"])).toBeNull();
  });
});
