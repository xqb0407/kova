/**
 * 设计体检引擎单测（纯函数）：对比度阈值与半透明合成、坏 var 引用、非法图标名、
 * 触控目标、裁切溢出、嵌套深度、圆角不一致、三卡区/卡片墙/紫光晕、布局漂移、
 * 以及 page/ids/severity/code 四种过滤。
 */
import { describe, expect, test } from "bun:test";
import { lintDoc, lintSummary, type LintIssue } from "../src/lint";
import { effectiveContrast, parseColor, relativeLuminance, contrastRatio, hueOf } from "../src/color";
import type { DesignDoc, DesignNode } from "../src/doc";

const frame = (id: string, over: Partial<DesignNode> = {}): DesignNode =>
  ({ id, type: "frame", name: id, x: 0, y: 0, w: 390, h: 844, fills: [], strokes: [], children: [], ...over }) as DesignNode;

const text = (id: string, over: Partial<DesignNode> = {}): DesignNode =>
  ({ id, type: "text", name: id, x: 0, y: 0, w: 200, h: 24, runs: [{ text: "hi" }], ...over }) as DesignNode;

const doc = (nodes: DesignNode[], variables?: DesignDoc["variables"]): DesignDoc => ({
  version: 1,
  meta: { name: "lint 测试", kind: "uidesign" },
  activePage: "p1",
  pages: [{ id: "p1", name: "Page 1", nodes }],
  ...(variables ? { variables } : {}),
});

const codes = (issues: LintIssue[]): string[] => [...new Set(issues.map((i) => i.code))].sort();
const find = (issues: LintIssue[], code: string): LintIssue | undefined => issues.find((i) => i.code === code);

/* ---------------- color.ts ---------------- */

