/**
 * MCP 原型交互与滚动区域的写入面测试：真实文件读写，验证
 * 严格校验（写错当场报错并列出可用取值）、整表替换语义、
 * edit_interactions 的四种 op、写入后的目标校验反馈、实例内部寻址。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TOOL_DEFS, type ToolCtx } from "../tools";
import { findNode, parseDesignDoc, type DesignDoc, type DesignNode, type FrameNode } from "../../ui/src/doc";
import { collectHotspots } from "../../ui/src/prototype";

/** 主档树里的深搜（主档不展开实例，直接递归 children 即可） */
function findNodeIn(list: DesignNode[], id: string): DesignNode | undefined {
  for (const n of list) {
    if (n.id === id) return n;
    if ("children" in n) {
      const hit = findNodeIn(n.children, id);
      if (hit) return hit;
    }
  }
  return undefined;
}

let ws = "";
let ctx: ToolCtx;

function run(name: string, args: Record<string, unknown>): any {
  const tool = TOOL_DEFS.find((t) => t.name === name);
  expect(tool).toBeDefined();
  return tool!.run(args, ctx);
}

function load(p = "proto.uidesign.json"): DesignDoc {
  const res = parseDesignDoc(readFileSync(path.join(ws, p), "utf8"));
  expect(res.fatal).toBe(false);
  return res.doc;
}
const frames = (doc: DesignDoc): FrameNode[] => doc.pages[0]!.nodes.filter((n) => n.type === "frame") as FrameNode[];
const byName = (doc: DesignDoc, name: string) => frames(doc).find((f) => f.name === name)!;
const nodeIn = (f: FrameNode, id: string) => {
  for (const n of f.children) if (n.id === id) return n;
  return undefined;
};

beforeAll(() => {
  ws = mkdtempSync(path.join(tmpdir(), "ui-design-interactions-"));
  ctx = { workspace: ws };
  run("create_doc", {
    path: "proto.uidesign.json",
    name: "原型验收",
    frames: [{ name: "首页", w: 390, h: 844 }, { name: "详情", w: 390, h: 844 }, { name: "弹窗", w: 270, h: 160 }],
  });
});

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe("add_nodes / update_nodes 的 interactions 与 scroll", () => {
  test("建节点时带 interactions：整表写入，别名归一，旧式 onTap 被清掉", () => {
    const doc0 = load();
    const home = byName(doc0, "首页");
    const detail = byName(doc0, "详情");
    run("add_nodes", {
      path: "proto.uidesign.json",
      parent: home.id,
      nodes: [
        { id: "btn-cta", type: "rect", name: "主按钮", x: 24, y: 740, w: 342, h: 48, onTap: { to: detail.id } },
      ],
    });
    run("update_nodes", {
      path: "proto.uidesign.json",
      updates: [
        {
          id: "btn-cta",
          interactions: [
            { trigger: "click", action: "jump", to: detail.id },
            { trigger: "swipeRight", action: "back" },
          ],
        },
      ],
    });
    const doc = load();
    const n = nodeIn(byName(doc, "首页"), "btn-cta")!;
    expect(n.onTap).toBeUndefined();
    // 落盘只存作者写的：缺省转场是渲染期策略（prototype.ts），不写进文档
    expect(n.interactions).toEqual([
      { trigger: "tap", action: "navigate", to: detail.id },
      { trigger: "swipeRight", action: "back" },
    ]);
    // 而预览/导出取热点时，缺省转场已经填好
    const hotspots = collectHotspots(byName(doc, "首页"), doc).find((h) => h.nodeId === "btn-cta")!;
    expect(hotspots.actions.map((a) => [a.action, a.transition, a.duration])).toEqual([
      ["navigate", "pushLeft", 300],
      ["back", "pushRight", 300],
    ]);
  });

  test("interactions 写错当场报错，并列出可用取值", () => {
    const doc = load();
    const detailId = byName(doc, "详情").id;
    expect(() =>
      run("update_nodes", { path: "proto.uidesign.json", updates: [{ id: "btn-cta", interactions: [{ trigger: "waggle", action: "navigate", to: detailId }] }] }),
    ).toThrow(/trigger 无法识别.*tap/s);
    expect(() =>
      run("update_nodes", { path: "proto.uidesign.json", updates: [{ id: "btn-cta", interactions: [{ trigger: "tap", action: "vanish" }] }] }),
    ).toThrow(/action 无法识别.*navigate/s);
    expect(() =>
      run("update_nodes", { path: "proto.uidesign.json", updates: [{ id: "btn-cta", interactions: "tap" }] }),
    ).toThrow(/需为数组/);
    // 校验失败不落盘：先前写好的交互原样保留
    const n = nodeIn(byName(load(), "首页"), "btn-cta")!;
    expect(n.interactions).toHaveLength(2);
  });

  test("interactions: null / [] 清除（连旧式 onTap 一起清）", () => {
    const doc = load();
    const detailId = byName(doc, "详情").id;
    run("update_nodes", {
      path: "proto.uidesign.json",
      updates: [{ id: "btn-cta", onTap: { to: detailId } }],
    });
    run("update_nodes", { path: "proto.uidesign.json", updates: [{ id: "btn-cta", interactions: null }] });
    const n = nodeIn(byName(load(), "首页"), "btn-cta")!;
    expect(n.interactions).toBeUndefined();
    expect(n.onTap).toBeUndefined();
  });

  test("scroll 在画板上生效、可关闭、写错报错", () => {
    const doc = load();
    const homeId = byName(doc, "首页").id;
    run("update_nodes", { path: "proto.uidesign.json", updates: [{ id: homeId, scroll: "v" }] });
    expect(byName(load(), "首页").scroll).toBe("v");
    run("update_nodes", { path: "proto.uidesign.json", updates: [{ id: homeId, scroll: "vertical" }] });
    expect(byName(load(), "首页").scroll).toBe("v");
    expect(() => run("update_nodes", { path: "proto.uidesign.json", updates: [{ id: homeId, scroll: "diagonal" }] })).toThrow(/scroll 无法识别/);
    run("update_nodes", { path: "proto.uidesign.json", updates: [{ id: homeId, scroll: false }] });
    expect(byName(load(), "首页").scroll).toBeUndefined();
  });
});

