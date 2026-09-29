/**
 * MCP edit_variables 单测：真实文件读写的 list/set/delete 端到端
 * （set 建表与更新 / update_nodes 写 var: 绑定读回 / delete 留坏引用 / detach 烘焙 / 坏输入）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TOOL_DEFS, type ToolCtx } from "../tools";
import { MISSING_VAR_COLOR, parseDesignDoc, resolveVarColor, type DesignDoc, type FrameNode } from "../../ui/src/doc";

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
  ws = mkdtempSync(path.join(tmpdir(), "ui-design-mcp-variables-"));
  ctx = { workspace: ws };
  run("create_doc", { path: "doc.uidesign.json", frames: [{ name: "页一", w: 200, h: 200 }] });
});

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
});

const DOC = "doc.uidesign.json";

describe("edit_variables", () => {
  test("set 新建 → list 显示 0 引用；update_nodes 写 var: 绑定后 list 计数", () => {
    const created = run("edit_variables", { path: DOC, action: "set", name: "主色", value: "#0d99ff" });
    const vid = created.variable.id as string;
    expect(created.variable.name).toBe("主色");

    const frame = (load(DOC).pages[0]!.nodes[0] as FrameNode);
    run("add_nodes", {
      path: DOC,
      parent: frame.id,
      nodes: [{ type: "rect", name: "卡", x: 10, y: 10, w: 80, h: 30, fill: "#dddddd", stroke: "#111111", strokeWidth: 1 }],
    });
    const rectId = ((load(DOC).pages[0]!.nodes[0] as FrameNode).children ?? [])[0]!.id;
    run("update_nodes", {
      path: DOC,
      updates: [
        { id: rectId, fill: `var:${vid}`, stroke: `var:${vid}` },
      ],
    });

    const list = run("edit_variables", { path: DOC, action: "list" });
    expect(list.variables[0]!.usage).toBe(2);
    // 绑定档再读回：解析后就是变量值（非警示粉）
    const d = load(DOC);
    const r = (d.pages[0]!.nodes[0] as FrameNode).children![0]! as unknown as { fills: { color: string }[]; strokes: { color: string }[] };
    expect(r.fills[0]!.color).toBe(`var:${vid}`);
    expect(resolveVarColor(d, r.strokes[0]!.color)).toBe("#0d99ff");

    // set 更新值 → 全稿联动（读回解析验证）
    run("edit_variables", { path: DOC, action: "set", id: vid, value: "#ff0055" });
    const d2 = load(DOC);
    expect(resolveVarColor(d2, `var:${vid}`)).toBe("#ff0055");
  });

  test("set 校验：重名报错、缺 name 报错；value 可为链式 var:", () => {
    expect(() => run("edit_variables", { path: DOC, action: "set", name: "主色", value: "#000000" })).toThrow(/已存在/);
    expect(() => run("edit_variables", { path: DOC, action: "set", value: "#000000" })).toThrow(/name/);
    const c = run("edit_variables", { path: DOC, action: "set", name: "强调", value: "var:" + (run("edit_variables", { path: DOC, action: "list" }).variables[0]!.id as string) });
    const d = load(DOC);
    expect(resolveVarColor(d, `var:${c.variable.id}`)).toBe("#ff0055");
  });

  test("delete 默认留坏引用（解析给缺失警告、渲染警示粉）；detach 烘焙色值", () => {
    const list = run("edit_variables", { path: DOC, action: "list" });
    const vid = list.variables.find((v: { name: string }) => v.name === "强调")!.id as string;
    // 先把「强调」绑到矩形描边，才有引用可数
    const d0 = load(DOC);
    const rectId0 = (d0.pages[0]!.nodes[0] as FrameNode).children![0]!.id;
    run("update_nodes", { path: DOC, updates: [{ id: rectId0, strokeWidth: 1 }] }); // 确保描边存在
    run("update_nodes", { path: DOC, updates: [{ id: rectId0, stroke: `var:${vid}` }] });
    const del = run("edit_variables", { path: DOC, action: "delete", id: vid });
    expect(del.usage).toBe(1);
    const d1 = load(DOC);
    const res1 = parseDesignDoc(readFileSync(path.join(ws, DOC), "utf8"));
    expect(res1.warnings.some((w) => w.includes("未定义的变量"))).toBe(true);
    expect(resolveVarColor(d1, `var:${vid}`)).toBe(MISSING_VAR_COLOR);

    // 重新建同名变量 → 新 id（旧引用仍是坏引用，警示粉不会因同名重建而复活）
    const again = run("edit_variables", { path: DOC, action: "set", name: "强调", value: "#ff0055" });
    const d2 = load(DOC);
    expect(resolveVarColor(d2, `var:${vid}`)).toBe(MISSING_VAR_COLOR);
    expect(resolveVarColor(d2, `var:${again.variable.id as string}`)).toBe("#ff0055");
    expect(again.variable.id).not.toBe(vid);

    // detach 删除：引用处烘焙成当前色值，档里不再有 var:
    const mainId = (run("edit_variables", { path: DOC, action: "list" }).variables as { id: string; name: string }[]).find((v) => v.name === "主色")!.id;
    run("edit_variables", { path: DOC, action: "delete", id: mainId, detach: true });
    const raw = readFileSync(path.join(ws, DOC), "utf8");
    expect(raw.includes(`var:${mainId}`)).toBe(false);
    const d3 = load(DOC);
    const r3 = (d3.pages[0]!.nodes[0] as FrameNode).children![0]! as unknown as { fills: { color: string }[] };
    expect(r3.fills[0]!.color).toBe("#ff0055");
  });

  test("list 报告 dangling 坏引用；delete 不存在的 id 报错", () => {
    const d = load(DOC);
    const frame = d.pages[0]!.nodes[0] as FrameNode;
    const rectId = frame.children![0]!.id;
    run("update_nodes", { path: DOC, updates: [{ id: rectId, stroke: "var:ghost-id" }] });
    const list = run("edit_variables", { path: DOC, action: "list" });
    expect(list.danglingRefs).toContain("var:ghost-id");
    expect(() => run("edit_variables", { path: DOC, action: "delete", id: "ghost-id" })).toThrow(/不存在/);
  });
});
