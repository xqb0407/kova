/**
 * MCP 渲染核单测：近似文本测量 + 档 → PNG 全链路（resvg-js 真渲染，bun 下可跑）。
 * 断言用 PNG 字节层面的事实：签名 / IHDR 尺寸 / 体积，不依赖像素级容差。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeApproxMeasure, renderDocPng } from "../render";
import { parseDesignDoc, type DesignDoc } from "../../ui/src/doc";

const ws = mkdtempSync(path.join(tmpdir(), "ui-design-render-"));

function pngSize(png: Uint8Array): { w: number; h: number } {
  // IHDR：宽在 16..19、高在 20..23（big-endian uint32）
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47];

function isPng(png: Uint8Array): boolean {
  return PNG_SIG.every((b, i) => png[i] === b);
}

const BASE_DOC = {
  version: 1,
  meta: { name: "渲染单测", kind: "uidesign" },
  activePage: "p1",
  pages: [
    {
      id: "p1",
      name: "页面 1",
      nodes: [
        {
          id: "f1",
          type: "frame",
          name: "首页",
          x: 0,
          y: 0,
          w: 390,
          h: 812,
          fills: [{ type: "solid", color: "#ffffff" }],
          children: [
            {
              id: "t1",
              type: "text",
              name: "标题",
              x: 24,
              y: 40,
              w: 342,
              h: 48,
              runs: [{ text: "设计规范验证 Design", size: 32, color: "#111111" }],
            },
            {
              id: "r1",
              type: "rect",
              name: "按钮",
              x: 24,
              y: 700,
              w: 342,
              h: 48,
              radius: 24,
              fills: [{ type: "solid", color: "#0d99ff" }],
            },
          ],
        },
      ],
    },
  ],
};

describe("makeApproxMeasure（近似文本测量）", () => {
  const m = makeApproxMeasure();
  test("CJK 全角按 1em 计宽", () => {
    expect(m("你好", "20px sans-serif").width).toBeCloseTo(40, 5);
  });
  test("ASCII 分桶且在合理区间（Latin 混合 ≈ 0.3~1em/字符）", () => {
    const w = m("Hello World", "16px system-ui").width;
    expect(w).toBeGreaterThan(16 * 3.5);
    expect(w).toBeLessThan(16 * 11 * 0.75);
  });
  test("加粗略宽于常规；空串零宽；行高指标随字号线性", () => {
    const plain = m("设计规范", "20px sans-serif").width;
    const bold = m("设计规范", "700 20px sans-serif").width;
    expect(bold).toBeGreaterThan(plain);
    expect(m("", "20px sans-serif").width).toBe(0);
    expect(m("x", "30px sans-serif").ascent).toBeCloseTo(24, 5);
    expect(m("x", "30px sans-serif").descent).toBeCloseTo(6, 5);
  });
});

describe("renderDocPng（档 → PNG 全链路）", () => {
  test("渲染基础稿：合法 PNG，尺寸≈设计盒×倍率", () => {
    const parsed = parseDesignDoc(JSON.stringify(BASE_DOC));
    expect(parsed.fatal).toBe(false);
    const r = renderDocPng(ws, parsed.doc, ["f1"], { scale: 2, maxDim: 1600 });
    expect(r).not.toBeNull();
    const got = r!;
    expect(isPng(got.png)).toBe(true);
    expect(got.boxW).toBe(390);
    expect(got.boxH).toBe(812);
    // ratio = min(2, 1600/812) ≈ 1.970 → 宽 ≈ 768
    const { w, h } = pngSize(got.png);
    expect(w).toBeCloseTo(390 * (1600 / 812), -1);
    expect(h).toBeCloseTo(812 * (1600 / 812), -1);
    expect(got.width).toBe(w);
    expect(got.missingImages).toBe(0);
    expect(got.png.byteLength).toBeLessThan(2 * 1024 * 1024);
  });

  test("ids 全隐藏 → null；不可见节点被跳过", () => {
    const doc = structuredClone(BASE_DOC) as unknown as DesignDoc;
    (doc.pages[0]!.nodes[0] as { visible?: boolean }).visible = false;
    expect(renderDocPng(ws, doc, ["f1"])).toBeNull();
  });

  test("位图资产：工作区 png 读成 dataURL；缺失记 missingImages 且仍出图", () => {
    writeFileSync(
      path.join(ws, "pix.png"),
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
    );
    const doc = structuredClone(BASE_DOC) as Record<string, unknown>;
    const pages = doc["pages"] as Array<{ nodes: unknown[] }>;
    pages[0]!.nodes.push({
      id: "img1",
      type: "image",
      name: "图",
      x: 420,
      y: 0,
      w: 100,
      h: 100,
      src: "pix.png",
    });
    const parsed = parseDesignDoc(JSON.stringify(doc));
    expect(parsed.fatal).toBe(false);
    const ok = renderDocPng(ws, parsed.doc, ["f1", "img1"]);
    expect(ok && ok.missingImages).toBe(0);

    const bad = structuredClone(doc);
    (bad["pages"] as Array<{ nodes: Array<Record<string, unknown>> }>).forEach((p) =>
      p.nodes.forEach((n) => {
        if (n.type === "image") n.src = "no-such-file.png";
      }),
    );
    const r2 = renderDocPng(ws, bad as unknown as DesignDoc, ["f1", "img1"]);
    expect(r2 && r2.missingImages).toBe(1);
    expect(r2 && isPng(r2.png)).toBe(true);
  });

  test("maxDim 约束最长边：4000×1000 盒在 maxDim 800 下宽 ≤800", () => {
    const doc = structuredClone(BASE_DOC) as Record<string, unknown>;
    const frame = (doc["pages"] as Array<{ nodes: Array<Record<string, unknown>> }>)[0]!.nodes[0]!;
    frame.x = 0;
    frame.y = 2000;
    const parsed = parseDesignDoc(JSON.stringify(doc));
    const big = structuredClone(doc) as Record<string, unknown>;
    const f = (big["pages"] as Array<{ nodes: Array<Record<string, unknown>> }>)[0]!.nodes[0]!;
    f.w = 4000;
    f.h = 1000;
    const p2 = parseDesignDoc(JSON.stringify(big));
    expect(p2.fatal).toBe(false);
    const r = renderDocPng(ws, p2.doc, ["f1"], { maxDim: 800 });
    expect(r).not.toBeNull();
    const { w, h } = pngSize(r!.png);
    expect(w).toBeLessThanOrEqual(801);
    expect(h).toBeLessThanOrEqual(801);
    void parsed;
  });

  test("透明底与白底：体积/字节存在但不可比，只保证合法 PNG", () => {
    const parsed = parseDesignDoc(JSON.stringify(BASE_DOC));
    const t = renderDocPng(ws, parsed.doc, ["f1"], { background: null });
    const w = renderDocPng(ws, parsed.doc, ["f1"], { background: "#ffffff" });
    expect(t && isPng(t.png)).toBe(true);
    expect(w && isPng(w.png)).toBe(true);
  });

  test("非法档不崩：空页/未知 id 一律 null", () => {
    const parsed = parseDesignDoc(JSON.stringify(BASE_DOC));
    expect(renderDocPng(ws, parsed.doc, ["nope"])).toBeNull();
    expect(renderDocPng(ws, parsed.doc, [])).toBeNull();
  });
});

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
});
