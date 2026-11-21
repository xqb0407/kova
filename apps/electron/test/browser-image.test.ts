import { describe, expect, test } from "bun:test";
import { base64DecodedBytes, imageSizeFromBuffer } from "../main/browser-image";

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
