/**
 * MCP 导出层真落盘测试：exportBundle 产出的目录包在临时工作区里逐一验证
 * （文件存在、PNG 像素尺寸、index.html 外链 assets/ 而非 dataURL、资产复制、
 * missingAssets 计数、路径越界拒绝），以及 saveToWorkspace 的边界行为。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportBundle, saveToWorkspace } from "../export";
import { parseDesignDoc } from "../../ui/src/doc";

/** 1×1 合法 PNG（资产 fixture 与签名比对基准） */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let ws = "";

const DOC_JSON = {
  version: 1,
  meta: { name: "落盘包", kind: "uidesign" },
  activePage: "p1",
  pages: [
    {
      id: "p1",
      name: "页面1",
      nodes: [
        {
          id: "f1",
          type: "frame",
          name: "首页",
          x: 0,
          y: 0,
          w: 200,
          h: 120,
          fills: [{ type: "solid", color: "#ffffff" }],
          children: [
            { id: "i1", type: "image", name: "头图", x: 10, y: 10, w: 60, h: 60, src: "pkg-assets/hero.png" },
            { id: "r1", type: "rect", name: "按钮", x: 10, y: 80, w: 120, h: 24 },
          ],
        },
        {
          id: "f2",
          type: "frame",
          name: "详情",
          x: 240,
          y: 0,
          w: 200,
          h: 120,
          children: [{ id: "i2", type: "image", name: "缺图", x: 0, y: 0, w: 80, h: 80, src: "gone/hero.png" }],
        },
      ],
    },
  ],
};

function pngWH(buf: Buffer): [number, number] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return [dv.getUint32(16), dv.getUint32(20)];
}

beforeAll(() => {
  ws = mkdtempSync(path.join(tmpdir(), "ui-design-export-"));
  writeFileSync(path.join(ws, "落盘包.uidesign.json"), JSON.stringify(DOC_JSON, null, 2));
  mkdirSync(path.join(ws, "pkg-assets"), { recursive: true });
  writeFileSync(path.join(ws, "pkg-assets", "hero.png"), PNG_1PX);
});

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
});

function runExport(opts: Parameters<typeof exportBundle>[5] = {}) {
  const docAbs = path.join(ws, "落盘包.uidesign.json");
  const doc = parseDesignDoc(readFileSync(docAbs, "utf8")).doc;
  const page = doc.pages[0]!;
  return exportBundle(ws, docAbs, doc, page, page.nodes.map((n) => n.id), opts);
}

