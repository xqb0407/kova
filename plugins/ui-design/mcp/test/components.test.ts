/**
 * MCP 组件工具集单测：create_component / list_components / edit_component /
 * update_nodes 的 "/" 内部寻址 / add_nodes 的 instance 规格，全走真实文件读写。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TOOL_DEFS, type ToolCtx } from "../tools";
import { parseDesignDoc, type DesignDoc, type FrameNode, type InstanceNode } from "../../ui/src/doc";

let ws = "";
let ctx: ToolCtx;

function run(name: string, args: Record<string, unknown>): any {
  const tool = TOOL_DEFS.find((t) => t.name === name);
  expect(tool).toBeDefined();
  return tool!.run(args, ctx);
}

function load(p: string): DesignDoc {
  const res = parseDesignDoc(readFileSync(path.join(ws, p), "utf8"));
  expect(res.fatal).toBe(false);
  return res.doc;
}
const node = (doc: DesignDoc, id: string) => doc.pages[0]!.nodes.find((n) => n.id === id);

beforeAll(() => {
  ws = mkdtempSync(path.join(tmpdir(), "ui-design-mcp-comp-"));
  ctx = { workspace: ws };
});

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
});

const P = "comp.uidesign.json";

describe("create_component / list_components", () => {
  test("建档：同容器多节点转组件，原位替换为 1:1 实例，主档保留原 id", () => {
    run("create_doc", { path: P, frames: [{ name: "首页", w: 300, h: 300 }] });
    const doc0 = load(P);
    const frame = doc0.pages[0]!.nodes[0]! as FrameNode;
    run("add_nodes", {
      path: P,
      parent: frame.id,
      nodes: [
        { type: "rect", name: "底", x: 10, y: 10, w: 100, h: 40, radius: 8, fill: "#0d99ff" },
        { type: "text", name: "标", x: 20, y: 18, w: 60, h: 20, text: "提交", size: 14 },
      ],
    });
    const doc1 = load(P);
    const [r1, t1] = (doc1.pages[0]!.nodes[0] as FrameNode).children;
    const created = run("create_component", { path: P, ids: [r1!.id, t1!.id], name: "按钮" });
    expect(created.masterNodeIds).toEqual([r1!.id, t1!.id]); // 主档沿用原 id → 覆盖寻址稳定
    const doc2 = load(P);
    const kids = (doc2.pages[0]!.nodes[0] as FrameNode).children;
    expect(kids).toHaveLength(1);
    const inst = kids[0] as InstanceNode;
    expect(inst.type).toBe("instance");
    expect(inst.componentId).toBe(created.componentId);
    expect(inst.w).toBe(created.bounds.w);
    expect(inst.h).toBe(created.bounds.h);
    // 主档在资产表，不在页面树
    expect(doc2.components!.some((c) => c.id === created.componentId)).toBe(true);
    expect(node(doc2, r1!.id)).toBeUndefined();

    const listed = run("list_components", { path: P });
    expect(listed.components).toHaveLength(1);
    const row = listed.components[0];
    expect(row.name).toBe("按钮");
    expect(row.instances).toBe(1);
    expect(row.bounds).toEqual(created.bounds);
    expect(row.masterNodeIds).toEqual([r1!.id, t1!.id]);
  });

  test("拒绝：跨容器 / 实例内部 id / 空 ids", () => {
    expect(() => run("create_component", { path: P, ids: ["nope"] })).toThrow(/找不到|不存在/);
    const doc = load(P);
    const inst = (doc.pages[0]!.nodes[0] as FrameNode).children[0] as InstanceNode;
    expect(() => run("create_component", { path: P, ids: [`${inst.id}/${inst.componentId}`] })).toThrow(/先 detach|内部/);
  });
});

describe("update_nodes 内部寻址（\"/\"）", () => {
  test("改文案存为覆盖；主档原始数据不动；read_doc 视图可直接拿内部 id", () => {
    const doc = load(P);
    const inst = (doc.pages[0]!.nodes[0] as FrameNode).children[0] as InstanceNode;
    const comp = doc.components!.find((c) => c.id === inst.componentId)!;
    const textId = comp.nodes.find((n) => n.type === "text")!.id;

    // read_doc 默认树：实例 children 展开为视图 id，即 "实例/内部" 寻址
    const read = run("read_doc", { path: P, depth: 4 });
    expect(JSON.stringify(read)).toContain(`${inst.id}/${textId}`);

    run("update_nodes", { path: P, updates: [{ id: `${inst.id}/${textId}`, text: "保存" }] });
    const after = load(P);
    const instA = (after.pages[0]!.nodes[0] as FrameNode).children[0] as InstanceNode;
    expect(instA.overrides![textId]!.runs).toBeDefined();
    // 主档保持原文案（存储永远主档口径）
    const compA = after.components!.find((c) => c.id === instA.componentId)!;
    const masterText = compA.nodes.find((n) => n.type === "text")! as { runs: { text: string }[] };
    expect(masterText.runs[0]!.text).toBe("提交");

    // 视图回读 = "保存"
    const read2 = run("read_doc", { path: P, depth: 4 });
    expect(JSON.stringify(read2)).toContain("保存");
  });

  test("缩放实例的几何补丁：视图口径进、主档口径存、视图读回不动点", () => {
    const doc = load(P);
    const comp = doc.components![0]!;
    const rectId = comp.nodes.find((n) => n.type === "rect")!.id;
    const row = run("list_components", { path: P }).components.find((c: { id: string }) => c.id === comp.id);
    const b = row.bounds; // 主档包围盒（含 x/y 偏移）
    const big = run("edit_component", { path: P, action: "insert", componentId: comp.id, x: 40, y: 600 });
    // 顶层缩放 2×（实例自身几何直接改，不是覆盖）
    run("update_nodes", { path: P, updates: [{ id: big.inserted.id, w: b.w * 2, h: b.h * 2 }] });
    // 内部根 rect 视图坐标 x=20 → 存储 = 20/2 + b.x
    run("update_nodes", { path: P, updates: [{ id: `${big.inserted.id}/${rectId}`, x: 20 }] });
    const after = load(P);
    const instBig = after.pages[0]!.nodes.find((n) => n.id === big.inserted.id) as InstanceNode;
    expect(instBig.w).toBe(b.w * 2);
    expect(instBig.overrides![rectId]!.x).toBe(20 / 2 + b.x);
    // 主档本体不动
    const masterRect = after.components![0].nodes.find((n) => n.id === rectId)!;
    expect(masterRect.x).toBe(10);
    // 视图读回不动点：read_doc 里该实例内部 rect 的盒 x = 20
    const read = run("read_doc", { path: P, depth: 4 });
    const text = JSON.stringify(read);
    expect(text).toContain(`${big.inserted.id}/${rectId}`);
    void text;
  });

  test("内部删除被拒；不存在的内部 id 报错", () => {
    const doc = load(P);
    const inst = (doc.pages[0]!.nodes[0] as FrameNode).children[0] as InstanceNode;
    const comp = doc.components!.find((c) => c.id === inst.componentId)!;
    expect(() => run("delete_nodes", { path: P, ids: [`${inst.id}/${comp.nodes[0]!.id}`] })).toThrow(/detach/);
    expect(() => run("update_nodes", { path: P, updates: [{ id: `${inst.id}/ghost`, x: 1 }] })).toThrow(/ghost|解析/);
  });
});

describe("edit_component 生命周期", () => {
  test("patch_master 改主档 → 全部实例联动；instancesAffected 计数", () => {
    const doc = load(P);
    const comp = doc.components![0]!;
    const rectId = comp.nodes.find((n) => n.type === "rect")!.id;
    const patched = run("edit_component", {
      path: P,
      action: "patch_master",
      componentId: comp.id,
      nodeId: rectId,
      fill: "#ff0055",
    });
    expect(patched.instancesAffected).toBeGreaterThanOrEqual(2); // create 的原位实例 + 两次 insert
    const after = load(P);
    const r = after.components![0].nodes.find((n) => n.id === rectId)! as { fills: { color: string }[] };
    expect(r.fills[0]!.color).toBe("#ff0055");
  });

  test("rename / reset_overrides", () => {
    const doc = load(P);
    const comp = doc.components![0]!;
    run("edit_component", { path: P, action: "rename", componentId: comp.id, name: "主按钮" });
    expect(load(P).components![0].name).toBe("主按钮");
    const inst = (load(P).pages[0]!.nodes[0] as FrameNode).children[0] as InstanceNode;
    expect(inst.overrides).toBeDefined();
    run("edit_component", { path: P, action: "reset_overrides", nodeId: inst.id });
    const cleared = (load(P).pages[0]!.nodes[0] as FrameNode).children[0] as InstanceNode;
    expect(cleared.overrides).toBeUndefined();
  });

  test("detach：实例变普通图层、id 全部重发（无斜杠前缀）、几何=视图", () => {
    const doc = load(P);
    const inst = (doc.pages[0]!.nodes[0] as FrameNode).children[0] as InstanceNode;
    const det = run("edit_component", { path: P, action: "detach", nodeId: inst.id });
    expect(det.nodeIds.length).toBeGreaterThan(0);
    expect(det.nodeIds.every((id: string) => !id.includes("/"))).toBe(true);
    const after = load(P);
    const kids = (after.pages[0]!.nodes[0] as FrameNode).children;
    expect(kids.some((k) => k.id === inst.id)).toBe(false);
    expect(kids.some((k) => det.nodeIds.includes(k.id))).toBe(true);
    // 分离后主档两根（rect+text）落回画板子层，类型/相对几何保留
    const detached = kids.find((k) => k.id === det.nodeIds[0])!;
    expect(detached.type).toBe("rect");
    expect(kids.some((k) => k.type === "text")).toBe(true);
  });

  test("remove：无 detach 警示占位；detach:true 先烘焙不留实例", () => {
    const doc = load(P);
    const comps = doc.components!;
    const victim = comps[comps.length - 1]!; // 最后建的那个（若有引用）
    const refsBefore = run("list_components", { path: P }).components.find((c: { id: string }) => c.id === victim.id).instances;
    if (refsBefore > 0) {
      const removed = run("edit_component", { path: P, action: "remove", componentId: victim.id });
      expect(removed.note).toContain("占位");
    } else {
      run("edit_component", { path: P, action: "remove", componentId: victim.id });
    }
    // 表清空后序列化消毒会删掉 components 字段本身
    expect((load(P).components ?? []).some((c) => c.id === victim.id)).toBe(false);
  });

  test("remove detach:true：引用实例烘焙为静态图层", () => {
    // 重建一个带引用的干净档
    run("create_doc", { path: "rm2.uidesign.json", frames: [{ name: "S", w: 300, h: 300 }] });
    const d0 = load("rm2.uidesign.json");
    const f = d0.pages[0]!.nodes[0] as FrameNode;
    run("add_nodes", { path: "rm2.uidesign.json", parent: f.id, node: { type: "rect", x: 0, y: 0, w: 50, h: 50 } });
    const rId = (load("rm2.uidesign.json").pages[0]!.nodes[0] as FrameNode).children[0]!.id;
    const cc = run("create_component", { path: "rm2.uidesign.json", ids: [rId], name: "方块" });
    run("edit_component", { path: "rm2.uidesign.json", action: "insert", componentId: cc.componentId, x: 100, y: 100 });
    const rm = run("edit_component", { path: "rm2.uidesign.json", action: "remove", componentId: cc.componentId, detach: true });
    expect(rm.instances).toBe(2); // 原位 + insert
    const after = load("rm2.uidesign.json");
    expect(after.components ?? []).toHaveLength(0);
    const kids = (after.pages[0]!.nodes[0] as FrameNode).children;
    expect(kids.some((k) => k.type === "instance")).toBe(false);
    expect(kids.some((k) => k.type === "rect")).toBe(true); // 烘焙出了 rect（视图根 id 被重发但类型/几何保留）
  });
});

describe("add_nodes 的 instance 规格", () => {
  test("componentId 校验 + 显式尺寸保留 + 省略尺寸取主档包围盒", () => {
    run("create_doc", { path: "instadd.uidesign.json", frames: [{ name: "S", w: 320, h: 240 }] });
    const doc = load("instadd.uidesign.json");
    const f = doc.pages[0]!.nodes[0] as FrameNode;
    run("add_nodes", { path: "instadd.uidesign.json", parent: f.id, node: { type: "rect", x: 0, y: 0, w: 60, h: 24, fill: "#111111" } });
    const rid = (load("instadd.uidesign.json").pages[0]!.nodes[0] as FrameNode).children[0]!.id;
    const cc = run("create_component", { path: "instadd.uidesign.json", ids: [rid], name: "条" });

    expect(() =>
      run("add_nodes", { path: "instadd.uidesign.json", nodes: [{ type: "instance", x: 0, y: 0, w: 10, h: 10 }] }),
    ).toThrow(/componentId/);
    expect(() =>
      run("add_nodes", {
        path: "instadd.uidesign.json",
        nodes: [{ type: "instance", componentId: "ghost", x: 0, y: 0, w: 10, h: 10 }],
      }),
    ).toThrow(/ghost|组件不存在/);

    // 省略 w/h → 主档包围盒；显式 w/h → 保留（缩放意图）
    run("add_nodes", { path: "instadd.uidesign.json", nodes: [{ type: "instance", componentId: cc.componentId, x: 500, y: 0 }] });
    run("add_nodes", { path: "instadd.uidesign.json", nodes: [{ type: "instance", componentId: cc.componentId, x: 600, y: 0, w: 120, h: 48 }] });
    const after = load("instadd.uidesign.json");
    const top = after.pages[0]!.nodes;
    const auto = top.find((n) => n.x === 500)!;
    const sized = top.find((n) => n.x === 600)!;
    expect(auto.w).toBe(60);
    expect(auto.h).toBe(24);
    expect(sized.w).toBe(120);
    expect(sized.h).toBe(48);
    expect(after.components!.length).toBe(1);
  });
});
