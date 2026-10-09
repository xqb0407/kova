/**
 * 原型交互测试：interactions 字段的容错解析与往返、旧式 onTap 折算、
 * 关键词别名归一、collectHotspots（嵌套偏移 / 隐藏子树 / 目标校验 / 缺省转场）、
 * 浮层锚点、滚动计划、起始画板选择。
 */
import { describe, expect, test } from "bun:test";
import { allFrames, nodeInteractions, parseDesignDoc, serializeDoc, type DesignNode, type FrameNode } from "../src/doc";
import {
  collectHotspots,
  defaultTransition,
  findBoxInFrame,
  firstPlayableFrame,
  invertTransition,
  overlayAnchor,
  overlayHasBackdrop,
  resolveTargetFrame,
  scrollPlanFor,
  topLevelFrameOf,
  transitionDuration,
} from "../src/prototype";

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
          rect("hiddenBranch", { visible: false }),
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

describe("onTap 旧写法与 interactions 新写法的解析", () => {
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

  test("interactions 全字段往返；trigger/action/transition 容错别名", () => {
    const doc = build({
      version: 1,
      meta: { name: "t" },
      pages: [{ id: "p", name: "P", nodes: [
        rect("a", {
          interactions: [
            { trigger: "click", action: "jump", to: "f1", animation: "slide-left" },
            { trigger: "long_press", action: "popup", to: "d1", position: "bottom", transition: "slideUp", duration: 400 },
            { trigger: "swipeRight", action: "back" },
            { trigger: "swipe-left", action: "close" },
          ],
        }),
        frame("f1"),
        frame("d1"),
      ] }],
    });
    const n = doc.pages[0]!.nodes[0]!;
    expect(n.interactions).toEqual([
      { trigger: "tap", action: "navigate", to: "f1", transition: "pushLeft" },
      { trigger: "longPress", action: "overlay", to: "d1", position: "bottom", transition: "slideUp", duration: 400 },
      { trigger: "swipeRight", action: "back" },
      { trigger: "swipeLeft", action: "closeOverlay" },
    ]);
    // 往返幂等：解析产物再写再读，结果不变
    expect(parseDesignDoc(serializeDoc(doc)).doc.pages[0]!.nodes[0]!.interactions).toEqual(n.interactions);
  });

  test("坏 interactions 被丢弃而不猜：认不出的 trigger/action、非数组、空数组", () => {
    const doc = build({
      version: 1,
      meta: { name: "t" },
      pages: [{ id: "p", name: "P", nodes: [
        rect("a", { interactions: [{ trigger: "wiggle", action: "navigate", to: "f1" }] }),
        rect("b", { interactions: [{ trigger: "tap", action: "explode" }] }),
        rect("c", { interactions: "tap" }),
        rect("d", { interactions: [] }),
      ] }],
    });
    const ns = doc.pages[0]!.nodes;
    expect(ns[0]!.interactions).toBeUndefined();
    expect(ns[1]!.interactions).toBeUndefined();
    expect(ns[2]!.interactions).toBeUndefined();
    expect(ns[3]!.interactions).toBeUndefined();
  });

  test("nodeInteractions：interactions 优先；否则把 onTap 折算成一条单击跳转", () => {
    const doc = build({
      version: 1,
      meta: { name: "t" },
      pages: [{ id: "p", name: "P", nodes: [
        rect("legacy", { onTap: { to: "f1" } }),
        rect("new", { interactions: [{ trigger: "tap", action: "navigate", to: "f2" }], onTap: { to: "f1" } }),
        rect("plain"),
      ] }],
    });
    const ns = doc.pages[0]!.nodes as DesignNode[];
    expect(nodeInteractions(ns[0]!)).toEqual([{ trigger: "tap", action: "navigate", to: "f1" }]);
    expect(nodeInteractions(ns[1]!)).toEqual([{ trigger: "tap", action: "navigate", to: "f2" }]);
    expect(nodeInteractions(ns[2]!)).toEqual([]);
  });

  test("scroll 轴解析：true→v、别名归一、未知值不落字段", () => {
    const doc = build({
      version: 1,
      meta: { name: "t" },
      pages: [{ id: "p", name: "P", nodes: [
        frame("a", [], { scroll: true }),
        frame("b", [], { scroll: "vertical" }),
        frame("c", [], { scroll: "H" }),
        frame("d", [], { scroll: "both" }),
        frame("e", [], { scroll: "diagonal" }),
      ] }],
    });
    const fs = doc.pages[0]!.nodes as FrameNode[];
    expect(fs.map((f) => f.scroll)).toEqual(["v", "v", "h", "both", undefined]);
  });
});