describe("颜色解析与对比度", () => {
  test("parseColor 覆盖 hex3/4/6/8、rgb()/rgba()、色名；脏值返回 null", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#ff0000")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("#00000080")!.a).toBeCloseTo(0.502, 2);
    expect(parseColor("#f00f")!.a).toBeCloseTo(0x0f / 255, 3);
    expect(parseColor("rgb(255, 0, 0)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("rgba(0, 0, 0, 0.5)")!.a).toBe(0.5);
    expect(parseColor("white")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("transparent")).toBeNull();
    expect(parseColor("var:abc")).toBeNull();
    expect(parseColor("")).toBeNull();
    expect(parseColor(undefined)).toBeNull();
  });

  test("黑对白 = 21:1；相对亮度单调", () => {
    const ratio = contrastRatio(parseColor("#000000")!, parseColor("#ffffff")!);
    expect(ratio).toBeCloseTo(21, 1);
    expect(relativeLuminance(parseColor("#ffffff")!)).toBeCloseTo(1, 3);
    expect(relativeLuminance(parseColor("#000000")!)).toBeCloseTo(0, 5);
    // 同一个色自比恒为 1
    expect(contrastRatio(parseColor("#8a8a8a")!, parseColor("#8a8a8a")!)).toBeCloseTo(1, 5);
  });

  test("半透明前景先合成再比：50% 黑压白底 ≈ 灰，对比度落在中间而非虚高", () => {
    const got = effectiveContrast("#00000080", "#ffffff");
    expect(got).not.toBeNull();
    // 合成后前景 ≈ #808080，白底对灰 ≈ 3.95:1；若不合成（按纯黑算）会得到 21:1
    expect(got!.ratio).toBeGreaterThan(3);
    expect(got!.ratio).toBeLessThan(5);
    expect(got!.fg).toBe("#7f7f7f");
  });

  test("hueOf：无彩色返回 null，紫/蓝/绿各归各位", () => {
    expect(hueOf(parseColor("#808080")!)).toBeNull();
    expect(hueOf(parseColor("#800080")!)!).toBeGreaterThanOrEqual(260);
    expect(hueOf(parseColor("#800080")!)!).toBeLessThanOrEqual(320);
    expect(hueOf(parseColor("#0000ff")!)).toBeCloseTo(240, 0);
    expect(hueOf(parseColor("#00ff00")!)).toBeCloseTo(120, 0);
  });
});

/* ---------------- text-contrast ---------------- */

describe("text-contrast", () => {
  test("低对比度报错并给出 fg/bg/ratio；达标的普通文字不报", () => {
    const bad = doc([
      frame("f1", { fills: [{ type: "solid", color: "#ffffff" }], children: [text("t1", { runs: [{ text: "浅灰", color: "#aaaaaa", size: 14 }] })] }),
    ]);
    const issues = lintDoc(bad).issues;
    const c = find(issues, "text-contrast");
    expect(c).toBeDefined();
    expect(c!.severity).toBe("error");
    expect(c!.nodeId).toBe("t1");
    expect(c!.detail!.ratio).toBeLessThan(4.5);

    const ok = doc([
      frame("f1", { fills: [{ type: "solid", color: "#ffffff" }], children: [text("t1", { runs: [{ text: "深灰", color: "#595959", size: 14 }] })] }),
    ]);
    expect(find(lintDoc(ok).issues, "text-contrast")).toBeUndefined();
  });

  test("大字阈值放宽到 3.0（≥24px 或 ≥19px 粗体）", () => {
    // #949494 on #fff ≈ 3.0：14px 普通文字不过，24px 大字过
    const mk = (size: number, weight = 400): DesignDoc =>
      doc([frame("f1", { fills: [{ type: "solid", color: "#ffffff" }], children: [text("t1", { runs: [{ text: "字", color: "#949494", size, weight }] })] })]);
    expect(find(lintDoc(mk(14)).issues, "text-contrast")).toBeDefined();
    expect(find(lintDoc(mk(24)).issues, "text-contrast")).toBeUndefined();
    expect(find(lintDoc(mk(19, 700)).issues, "text-contrast")).toBeUndefined();
    expect(find(lintDoc(mk(19, 400)).issues, "text-contrast")).toBeDefined();
  });

  test("背景向上找祖先：文字套在深色按钮里，浅色字判为达标", () => {
    const d = doc([
      frame("f1", {
        fills: [{ type: "solid", color: "#ffffff" }],
        children: [
          {
            ...frame("btn", { x: 10, y: 10, w: 120, h: 44, fills: [{ type: "solid", color: "#111111" }], name: "提交按钮" }),
            children: [text("t1", { x: 8, y: 12, runs: [{ text: "提交", color: "#ffffff" }] })],
          } as DesignNode,
        ],
      }),
    ]);
    expect(find(lintDoc(d).issues, "text-contrast")).toBeUndefined();
  });

  test("背景按绘制顺序解析：色块与文字是同层兄弟时，取色块而非深色画板", () => {
    // 真实稿里的典型画法：按钮色块 rect 与按钮文字平级叠放，文字的父链上只有深色画板
    const d = doc([
      frame("board", {
        w: 390,
        h: 200,
        fills: [{ type: "solid", color: "#1c1e24" }],
        children: [
          { id: "btn", type: "rect", name: "主按钮", x: 24, y: 40, w: 342, h: 56, fills: [{ type: "solid", color: "#8ee6cf" }], strokes: [] } as DesignNode,
          text("btnLabel", { x: 24, y: 56, w: 342, h: 24, align: "center", runs: [{ text: "登 录", color: "#1c1f26" }] }),
        ],
      }),
    ]);
    // 深字压薄荷绿底 = 达标，不该报
    expect(find(lintDoc(d).issues, "text-contrast")).toBeUndefined();
  });

  test("真问题仍然抓得住：同层兄弟是浅色而文字也是浅色 → 照样报错", () => {
    const d = doc([
      frame("board", {
        w: 390,
        h: 200,
        fills: [{ type: "solid", color: "#1c1e24" }],
        children: [
          { id: "btn", type: "rect", name: "主按钮", x: 24, y: 40, w: 342, h: 56, fills: [{ type: "solid", color: "#f2f2f2" }], strokes: [] } as DesignNode,
          text("btnLabel", { x: 24, y: 56, w: 342, h: 24, align: "center", runs: [{ text: "登录", color: "#e8e8e8" }] }),
        ],
      }),
    ]);
    const c = find(lintDoc(d).issues, "text-contrast");
    expect(c).toBeDefined();
    expect(c!.detail!.bg).toBe("#f2f2f2");
  });

  test("半透明兄弟色叠在祖先底色之上，两者都要参与计算", () => {
    // 祖先深色 + 覆盖文字的半透明白色兄弟 → 合成后是浅灰，深字压浅灰仍不达标
    const d = doc([
      frame("board", {
        w: 390,
        h: 200,
        fills: [{ type: "solid", color: "#1c1e24" }],
        children: [
          { id: "veil", type: "rect", name: "半透明白", x: 0, y: 0, w: 390, h: 200, fills: [{ type: "solid", color: "#ffffff80" }], strokes: [] } as DesignNode,
          text("t", { x: 24, y: 40, w: 300, h: 24, runs: [{ text: "浅底深字", color: "#2a2a2a" }] }),
        ],
      }),
    ]);
    const c = find(lintDoc(d).issues, "text-contrast");
    // 合成结果应是中间调（既不是祖先的近黑，也不是兄弟的纯白）
    expect(c!.detail!.bg).not.toBe("#1c1e24");
    expect(c!.detail!.bg).not.toBe("#ffffff");
  });

  test("不覆盖文字的兄弟不算背景（退回祖先）", () => {
    // 兄弟在左边、与文字盒不重叠 → 不能拿它的颜色当背景
    const d = doc([
      frame("board", {
        w: 390,
        h: 200,
        fills: [{ type: "solid", color: "#ffffff" }],
        children: [
          { id: "chip", type: "rect", name: "左侧色块", x: 0, y: 0, w: 40, h: 200, fills: [{ type: "solid", color: "#000000" }], strokes: [] } as DesignNode,
          text("t", { x: 100, y: 40, w: 200, h: 24, runs: [{ text: "正常文字", color: "#bbbbbb" }] }),
        ],
      }),
    ]);
    const c = find(lintDoc(d).issues, "text-contrast");
    expect(c!.detail!.bg).toBe("#ffffff");
  });

  test("仍是 var: 引用解不开时跳过判定（不误报），解开后照常判", () => {
    const withVar = doc(
      [frame("f1", { children: [text("t1", { runs: [{ text: "字", color: "var:v1" }] })] })],
      [{ id: "v1", name: "灰", value: "#aaaaaa" }],
    );
    const c = find(lintDoc(withVar).issues, "text-contrast");
    expect(c).toBeDefined();
    expect(c!.detail!.fg).toBe("#aaaaaa");
  });
});

/* ---------------- 单点规则 ---------------- */

describe("dangling-var / unknown-icon", () => {
  test("指向未定义变量报错；变量存在则不报", () => {
    const bad = doc([frame("f1", { children: [text("t1", { runs: [{ text: "字", color: "var:ghost" }] })] })]);
    expect(find(lintDoc(bad).issues, "dangling-var")!.nodeId).toBe("t1");
    const good = doc([frame("f1", { children: [text("t1", { runs: [{ text: "字", color: "var:v1" }] })] })], [
      { id: "v1", name: "灰", value: "#aaaaaa" },
    ]);
    expect(find(lintDoc(good).issues, "dangling-var")).toBeUndefined();
  });

  test("非法 lucide 图标名 warning，合法名（含别名）不报", () => {
    const bad = doc([frame("f1", { children: [{ id: "i1", type: "icon", name: "i1", x: 0, y: 0, w: 24, h: 24, icon: "not-a-real-icon" } as DesignNode] })]);
    const iss = find(lintDoc(bad).issues, "unknown-icon");
    expect(iss!.severity).toBe("warning");
    expect(iss!.detail!.icon).toBe("not-a-real-icon");

    const good = doc([frame("f1", { children: [{ id: "i1", type: "icon", name: "i1", x: 0, y: 0, w: 24, h: 24, icon: "home" } as DesignNode] })]);
    expect(find(lintDoc(good).issues, "unknown-icon")).toBeUndefined();
  });
});

describe("tap-target-small", () => {
  test("移动端画板内 onTap 节点小于 44 报警；≥44 通过", () => {
    const small = doc([frame("f1", { children: [{ ...text("b1", { w: 30, h: 30 }), onTap: { to: "f2" } } as DesignNode] })]);
    expect(find(lintDoc(small).issues, "tap-target-small")!.detail!.min).toBe(44);

    const big = doc([frame("f1", { children: [{ ...text("b1", { w: 44, h: 44 }), onTap: { to: "f2" } } as DesignNode] })]);
    expect(find(lintDoc(big).issues, "tap-target-small")).toBeUndefined();
  });

  test("桌面宽画板内不判（44pt 只约束触屏）", () => {
    const d = doc([frame("f1", { w: 1440, h: 900, children: [{ ...text("b1", { w: 30, h: 30 }), onTap: { to: "f2" } } as DesignNode] })]);
    expect(find(lintDoc(d).issues, "tap-target-small")).toBeUndefined();
  });
});

describe("dangling-interaction / prototype-flow", () => {
  const inter = (trigger: string, action: string, to?: string) => ({ trigger, action, ...(to ? { to } : {}) });

  test("交互目标不可用 → error，带 trigger/action/reason，nodeId 可直喂 update_nodes", () => {
    const d = doc([
      frame("f1", {
        children: [
          { ...text("btn", { w: 100, h: 44 }), interactions: [inter("tap", "navigate", "ghost")] } as DesignNode,
        ],
      }),
    ]);
    const issue = find(lintDoc(d).issues, "dangling-interaction")!;
    expect(issue.severity).toBe("error");
    expect(issue.nodeId).toBe("btn");
    expect(issue.detail!.to).toBe("ghost");
    expect(issue.message).toContain("单击");
    expect(issue.suggestion).toContain("顶层画板");
  });

  test("back / closeOverlay 无目标也算合法；屏内动作指向画板内节点才算数", () => {
    const ok = doc([
      frame("f1", {
        scroll: "v",
        children: [
          { ...text("b", { w: 100, h: 44 }), interactions: [inter("tap", "back"), inter("swipeDown", "closeOverlay")] } as DesignNode,
          { ...text("foot", { y: 900, w: 100, h: 24 }) } as DesignNode,
          { ...text("jump", { w: 100, h: 44 }), interactions: [inter("tap", "scrollTo", "foot")] } as DesignNode,
        ],
      }),
    ]);
    expect(find(lintDoc(ok).issues, "dangling-interaction")).toBeUndefined();

    const bad = doc([
      frame("f1", { children: [{ ...text("b", { w: 100, h: 44 }), interactions: [inter("tap", "scrollTo", "not-here")] } as DesignNode] }),
      frame("f2"),
    ]);
    expect(find(lintDoc(bad).issues, "dangling-interaction")!.detail!.reason).toContain("不在当前画板内");
  });

  test("prototype-flow：孤儿屏与断头屏各报一条，首屏不算孤儿", () => {
    const d = doc([
      frame("home", { children: [{ ...text("go", { w: 100, h: 44 }), interactions: [inter("tap", "navigate", "detail")] } as DesignNode] }),
      frame("detail", { children: [{ ...text("back", { w: 100, h: 44 }), interactions: [inter("tap", "back")] } as DesignNode] }),
      frame("orphan"),
    ]);
    const flows = lintDoc(d).issues.filter((i) => i.code === "prototype-flow");
    // 引擎按 code@nodeId 去重 → 孤儿屏的两条毛病合成一条
    expect(flows.map((i) => [i.nodeId, i.detail!.kinds])).toEqual([["orphan", ["unreachable", "dead-end"]]]);
    expect(flows[0]!.message).toContain("没有任何交互跳进"); // 两种毛病合成一句话说清
    // home 是主入口：不报孤儿；它有出口：不报断头。detail 只有 back 也算出口
    expect(flows.some((i) => i.nodeId === "home" || i.nodeId === "detail")).toBe(false);
  });

  test("只有 back 出口的画板不算断头屏", () => {
    const d = doc([
      frame("home", { children: [{ ...text("go", { w: 100, h: 44 }), interactions: [inter("tap", "navigate", "detail")] } as DesignNode] }),
      frame("detail", { children: [{ ...text("b", { w: 100, h: 44 }), interactions: [inter("swipeRight", "back")] } as DesignNode] }),
    ]);
    expect(find(lintDoc(d).issues, "prototype-flow")).toBeUndefined();
  });

  test("prototype-flow：全档没有任何交互时不评流程（纯视觉稿不该被刷屏）", () => {
    const d = doc([frame("f1"), frame("f2"), frame("f3")]);
    expect(find(lintDoc(d).issues, "prototype-flow")).toBeUndefined();
  });

  test("单屏稿不评流程", () => {
    const d = doc([frame("f1", { children: [{ ...text("b", { w: 100, h: 44 }), interactions: [inter("tap", "back")] } as DesignNode] })]);
    expect(find(lintDoc(d).issues, "prototype-flow")).toBeUndefined();
  });
});

describe("overflow-clipped / nesting-depth / empty-container", () => {
  test("clip 画板内子节点越界 warning；clip:false 不报", () => {
    const clipped = doc([frame("f1", { children: [text("t1", { x: 380, y: 20, w: 100, h: 24 })] })]);
    const c = find(lintDoc(clipped).issues, "overflow-clipped");
    expect(c!.detail!.edges).toEqual(["右"]);

    const open = doc([frame("f1", { clip: false, children: [text("t1", { x: 380, y: 20, w: 100, h: 24 })] })]);
    expect(find(lintDoc(open).issues, "overflow-clipped")).toBeUndefined();
  });

  test("滚动区域：滚动轴上的溢出不算问题，非滚动轴仍报且带 scroll 说明", () => {
    // scroll:"v" + 内容向下溢出 = 设计意图，不报
    const scrolled = doc([frame("f1", { scroll: "v", children: [text("t1", { y: 900, w: 100, h: 24 })] })]);
    expect(find(lintDoc(scrolled).issues, "overflow-clipped")).toBeUndefined();

    // 同一块画板横向溢出：竖向滚动轴救不了它
    const sideways = doc([frame("f1", { scroll: "v", children: [text("t1", { x: 380, y: 20, w: 100, h: 24 })] })]);
    const c = find(lintDoc(sideways).issues, "overflow-clipped")!;
    expect(c.detail!.edges).toEqual(["右"]);
    expect(c.detail!.scroll).toBe("v");
    expect(c.message).toContain("滚不到");
    expect(c.suggestion).toContain("both");
  });

  test("嵌套超过 8 层报警，同链只报一次", () => {
    let node: DesignNode = text("leaf", { x: 0, y: 0, w: 10, h: 10 });
    for (let i = 0; i < 10; i++) node = frame(`f${i}`, { w: 200, h: 200, children: [node] });
    const issues = lintDoc(doc([node])).issues;
    const deep = issues.filter((i) => i.code === "nesting-depth");
    expect(deep.length).toBe(1);
    expect(deep[0]!.detail!.depth).toBeGreaterThan(8);
  });

  test("空容器 info；有可见子节点则不报（visible:false 不算）", () => {
    expect(find(lintDoc(doc([frame("f1")])).issues, "empty-container")!.severity).toBe("info");
    const hidden = doc([frame("f1", { children: [text("t1", { visible: false })] })]);
    expect(find(lintDoc(hidden).issues, "empty-container")).toBeDefined();
    const filled = doc([frame("f1", { children: [text("t1")] })]);
    expect(find(lintDoc(filled).issues, "empty-container")).toBeUndefined();
  });
});

/* ---------------- 同层规则 ---------------- */

describe("同层一致性规则", () => {
  test("mixed-sibling-radius：3 个同尺寸兄弟圆角不一致才报", () => {
    const mk = (radii: number[]): DesignDoc =>
      doc([
        frame("f1", {
          children: radii.map((r, i) => ({
            id: `c${i}`,
            type: "rect",
            name: `c${i}`,
            x: i * 120,
            y: 0,
            w: 100,
            h: 80,
            radius: r,
            fills: [],
            strokes: [],
          })) as DesignNode[],
        }),
      ]);
    expect(find(lintDoc(mk([8, 8, 8])).issues, "mixed-sibling-radius")).toBeUndefined();
    expect(find(lintDoc(mk([8, 16, 8])).issues, "mixed-sibling-radius")).toBeDefined();
    // 只有 2 个同尺寸 → 不构成「一组」
    expect(find(lintDoc(mk([8, 16])).issues, "mixed-sibling-radius")).toBeUndefined();
  });

  test("slop-three-card-row：3 个等尺寸等间距「卡片」命中；裸行与间距不等都不命中", () => {
    const card = (id: string, x: number): DesignNode =>
      ({ id, type: "rect", name: id, x, y: 0, w: 100, h: 80, radius: 8, fills: [], strokes: [] }) as DesignNode;
    const even = doc([frame("f1", { children: [card("c0", 0), card("c1", 120), card("c2", 240)] })]);
    expect(find(lintDoc(even).issues, "slop-three-card-row")).toBeDefined();

    const uneven = doc([frame("f1", { children: [card("c0", 0), card("c1", 120), card("c2", 300)] })]);
    expect(find(lintDoc(uneven).issues, "slop-three-card-row")).toBeUndefined();

    // 无填充/无圆角/无阴影的裸行 = 列表行或导航行，不是卡片，不该报
    const row = (id: string, x: number): DesignNode =>
      ({ id, type: "rect", name: id, x, y: 0, w: 390, h: 56, fills: [], strokes: [] }) as DesignNode;
    const plainRows = doc([frame("f1", { children: [row("r0", 0), row("r1", 0), row("r2", 0), row("r3", 0)] })]);
    expect(find(lintDoc(plainRows).issues, "slop-three-card-row")).toBeUndefined();

    // 有非白底色才算卡片（newFrame 的默认 #ffffff 不算）
    const filled = (id: string, x: number): DesignNode =>
      ({ id, type: "rect", name: id, x, y: 0, w: 100, h: 80, fills: [{ type: "solid", color: "#eeeeee" }], strokes: [] }) as DesignNode;
    const filledRow = doc([frame("f1", { children: [filled("c0", 0), filled("c1", 120), filled("c2", 240)] })]);
    expect(find(lintDoc(filledRow).issues, "slop-three-card-row")).toBeDefined();

    // frame 自带默认白填充 —— 等同于裸行，不该报
    const defaultWhite = doc([frame("f1", { children: [frame("a", { x: 0, w: 390, h: 56 }), frame("b", { x: 0, w: 390, h: 56 }), frame("c", { x: 0, w: 390, h: 56 })] })]);
    expect(find(lintDoc(defaultWhite).issues, "slop-three-card-row")).toBeUndefined();
  });

  test("slop-rounded-card-wall：≥4 个「大圆角+阴影」才报，且必须是全部兄弟", () => {
    const card = (id: string, i: number, radius: number, shadow: boolean): DesignNode =>
      ({
        id,
        type: "rect",
        name: id,
        x: i * 120,
        y: 0,
        w: 100,
        h: 80,
        radius,
        fills: [],
        strokes: [],
        ...(shadow ? { effects: [{ type: "drop-shadow", color: "#00000033", x: 0, y: 2, blur: 8 }] } : {}),
      }) as DesignNode;
    const wall = doc([frame("f1", { children: [0, 1, 2, 3].map((i) => card(`c${i}`, i, 20, true)) })]);
    expect(find(lintDoc(wall).issues, "slop-rounded-card-wall")!.detail!.cards).toBe(4);

    const mixed = doc([frame("f1", { children: [card("c0", 0, 20, true), card("c1", 1, 20, true), card("c2", 2, 4, true), card("c3", 3, 20, true)] })]);
    expect(find(lintDoc(mixed).issues, "slop-rounded-card-wall")).toBeUndefined();
  });

  test("slop-purple-glow：紫色渐变 + 大模糊阴影才报；去掉任一条件即不报", () => {
    const grad = (c1: string, c2: string, blur: number): DesignNode =>
      ({
        id: "g1",
        type: "rect",
        name: "g1",
        x: 0,
        y: 0,
        w: 200,
        h: 120,
        fills: [{ type: "linear", angle: 135, stops: [{ at: 0, color: c1 }, { at: 1, color: c2 }] }],
        strokes: [],
        effects: [{ type: "drop-shadow", color: "#00000055", x: 0, y: 8, blur }],
      }) as DesignNode;
    const d1 = doc([frame("f1", { children: [grad("#7c3aed", "#c026d3", 40)] })]);
    expect(find(lintDoc(d1).issues, "slop-purple-glow")).toBeDefined();
    // 小模糊半径
    expect(find(lintDoc(doc([frame("f1", { children: [grad("#7c3aed", "#c026d3", 8)] })])).issues, "slop-purple-glow")).toBeUndefined();
    // 换成品牌蓝渐变
    expect(find(lintDoc(doc([frame("f1", { children: [grad("#0d99ff", "#0a6fd8", 40)] })])).issues, "slop-purple-glow")).toBeUndefined();
  });
});

describe("layout-drift", () => {
  test("自动布局画板里手动挪过子项 → info；位置与重排一致则不报", () => {
    const aligned = doc([
      frame("f1", {
        layout: { mode: "v", gap: 10, padding: [0, 0, 0, 0], main: "start", cross: "start" },
        children: [text("t1", { x: 0, y: 0, w: 100, h: 20 }), text("t2", { x: 0, y: 30, w: 100, h: 20 })],
      }),
    ]);
    expect(find(lintDoc(aligned).issues, "layout-drift")).toBeUndefined();

    const drifted = doc([
      frame("f1", {
        layout: { mode: "v", gap: 10, padding: [0, 0, 0, 0], main: "start", cross: "start" },
        children: [text("t1", { x: 0, y: 0, w: 100, h: 20 }), text("t2", { x: 0, y: 999, w: 100, h: 20 })],
      }),
    ]);
    expect(find(lintDoc(drifted).issues, "layout-drift")!.detail!.drifted).toEqual(["t2"]);
  });
});

/* ---------------- 入口与过滤 ---------------- */

describe("lintDoc 过滤与统计", () => {
  const busy = (): DesignDoc =>
    doc([
      frame("f1", {
        fills: [{ type: "solid", color: "#ffffff" }],
        children: [
          text("t1", { runs: [{ text: "浅", color: "#bbbbbb" }] }),
          frame("empty1", { x: 200, y: 0, w: 50, h: 50 }),
          { id: "i1", type: "icon", name: "i1", x: 0, y: 60, w: 24, h: 24, icon: "zzz-nope" } as DesignNode,
        ],
      }),
      frame("f2", { x: 500, w: 1440, h: 900 }),
    ]);

  test("counts 按级别统计，issues 按严重度排序", () => {
    const r = lintDoc(busy());
    expect(r.counts.error).toBeGreaterThan(0);
    expect(r.counts.warning).toBeGreaterThan(0);
    expect(r.counts.info).toBeGreaterThan(0);
    const sev = r.issues.map((i) => i.severity);
    expect(sev.indexOf("error")).toBeLessThan(sev.lastIndexOf("info"));
  });

  test("page / ids / minSeverity / codes 四种过滤都生效", () => {
    const d = busy();
    const second: DesignDoc = { ...d, pages: [{ id: "p2", name: "第二页", nodes: [frame("f9")] }] };
    expect(lintDoc(second, { page: "p2" }).issues.every((i) => i.page === "第二页")).toBe(true);
    expect(lintDoc(second, { page: "第二页" }).issues.length).toBeGreaterThan(0);

    const onlyF2 = lintDoc(d, { ids: ["f2"] }).issues;
    expect(onlyF2.every((i) => i.nodeId === "f2")).toBe(true);

    const warnOnly = lintDoc(d, { minSeverity: "warning" });
    expect(warnOnly.issues.every((i) => i.severity !== "info")).toBe(true);

    const justContrast = lintDoc(d, { codes: ["text-contrast"] });
    expect(justContrast.issues.every((i) => i.code === "text-contrast")).toBe(true);
  });

  test("空文档不炸，counts 全 0", () => {
    const r = lintDoc(doc([]));
    expect(r.issues).toEqual([]);
    expect(r.counts).toEqual({ error: 0, warning: 0, info: 0 });
  });

  test("lintSummary 只回 warning 以上的前 N 条 code@id", () => {
    const s = lintSummary(busy());
    expect(s.counts.info).toBe(0);
    expect(s.top.length).toBeLessThanOrEqual(3);
    expect(s.top.every((t) => t.includes("@"))).toBe(true);
  });

  test("实例内部节点一并体检，nodeId 是可寻址的 实例id/内部id", () => {
    const d: DesignDoc = {
      version: 1,
      meta: { name: "实例", kind: "uidesign" },
      activePage: "p1",
      pages: [
        {
          id: "p1",
          name: "Page 1",
          nodes: [
            {
              id: "inst1",
              type: "instance",
              name: "卡片",
              x: 0,
              y: 0,
              w: 200,
              h: 100,
              componentId: "c1",
            } as DesignNode,
          ],
        },
      ],
      components: [
        {
          id: "c1",
          name: "卡片",
          nodes: [
            {
              ...frame("inner", { w: 200, h: 100, fills: [{ type: "solid", color: "#ffffff" }] }),
              children: [text("label", { runs: [{ text: "浅字", color: "#cccccc" }] })],
            } as DesignNode,
          ],
        },
      ],
    };
    const c = find(lintDoc(d).issues, "text-contrast");
    expect(c).toBeDefined();
    // instanceView 展开时前缀只带实例 id（主档根节点被吃掉），与 update_nodes 的寻址口径一致
    expect(c!.nodeId).toBe("inst1/label");
  });
});