describe("edit_interactions", () => {
  test("set 整表替换；缺省转场由渲染期按 动作+停靠位 补上", () => {
    const doc0 = load();
    const dialogId = byName(doc0, "弹窗").id;
    const res = run("edit_interactions", {
      path: "proto.uidesign.json",
      node: "btn-cta",
      op: "set",
      list: [{ trigger: "longPress", action: "overlay", to: dialogId, position: "bottom" }],
    });
    expect(res.interactions).toEqual([{ trigger: "longPress", action: "overlay", to: dialogId, position: "bottom" }]);
    expect(res.problems).toBeUndefined();
    const hs = collectHotspots(byName(load(), "首页"), load()).find((h) => h.nodeId === "btn-cta")!;
    expect(hs.actions[0]).toMatchObject({ action: "overlay", transition: "slideUp", duration: 260, position: "bottom" });
  });

  test("add 追加；remove 按 trigger 与 index 删除；clear 清空", () => {
    const doc0 = load();
    const detailId = byName(doc0, "详情").id;
    run("edit_interactions", { path: "proto.uidesign.json", node: "btn-cta", op: "add", list: [{ trigger: "doubleTap", action: "navigate", to: detailId }] });
    let res = run("edit_interactions", { path: "proto.uidesign.json", node: "btn-cta", op: "add", list: [{ trigger: "swipeLeft", action: "scrollTo", to: "btn-cta" }] });
    expect(res.interactions.map((i: { trigger: string }) => i.trigger)).toEqual(["longPress", "doubleTap", "swipeLeft"]);

    res = run("edit_interactions", { path: "proto.uidesign.json", node: "btn-cta", op: "remove", trigger: "doubleTap" });
    expect(res.interactions.map((i: { trigger: string }) => i.trigger)).toEqual(["longPress", "swipeLeft"]);

    res = run("edit_interactions", { path: "proto.uidesign.json", node: "btn-cta", op: "remove", index: 0 });
    expect(res.interactions.map((i: { trigger: string }) => i.trigger)).toEqual(["swipeLeft"]);

    res = run("edit_interactions", { path: "proto.uidesign.json", node: "btn-cta", op: "clear" });
    expect(res.interactions).toEqual([]);
    expect(nodeIn(byName(load(), "首页"), "btn-cta")!.interactions).toBeUndefined();
  });

  test("目标不可解析 → problems 里给 reason（不阻止写入，但立刻暴露）", () => {
    const res = run("edit_interactions", {
      path: "proto.uidesign.json",
      node: "btn-cta",
      op: "set",
      list: [
        { trigger: "tap", action: "navigate", to: "no-such-frame" },
        { trigger: "swipeLeft", action: "scrollTo", to: "no-such-node" },
        { trigger: "swipeRight", action: "back" },
      ],
    });
    expect(res.problems).toHaveLength(2);
    expect(res.problems[0].reason).toMatch(/不是顶层画板|已删除/);
    expect(res.problems[1].reason).toMatch(/不在当前画板内/);
    // back 无需目标，不算问题
    expect(res.interactions.map((i: { action: string }) => i.action)).toEqual(["navigate", "scrollTo", "back"]);
  });

  test("remove 的误用给出可读报错", () => {
    // 先清空，免得受上一条用例残留的 tap 影响
    run("edit_interactions", { path: "proto.uidesign.json", node: "btn-cta", op: "clear" });
    expect(() => run("edit_interactions", { path: "proto.uidesign.json", node: "btn-cta", op: "remove", trigger: "tap" })).toThrow(/没有 trigger/);
    expect(() => run("edit_interactions", { path: "proto.uidesign.json", node: "btn-cta", op: "remove", index: 99 })).toThrow(/越界/);
    expect(() => run("edit_interactions", { path: "proto.uidesign.json", node: "btn-cta", op: "explode" })).toThrow(/op 需为/);
    expect(() => run("edit_interactions", { path: "proto.uidesign.json", node: "ghost-node", op: "set", list: [] })).toThrow(/节点不存在/);
  });

  test("实例内部节点也能挂交互（写进 overrides）", () => {
    const doc0 = load();
    const detailId = byName(doc0, "详情").id;
    run("add_nodes", {
      path: "proto.uidesign.json",
      parent: byName(doc0, "详情").id,
      nodes: [{ id: "c-hero", type: "frame", name: "头图组", x: 0, y: 0, w: 200, h: 100 }],
    });
    // parent 是**工具参数**（不是节点字段）：第二层要另起一次调用
    run("add_nodes", {
      path: "proto.uidesign.json",
      parent: "c-hero",
      nodes: [{ id: "c-label", type: "text", name: "标签", x: 8, y: 8, w: 120, h: 20, text: "详情页" }],
    });
    const made = run("create_component", { path: "proto.uidesign.json", ids: ["c-hero"] });
    const instanceId = made.instanceId as string;
    const res = run("edit_interactions", {
      path: "proto.uidesign.json",
      node: `${instanceId}/c-label`,
      op: "set",
      list: [{ trigger: "tap", action: "navigate", to: detailId }],
    });
    expect(res.problems).toBeUndefined();
    expect(res.interactions).toHaveLength(1);
    // 存的是覆盖表（主档不带交互），实例渲染时才展开
    const doc = load();
    const inst = findNode(doc, instanceId)!.node as { overrides?: Record<string, Record<string, unknown>> };
    expect(inst.overrides!["c-label"]!.interactions).toHaveLength(1);
    const master = doc.components!.find((c) => c.id === made.componentId)!;
    expect(findNodeIn(master.nodes, "c-label")!.interactions).toBeUndefined();
    // 展开视图后热点能取到（组件内按钮的交互必须可点）
    const hs = collectHotspots(byName(doc, "详情"), doc);
    expect(hs.map((h) => h.nodeId)).toContain(`${instanceId}/c-label`);
  });
});

