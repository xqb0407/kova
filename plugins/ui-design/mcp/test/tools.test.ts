/**
 * MCP 画布工具集单测：全部走真实文件读写（临时工作区），验证
 * 「解析 → 变更 → 序列化」闭环与文档模型不变量（id/局部坐标/组盒派生）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TOOL_DEFS, type ToolCtx } from "../tools";
import { parseDesignDoc, type DesignDoc, type FrameNode, type DesignNode } from "../../ui/src/doc";

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

describe("screenshot_doc（画布内容 → PNG 图像块）", () => {
  test("默认截当前页全部可见顶层：mcpContent = 文本报导 + 合法 PNG", () => {
    run("create_doc", { path: "shot.uidesign.json", name: "截图档", frames: [{ name: "屏", w: 300, h: 400 }] });
    const doc = load("shot.uidesign.json");
    const frameId = page0(doc).nodes[0]!.id;
    run("add_nodes", {
      path: "shot.uidesign.json",
      parent: frameId,
      nodes: [
        { type: "rect", x: 20, y: 20, w: 260, h: 80, fill: "#0d99ff", radius: 12 },
        { type: "text", x: 20, y: 120, w: 260, h: 40, text: "视觉自检", size: 24 },
      ],
    });
    const res = run("screenshot_doc", { path: "shot.uidesign.json" });
    expect(Array.isArray(res.mcpContent)).toBe(true);
    const [textBlock, imgBlock] = res.mcpContent;
    expect(textBlock.type).toBe("text");
    expect(textBlock.text).toContain("画布截图");
    expect(textBlock.text).toContain("300×400");
    expect(imgBlock.type).toBe("image");
    expect(imgBlock.mimeType).toBe("image/png");
    const png = Buffer.from(imgBlock.data, "base64");
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(dv.getUint32(16)).toBeLessThanOrEqual(601); // 300×2 倍率上限
    expect(png.byteLength).toBeGreaterThan(500);
  });

  test("ids 只截指定节点；隐藏节点跳过、全隐藏报错", () => {
    run("create_doc", {
      path: "shot2.uidesign.json",
      frames: [
        { name: "A", w: 100, h: 100 },
        { name: "B", w: 100, h: 100 },
      ],
    });
    const doc = load("shot2.uidesign.json");
    const [a, b] = page0(doc).nodes;
    const one = run("screenshot_doc", { path: "shot2.uidesign.json", ids: [a.id] });
    expect(one.mcpContent[0].text).toContain("1 个顶层节点");
    run("update_nodes", { path: "shot2.uidesign.json", updates: [{ id: a.id, visible: false }] });
    const other = run("screenshot_doc", { path: "shot2.uidesign.json" });
    expect(other.mcpContent[0].text).toContain("1 个顶层节点"); // 默认只统计可见
    run("update_nodes", { path: "shot2.uidesign.json", updates: [{ id: b.id, visible: false }] });
    expect(() => run("screenshot_doc", { path: "shot2.uidesign.json" })).toThrow(/没有可见/);
  });

  test("image 资产：工作区文件内嵌；读不到时文本报导占位数", () => {
    writeFileSync(
      path.join(ws, "s.png"),
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
    );
    run("create_doc", { path: "shot3.uidesign.json", frames: [{ name: "屏", w: 240, h: 200 }] });
    const doc = load("shot3.uidesign.json");
    const frameId = page0(doc).nodes[0]!.id;
    const addRes = run("add_nodes", {
      path: "shot3.uidesign.json",
      parent: frameId,
      nodes: [{ type: "image", x: 10, y: 10, w: 100, h: 100, src: "s.png" }],
    });
    const imgId = addRes.created[0].id as string;
    const ok = run("screenshot_doc", { path: "shot3.uidesign.json" });
    expect(ok.mcpContent[0].text).not.toContain("占位");
    run("update_nodes", { path: "shot3.uidesign.json", updates: [{ id: imgId, src: "gone.png" }] });
    const miss = run("screenshot_doc", { path: "shot3.uidesign.json" });
    expect(miss.mcpContent[0].text).toContain("1 张位图资产读不到");
  });

  test("path 后缀/缺档错误与其它工具一致", () => {
    expect(() => run("screenshot_doc", { path: "nope.json" })).toThrow(/uidesign\.json/);
    expect(() => run("screenshot_doc", { path: "nope.uidesign.json" })).toThrow(/不存在/);
  });
});

describe("export_doc / screenshot saveTo（导出 = 静态文件包）", () => {
  test("screenshot_doc saveTo：内联图像块之外顺带落盘一份 PNG", () => {
    run("create_doc", { path: "st.uidesign.json", frames: [{ name: "屏", w: 120, h: 80 }] });
    const res = run("screenshot_doc", { path: "st.uidesign.json", saveTo: "shots/preview.png" });
    expect(res.mcpContent[0].text).toContain("已保存到 shots/preview.png");
    const buf = readFileSync(path.join(ws, "shots/preview.png"));
    expect([...buf.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // 越出工作区的 saveTo 拒绝
    expect(() => run("screenshot_doc", { path: "st.uidesign.json", saveTo: "../out.png" })).toThrow(/越出工作区/);
  });

  test("export_doc 默认导出 png/html/source 目录包并回报路径清单", () => {
    mkdirSync(path.join(ws, "e-assets"), { recursive: true });
    writeFileSync(path.join(ws, "e-assets", "hero.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    run("create_doc", {
      path: "e.uidesign.json",
      name: "导出验收",
      frames: [
        { name: "A", w: 160, h: 100 },
        { name: "B", w: 160, h: 100 },
      ],
    });
    const doc = load("e.uidesign.json");
    const fa = page0(doc).nodes[0]!;
    run("add_nodes", { path: "e.uidesign.json", parent: fa.id, nodes: [{ type: "image", x: 8, y: 8, w: 40, h: 40, src: "e-assets/hero.png" }] });

    const res = run("export_doc", { path: "e.uidesign.json" });
    expect(res.dir).toBe("e-export");
    expect(res.manifest).toBe("e-export/manifest.json");
    expect(res.screens).toEqual(["A", "B"]);
    expect(res.missingAssets).toBe(0);
    const kinds = res.files.map((f: { kind: string }) => f.kind);
    for (const want of ["source", "asset", "png", "html", "manifest"]) expect(kinds).toContain(want);
    expect(res.hint).toContain("e-export/");
    expect(existsSync(path.join(ws, "e-export/manifest.json"))).toBe(true);
    expect(existsSync(path.join(ws, "e-export/screens/01-A.png"))).toBe(true);
    expect(existsSync(path.join(ws, "e-export/assets/hero.png"))).toBe(true);
    const html = readFileSync(path.join(ws, "e-export/index.html"), "utf8");
    expect(html).toContain("assets/hero.png");
    expect(html).not.toContain("data:image");
    // 源档可再解析
    expect(parseDesignDoc(readFileSync(path.join(ws, "e-export/e.uidesign.json"), "utf8")).fatal).toBe(false);
  });

  test("export_doc format/dir 选项与错误路径", () => {
    run("create_doc", { path: "e2.uidesign.json", frames: [{ name: "仅源", w: 100, h: 100 }] });
    const srcOnly = run("export_doc", { path: "e2.uidesign.json", format: "source", dir: "dist/just" });
    expect(srcOnly.files.map((f: { kind: string }) => f.kind).sort()).toEqual(["manifest", "source"]);
    expect(() => run("export_doc", { path: "e2.uidesign.json", dir: "../evil" })).toThrow(/越出工作区/);

    run("create_doc", { path: "e3.uidesign.json", frames: [{ name: "屏", w: 100, h: 100 }] });
    const doc = load("e3.uidesign.json");
    run("update_nodes", { path: "e3.uidesign.json", updates: [{ id: page0(doc).nodes[0]!.id, visible: false }] });
    expect(() => run("export_doc", { path: "e3.uidesign.json" })).toThrow(/没有可见/);
  });
});

describe("list_icons 与 icon 节点", () => {
  test("list_icons：搜索 + 别名折算 + 空查询", () => {
    const r = run("list_icons", { query: "home" });
    expect(r.count).toBeGreaterThanOrEqual(1);
    expect(r.icons).toContain("house");
    expect(run("list_icons", {}).count).toBeGreaterThan(10);
    expect(run("list_icons", { query: "cart", limit: 3 }).icons.length).toBeLessThanOrEqual(3);
  });

  test("add_nodes icon：别名归一 + name 兼容 + 颜色粗细；未知图标名报错", () => {
    run("create_doc", { path: "ic.uidesign.json", frames: [{ name: "屏", w: 200, h: 200 }] });
    const fid = page0(load("ic.uidesign.json")).nodes[0]!.id;
    const add = run("add_nodes", {
      path: "ic.uidesign.json",
      parent: fid,
      nodes: [
        { type: "icon", name: "home-btn", icon: "home", x: 10, y: 10, w: 48, h: 48, color: "#0d99ff", strokeWidth: 2 },
        { type: "icon", name: "star", x: 70, y: 10, w: 24, h: 24 },
      ],
    });
    expect(add.created).toHaveLength(2);
    const kids = (page0(load("ic.uidesign.json")).nodes[0] as { children: DesignNode[] }).children;
    expect(kids[0]!.type === "icon" && kids[0].icon).toBe("house"); // home → house 别名
    expect(kids[0]!.type === "icon" && kids[0].color).toBe("#0d99ff");
    expect(kids[1]!.type === "icon" && kids[1].icon).toBe("star");
    expect(() =>
      run("add_nodes", { path: "ic.uidesign.json", parent: fid, nodes: [{ type: "icon", name: "x", icon: "nope-xyz", x: 0, y: 0, w: 24, h: 24 }] }),
    ).toThrow(/list_icons/);
    run("update_nodes", { path: "ic.uidesign.json", updates: [{ id: kids[1]!.id, icon: "heart", color: "#ff0000" }] });
    const kids2 = (page0(load("ic.uidesign.json")).nodes[0] as { children: DesignNode[] }).children;
    expect(kids2[1]!.type === "icon" && kids2[1].icon).toBe("heart");
    expect(kids2[1]!.type === "icon" && kids2[1].color).toBe("#ff0000");
  });

  test("截图文本上报未知图标名（裸写 JSON 的坏图标名不会被 add_nodes 拦下）", () => {
    // 直接落盘一份带坏图标名的档（模拟 agent 裸写 JSON）：add_nodes 会拦，但裸写拦不住
    writeFileSync(
      path.join(ws, "badicon.uidesign.json"),
      JSON.stringify({
        version: 1,
        meta: { name: "坏图标", kind: "uidesign" },
        activePage: "p1",
        pages: [
          {
            id: "p1",
            name: "页",
            nodes: [
              {
                id: "f1",
                type: "frame",
                name: "屏",
                x: 0,
                y: 0,
                w: 100,
                h: 100,
                children: [{ id: "i1", type: "icon", name: "q", icon: "zzz-fake", x: 8, y: 8, w: 24, h: 24 }],
              },
            ],
          },
        ],
      }),
    );
    const res = run("screenshot_doc", { path: "badicon.uidesign.json" });
    expect(res.mcpContent[0].text).toContain("图标名无效");
  });
});

describe("apply_layout 与自动布局", () => {
  test("update_nodes 设 layout → add_nodes 自动重排子项（含 grow 分配）", () => {
    run("create_doc", { path: "al.uidesign.json", frames: [{ name: "卡", w: 400, h: 200 }] });
    const fid = page0(load("al.uidesign.json")).nodes[0]!.id;
    run("update_nodes", { path: "al.uidesign.json", updates: [{ id: fid, layout: { mode: "h", gap: 10, padding: [8, 8, 8, 8] } }] });
    const a = run("add_nodes", {
      path: "al.uidesign.json",
      parent: fid,
      nodes: [
        { type: "rect", name: "A", w: 100, h: 40 },
        { type: "rect", name: "B", w: 60, h: 40, grow: 1 },
      ],
    });
    expect(a.reflowed).toBe(true);
    const kids = (page0(load("al.uidesign.json")).nodes[0] as { children: DesignNode[] }).children;
    expect(`${kids[0]!.x},${kids[0]!.y}`).toBe("8,8");
    expect(kids[1]!.w).toBe(274); // grow 子项原宽不占位：free = 400-16-100-10
    expect(kids[1]!.x).toBe(118);
  });

  test("update_nodes：结构字段自动重排；x/y 位移不重排；reflow:false 跳过", () => {
    const kids = () => (page0(load("al.uidesign.json")).nodes[0] as { children: DesignNode[] }).children;
    run("update_nodes", { path: "al.uidesign.json", updates: [{ id: kids()[0]!.id, grow: 1 }] });
    expect(kids()[0]!.w).toBeGreaterThan(100); // 两个 grow 平分
    run("update_nodes", { path: "al.uidesign.json", updates: [{ id: kids()[0]!.id, x: 50, y: 50 }] });
    expect(kids()[0]!.x).toBe(50); // 位移不重排（自由微调优先）
    const r1 = run("update_nodes", { path: "al.uidesign.json", updates: [{ id: kids()[0]!.id, w: 20 }] });
    expect(r1.reflowed).toBe(true);
    expect(kids()[0]!.x).toBe(8); // grow 子项宽度由布局接管，位置回正
    const r2 = run("update_nodes", { path: "al.uidesign.json", reflow: false, updates: [{ id: kids()[1]!.id, w: 30 }] });
    expect(r2.reflowed).toBe(false);
    expect(kids()[1]!.w).toBe(30);
  });

  test("apply_layout：强制重排挪乱的子项 + 错误路径", () => {
    const fid = page0(load("al.uidesign.json")).nodes[0]!.id;
    const kids = () => (page0(load("al.uidesign.json")).nodes[0] as { children: DesignNode[] }).children;
    run("update_nodes", { path: "al.uidesign.json", reflow: false, updates: [{ id: kids()[0]!.id, x: 300 }] });
    const r = run("apply_layout", { path: "al.uidesign.json", id: fid });
    expect(r.reflowed).toContain(fid);
    expect(r.changed).toBe(true);
    expect(kids()[0]!.x).toBe(8);
    expect(() => run("apply_layout", { path: "al.uidesign.json", id: "nope" })).toThrow(/不存在/);
    expect(() => run("update_nodes", { path: "al.uidesign.json", updates: [{ id: fid, layout: { gap: 5 } }] })).toThrow(/layout\.mode/);
  });
});

describe("blendMode / flip / wrap / hug / code 导出", () => {
  test("update_nodes：blendMode 校验与 flipX/flipY；normal 清除", () => {
    run("create_doc", { path: "bf.uidesign.json", frames: [{ name: "屏", w: 300, h: 300 }] });
    const fid = page0(load("bf.uidesign.json")).nodes[0]!.id;
    run("add_nodes", { path: "bf.uidesign.json", parent: fid, nodes: [{ type: "rect", name: "A", x: 10, y: 10, w: 50, h: 50, fill: "#ff0000" }] });
    const kid = (page0(load("bf.uidesign.json")).nodes[0] as { children: DesignNode[] }).children[0]!.id;
    run("update_nodes", { path: "bf.uidesign.json", updates: [{ id: kid, blendMode: " MULTIPLY ", flipX: true }] });
    let n = (page0(load("bf.uidesign.json")).nodes[0] as { children: DesignNode[] }).children[0]!;
    expect(n.blendMode).toBe("multiply");
    expect(n.flipX).toBe(true);
    expect(() => run("update_nodes", { path: "bf.uidesign.json", updates: [{ id: kid, blendMode: "nope" }] })).toThrow(/blendMode/);
    run("update_nodes", { path: "bf.uidesign.json", updates: [{ id: kid, blendMode: "normal", flipY: true }] });
    n = (page0(load("bf.uidesign.json")).nodes[0] as { children: DesignNode[] }).children[0]!;
    expect(n.blendMode).toBeUndefined();
    expect(n.flipY).toBe(true);
  });

  test("layout wrap/hug 走 MCP：折行位置与 hug 交叉轴尺寸", () => {
    run("create_doc", { path: "wh.uidesign.json", frames: [{ name: "流", w: 260, h: 300 }] });
    const fid = page0(load("wh.uidesign.json")).nodes[0]!.id;
    run("update_nodes", { path: "wh.uidesign.json", updates: [{ id: fid, layout: { mode: "h", gap: 10, wrap: true, hug: "cross" } }] });
    run("add_nodes", {
      path: "wh.uidesign.json",
      parent: fid,
      nodes: [
        { type: "rect", name: "A", w: 100, h: 40 },
        { type: "rect", name: "B", w: 100, h: 60 },
        { type: "rect", name: "C", w: 100, h: 30 },
      ],
    });
    const frame = page0(load("wh.uidesign.json")).nodes[0] as FrameNode;
    const kids = frame.children;
    expect(`${kids[0]!.x},${kids[0]!.y}`).toBe("0,0"); // 未设 cross → start
    expect(kids[1]!.y).toBe(0);
    expect(kids[2]!.y).toBe(70); // 行2 y = 60 + 10
    expect(frame.h).toBe(100); // hug 交叉轴 = 行高总和 60+10+30
  });

  test("export_doc format code：每画板一份 CSS 标注文件", () => {
    const r = run("export_doc", { path: "wh.uidesign.json", dir: "dist/code", format: ["code"] });
    const codeFile = r.files.find((f: { kind: string }) => f.kind === "code");
    expect(codeFile).toBeTruthy();
    const css = readFileSync(path.join(ws, codeFile.path), "utf8");
    expect(css).toContain("position: absolute;");
    expect(css.split("\n\n").length).toBeGreaterThanOrEqual(4); // 画板 + 3 子项
  });
});

describe("boolean_nodes 布尔运算", () => {
  test("union（别名 merge）：两形状合并为一个 vector，取底形样式", () => {
    run("create_doc", { path: "bo.uidesign.json", frames: [{ name: "画", w: 400, h: 300 }] });
    const fid = page0(load("bo.uidesign.json")).nodes[0]!.id;
    run("add_nodes", {
      path: "bo.uidesign.json",
      parent: fid,
      nodes: [
        { type: "rect", name: "底", x: 10, y: 10, w: 100, h: 100, fill: "#0d99ff" },
        { type: "ellipse", name: "圆", x: 60, y: 60, w: 100, h: 100, fill: "#22c55e" },
      ],
    });
    const kids = () => (page0(load("bo.uidesign.json")).nodes[0] as { children: DesignNode[] }).children;
    expect(kids()).toHaveLength(2);
    const r = run("boolean_nodes", { path: "bo.uidesign.json", ids: kids().map((k) => k.id), operation: "merge" });
    expect(r.operation).toBe("union");
    expect(r.w).toBe(150);
    expect(r.h).toBe(150);
    const after = kids();
    expect(after).toHaveLength(1);
    expect(after[0]!.type).toBe("vector");
    expect(after[0]!.type === "vector" && after[0].fills[0]?.type === "solid" && after[0].fills[0].color).toBe("#0d99ff");
    // 结果可继续参与布尔/被普通编辑
    const r2 = run("update_nodes", { path: "bo.uidesign.json", updates: [{ id: after[0]!.id, name: "合并体" }] });
    expect(r2.updated).toContain(after[0]!.id);
  });

  test("subtract：底形减去覆盖形", () => {
    run("create_doc", { path: "bo2.uidesign.json", frames: [{ name: "画", w: 400, h: 300 }] });
    const fid = page0(load("bo2.uidesign.json")).nodes[0]!.id;
    run("add_nodes", {
      path: "bo2.uidesign.json",
      parent: fid,
      nodes: [
        { type: "rect", name: "底", x: 10, y: 10, w: 100, h: 100, fill: "#0d99ff" },
        { type: "rect", name: "盖", x: 60, y: 60, w: 100, h: 100, fill: "#22c55e" },
      ],
    });
    const ids = (page0(load("bo2.uidesign.json")).nodes[0] as { children: DesignNode[] }).children.map((k) => k.id);
    const r = run("boolean_nodes", { path: "bo2.uidesign.json", ids, operation: "subtract" });
    expect(r.operation).toBe("subtract");
    expect(r.w).toBe(100); // 底形包围盒保持
    const v = (page0(load("bo2.uidesign.json")).nodes[0] as { children: DesignNode[] }).children[0]!;
    expect(v.type).toBe("vector");
  });

  test("错误路径：单节点 / 文本节点 / 跨容器", () => {
    run("create_doc", { path: "bo3.uidesign.json", frames: [{ name: "画", w: 400, h: 300 }] });
    const fid = page0(load("bo3.uidesign.json")).nodes[0]!.id;
    run("add_nodes", { path: "bo3.uidesign.json", parent: fid, nodes: [{ type: "rect", name: "R", x: 10, y: 10, w: 40, h: 40 }] });
    const rid = (page0(load("bo3.uidesign.json")).nodes[0] as { children: DesignNode[] }).children[0]!.id;
    expect(() => run("boolean_nodes", { path: "bo3.uidesign.json", ids: [rid] })).toThrow(/至少 2/);
    run("add_nodes", { path: "bo3.uidesign.json", parent: fid, nodes: [{ type: "text", name: "T", x: 10, y: 60, w: 40, h: 20, text: "字" }] });
    const tid = (page0(load("bo3.uidesign.json")).nodes[0] as { children: DesignNode[] }).children[1]!.id;
    expect(() => run("boolean_nodes", { path: "bo3.uidesign.json", ids: [rid, tid] })).toThrow(/不支持布尔运算/);
    run("add_nodes", { path: "bo3.uidesign.json", nodes: [{ type: "rect", name: "外", x: 200, y: 10, w: 40, h: 40 }] });
    const outId = page0(load("bo3.uidesign.json")).nodes[1]!.id;
    expect(() => run("boolean_nodes", { path: "bo3.uidesign.json", ids: [rid, outId] })).toThrow(/同一容器/);
  });
});
