/**
 * 从 base64 图片数据里读 intrinsic 尺寸——只解析文件头，不解码整张图。
 *
 * 动机：消息里的图片在加载前没有占位高度，`<img>` 一落图就把下方内容顶开
 * （CLS）。投影阶段顺手读出宽高，挂到 `<img width height>` 上，浏览器就能在
 * 加载前按比例预留空间。识别失败返回 null，调用方回退到无尺寸行为，绝不
 * 影响图片显示。
 *
 * 覆盖离线上屏白名单里的 png / jpeg / gif / webp；JPEG 的 EXIF 旋转未处理
 * （工具产物基本无 EXIF，若以后有手机照片附件需要再补 orientation）。
 */
export type ImageSize = { width: number; height: number };

/** 头部最多解码这么多：足够覆盖 JPEG 的 SOF，又不会为了尺寸吃掉整张图 */
const HEADER_BYTES = 64 * 1024;

const decodeHeader = (b64: string): Uint8Array | null => {
  try {
    // 截断必须落在 4 的倍数上，否则 atob 会因非法 padding 抛错
    const chars = Math.floor(Math.min(b64.length, (HEADER_BYTES * 4) / 3) / 4) * 4;
    const bin = atob(b64.slice(0, chars));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const be32 = (b: Uint8Array, i: number) =>
  (b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!;
const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const le24 = (b: Uint8Array, i: number) =>
  b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);

function pngSize(b: Uint8Array): ImageSize | null {
  // 89 50 4E 47 0D 0A 1A 0A | len(4) | "IHDR" | width(4) | height(4)
  if (b.length < 24 || b[0] !== 0x89 || ascii(b, 12, 4) !== "IHDR") return null;
  const width = be32(b, 16);
  const height = be32(b, 20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function gifSize(b: Uint8Array): ImageSize | null {
  if (b.length < 10 || ascii(b, 0, 6).slice(0, 3) !== "GIF") return null;
  const width = le16(b, 6);
  const height = le16(b, 8);
  return width > 0 && height > 0 ? { width, height } : null;
}

function jpegSize(b: Uint8Array): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1]!;
    // 填充字节 / 无长度段
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (
      marker === 0x01 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2;
      continue;
    }
    const length = be16(b, i + 2);
    if (length < 2) return null;
    // SOF0/1/2/3/5/6/7/9/10/11/13/14/15（排除 DHT/JPG/DAC）
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      const height = be16(b, i + 5);
      const width = be16(b, i + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + length;
  }
  return null;
}

function webpSize(b: Uint8Array): ImageSize | null {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") {
    return null;
  }
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8X") {
    // flags(1) + reserved(3) + canvas width-1(3, LE) + height-1(3, LE)
    return { width: 1 + le24(b, 24), height: 1 + le24(b, 27) };
  }
  if (chunk === "VP8 ") {
    // frame tag(3) + start code 9D 01 2A(3) + width(2, LE, 14 bits) + height(2)
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    // 签名后 4 字节按位打包：width-1(14) + height-1(14)
    const b0 = b[21]!;
    const b1 = b[22]!;
    const b2 = b[23]!;
    const b3 = b[24]!;
    return {
      width: 1 + (b0 | ((b1 & 0x3f) << 8)),
      height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)),
    };
  }
  return null;
}

/** base64（不带 data: 前缀）+ mime → 尺寸；无法识别返回 null。 */
export function imageSizeFromBase64(
  b64: string,
  mimeType: string,
): ImageSize | null {
  const bytes = decodeHeader(b64);
  if (!bytes) return null;
  switch (mimeType) {
    case "image/png":
      return pngSize(bytes);
    case "image/jpeg":
      return jpegSize(bytes);
    case "image/gif":
      return gifSize(bytes);
    case "image/webp":
      return webpSize(bytes);
    default:
      return null;
  }
}