describe("read_doc 摘要带上交互、滚动与失效目标", () => {
  test("摘要里能直接看到 interactions / scroll / interactionProblems", () => {
    const doc = load();
    run("edit_interactions", {
      path: "proto.uidesign.json",
      node: byName(doc, "首页").id,
      op: "set",
      list: [],
    });
    const homeId = byName(doc, "首页").id;
    run("update_nodes", { path: "proto.uidesign.json", updates: [{ id: homeId, scroll: "v" }, { id: "btn-cta", interactions: [{ trigger: "tap", action: "back" }, { trigger: "doubleTap", action: "overlay", to: "gone" }] }] });
    const read = run("read_doc", { path: "proto.uidesign.json" });
    const home = read.nodes.find((n: { name: string }) => n.name === "首页");
    expect(home.scroll).toBe("v");
    // 摘要里子节点被折叠时，用 ids 精确读该节点
    const leaf = run("read_doc", { path: "proto.uidesign.json", ids: ["btn-cta"] });
    const summary = JSON.stringify(leaf);
    expect(summary).toContain("interactions");
    expect(summary).toContain("interactionProblems");
    expect(summary).toContain("navigate");
  });
});

/* ---------------- 素材库工具 ---------------- */

describe("list_stencils / insert_stencil", () => {
  test("list 给分类计数与条目；query 中英文检索", () => {
    const all = run("list_stencils", {});
    expect(all.total).toBeGreaterThanOrEqual(30);
    expect(all.categories.map((c: { name: string }) => c.name)).toEqual(["基础", "形状", "流程", "图表", "界面"]);
    const hit = run("list_stencils", { query: "饼图" });
    expect(hit.stencils[0].id).toBe("chart-pie");
    const byCat = run("list_stencils", { category: "流程" });
    expect(byCat.stencils.every((s: { category: string }) => s.category === "流程")).toBe(true);
  });

  test("写入画板：一次产出整棵子树（含嵌套 children），坐标是画板局部", () => {
    const doc0 = load();
    const homeId = byName(doc0, "首页").id;
    const res = run("insert_stencil", { path: "proto.uidesign.json", stencil: "scroll-panel", parent: homeId, x: 16, y: 300, w: 240, h: 200 });
    expect(res.count).toBe(1);
    const doc = load();
    const panel = nodeIn(byName(doc, "首页"), res.added[0])!;
    expect(panel).toBeDefined();
    expect(panel!.x).toBe(16);
    expect(panel!.y).toBe(300);
    expect((panel as { scroll?: string }).scroll).toBe("v");
    expect((panel as { children: unknown[] }).children.length).toBe(3);
  });

  test("素材 id 写错给出近似候选；未知父容器报错", () => {
    const doc0 = load();
    const homeId = byName(doc0, "首页").id;
    expect(() => run("insert_stencil", { path: "proto.uidesign.json", stencil: "饼型图", parent: homeId })).toThrow(/没有这个素材/);
    expect(() => run("insert_stencil", { path: "proto.uidesign.json", stencil: "chart-pie", parent: "ghost" })).toThrow(/父容器不存在/);
    // 形状节点不能当父容器
    expect(() => run("insert_stencil", { path: "proto.uidesign.json", stencil: "button", parent: "btn-cta" })).toThrow(/不能容纳子节点/);
  });

  test("等比缩放：给的目标框比标称小，产物按比例缩（不拉伸）", () => {
    const doc0 = load();
    const homeId = byName(doc0, "首页").id;
    const res = run("insert_stencil", { path: "proto.uidesign.json", stencil: "status-bar", parent: homeId, x: 0, y: 0, w: 195, h: 200 });
    const doc = load();
    const bar = nodeIn(byName(doc, "首页"), res.added[0])!;
    expect(bar.w).toBeCloseTo(195, 0);
    expect(bar.h).toBeCloseTo(22, 0);
  });
});
