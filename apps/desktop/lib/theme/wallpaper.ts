"use client";

/**
 * 壁纸存储与图像处理。
 *
 * 存储放在 localStorage（与项目图标同一套做法）：
 * - ui.wallpaper.image：裁剪后的展示图，首帧预绘制直接读它，避免白闪
 * - ui.wallpaper.source：裁剪前的压缩原图，供「调整构图」再次进入
 * 图片先缩到长边 ≤2560/3200 再编码，避免撑爆 5MB 配额；写入失败时由
 * 调用方降级或提示。
 */
import { useSyncExternalStore } from "react";
import type { SourceRect } from "./crop";

export const WALLPAPER_IMAGE_KEY = "ui.wallpaper.image";
export const WALLPAPER_SOURCE_KEY = "ui.wallpaper.source";

/** 壁纸图变更通知：设置页预览、跨组件导入/重置共用 */
const imageListeners = new Set<() => void>();

function notifyImageChange(): void {
  for (const listener of imageListeners) listener();
}

function subscribeWallpaperImage(listener: () => void): () => void {
  imageListeners.add(listener);
  return () => {
    imageListeners.delete(listener);
  };
}

/**
 * 当前展示图（水合安全）：服务端快照恒为 null，水合后自动切到本地图片，
 * 避免「服务端没有 localStorage / 客户端有图」导致的 hydration mismatch。
 */
export function useWallpaperImage(): string | null {
  return useSyncExternalStore(
    subscribeWallpaperImage,
    getWallpaperImage,
    () => null,
  );
}

const DATA_IMAGE_RE =
  /^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=]+$/iu;

/** 长边上限：展示图与可再编辑的原图 */
const DISPLAY_MAX_EDGE = 2560;
const SOURCE_MAX_EDGE = 3200;
const ENCODE_QUALITY = 0.86;

export function isWallpaperDataUrl(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    raw.length > 0 &&
    raw.length <= 8_000_000 &&
    DATA_IMAGE_RE.test(raw)
  );
}

function readKey(key: string): string | null {
  try {
    const raw = window.localStorage.getItem(key);
    return isWallpaperDataUrl(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** 展示图内存缓存：dataURL 可能有几百 KB，避免每次渲染都同步读 localStorage */
let imageCache: string | null | undefined;

export function getWallpaperImage(): string | null {
  if (imageCache === undefined) imageCache = readKey(WALLPAPER_IMAGE_KEY);
  return imageCache;
}

export function getWallpaperSource(): string | null {
  return readKey(WALLPAPER_SOURCE_KEY);
}

/** 别的窗口改了壁纸：丢掉内存缓存并通知订阅者重新取图 */
export function invalidateWallpaperImageCache(): void {
  imageCache = undefined;
  notifyImageChange();
}

function writeKey(key: string, dataUrl: string): boolean {
  if (!isWallpaperDataUrl(dataUrl)) return false;
  try {
    window.localStorage.setItem(key, dataUrl);
    return true;
  } catch {
    return false;
  }
}

/** 保存展示图；失败（配额）返回 false，由调用方提示 */
export function saveWallpaperImage(dataUrl: string): boolean {
  const ok = writeKey(WALLPAPER_IMAGE_KEY, dataUrl);
  if (ok) {
    imageCache = dataUrl;
    notifyImageChange();
  }
  return ok;
}

/** 保存可再编辑原图；失败不致命（只是不能重新构图） */
export function saveWallpaperSource(dataUrl: string): boolean {
  return writeKey(WALLPAPER_SOURCE_KEY, dataUrl);
}

/**
 * 丢弃旧原图（只删 source，不影响展示图）。
 * 导入主题时只带裁剪后的展示图：必须清掉父主题留下的旧原图，否则
 * 「调整构图」会拿旧图重裁，看到的是另一张壁纸。
 */
export function clearWallpaperSource(): void {
  try {
    window.localStorage.removeItem(WALLPAPER_SOURCE_KEY);
  } catch {
    // 存储不可用时没有可清的原图
  }
}

export function clearWallpaperImages(): void {
  try {
    window.localStorage.removeItem(WALLPAPER_IMAGE_KEY);
    window.localStorage.removeItem(WALLPAPER_SOURCE_KEY);
  } catch {
    // 存储不可用时无图可清
  }
  imageCache = null;
  notifyImageChange();
}

/** 文件 → ImageBitmap（Chromium 默认按 EXIF 方向解码） */
export async function fileToBitmap(file: File): Promise<ImageBitmap> {
  return createImageBitmap(file);
}

/** 按源图矩形裁剪并缩放编码；rect 省略时整图缩放 */
export function bitmapToDataUrl(
  bitmap: ImageBitmap,
  rect: SourceRect | null,
  maxEdge: number = DISPLAY_MAX_EDGE,
): string {
  const sw = rect?.sw ?? bitmap.width;
  const sh = rect?.sh ?? bitmap.height;
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    bitmap,
    rect?.sx ?? 0,
    rect?.sy ?? 0,
    sw,
    sh,
    0,
    0,
    width,
    height,
  );
  const webp = canvas.toDataURL("image/webp", ENCODE_QUALITY);
  if (isWallpaperDataUrl(webp) && webp.startsWith("data:image/webp")) return webp;
  return canvas.toDataURL("image/jpeg", ENCODE_QUALITY);
}

/** 压缩原图：长边 ≤ SOURCE_MAX_EDGE，供后续重新构图 */
export function bitmapToSource(bitmap: ImageBitmap): string {
  return bitmapToDataUrl(bitmap, null, SOURCE_MAX_EDGE);
}

/** dataURL → ImageBitmap（导入/重新编辑时使用） */
export async function dataUrlToBitmap(dataUrl: string): Promise<ImageBitmap> {
  const res = await fetch(dataUrl);
  return createImageBitmap(await res.blob());
}