/* ---------------- 缺省转场策略 ---------------- */

describe("缺省转场与时长", () => {
  test("navigate 缺省左推、back 缺省右推；浮层按停靠位取动画", () => {
    expect(defaultTransition("navigate")).toBe("pushLeft");
    expect(defaultTransition("back")).toBe("pushRight");
    expect(defaultTransition("overlay", "center")).toBe("scale");
    expect(defaultTransition("overlay", "bottom")).toBe("slideUp");
    expect(defaultTransition("overlay", "top")).toBe("slideDown");
    expect(defaultTransition("overlay", "left")).toBe("pushLeft");
    expect(defaultTransition("overlay", "right")).toBe("pushRight");
    expect(defaultTransition("scrollTo")).toBe("none");
    expect(defaultTransition("toggleVisible")).toBe("none");
  });

  test("反向转场：推入/滑入取反，none/fade/scale 自逆", () => {
    expect(invertTransition("pushLeft")).toBe("pushRight");
    expect(invertTransition("pushRight")).toBe("pushLeft");
    expect(invertTransition("pushUp")).toBe("pushDown");
    expect(invertTransition("slideUp")).toBe("slideDown");
    expect(invertTransition("fade")).toBe("fade");
    expect(invertTransition("none")).toBe("none");
  });

  test("时长：none 为 0，淡入最短，推入最长", () => {
    expect(transitionDuration("none")).toBe(0);
    expect(transitionDuration("fade")).toBeLessThan(transitionDuration("pushLeft"));
    expect(transitionDuration("pushLeft")).toBeGreaterThan(0);
  });
});

/* ---------------- 浮层锚点 ---------------- */

describe("浮层锚点", () => {
  const screen = { w: 390, h: 844 };
  test("五个停靠位的对齐规则", () => {
    expect(overlayAnchor("center", screen, { w: 270, h: 160 })).toEqual({ x: 60, y: 342 });
    expect(overlayAnchor("bottom", screen, { w: 390, h: 240 })).toEqual({ x: 0, y: 604 });
    expect(overlayAnchor("top", screen, { w: 390, h: 120 })).toEqual({ x: 0, y: 0 });
    expect(overlayAnchor("left", screen, { w: 280, h: 844 })).toEqual({ x: 0, y: 0 });
    expect(overlayAnchor("right", screen, { w: 280, h: 400 })).toEqual({ x: 110, y: 222 });
  });

  test("居中/上下停靠带遮罩，左右抽屉不带", () => {
    expect(overlayHasBackdrop("center")).toBe(true);
    expect(overlayHasBackdrop("bottom")).toBe(true);
    expect(overlayHasBackdrop("left")).toBe(false);
    expect(overlayHasBackdrop("right")).toBe(false);
  });
});

/* ---------------- 热点收集 ---------------- */

