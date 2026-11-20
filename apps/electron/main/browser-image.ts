/**
 * 图片头解析（browser 截图路径专用，纯函数、无 electron 依赖）。
 *
 * 为什么不用 `nativeImage.createFromBuffer(...).getSize()`：那会在**主进程主线程**
 * 上把整张图解码成位图，只为了读两个整数。`browser_shot` 全页截图最高可到
 * 16MP，一次同步解码就是几十到上百毫秒的主线程停顿；60fps WebGL 页面下 AI 连续
 * 截图时，停顿会直接压到聊天流式更新上。PNG/JPEG 的宽高都在文件头，扫前 64KB
 * 就够，代价是 O(头长度)。
 *
 * 解析不出来（未知格式/头被截断）返回 null，调用方回退 nativeImage 兜底。
 */

export interface ImageSize {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngSize(buf: Uint8Array): ImageSize | null {
  if (buf.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (buf[i] !== PNG_SIGNATURE[i]) return null;
  }
  // 8: chunk length, 12: "IHDR", 16..19 width, 20..23 height（均大端）
  if (buf[12] !== 0x49 || buf[13] !== 0x48 || buf[14] !== 0x44 || buf[15] !== 0x52) {
    return null;
  }
  const width = ((buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19]) >>> 0;
  const height = ((buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23]) >>> 0;
  if (width === 0 || height === 0) return null;
  return { width, height };
}

/** JPEG 的 SOF0/SOF1/SOF2/SOF3/SOF5..SOF15（排除 DHT=C4、JPG=C8、DAC=CC） */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegSize(buf: Uint8Array): ImageSize | null {
  if (buf.length < 4) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  // 上限 64KB 由调用方保证；这里再兜一层，防止异常数据把循环拖长
  const limit = Math.min(buf.length, 64 * 1024);
  while (off + 9 < limit) {
    if (buf[off] !== 0xff) {
      off += 1;
      continue;
    }
    let marker = buf[off + 1];
    // 填充字节（FF FF ...）与无长度段
    if (marker === 0xff) {
      off += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    // 进入压缩数据：SOF 只可能在此之前出现
    if (marker === 0xda || marker === 0xd9) return null;
    const len = (buf[off + 2] << 8) | buf[off + 3];
    if (len < 2) return null;
    if (isStartOfFrame(marker)) {
      // payload: precision(1) height(2) width(2) ...
      const height = (buf[off + 5] << 8) | buf[off + 6];
      const width = (buf[off + 7] << 8) | buf[off + 8];
      if (width === 0 || height === 0) return null;
      return { width, height };
    }
    off += 2 + len;
  }
  return null;
}

/** 从图片字节头读宽高；只认 PNG/JPEG（截图只会产出这两种）。 */
export function imageSizeFromBuffer(buf: Uint8Array): ImageSize | null {
  return pngSize(buf) ?? jpegSize(buf);
}

/**
 * base64 解码后的字节数（不真正解码）。用来给截图载荷做预算判断，避免为了
 * 读一个长度在主线程上 `Buffer.from(base64)` 复制整张图。
 */
export function base64DecodedBytes(base64: string): number {
  if (base64.length === 0) return 0;
  let padding = 0;
  if (base64.endsWith("==")) padding = 2;
  else if (base64.endsWith("=")) padding = 1;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}
