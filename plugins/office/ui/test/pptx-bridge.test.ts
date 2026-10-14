/**
 * pptx → deck 转换桥的测试：用 pptxgenjs（插件导出链路的同一依赖）现场构造
 * fixture pptx（文本/形状/表格/图片），转换后断言位置（EMU→px）、字号（pt→px）、
 * 公式化映射的保真点。XML 解析注入 @xmldom/xmldom（bun 无 DOMParser）。
 */
import { describe, expect, test } from "bun:test";
import { DOMParser } from "@xmldom/xmldom";
import PptxGenJS from "pptxgenjs";
import { importPptxToDeck } from "../src/pptx-bridge";

const parse = (xml: string) => new DOMParser().parseFromString(xml, "text/xml");

async function buildFixture(): Promise<ArrayBuffer> {
  const pptx = new PptxGenJS();
  const slide = pptx.addSlide();
  slide.background = { color: "111318" };
  slide.addText("Hello", { x: 1, y: 1, w: 4, h: 1, fontSize: 24, bold: true, color: "F5F5F7" });
  slide.addShape(pptx.ShapeType.rect, { x: 1, y: 2, w: 2, h: 1, fill: { color: "FF0000" } });
  slide.addTable(
    [
      ["A", "B"],
      ["1", "2"],
    ],
    { x: 5, y: 1, w: 4, h: 1.5 },
  );
  slide.addImage({
    data: "image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    x: 7,
    y: 4,
    w: 1,
    h: 1,
  });
  const buf = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe("pptx → deck 转换", () => {
  test("页尺寸（EMU→px）与页数", async () => {
    const r = await importPptxToDeck(await buildFixture(), "演示", parse);
    // pptxgenjs 默认 16:9 = 10in × 5.625in
    expect(r.doc.frames.length).toBe(1);
    expect(r.doc.frames[0]!.w).toBe(960);
    expect(r.doc.frames[0]!.h).toBe(540);
    expect(r.doc.meta.kind).toBe("deck");
  });

  test("文本：位置/字号 pt→px/粗体/颜色；页背景", async () => {
    const r = await importPptxToDeck(await buildFixture(), "演示", parse);
    const text = r.doc.frames[0]!.elements.find((e) => e.kind === "text") as
      | { x: number; y: number; w: number; h: number; runs: { text: string; size?: number; bold?: true; color?: string }[] }
      | undefined;
    expect(text).toBeDefined();
    // 1in = 914400 EMU = 96px
    expect(text!.x).toBe(96);
    expect(text!.y).toBe(96);
    expect(text!.w).toBe(384);
    expect(text!.runs[0]?.text).toBe("Hello");
    expect(text!.runs[0]?.size).toBe(32); // 24pt × 4/3
    expect(text!.runs[0]?.bold).toBe(true);
    expect(text!.runs[0]?.color).toBe("#F5F5F7");
    expect(r.doc.frames[0]!.background).toBe("#111318");
  });

  test("形状：rect + 填充色", async () => {
    const r = await importPptxToDeck(await buildFixture(), "演示", parse);
    const shape = r.doc.frames[0]!.elements.find((e) => e.kind === "shape") as
      | { shape: string; fill?: string }
      | undefined;
    expect(shape?.shape).toBe("rect");
    expect(shape?.fill).toBe("#FF0000");
  });

  test("表格：a:tbl → deck table 行列文本", async () => {
    const r = await importPptxToDeck(await buildFixture(), "演示", parse);
    const table = r.doc.frames[0]!.elements.find((e) => e.kind === "table") as
      | { rows: string[][] }
      | undefined;
    expect(table?.rows).toEqual([
      ["A", "B"],
      ["1", "2"],
    ]);
  });

  test("图片：media 字节抽出 + src 指向 <名>-assets/", async () => {
    const r = await importPptxToDeck(await buildFixture(), "演示", parse);
    expect(r.images.length).toBe(1);
    expect(r.images[0]!.base64.length).toBeGreaterThan(50);
    const img = r.doc.frames[0]!.elements.find((e) => e.kind === "image") as
      | { src: string }
      | undefined;
    expect(img?.src).toBe("演示-assets/image-1-1.png"); // media 文件名沿用 pptx 内部命名
  });
});
