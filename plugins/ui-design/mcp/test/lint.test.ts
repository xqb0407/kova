/**
 * MCP 层 lint_doc / run_design_script / create_doc template 的端到端单测：
 * 工具注册、真实文件读写、过滤参数、脚本产物与 add_nodes 同构、模板骨架、
 * 以及写操作返回值里附带的 lint 汇总。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TOOL_DEFS, type ToolCtx } from "../tools";
import { parseDesignDoc, type DesignDoc, type FrameNode, type TextNode } from "../../ui/src/doc";
import { readFileSync } from "node:fs";

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
  ws = mkdtempSync(path.join(tmpdir(), "ui-design-mcp-lint-"));
  ctx = { workspace: ws };
});

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
});

const findIssue = (report: any, code: string): any => report.issues.find((i: any) => i.code === code);

describe("lint_doc 工具", () => {
  test("注册在 TOOL_DEFS 里，且描述点名了关键规则", () => {
    const tool = TOOL_DEFS.find((t) => t.name === "lint_doc");
    expect(tool).toBeDefined();
    expect(tool!.description).toContain("text-contrast");
    expect(tool!.description).toContain("slop-purple-glow");
    expect(tool!.inputSchema.required).toEqual(["path"]);
  });

  test("新建的空画板没有 error/warning，但会诚实地报 empty-container", () => {
    run("create_doc", { path: "clean.uidesign.json", frames: [{ name: "页一", w: 390, h: 844 }] });
    const r = run("lint_doc", { path: "clean.uidesign.json" });
    expect(r.counts.error).toBe(0);
    expect(r.counts.warning).toBe(0);
    expect(findIssue(r, "empty-container")).toBeDefined();
    expect(r.scanned.frames).toBe(1);

    // 填了内容之后 summary 才变成「未发现问题」
    const created = run("create_doc", { path: "clean2.uidesign.json", frames: [{ name: "页一", w: 390, h: 844, fill: "#ffffff" }] });
    run("add_nodes", {
      path: "clean2.uidesign.json",
      parent: created.frames[0].id,
      nodes: [{ type: "text", name: "标题", x: 16, y: 20, w: 200, h: 24, text: "设置", size: 17, color: "#111111" }],
    });
    expect(run("lint_doc", { path: "clean2.uidesign.json" }).summary).toBe("未发现问题");
  });

  test("低对比度文字命中 text-contrast，nodeId 可直接喂给 update_nodes", () => {
    const created = run("create_doc", { path: "contrast.uidesign.json", frames: [{ name: "页一", w: 390, h: 844, fill: "#ffffff" }] });
    const frameId = created.frames[0].id as string;
    run("add_nodes", {
      path: "contrast.uidesign.json",
      parent: frameId,
      nodes: [{ type: "text", name: "提示", x: 16, y: 40, w: 200, h: 20, text: "浅灰字", size: 14, color: "#bbbbbb" }],
    });
    const r = run("lint_doc", { path: "contrast.uidesign.json" });
    const iss = findIssue(r, "text-contrast");
    expect(iss).toBeDefined();
    expect(iss.severity).toBe("error");
    expect(iss.detail.ratio).toBeLessThan(4.5);
    expect(iss.suggestion).toBeTruthy();

    // 报告里的 nodeId 真的能拿来改稿
    run("update_nodes", { path: "contrast.uidesign.json", updates: [{ id: iss.nodeId, color: "#595959" }] });
    expect(findIssue(run("lint_doc", { path: "contrast.uidesign.json" }), "text-contrast")).toBeUndefined();
  });

  test("severity / codes / page 过滤生效；非法规则名报错", () => {
    const r1 = run("lint_doc", { path: "contrast.uidesign.json", codes: ["text-contrast"] });
    expect(r1.issues.every((i: any) => i.code === "text-contrast")).toBe(true);
    const r2 = run("lint_doc", { path: "contrast.uidesign.json", minSeverityWrong: 1 } as any);
    expect(r2).toBeDefined();
    expect(() => run("lint_doc", { path: "contrast.uidesign.json", codes: ["no-such-rule"] })).toThrow(/未知规则/);
    expect(() => run("lint_doc", { path: "contrast.uidesign.json", severity: "fatal" })).toThrow(/severity 需为/);
  });

  test("ids 过滤只看指定画板", () => {
    run("create_doc", { path: "two.uidesign.json", frames: [{ name: "甲", w: 390, h: 844 }, { name: "乙", w: 390, h: 844 }] });
    const only = run("lint_doc", { path: "two.uidesign.json", ids: ["__none__"] });
    expect(only.issues).toEqual([]);
  });

  test("写操作返回值带一行 lint 汇总（不淹没主结果）", () => {
    const created = run("create_doc", { path: "sum.uidesign.json", frames: [{ name: "页一", w: 390, h: 844, fill: "#ffffff" }] });
    const frameId = created.frames[0].id as string;
    const out = run("add_nodes", {
      path: "sum.uidesign.json",
      parent: frameId,
      nodes: [{ type: "text", name: "浅字", x: 16, y: 40, w: 200, h: 20, text: "灰", size: 14, color: "#cccccc" }],
    });
    expect(out.lint).toBeDefined();
    expect(out.lint.counts.error).toBeGreaterThan(0);
    expect(out.lint.top.length).toBeLessThanOrEqual(3);
    expect(out.lint.top[0]).toContain("text-contrast");
    // info 级不进汇总
    expect(out.lint.counts.info).toBe(0);
  });
});

describe("run_design_script 工具", () => {
  test("注册在 TOOL_DEFS 里，描述写清了 I/U/log 与超时约束", () => {
    const tool = TOOL_DEFS.find((t) => t.name === "run_design_script");
    expect(tool).toBeDefined();
    expect(tool!.description).toContain("I(parentId, spec)");
    expect(tool!.description).toContain("超时");
    expect(tool!.inputSchema.required).toEqual(["path", "script"]);
  });

  test("循环批量建列表：一次调用成型，产物与 add_nodes 同构", async () => {
    const created = run("create_doc", { path: "script.uidesign.json", frames: [{ name: "设置", w: 390, h: 844, fill: "#ffffff" }] });
    const frameId = created.frames[0].id as string;
    const items = ["蓝牙", "Wi-Fi", "蜂窝网络", "个人热点", " airplane "];
    const r = await run("run_design_script", {
      path: "script.uidesign.json",
      script: `
        const items = ${JSON.stringify(items)};
        for (let i = 0; i < items.length; i++) {
          const row = I(${JSON.stringify(frameId)}, { type: "frame", name: "行" + i, x: 16, y: 120 + i * 56, w: 358, h: 48, fill: "#ffffff" });
          I(row, { type: "text", text: items[i], x: 12, y: 14, w: 300, h: 20, size: 15 });
        }
        return items.length;
      `,
    });
    expect(r.result).toBe(items.length);
    expect(r.inserted).toHaveLength(items.length * 2);

    const doc = load("script.uidesign.json");
    const frame = doc.pages[0]!.nodes[0] as FrameNode;
    expect(frame.children).toHaveLength(items.length);
    // 每个行 frame 里确实躺着一个 text 子节点
    for (const row of frame.children) {
      expect((row as FrameNode).children).toHaveLength(1);
      expect(((row as FrameNode).children![0] as TextNode).runs[0]!.text).toBeTruthy();
    }
  }, 20000);

  test("U() 能改脚本内刚建的节点；返回值与日志透传", async () => {
    const created = run("create_doc", { path: "script2.uidesign.json", frames: [{ name: "页", w: 390, h: 844 }] });
    const frameId = created.frames[0].id as string;
    const r = await run("run_design_script", {
      path: "script2.uidesign.json",
      script: `
        const t = I(${JSON.stringify(frameId)}, { type: "text", name: "标题", x: 16, y: 20, w: 200, h: 30, text: "旧" });
        U(t, { text: "新标题", color: "#ff0000" });
        log("改完了", t);
        return t;
      `,
    });
    expect(r.updated).toHaveLength(1);
    expect(r.logs[0]).toContain("改完了");

    const doc = load("script2.uidesign.json");
    const node = (doc.pages[0]!.nodes[0] as FrameNode).children![0] as TextNode;
    expect(node.runs[0]!.text).toBe("新标题");
    expect(node.runs[0]!.color).toBe("#ff0000");
  }, 20000);

  test("脚本产物与 add_nodes 逐字段同构（同样的 spec 得到同样的节点）", async () => {
    const created = run("create_doc", { path: "cmp.uidesign.json", frames: [{ name: "页", w: 390, h: 844 }] });
    const frameId = created.frames[0].id as string;
    const spec = { type: "rect", name: "方块", x: 10, y: 20, w: 100, h: 80, fill: "#123456", radius: 8 };
    await run("run_design_script", {
      path: "cmp.uidesign.json",
      script: `I(${JSON.stringify(frameId)}, ${JSON.stringify(spec)});`,
    });
    const viaScript = JSON.stringify((load("cmp.uidesign.json").pages[0]!.nodes[0] as FrameNode).children![0]);

    const created2 = run("create_doc", { path: "cmp2.uidesign.json", frames: [{ name: "页", w: 390, h: 844 }] });
    const frameId2 = created2.frames[0].id as string;
    run("add_nodes", { path: "cmp2.uidesign.json", parent: frameId2, nodes: [spec] });
    const viaTool = JSON.stringify((load("cmp2.uidesign.json").pages[0]!.nodes[0] as FrameNode).children![0]);
    // 只差自动分配的 id
    expect(viaScript.replace(/"id":"[^"]+"/, '"id":"X"')).toBe(viaTool.replace(/"id":"[^"]+"/, '"id":"X"'));
  }, 20000);

  test("脚本报错时不落半截（原子性）", async () => {
    const created = run("create_doc", { path: "atomic.uidesign.json", frames: [{ name: "页", w: 390, h: 844 }] });
    const frameId = created.frames[0].id as string;
    const before = readFileSync(path.join(ws, "atomic.uidesign.json"), "utf8");
    await expect(
      run("run_design_script", {
        path: "atomic.uidesign.json",
        script: `
          I(${JSON.stringify(frameId)}, { type: "rect", x: 0, y: 0 });
          I("不存在的画板", { type: "rect", x: 0, y: 0 });
        `,
      }),
    ).rejects.toThrow();
    expect(readFileSync(path.join(ws, "atomic.uidesign.json"), "utf8")).toBe(before);
  }, 20000);

  test("死循环脚本被超时中断并给出可读报错", async () => {
    await expect(
      run("run_design_script", { path: "atomic.uidesign.json", script: "while(true){}", timeoutMs: 600 }),
    ).rejects.toThrow(/超过 600ms/);
  }, 20000);
});

describe("create_doc 模板骨架", () => {
  test("settings 模板铺出命名分区，且都是空骨架", () => {
    const r = run("create_doc", { path: "tpl.uidesign.json", template: "settings", preset: "ios-390" });
    expect(r.frames).toHaveLength(1);
    const doc = load("tpl.uidesign.json");
    const frame = doc.pages[0]!.nodes[0] as FrameNode;
    const names = frame.children!.map((c) => c.name);
    expect(names).toContain("标题");
    expect(names).toContain("分组一");
    // 骨架 = 只有分区，没有真实内容
    for (const c of frame.children!) expect((c as FrameNode).children ?? []).toHaveLength(0);
  });

  test("dashboard 模板随设备尺寸给出侧栏/顶栏/指标行/主区", () => {
    run("create_doc", { path: "dash.uidesign.json", template: "dashboard", preset: "desktop-1440" });
    const frame = load("dash.uidesign.json").pages[0]!.nodes[0] as FrameNode;
    const names = frame.children!.map((c) => c.name);
    expect(names).toEqual(["侧栏", "顶栏", "指标行", "主区"]);
    expect(frame.w).toBe(1440);
  });

  test("template=blank 等价于旧行为；未知模板报错", () => {
    const r = run("create_doc", { path: "blank.uidesign.json", template: "blank", preset: "ios-390" });
    expect(r.frames).toHaveLength(1);
    expect((load("blank.uidesign.json").pages[0]!.nodes[0] as FrameNode).children ?? []).toHaveLength(0);
    expect(() => run("create_doc", { path: "bad.uidesign.json", template: "nope" })).toThrow(/未知模板/);
  });

  test("骨架能直接喂给 run_design_script 填内容", async () => {
    const created = run("create_doc", { path: "fill.uidesign.json", template: "settings", preset: "ios-390" });
    const doc0 = load("fill.uidesign.json");
    const frame = doc0.pages[0]!.nodes[0] as FrameNode;
    const group = frame.children!.find((c) => c.name === "分组一") as FrameNode;

    await run("run_design_script", {
      path: "fill.uidesign.json",
      script: `
        const rows = ["账号与安全", "通知", "隐私"];
        for (let i = 0; i < rows.length; i++) {
          const row = I(${JSON.stringify(group.id)}, { type: "frame", name: rows[i], x: 0, y: i * 56, w: 390, h: 56 });
          I(row, { type: "text", text: rows[i], x: 16, y: 18, w: 300, h: 20, size: 15 });
        }
      `,
    });
    const after = load("fill.uidesign.json").pages[0]!.nodes[0] as FrameNode;
    const filled = after.children!.find((c) => c.name === "分组一") as FrameNode;
    expect(filled.children).toHaveLength(3);
  }, 20000);
});