import { describe, expect, test } from "bun:test";
import {
  base64DecodedBytes,
  deviceScaleFromDpr,
  imageSizeFromBuffer,
  screenshotScaleForMaxDim,
} from "../main/browser-image";

function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function jpegHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  // SOI + APP0(len=4) + SOF0(len=17, precision=8, h, w)
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]).copy(buf, 0);
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]).copy(buf, 8);
  buf.writeUInt16BE(height, 13);
  buf.writeUInt16BE(width, 15);
  return buf;
}

describe("imageSizeFromBuffer", () => {
  test("PNG 头直接读出宽高", () => {
    expect(imageSizeFromBuffer(pngHeader(1580, 962))).toEqual({ width: 1580, height: 962 });
  });

  test("JPEG 走 SOF0 读出宽高（可跳过 APP0 段）", () => {
    expect(imageSizeFromBuffer(jpegHeader(3000, 1944))).toEqual({ width: 3000, height: 1944 });
  });

  test("未知格式/半截头返回 null（调用方回退 nativeImage）", () => {
    expect(imageSizeFromBuffer(Buffer.from("not an image"))).toBeNull();
    expect(imageSizeFromBuffer(Buffer.from([0x89, 0x50]))).toBeNull();
  });

  test("JPEG 在 SOF 前进入压缩数据则放弃", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00]);
    expect(imageSizeFromBuffer(buf)).toBeNull();
  });
});

describe("base64DecodedBytes", () => {
  test("按 padding 换算，不解码", () => {
    expect(base64DecodedBytes("")).toBe(0);
    expect(base64DecodedBytes("AAAA")).toBe(3);
    expect(base64DecodedBytes("AAA=")).toBe(2);
    expect(base64DecodedBytes("AA==")).toBe(1);
  });
});

describe("screenshotScaleForMaxDim", () => {
  test("设备 scale 要去掉页面 zoom（DPR 包含 zoom）", () => {
    // Electron 实测：zoom=2 时 DPR=4，但 CDP clip 仍按设备 scale=2 输出。
    expect(deviceScaleFromDpr(4, 2)).toBe(2);
    expect(deviceScaleFromDpr(2, 1)).toBe(2);
    expect(deviceScaleFromDpr(1.25, 1)).toBe(1.25);
  });

  test("Retina 2x 下最长边按物理像素封顶", () => {
    // CSS 1200 宽 @2x 想压到 1920 物理像素，clip.scale 必须是 0.8。
    const scale = screenshotScaleForMaxDim(1200, 800, 1920, 2);
    expect(Math.abs(scale - 0.8)).toBeLessThan(1e-9);
    expect(1200 * scale * 2).toBe(1920);
  });

  test("DPR 1 时保持原行为", () => {
    expect(screenshotScaleForMaxDim(1200, 800, 1920, 1)).toBe(1);
    expect(
      Math.abs(screenshotScaleForMaxDim(3000, 1000, 1920, 1) - 0.64),
    ).toBeLessThan(1e-9);
  });

  test("16MP 像素预算会继续收缩", () => {
    const scale = screenshotScaleForMaxDim(5000, 5000, 7680, 1, 16_000_000);
    expect(Math.abs(scale - 0.8)).toBeLessThan(1e-9);
    expect(5000 * 5000 * scale * scale).toBeLessThanOrEqual(16_000_000 + 1);
  });
});
