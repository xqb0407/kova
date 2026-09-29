/**
 * MCP import_doc 单测：真实文件读写的合并导入端到端（页子集 / 实例覆盖重映射 / 坏输入）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TOOL_DEFS, type ToolCtx } from "../tools";
import { parseDesignDoc, serializeDoc, type DesignDoc, type FrameNode, type InstanceNode } from "../../ui/src/doc";

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

beforeAll(() => {
  ws = mkdtempSync(path.join(tmpdir(), "ui-design-mcp-import-"));
  ctx = { workspace: ws };
});

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
});

const TARGET = "target.uidesign.json";
const SOURCE = "source.uidesign.json";

describe("import_doc", () => {
  test("全量并入：新页/新组件落盘，实例引用与覆盖 key 重映射后仍解析（读回即证）", () => {
    run("create_doc", { path: TARGET, frames: [{ name: "甲页", w: 200, h: 200 }] });
    // 来源档：画板里放一个矩形 → create_component 转组件（原位留实例）→ 手写覆盖
    run("create_doc", { path: SOURCE, frames: [{ name: "乙页", w: 200, h: 200 }] });
    const src0 = load(SOURCE);
    const frame = src0.pages[0]!.nodes[0] as FrameNode;
    run("add_nodes", {
      path: SOURCE,
      parent: frame.id,
      nodes: [{ type: "rect", name: "底", x: 10, y: 10, w: 80, h: 30, fill: "#0d99ff" }],
    });
    const src1 = load(SOURCE);
    const rectNode = (src1.pages[0]!.nodes[0] as FrameNode).children[0]!;
    const compRes = run("create_component", { path: SOURCE, ids: [rectNode.id], name: "按钮" });
    const masterId = compRes.masterNodeIds[0] as string;
    const src2 = load(SOURCE);
    const inst = (src2.pages[0]!.nodes[0] as FrameNode).children[0] as InstanceNode;
    expect(inst.type).toBe("instance");
    inst.overrides = { [masterId]: { x: 42 } };
    writeFileSync(path.join(ws, SOURCE), serializeDoc(src2), "utf8");

    const out = run("import_doc", { path: TARGET, from: SOURCE });
    expect(out.importedPages).toHaveLength(1);
    expect(out.importedComponents).toBe(1);
    expect(out.importedNodes).toBeGreaterThanOrEqual(3); // 画板 + 主档矩形 + 页面实例

    const doc = load(TARGET);
    expect(doc.pages).toHaveLength(2);
    expect((doc.pages[1]!.nodes[0] as FrameNode).name).toBe("乙页"); // 页内画板原名带过来
    expect(doc.activePage).toBe(doc.pages[0]!.id); // 未切页
    expect(doc.components).toHaveLength(1);
    const comp = doc.components![0]!;
    expect(comp.name).toBe("按钮");
    const newMasterId = comp.nodes[0]!.id;
    expect(newMasterId).not.toBe(masterId); // id 全量重发
    const instFrame = (doc.pages[1]!.nodes[0] as FrameNode).children[0] as InstanceNode;
    expect(instFrame.type).toBe("instance");
    expect(instFrame.componentId).toBe(comp.id); // 引用指到重发后的组件
    expect(instFrame.overrides![newMasterId]).toEqual({ x: 42 }); // 覆盖 key 跟着重映射、值原样
    expect(instFrame.overrides![masterId]).toBeUndefined();
    // 新页里的实例与主档能被面板寻址体系解析（findNode 走 "/" 视图 id）
    const res = parseDesignDoc(serializeDoc(doc));
    expect(res.fatal).toBe(false);
  });

  test("pageNames 挑子集：只要第二页；其余页不入目标档", () => {
    writeFileSync(
      path.join(ws, "two.uidesign.json"),
      JSON.stringify({
        version: 1,
        meta: { name: "两页", kind: "uidesign" },
        activePage: "pa",
        pages: [
          { id: "pa", name: "A页", nodes: [{ id: "ra", type: "rect", name: "ra", x: 0, y: 0, w: 10, h: 10 }] },
          { id: "pb", name: "B页", nodes: [{ id: "rb", type: "rect", name: "rb", x: 0, y: 0, w: 10, h: 10 }] },
        ],
      }),
      "utf8",
    );
    const out = run("import_doc", { path: TARGET, from: "two.uidesign.json", pageNames: ["B页"] });
    expect(out.importedPages.map((p: { name: string }) => p.name)).toEqual(["B页"]);
    const doc = load(TARGET);
    expect(doc.pages).toHaveLength(3); // 甲 + 乙 + B
    expect(doc.pages.some((p) => p.name === "A页")).toBe(false);
  });

  test("pageNames 全没命中 → 报错且目标档不被改写", () => {
    const before = readFileSync(path.join(ws, TARGET), "utf8");
    expect(() => run("import_doc", { path: TARGET, from: "two.uidesign.json", pageNames: ["没这页"] })).toThrow(/没有可导入/);
    expect(readFileSync(path.join(ws, TARGET), "utf8")).toBe(before);
  });

  test("源/目标同档 → 拒绝；坏 JSON 来源 → 明确报错", () => {
    expect(() => run("import_doc", { path: TARGET, from: TARGET })).toThrow(/同一份/);
    writeFileSync(path.join(ws, "bad.uidesign.json"), "{ 这不是JSON", "utf8");
    expect(() => run("import_doc", { path: TARGET, from: "bad.uidesign.json" })).toThrow();
    const missing = (() => {
      try {
        run("import_doc", { path: TARGET, from: "nope.uidesign.json" });
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(missing).toContain("不存在");
  });
});
