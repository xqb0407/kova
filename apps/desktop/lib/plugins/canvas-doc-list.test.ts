/**
 * 工作区文档盘点的测试：opens-glob 驱动扫描（glob 语义与 sidecar globMatch 一致：
 * `*` 不跨路径分隔符）、多 glob 去重、深度/条数上限，以及摘要的 kind 分支
 * （画布档给页框摘要，Univer 快照档只报名称，坏档照常列出打 corrupt）。
 */
import { describe, expect, mock, test } from "bun:test";

// fs 走 Tauri 命令，测试里替换成内存目录树
const tree = new Map<string, string>();
const dirs = new Set<string>();

mock.module("@/lib/workspace/fs", () => ({
  fsListDir: async (_cwd: string | null, dir: string) => {
    const prefix = dir ? `${dir}/` : "";
    const entries = new Map<string, { name: string; dir: boolean }>();
    for (const path of [...tree.keys(), ...dirs]) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest) continue;
      const seg = rest.split("/")[0];
      if (seg) entries.set(seg, { name: seg, dir: rest.includes("/") });
    }
    return { entries: [...entries.values()] };
  },
  fsReadFile: async (_cwd: string | null, path: string) => {
    const content = tree.get(path);
    return content === undefined ? null : { content, binary: false, truncated: false };
  },
}));

const { listCanvasDocs } = await import("@/lib/plugins/canvas-doc-list");

const put = (path: string, content: string) => tree.set(path, content);
const canvasDoc = (name: string, kind: string | null = null, objects = 2) =>
  JSON.stringify({
    version: 3,
    meta: kind ? { name, kind } : { name },
    objects: Array.from({ length: objects }, (_, i) => ({ kind: "shape", id: `o${i}`, shape: "rect", x: i * 40, y: 0, w: 100, h: 60, fill: "#0a84ff" })),
  });
const sheetDoc = (name: string) => JSON.stringify({ id: "u1", name, sheetOrder: ["s1"], sheets: {} });
const docDoc = (title: string) => JSON.stringify({ id: "u2", title, body: {} });

describe("listCanvasDocs 扫描范围", () => {
  test("缺省仍扫 *.canvas.json（兼容旧调用）", async () => {
    tree.clear();
    put("a.canvas.json", canvasDoc("演示"));
    put("b.sheet.univer.json", sheetDoc("报表"));
    const items = await listCanvasDocs("w");
    expect(items.map((i) => i.path)).toEqual(["a.canvas.json"]);
    expect(items[0]?.kind).toBe("board"); // deck 已成历史，一律按画布
  });

  test("传入面板 opens glob：画布 + Univer 快照档一起列出", async () => {
    tree.clear();
    put("a.canvas.json", canvasDoc("演示"));
    put("b.sheet.univer.json", sheetDoc("报表"));
    put("c.doc.univer.json", docDoc("纪要"));
    put("d.unrelated.json", "{}");
    const items = await listCanvasDocs("w", [
      "*.canvas.json",
      "*.sheet.univer.json",
      "*.doc.univer.json",
    ]);
    expect(items.map((i) => i.path).sort()).toEqual([
      "a.canvas.json",
      "b.sheet.univer.json",
      "c.doc.univer.json",
    ]);
  });

  test("相对路径或文件名命中即可（子目录画布档照列）；同文件多 glob 命中只列一次", async () => {
    tree.clear();
    put("root.canvas.json", canvasDoc("根"));
    put("sub/nested.canvas.json", canvasDoc("嵌套"));
    put("sub/deep/grand.canvas.json", canvasDoc("深层"));
    put("other/unrelated.md", "x");
    // 深层档同时命中 `*.canvas.json`（basename）与 `sub/deep/*.canvas.json`（相对路径），只列一次
    const items = await listCanvasDocs("w", ["*.canvas.json", "sub/deep/*.canvas.json"]);
    expect(items.map((i) => i.path).sort()).toEqual([
      "root.canvas.json",
      "sub/deep/grand.canvas.json",
      "sub/nested.canvas.json",
    ]);
  });
});

describe("listCanvasDocs 摘要分支", () => {
  test("sheet 快照：名称取快照 name，缺省退文件名", async () => {
    tree.clear();
    put("q.sheet.univer.json", sheetDoc("季度报表"));
    put("r.sheet.univer.json", JSON.stringify({ id: "sheet-9", sheets: {} }));
    const items = await listCanvasDocs("w", ["*.sheet.univer.json"]);
    expect(items.find((i) => i.path === "q.sheet.univer.json")?.name).toBe("季度报表");
    expect(items.find((i) => i.path === "r.sheet.univer.json")?.name).toBe("r");
    for (const i of items) {
      expect(i.kind).toBe("sheet");
      expect(i.frames).toBe(0);
      expect(i.preview).toEqual([]);
    }
  });

  test("doc 快照：名称取快照 title", async () => {
    tree.clear();
    put("m.doc.univer.json", docDoc("会议纪要"));
    const items = await listCanvasDocs("w", ["*.doc.univer.json"]);
    expect(items[0]?.name).toBe("会议纪要");
    expect(items[0]?.kind).toBe("doc");
  });

  test("画布档：objects 计数 + 元素包围盒摘要；ui kind 保留", async () => {
    tree.clear();
    put("w.canvas.json", canvasDoc("白板", null, 3));
    put("u.canvas.json", canvasDoc("旧UI", "ui", 1));
    const items = await listCanvasDocs("w", ["*.canvas.json"]);
    const w = items.find((i) => i.path === "w.canvas.json");
    expect(w?.kind).toBe("board");
    expect(w?.objects).toBe(3);
    expect(w?.preview).toHaveLength(3);
    expect(w?.preview[0]?.w).toBe(100);
    const u = items.find((i) => i.path === "u.canvas.json");
    expect(u?.kind).toBe("ui"); // 旧「UI 设计」档标记只读保留
  });

  test("坏档照常列出并打 corrupt（按后缀判 kind，不再一律 board）", async () => {
    tree.clear();
    put("bad.sheet.univer.json", "{oops");
    put("bad.canvas.json", "{oops");
    const items = await listCanvasDocs("w", ["*.canvas.json", "*.sheet.univer.json"]);
    const sheet = items.find((i) => i.path === "bad.sheet.univer.json");
    const canvas = items.find((i) => i.path === "bad.canvas.json");
    expect(sheet?.corrupt).toBe(true);
    expect(sheet?.kind).toBe("sheet");
    expect(sheet?.name).toBe("bad");
    expect(canvas?.corrupt).toBe(true);
    expect(canvas?.kind).toBe("board");
  });
});
