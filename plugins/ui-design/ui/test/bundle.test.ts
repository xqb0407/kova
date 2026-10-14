/**
 * 导出工程包纯装配器单测：目录结构 / 画板编号 / 资产去重 / 外链表 / manifest。
 * 零 IO——浏览器面板与 MCP export_doc 共用它，保证两条链路产物一致。
 */
import { describe, expect, test } from "bun:test";
import { parseDesignDoc, type DesignDoc } from "../src/doc";
import {
  buildManifest,
  DEFAULT_FORMATS,
  externalImagesMap,
  planBundle,
  safeToken,
  serializeManifest,
  type BundleFileResult,
} from "../src/bundle";

function docOf(json: unknown): DesignDoc {
  const res = parseDesignDoc(JSON.stringify(json));
  expect(res.fatal).toBe(false);
  return res.doc;
}

/**
 * f1 首页（含两张不同目录同名资产）/ f2 详情 / f3 隐藏画板。
 */
function fixture() {
  const doc = docOf({
    version: 1,
    meta: { name: "包测试", kind: "uidesign" },
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
            w: 375,
            h: 812,
            children: [
              { id: "r1", type: "rect", name: "按钮", x: 10, y: 220, w: 100, h: 40 },
              { id: "i1", type: "image", name: "头图", x: 0, y: 0, w: 375, h: 200, src: "pkg-assets/hero.png" },
            ],
          },
          {
            id: "f2",
            type: "frame",
            name: "详情",
            x: 420,
            y: 0,
            w: 375,
            h: 812,
            children: [
              { id: "i2", type: "image", name: "头图2", x: 0, y: 0, w: 375, h: 100, src: "other/hero.png" },
            ],
          },
          { id: "f3", type: "frame", name: "隐藏页", x: 840, y: 0, w: 375, h: 812, visible: false },
        ],
      },
    ],
  });
  return { doc, page: doc.pages[0]! };
}

describe("safeToken", () => {
  test("路径分隔/非法字符与空白折叠成 -，保留中文", () => {
    expect(safeToken("首页/2024:版")).toBe("首页-2024-版");
    expect(safeToken(" a  b\\c?d*e\"f<g>h| ")).toBe("a-b-c-d-e-f-g-h");
  });
  test("空/纯非法输入回退 fallback；超长截 48", () => {
    expect(safeToken("", "screen")).toBe("screen");
    expect(safeToken("///")).toBe("screen");
    expect(safeToken("x".repeat(80))).toHaveLength(48);
  });
});

describe("planBundle", () => {
  test("默认目录/编号/跳过隐藏/尺寸取整", () => {
    const { doc, page } = fixture();
    const plan = planBundle(doc, page, ["f1", "f2", "f3"], "app", {});
    expect(plan.dir).toBe("app-export");
    expect(plan.screens).toHaveLength(2); // f3 隐藏被跳过
    const [s1, s2] = plan.screens;
    expect(s1!.pngPath).toBe("app-export/screens/01-首页.png");
    expect(s2!.pngPath).toBe("app-export/screens/02-详情.png");
    expect(s1!.svgPath).toBe("app-export/screens/01-首页.svg");
    expect(s1!.w).toBe(375);
    expect(s1!.h).toBe(812);
    expect(plan.sourcePath).toBe("app-export/app.uidesign.json");
    expect(plan.indexHtmlPath).toBe("app-export/index.html");
    expect(plan.manifestPath).toBe("app-export/manifest.json");
    expect([...plan.formats].sort()).toEqual([...DEFAULT_FORMATS].sort()); // png/html/source
    expect(plan.background).toBe(null); // 导出缺省透明，画板自绘底
    expect(plan.scale).toBe(2);
    expect(plan.maxDim).toBe(4096);
  });

  test("自定义目录去尾部斜杠；formats 覆盖默认", () => {
    const { doc, page } = fixture();
    const plan = planBundle(doc, page, ["f1"], "my.app", { dir: "dist/pkg/", formats: ["svg"] });
    expect(plan.dir).toBe("dist/pkg");
    expect([...plan.formats]).toEqual(["svg"]);
    expect(plan.screens[0]!.pngPath).toBe("dist/pkg/screens/01-首页.png");
  });

  test("同名不同路径资产去重：basename + ~2 bump；externalImagesMap 指 assets/ 相对路径", () => {
    const { doc, page } = fixture();
    const plan = planBundle(doc, page, ["f1", "f2"], "app", {});
    expect(plan.assets.map((a) => a.rel)).toEqual(["hero.png", "hero~2.png"]);
    expect(plan.assets.map((a) => a.path)).toEqual([
      "app-export/assets/hero.png",
      "app-export/assets/hero~2.png",
    ]);
    const m = externalImagesMap(plan);
    expect(m.get("pkg-assets/hero.png")).toBe("assets/hero.png");
    expect(m.get("other/hero.png")).toBe("assets/hero~2.png");
    expect(m.size).toBe(2);
  });

  test("只给嵌套子节点 id 也能成屏（子树资产照收集）", () => {
    const { doc, page } = fixture();
    const plan = planBundle(doc, page, ["i1"], "app", {});
    expect(plan.screens).toHaveLength(1);
    expect(plan.screens[0]!.name).toBe("头图");
    expect(plan.assets.map((a) => a.src)).toEqual(["pkg-assets/hero.png"]);
  });
});

describe("buildManifest / serializeManifest", () => {
  test("files 按路径排序；附设计尺寸与逐画板名；键序稳定", () => {
    const { doc, page } = fixture();
    const plan = planBundle(doc, page, ["f1", "f2"], "app", {});
    const files: BundleFileResult[] = [
      { path: "app-export/manifest-placeholder-b.txt", kind: "asset", bytes: 2 },
      { path: "app-export/manifest-placeholder-a.txt", kind: "html", bytes: 1 },
    ];
    const m = buildManifest(doc, plan, "app.uidesign.json", files, "2026-09-28T00:00:00.000Z");
    expect(m.generator).toBe("ui-design/export");
    expect(m.doc).toBe("app.uidesign.json");
    expect(m.docName).toBe("包测试");
    expect(m.page).toBe("页面1");
    expect(m.files.map((f) => f.path)).toEqual([
      "app-export/manifest-placeholder-a.txt",
      "app-export/manifest-placeholder-b.txt",
    ]);
    expect(m.screens).toEqual([
      { name: "首页", width: 375, height: 812 },
      { name: "详情", width: 375, height: 812 },
    ]);
    const text = serializeManifest(m);
    expect(text).toContain('"generator": "ui-design/export"');
    expect(text).toContain("2026-09-28T00:00:00.000Z");
    // 稳定序列化：两次调用逐字节一致（键序固定，可 diff）
    expect(serializeManifest(buildManifest(doc, plan, "app.uidesign.json", files, "2026-09-28T00:00:00.000Z"))).toBe(text);
  });
});
