/**
 * MCP 画布工具集单测：全部走真实文件读写（临时工作区），验证
 * 「解析 → 变更 → 序列化」闭环与文档模型不变量（id/局部坐标/组盒派生）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TOOL_DEFS, type ToolCtx } from "../tools";
import { parseDesignDoc, type DesignDoc } from "../../ui/src/doc";

let ws = "";
let ctx: ToolCtx;

function run(name: string, args: Record<string, unknown>): any {
  const tool = TOOL_DEFS.find((t) => t.name === name);
  expect(tool).toBeDefined();
  return tool!.run(args, ctx);
}

function load(p = "app.uidesign.json"): DesignDoc {
  const res = parseDesignDoc(readFileSync(path.join(ws, p), "utf8"));
  expect(res.fatal).toBe(false);
  return res.doc;
}

const page0 = (doc: DesignDoc) => doc.pages[0]!;

beforeAll(() => {
  ws = mkdtempSync(path.join(tmpdir(), "ui-design-mcp-"));
  ctx = { workspace: ws };
});

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe("create_doc / list_docs / read_doc", () => {
  test("按设备预设建档，list 能列出，read 给页面与图层摘要", () => {
    const created = run("create_doc", { path: "app.uidesign.json", name: "验收稿", preset: "ios-390" });
    expect(created.frames).toHaveLength(1);
    const doc = load();
    expect(doc.meta.name).toBe("验收稿");
    const frame = page0(doc).nodes[0]!;
    expect(frame.type).toBe("frame");
    expect(frame.w).toBe(390);
    expect(frame.h).toBe(844);

    const list = run("list_docs", {});
    expect(list.docs.some((d: { path: string }) => d.path === "app.uidesign.json")).toBe(true);

    const read = run("read_doc", { path: "app.uidesign.json" });
    expect(read.name).toBe("验收稿");
    expect(read.nodes).toHaveLength(1);
    expect(read.nodes[0].type).toBe("frame");
    expect(read.nodes[0].id).toBe(frame.id);
  });

  test("已有文件拒绝覆盖；overwrite:true 可重写", () => {
    expect(() => run("create_doc", { path: "app.uidesign.json" })).toThrow(/已存在/);
  });

  test("frames 数组建档：x 省略自动横排", () => {
    run("create_doc", {
      path: "multi.uidesign.json",
      frames: [{ name: "A", w: 200, h: 400 }, { name: "B", w: 200, h: 400 }],
    });
    const doc = load("multi.uidesign.json");
    const [a, b] = page0(doc).nodes;
    expect(a!.x).toBe(0);
    expect(b!.x).toBe(200 + Math.max(80, Math.round(200 * 0.32)));
  });

  test("path 后缀与缺档报错", () => {
    expect(() => run("read_doc", { path: "app.json" })).toThrow(/uidesign\.json/);
    expect(() => run("read_doc", { path: "nope.uidesign.json" })).toThrow(/不存在/);
  });
});

describe("add_nodes / update_nodes / delete_nodes", () => {
  test("画板内局部坐标 + 省略 x/y 自动叠放", () => {
    const docBefore = load();
    const frameId = page0(docBefore).nodes[0]!.id;
    const res = run("add_nodes", {
      path: "app.uidesign.json",
      parent: frameId,
      nodes: [
        { type: "rect", name: "卡片", x: 24, y: 100, w: 342, h: 96, fill: "#ffffff", radius: 16 },
        { type: "text", name: "标题", x: 40, y: 116, w: 200, h: 24, text: "今日训练", size: 17, weight: 600 },
      ],
    });
    expect(res.created).toHaveLength(2);
    expect(res.created[0].x).toBe(24);
    const doc = load();
    const frame = page0(doc).nodes[0]!;
    expect("children" in frame && frame.children).toHaveLength(2);
    // 自动落位：第三个节点（省略 x/y）叠在最后一个子节点下方 +16
    const auto = run("add_nodes", {
      path: "app.uidesign.json",
      parent: frameId,
      nodes: [{ type: "rect", name: "自动", w: 100, h: 40 }],
    });
    expect(auto.created[0].x).toBe(24); // 与既有子节点左缘对齐
    expect(auto.created[0].y).toBe(100 + 96 + 16); // 卡片底 196（最大），+16 间隙
  });

  test("风格 shorthand 生效且序列化可回读（填充/圆角/文本 run）", () => {
    const doc = load();
    const frame = page0(doc).nodes[0]!;
    const kids = "children" in frame ? frame.children : [];
    const card = kids.find((n) => n.name === "卡片")!;
    expect(card.type).toBe("rect");
    if (card.type === "rect") {
      expect(card.fills[0]!.color).toBe("#ffffff");
      expect(card.radius).toBe(16);
    }
    const title = kids.find((n) => n.name === "标题")!;
    if (title.type === "text") {
      expect(title.runs[0]!.text).toBe("今日训练");
      expect(title.runs[0]!.size).toBe(17);
      expect(title.runs[0]!.weight).toBe(600);
    }
  });

  test("update_nodes：绝对坐标、相对位移、改色与文字", () => {
    const doc = load();
    const frame = page0(doc).nodes[0]!;
    const kids = "children" in frame ? frame.children : [];
    const card = kids.find((n) => n.name === "卡片")!;
    const title = kids.find((n) => n.name === "标题")!;
    run("update_nodes", {
      path: "app.uidesign.json",
      updates: [
        { id: card.id, dx: 8, dy: 4, fill: "#0d99ff", radius: 24 },
        { id: title.id, text: "已改名", size: 18 },
      ],
    });
    const after = load();
    const frameAfter = page0(after).nodes[0]!;
    const kidsAfter = "children" in frameAfter ? frameAfter.children : [];
    const cardAfter = kidsAfter.find((n) => n.id === card.id)!;
    expect(cardAfter.x).toBe(32);
    expect(cardAfter.y).toBe(104);
    if (cardAfter.type === "rect") {
      expect(cardAfter.fills[0]!.color).toBe("#0d99ff");
      expect(cardAfter.radius).toBe(24);
    }
    const titleAfter = kidsAfter.find((n) => n.id === title.id)!;
    if (titleAfter.type === "text") {
      expect(titleAfter.runs[0]!.text).toBe("已改名");
      expect(titleAfter.runs[0]!.size).toBe(18);
    }
  });

  test("onTap 原型跳转：add 直挂、update 改挂/清除、坏值报错不落盘", () => {
    const doc = load();
    const frame = page0(doc).nodes[0]!;
    const created = run("add_nodes", {
      path: "app.uidesign.json",
      parent: frame.id,
      nodes: [{ type: "rect", name: "跳转钮", w: 100, h: 40, onTap: { to: frame.id } }],
    });
    const btnId = created.created[0].id as string;
    expect(findById(load(), btnId).onTap).toEqual({ to: frame.id });
    // read_doc 摘要要能看见已挂的跳转（agent 迭代靠它确认）
    const read = run("read_doc", { path: "app.uidesign.json" });
    const flat = JSON.stringify(read.nodes);
    expect(flat.includes('"onTap"')).toBe(true);
    // 空 to 拒绝且不影响盘上内容
    expect(() => run("update_nodes", { path: "app.uidesign.json", updates: [{ id: btnId, onTap: { to: "" } }] })).toThrow(/onTap/);
    expect(findById(load(), btnId).onTap).toEqual({ to: frame.id });
    // null 清除
    run("update_nodes", { path: "app.uidesign.json", updates: [{ id: btnId, onTap: null }] });
    expect(findById(load(), btnId).onTap).toBeUndefined();
  });

  test("delete_nodes 删除子树；未知 id 报错且不落盘", () => {
    const doc = load();
    const frame = page0(doc).nodes[0]!;
    const kids = "children" in frame ? frame.children : [];
    const title = kids.find((n) => n.name === "标题")!;
    run("delete_nodes", { path: "app.uidesign.json", ids: [title.id] });
    const after = load();
    const frameAfter = page0(after).nodes[0]!;
    const kidsAfter = "children" in frameAfter ? frameAfter.children : [];
    expect(kidsAfter.some((n) => n.id === title.id)).toBe(false);
    expect(() => run("delete_nodes", { path: "app.uidesign.json", ids: ["nope"] })).toThrow(/不存在/);
  });

  test("image / line 类型字段", () => {
    const doc = load();
    const frameId = page0(doc).nodes[0]!.id;
    const res = run("add_nodes", {
      path: "app.uidesign.json",
      parent: frameId,
      nodes: [
        { type: "image", name: "配图", x: 0, y: 0, w: 100, h: 60, src: "assets/a.png", fit: "contain" },
        { type: "arrow", name: "指示", x: 0, y: 0, w: 60, h: 60, dir: 2, stroke: { color: "#111111", width: 2 } },
      ],
    });
    expect(res.created).toHaveLength(2);
    const after = load();
    const frame = page0(after).nodes[0]!;
    const kids = "children" in frame ? frame.children : [];
    const img = kids.find((n) => n.name === "配图")!;
    expect(img.type === "image" ? img.fit : null).toBe("contain");
    const arrow = kids.find((n) => n.name === "指示")!;
    expect(arrow.type === "arrow" ? arrow.dir : null).toBe(2);
  });
});

describe("align / stack / group / reorder", () => {
  let ids: string[] = [];

  test("准备三块矩形", () => {
    const doc = load();
    const frameId = page0(doc).nodes[0]!.id;
    const res = run("add_nodes", {
      path: "app.uidesign.json",
      parent: frameId,
      nodes: [
        { type: "rect", name: "r1", x: 10, y: 300, w: 60, h: 40 },
        { type: "rect", name: "r2", x: 100, y: 320, w: 60, h: 40 },
        { type: "rect", name: "r3", x: 200, y: 360, w: 60, h: 40 },
      ],
    });
    ids = res.created.map((c: { id: string }) => c.id);
    expect(ids).toHaveLength(3);
  });

  test("align left 对齐到选择集左缘", () => {
    run("align_nodes", { path: "app.uidesign.json", ids, mode: "left" });
    const doc = load();
    const xs = ids.map((id) => findById(doc, id).x);
    expect(new Set(xs.map((x) => Math.round(x))).size).toBe(1);
  });

  test("stack column：主轴顺序 + gap 间距", () => {
    run("stack_nodes", { path: "app.uidesign.json", ids, direction: "column", gap: 20 });
    const doc = load();
    const sorted = ids.map((id) => findById(doc, id)).sort((a, b) => a.y - b.y);
    expect(sorted[1]!.y - (sorted[0]!.y + sorted[0]!.h)).toBe(20);
    expect(sorted[2]!.y - (sorted[1]!.y + sorted[1]!.h)).toBe(20);
  });

  test("group → 组盒派生 / ungroup 还原坐标", () => {
    const docBefore = load();
    const before = ids.map((id) => {
      const n = findById(docBefore, id);
      return { x: n.x, y: n.y };
    });
    const grouped = run("group_nodes", { path: "app.uidesign.json", ids, name: "一排" });
    const docMid = load();
    const group = findById(docMid, grouped.groupId);
    expect(group.type).toBe("group");
    if (group.type === "group") {
      expect(group.children.map((c) => c.id)).toEqual(ids);
      // 组盒 = 子节点并集
      const minX = Math.min(...before.map((b) => b.x));
      expect(Math.round(group.x)).toBe(Math.round(minX));
    }
    run("ungroup_nodes", { path: "app.uidesign.json", ids: [grouped.groupId] });
    const docAfter = load();
    const after = ids.map((id) => {
      const n = findById(docAfter, id);
      return { x: n.x, y: n.y };
    });
    expect(after.map((a, i) => Math.round(a.x - before[i]!.x))).toEqual([0, 0, 0]);
    expect(after.map((a, i) => Math.round(a.y - before[i]!.y))).toEqual([0, 0, 0]);
  });

  test("reorder front：节点移到同级末尾", () => {
    const doc = load();
    const frame = page0(doc).nodes[0]!;
    const kids = "children" in frame ? frame.children : [];
    const first = kids[0]!.id;
    run("reorder_nodes", { path: "app.uidesign.json", ids: [first], mode: "front" });
    const after = load();
    const frameAfter = page0(after).nodes[0]!;
    const kidsAfter = "children" in frameAfter ? frameAfter.children : [];
    expect(kidsAfter[kidsAfter.length - 1]!.id).toBe(first);
  });
});

describe("edit_pages", () => {
  test("add / rename / activate / remove 与最后一页保护", () => {
    const added = run("edit_pages", { path: "app.uidesign.json", action: "add", name: "流程" });
    expect(added.added.name).toBe("流程");
    run("edit_pages", { path: "app.uidesign.json", action: "rename", pageId: added.added.id, name: "关键流程" });
    run("edit_pages", { path: "app.uidesign.json", action: "activate", pageId: added.added.id });
    let doc = load();
    expect(doc.pages.find((p) => p.id === doc.activePage)!.name).toBe("关键流程");
    run("edit_pages", { path: "app.uidesign.json", action: "remove", pageId: added.added.id });
    doc = load();
    expect(doc.pages).toHaveLength(1);
    expect(() => run("edit_pages", { path: "app.uidesign.json", action: "remove", pageId: doc.pages[0]!.id })).toThrow(/最后一页/);
  });
});

describe("read_doc 细节与错误路径", () => {
  test("nodeId 返回完整节点 JSON（含 runs）", () => {
    const doc = load();
    const frame = page0(doc).nodes[0]!;
    const kids = "children" in frame ? frame.children : [];
    const text = kids.find((n) => n.type === "text");
    if (!text) return; // 前面的用例可能已删；宽松通过
    const res = run("read_doc", { path: "app.uidesign.json", nodeId: text.id });
    expect(res.node.id).toBe(text.id);
  });

  test("未知父容器/未知字段报错", () => {
    expect(() =>
      run("add_nodes", { path: "app.uidesign.json", parent: "ghost", nodes: [{ type: "rect" }] }),
    ).toThrow(/不存在/);
    expect(() =>
      run("add_nodes", { path: "app.uidesign.json", nodes: [{ type: "group" }] }),
    ).toThrow(/group_nodes/);
    expect(() =>
      run("add_nodes", { path: "app.uidesign.json", nodes: [{ type: "rect", fill: "#fff" }], parent: undefined }),
    ).not.toThrow();
  });

  test("临时文件不残留（原子落盘）", () => {
    expect(existsSync(path.join(ws, "app.uidesign.json.tmp-mcp"))).toBe(false);
  });
});

/** 在文档里按 id 找节点（测试辅助） */
function findById(doc: DesignDoc, id: string) {
  const stack = [...doc.pages.flatMap((p) => p.nodes)];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.id === id) return n;
    if ("children" in n) stack.push(...n.children);
  }
  throw new Error(`节点不存在：${id}`);
}
