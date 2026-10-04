/**
 * 图片落盘（内存优化）纯逻辑单测：扫描只认工具行、只认「还没落盘」的块；
 * 回写必须真正丢掉 data（省内存的那一刀）；降采样按长边算、等比、不放大。
 */
import { describe, expect, test } from "vitest";
import {
  clearRowImageUri,
  collectFailedImageParts,
  collectInlineToolImages,
  fitWithinMaxEdge,
  patchRowImage,
  shouldMaterializeImage,
} from "./image-materialize-pure";

const png = "A".repeat(1024);

const toolRow = (parts: unknown[]) => ({ role: "toolResult", content: parts });

describe("图片落盘纯逻辑", () => {
  test("shouldMaterializeImage：动图/空/超大/端不支持都跳过", () => {
    expect(shouldMaterializeImage(png, "image/png")).toBe(true);
    expect(shouldMaterializeImage(png, "image/jpeg")).toBe(true);
    expect(shouldMaterializeImage(png, "image/gif")).toBe(false);
    expect(shouldMaterializeImage(png, "image/webp")).toBe(false);
    expect(shouldMaterializeImage("", "image/png")).toBe(false);
    expect(shouldMaterializeImage("A".repeat(24_000_001), "image/png")).toBe(false);
    expect(shouldMaterializeImage(png, "image/png", false)).toBe(false);
  });

  test("fitWithinMaxEdge：长边为准、等比、不放大", () => {
    expect(fitWithinMaxEdge(3000, 2000, 1600)).toEqual({ width: 1600, height: 1067 });
    // 竖图按高缩（width 优先的写法会把竖图放大）
    expect(fitWithinMaxEdge(1000, 4000, 1600)).toEqual({ width: 400, height: 1600 });
    expect(fitWithinMaxEdge(800, 600, 1600)).toBe(null);
    expect(fitWithinMaxEdge(0, 0, 1600)).toBe(null);
  });

  test("collectInlineToolImages：只收工具行的未落盘内联图，尊重批上限", () => {
    const rows = [
      { role: "user", content: [{ type: "image", data: png, mimeType: "image/png" }] },
      toolRow([
        { type: "text", text: "ok" },
        { type: "image", data: png, mimeType: "image/png" },
        { type: "image", data: png, mimeType: "image/gif" }, // 动图跳过
        { type: "image", uri: "file:///a.png", mimeType: "image/png" }, // 已落盘
      ]),
      toolRow([{ type: "image", data: png, mimeType: "image/png" }]),
    ];
    const older = [
      toolRow([{ type: "image", data: png, mimeType: "image/jpeg" }]),
    ];
    const all = collectInlineToolImages(rows, older, 10);
    expect(all.map((t) => `${t.where}#${t.rowIndex}.${t.partIndex}`)).toEqual([
      "messages#1.1",
      "messages#2.0",
      "olderMessages#0.0",
    ]);
    // 批上限：本窗优先
    expect(collectInlineToolImages(rows, older, 1).map((t) => t.rowIndex)).toEqual([1]);
    expect(collectInlineToolImages(rows, older, 4)).toHaveLength(3);
  });

  test("patchRowImage：丢掉 data、补 uri/尺寸，且不改原数组", () => {
    const rows = [
      toolRow([{ type: "image", data: png, mimeType: "image/png", toolCallId: null }]),
    ];
    const next = patchRowImage(rows, 0, 0, {
      uri: "file:///cache/a.png",
      mimeType: "image/png",
      width: 1600,
      height: 900,
    });
    expect(next).not.toBeNull();
    const part = ((next as { content: Record<string, unknown>[] }[])[0].content)[0];
    expect(part).toEqual({
      type: "image",
      mimeType: "image/png",
      toolCallId: null,
      uri: "file:///cache/a.png",
      width: 1600,
      height: 900,
    });
    expect("data" in part).toBe(false);
    // 原行未被改动（不可变语义）
    expect((rows[0].content[0] as { data?: string }).data).toBe(png);
    // 已落盘 / 索引越界 / 非图片块 → null（调用方跳过）
    expect(patchRowImage(next as unknown[], 0, 0, { uri: "file:///b", mimeType: "image/png", width: 1, height: 1 })).toBeNull();
    expect(patchRowImage(rows, 5, 0, { uri: "file:///b", mimeType: "image/png", width: 1, height: 1 })).toBeNull();
    expect(patchRowImage([toolRow([{ type: "text", text: "x" }])], 0, 0, { uri: "file:///b", mimeType: "image/png", width: 1, height: 1 })).toBeNull();
  });

  test("自愈：清掉坏 uri 后行回到待落盘，扫描能指出坏图位置", () => {
    const rows = [
      toolRow([{ type: "image", uri: "file:///cache/bad.png", mimeType: "image/png", width: 1, height: 1 }]),
      toolRow([{ type: "image", data: png, mimeType: "image/png" }]),
    ];
    const older = [
      toolRow([{ type: "image", uri: "file:///cache/bad2.png", mimeType: "image/png", width: 1, height: 1 }]),
    ];
    const failed = collectFailedImageParts(rows, older, (u) => u.includes("bad"));
    expect(failed.map((t) => `${t.where}#${t.rowIndex}.${t.partIndex}`)).toEqual([
      "messages#0.0",
      "olderMessages#0.0",
    ]);
    // 摘掉 uri：data/宽度等残留一并清掉，行回到"没有 uri"
    const next = clearRowImageUri(rows, 0, 0);
    expect(next).not.toBeNull();
    const part = ((next as { content: Record<string, unknown>[] }[])[0].content)[0];
    expect(part).toEqual({ type: "image", mimeType: "image/png" });
    // 没有 uri / 索引越界 → null（调用方跳过）
    expect(clearRowImageUri(rows, 1, 0)).toBeNull();
    expect(clearRowImageUri(rows, 9, 0)).toBeNull();
  });
});