describe("exportBundle（工程包真落盘）", () => {
  test("默认格式 png/html/source：目录树完整、内容达标", () => {
    const sum = runExport();
    expect(sum.dir).toBe("落盘包-export");
    expect(sum.doc).toBe("落盘包.uidesign.json");
    expect(sum.screens).toEqual(["首页", "详情"]);
    expect(sum.missingAssets).toBe(1); // gone/hero.png 读不到

    const abs = (rel: string) => path.join(ws, rel);
    expect(existsSync(abs("落盘包-export/manifest.json"))).toBe(true);
    expect(existsSync(abs("落盘包-export/落盘包.uidesign.json"))).toBe(true);
    expect(existsSync(abs("落盘包-export/assets/hero.png"))).toBe(true);
    const s1 = abs("落盘包-export/screens/01-首页.png");
    const s2 = abs("落盘包-export/screens/02-详情.png");
    expect(existsSync(s1)).toBe(true);
    expect(existsSync(s2)).toBe(true);
    expect(existsSync(abs("落盘包-export/index.html"))).toBe(true);
    // 不应该有 svg（默认格式不含）
    expect(existsSync(abs("落盘包-export/screens/01-首页.svg"))).toBe(false);

    // 源档副本 = 原样字节
    expect(readFileSync(abs("落盘包-export/落盘包.uidesign.json"), "utf8")).toBe(
      readFileSync(abs("落盘包.uidesign.json"), "utf8"),
    );
    // 资产逐份复制：字节一致
    expect(readFileSync(abs("落盘包-export/assets/hero.png"))).toEqual(PNG_1PX);

    // PNG 合法 + 像素尺寸 = 设计盒 × scale(2)
    for (const [f, w, h] of [
      [s1, 200, 120],
      [s2, 200, 120],
    ] as const) {
      const buf = readFileSync(f);
      expect([...buf.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(pngWH(buf)).toEqual([w * 2, h * 2]);
    }

    // index.html：位图外链 assets/，绝无 dataURL 内联
    const html = readFileSync(abs("落盘包-export/index.html"), "utf8");
    expect(html).toContain("assets/hero.png");
    expect(html).not.toContain("data:image");

    // summary.files 与 manifest.json 相互一致
    const kinds = sum.files.map((f) => f.kind);
    for (const want of ["source", "asset", "png", "html", "manifest"]) expect(kinds).toContain(want);
    const manifest = JSON.parse(readFileSync(abs("落盘包-export/manifest.json"), "utf8"));
    expect(manifest.generator).toBe("ui-design/export");
    expect(manifest.screens).toEqual([
      { name: "首页", width: 200, height: 120 },
      { name: "详情", width: 200, height: 120 },
    ]);
    expect(manifest.files.map((f: { path: string }) => f.path)).toEqual(
      sum.files
        .filter((f) => f.kind !== "manifest")
        .map((f) => f.path)
        .sort(),
    );
  });

  test("formats 仅 source：只有源档 + manifest；自定义 dir 生效", () => {
    const sum = runExport({ formats: ["source"], dir: "dist/min" });
    expect(sum.dir).toBe("dist/min");
    // formats 只挡 png/svg/html：源档副本与可整体拷走的 assets/ 恒在
    expect(sum.files.map((f) => f.kind).sort()).toEqual(["asset", "manifest", "source"]);
    expect(existsSync(path.join(ws, "dist/min/manifest.json"))).toBe(true);
    expect(existsSync(path.join(ws, "dist/min/index.html"))).toBe(false);
    expect(existsSync(path.join(ws, "dist/min/screens"))).toBe(false);
  });

  test("formats 含 svg：逐画板出自包含矢量", () => {
    const sum = runExport({ formats: ["svg", "source"], dir: "dist/v" });
    expect(sum.files.map((f) => f.kind)).toContain("svg");
    const svg = readFileSync(path.join(ws, "dist/v/screens/01-首页.svg"), "utf8");
    expect(svg.trimStart().startsWith("<svg")).toBe(true);
    // svg 自包含：资产以 dataURL 内嵌（区别于 index.html 的外链）
    expect(svg).toContain("data:image");
    expect(existsSync(path.join(ws, "dist/v/screens/01-首页.png"))).toBe(false);
  });

  test("scale/maxDim/background 透传：倍率钳制到最长边", () => {
    const sum = runExport({ formats: ["png"], dir: "dist/cap", scale: 4, maxDim: 300 });
    const pngFile = sum.files.find((f) => f.kind === "png")!;
    const buf = readFileSync(path.join(ws, pngFile.path));
    const [w, h] = pngWH(buf);
    expect(w).toBeLessThanOrEqual(300);
    expect(w).toBe(300); // 200×min(4, 300/200=1.5) = 300
    expect(h).toBe(180);
  });

  test("dir 越出工作区 → 抛错拒绝", () => {
    expect(() => runExport({ dir: "../evil" })).toThrow(/越出工作区/);
    expect(() => runExport({ dir: "a/../../b" })).toThrow(/越出工作区/);
  });

  test("无可见顶层节点 → 报错而非空包", () => {
    const docAbs = path.join(ws, "落盘包.uidesign.json");
    const doc = parseDesignDoc(readFileSync(docAbs, "utf8")).doc;
    expect(() => exportBundle(ws, docAbs, doc, doc.pages[0]!, ["ghost"])).toThrow(/没有可见/);
  });
});

describe("saveToWorkspace（截图 saveTo 共用的落盘边界）", () => {
  test("嵌套路径自动建目录并回正斜杠相对路径", () => {
    const rel = saveToWorkspace(ws, "shots\\sub\\a.png", PNG_1PX);
    expect(rel).toBe("shots/sub/a.png");
    expect(readFileSync(path.join(ws, "shots", "sub", "a.png"))).toEqual(PNG_1PX);
  });
  test("空路径与越出工作区拒绝", () => {
    expect(() => saveToWorkspace(ws, "  ", PNG_1PX)).toThrow(/空/);
    expect(() => saveToWorkspace(ws, "../out.png", PNG_1PX)).toThrow(/越出工作区/);
    expect(() => saveToWorkspace(ws, "a/../../out.png", PNG_1PX)).toThrow(/越出工作区/);
  });
});