describe("allFrames / collectHotspots", () => {
  test("allFrames 只收顶层画板、按页面顺序", () => {
    expect(allFrames(doc2).map((f) => f.frame.id)).toEqual(["f1", "f2", "f3"]);
    expect(allFrames(doc2).map((f) => f.pageId)).toEqual(["pA", "pB", "pB"]);
  });

  test("热点：跨组偏移累加、隐藏节点及其子树跳过、嵌套 frame 深入", () => {
    const f1 = allFrames(doc2).find((f) => f.frame.id === "f1")!.frame as FrameNode;
    const hs = collectHotspots(f1, doc2);
    const byId = Object.fromEntries(hs.map((h) => [h.nodeId, h]));
    expect(hs.map((h) => h.nodeId)).toEqual(["btn1", "deep"]); // ghost 隐藏、nope 目标在别的屏
    expect(byId["btn1"]!.box).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    // 嵌套画板 f1c 在 (20,40)，deep 相对它 (0,0) → 累加成画板局部 (20,40)
    expect(byId["deep"]!.box).toEqual({ x: 20, y: 40, w: 10, h: 10 });
    expect(byId["deep"]!.actions[0]!.target).toBe("f3");
  });

  test("死链目标保留在 dead 里（渲染侧画红圈提示），不混进 actions", () => {
    const f2 = allFrames(doc2).find((f) => f.frame.id === "f2")!.frame as FrameNode;
    const hs = collectHotspots(f2, doc2);
    expect(hs[0]!.actions).toEqual([]);
    expect(hs[0]!.dead).toEqual([{ trigger: "tap", action: "navigate", to: "nope" }]);
  });

  test("屏内动作（scrollTo/toggleVisible）目标必须在当前画板内，否则算死链", () => {
    const doc = build({
      version: 1,
      meta: { name: "t" },
      pages: [{ id: "p", name: "P", nodes: [
        frame("f1", [
          rect("jump", { interactions: [{ trigger: "tap", action: "scrollTo", to: "foot" }] }),
          rect("bad", { interactions: [{ trigger: "tap", action: "scrollTo", to: "elsewhere" }] }),
          rect("foot", { y: 900 }),
        ], { scroll: "v" }),
        frame("f2", [rect("elsewhere")]),
      ] }],
    });
    const f1 = allFrames(doc).find((f) => f.frame.id === "f1")!.frame as FrameNode;
    const hs = Object.fromEntries(collectHotspots(f1, doc).map((h) => [h.nodeId, h]));
    expect(hs["jump"]!.actions[0]).toMatchObject({ action: "scrollTo", target: "foot" });
    expect(hs["jump"]!.dead).toEqual([]);
    expect(hs["bad"]!.actions).toEqual([]);
    expect(hs["bad"]!.dead[0]).toMatchObject({ action: "scrollTo", to: "elsewhere" });
  });

  test("back / closeOverlay 不需要目标，永远可执行", () => {
    const doc = build({
      version: 1,
      meta: { name: "t" },
      pages: [{ id: "p", name: "P", nodes: [
        frame("f1", [rect("b", { interactions: [{ trigger: "swipeRight", action: "back" }, { trigger: "tap", action: "closeOverlay" }] })]),
      ] }],
    });
    const f1 = allFrames(doc)[0]!.frame as FrameNode;
    const h = collectHotspots(f1, doc)[0]!;
    expect(h.dead).toEqual([]);
    expect(h.actions.map((a) => a.action)).toEqual(["back", "closeOverlay"]);
    expect(h.actions[0]).toMatchObject({ target: null, transition: "pushRight", duration: 300 });
  });
});

/* ---------------- 屏内定位与滚动 ---------------- */

describe("findBoxInFrame / scrollPlanFor", () => {
  const doc = build({
    version: 1,
    meta: { name: "t" },
    pages: [{ id: "p", name: "P", nodes: [
      frame("f1", [
        { ...frame("inner", [rect("deep", { y: 20, h: 30 })], { x: 10, y: 40, w: 100, h: 100 }) },
        rect("mid", { y: 300, h: 60 }),
        rect("foot", { y: 1100, h: 80 }),
      ], { scroll: "v" }),
    ] }],
  });
  const f1 = allFrames(doc)[0]!.frame as FrameNode;

  test("节点画板局部盒（嵌套偏移累加）；画板自身 = 满屏盒；找不到为 null", () => {
    expect(findBoxInFrame(doc, f1, "deep")).toEqual({ x: 10, y: 60, w: 10, h: 30 });
    expect(findBoxInFrame(doc, f1, "mid")).toEqual({ x: 0, y: 300, w: 10, h: 60 });
    expect(findBoxInFrame(doc, f1, "f1")).toEqual({ x: 0, y: 0, w: 300, h: 600 });
    expect(findBoxInFrame(doc, f1, "nope")).toBeNull();
  });

  test("滚动计划：视口内的目标贴顶；越界目标整块带入（贴底优先）", () => {
    expect(scrollPlanFor(doc, f1, "mid")).toEqual({ x: 0, y: 300 });
    // foot 底边 1180 > 600：滚到 1180-600=580，整块可见
    expect(scrollPlanFor(doc, f1, "foot")).toEqual({ x: 0, y: 580 });
    expect(scrollPlanFor(doc, f1, "nope")).toBeNull();
  });

  test("没开滚动的画板：任何目标都不产生滚动", () => {
    const plain = build({
      version: 1,
      meta: { name: "t" },
      pages: [{ id: "p", name: "P", nodes: [frame("f", [rect("a", { y: 900 })])] }],
    });
    const f = allFrames(plain)[0]!.frame as FrameNode;
    expect(scrollPlanFor(plain, f, "a")).toEqual({ x: 0, y: 0 });
  });

  test("横向滚动轴只算 x", () => {
    const hdoc = build({
      version: 1,
      meta: { name: "t" },
      pages: [{ id: "p", name: "P", nodes: [frame("f", [rect("a", { x: 500, y: 700, w: 40, h: 40 })], { scroll: "h", w: 390, h: 200 })] }],
    });
    const f = allFrames(hdoc)[0]!.frame as FrameNode;
    expect(scrollPlanFor(hdoc, f, "a")).toEqual({ x: 150, y: 0 });
  });
});

/* ---------------- 目标解析与起始画板 ---------------- */

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
