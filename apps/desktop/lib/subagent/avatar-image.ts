"use client";

/**
 * 上传图片 → 128px 方形 data URL（子智能体头像专用）。
 *
 * 不引 React；用 Image + canvas 在渲染进程里就地完成「居中裁方 + 缩放 + 重编码」，
 * 产物（几十 KB 的 WebP/PNG data URL）直接进 kv，不需要文件服务或临时目录——
 * 这也是头像能覆盖内置/插件只读定义的原因：数据跟着清单走，不落盘。
 *
 * GIF 只取首帧（canvas 无动画帧）；SVG 经 <img> 栅格化后同样落成位图。
 * 重编码优先 WebP（Chromium 下体积最小且保留透明）；Safari 不支持时会自动
 * 回落 PNG——toDataURL 对不认识的 mime 静默改产 PNG，这里靠前缀探测即可。
 */
import {
  SUBAGENT_AVATAR_SIZE,
  SUBAGENT_AVATAR_SOURCE_MAX_BYTES,
  subagentAvatarValidationError,
} from "./avatar";

const SOURCE_MIME = /^(image\/(?:png|jpeg|webp|gif|apng|svg\+xml))$/i;

/** 加载失败的报错文案统一走这里，调用方直接展示 */
export async function fileToSubagentAvatarDataUrl(file: File): Promise<string> {
  if (!SOURCE_MIME.test(file.type)) {
    throw new Error("仅支持 PNG / JPEG / WebP / GIF / SVG 图片");
  }
  if (file.size > SUBAGENT_AVATAR_SOURCE_MAX_BYTES) {
    throw new Error("图片太大（上限 8 MB）");
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    return drawToDataUrl(image);
  } catch {
    throw new Error("图片读取失败，文件可能已损坏");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () => reject(new Error("image load failed")));
    image.src = src;
  });
}

/** 居中裁方 + 缩到目标边长（cover 语义：短边贴满，长边裁掉） */
function drawToDataUrl(image: HTMLImageElement): string {
  const size = SUBAGENT_AVATAR_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  const source = image.naturalWidth > 0 && image.naturalHeight > 0
    ? { w: image.naturalWidth, h: image.naturalHeight }
    : { w: size, h: size };
  const side = Math.min(source.w, source.h);
  const sx = (source.w - side) / 2;
  const sy = (source.h - side) / 2;
  ctx.drawImage(image, sx, sy, side, side, 0, 0, size, size);
  const dataUrl = canvas.toDataURL("image/webp", 0.85);
  // toDataURL 对不支持的 mime 会静默回落 PNG；两种产物校验规则都认
  const check = subagentAvatarValidationError(dataUrl);
  if (check) throw new Error(check);
  return dataUrl;
}
