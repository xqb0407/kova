"use client";

/**
 * 预览静帧提取器 —— 设置页卡片墙专用（previewFramePlan / loadPreviewFrame）。
 *
 * 卡片渲染**静态图**而不是动画（2026-11 用户决策：非动图渲染开销最小）：
 * 从 idle 行裁**第 0 帧**一张小图，运行时只是 `<img>`——零定时器、零帧推进、
 * 位图 ~0.2MB/张；点卡片应用后，内嵌/悬浮窗里照样能看到完整动画。
 *
 * 取材两级：
 * 1. **preview.webp**（库约定：图集缩微版，~50–300KB）：仅当 idle 行为契约默认
 *    0 行、且图片尺寸与清单网格一致时，按缩微比例裁 (0,0) 格——库宠物大多带
 *    这个文件，完全不碰大图；
 * 2. **整张图集**：`createImageBitmap` 一步解码+缩放到显示分辨率，裁 idle 首帧。
 *    缩放目标按**网格整数对齐**取整（columns×tw / rows×th），行/列边界在缩放后
 *    位图上仍是整数像素，裁剪零漂移。
 *
 * 两级都不可用（idle 非 atlas 形态的动图/static 宠、资源缺失、解码 API 缺失）
 * 返回 null，调用方回退整装 <Pet> 老路径。
 */

import type { PetAtlasGeometry } from "./types";
import { fetchPetBytes, fetchPetJson } from "./fetch-manifest";
import { resolvePetManifest } from "./manifest";

/** 图集路径的缩放/裁剪计划（纯函数，供测试）。 */
export interface PreviewFramePlan {
  /** 缩后单格宽（px）＝裁剪宽 */
  frameWidth: number;
  /** 缩后单格高（px）＝裁剪高 */
  frameHeight: number;
  /** 整图缩放目标宽（columns × frameWidth）：网格整数对齐，见文件头 */
  resizeWidth: number;
  /** 整图缩放目标高（rows × frameHeight） */
  resizeHeight: number;
  /** 缩放后位图上 idle 行的裁剪起点 y（row × frameHeight）；裁剪 x 恒为 0（第 0 帧） */
  cropY: number;
}

/**
 * 图集路径计划：目标格宽不放大（`frameTargetPx` 超过原格宽时取原值），格高按
 * 宽比推算并取整；缩放目标取「整图列行 × 缩后格尺寸」保证网格严格整数对齐
 *（对整图各缩各的列/行步长，而不是先缩完再按比例找行界）。
 */
export function previewFramePlan(
  geometry: PetAtlasGeometry,
  idleRow: number,
  frameTargetPx: number,
): PreviewFramePlan {
  const frameWidth = Math.max(1, Math.min(frameTargetPx, geometry.frameWidth));
  const frameHeight = Math.max(1, Math.round((geometry.frameHeight * frameWidth) / geometry.frameWidth));
  return {
    frameWidth,
    frameHeight,
    resizeWidth: geometry.columns * frameWidth,
    resizeHeight: geometry.rows * frameHeight,
    cropY: idleRow * frameHeight,
  };
}

/** preview.webp 的网格校验结果：缩微比例下的单格尺寸。 */
export interface MiniGrid {
  cellWidth: number;
  cellHeight: number;
}

/**
 * 校验一张图是否是清单网格的缩微版（preview.webp 约定），并给出单格尺寸。
 * 宽度定比例 `s = naturalWidth / (columns × frameWidth)`，高度按同比例复核
 * （±2% + 2px 容差，容忍重编码误差）；`s > 1`（比图集还大）视为不符合约定。
 * 校验失败返回 null——宁可回落大图路径，也不从对不上网格的图里裁出废帧。
 */
export function previewMiniGrid(
  naturalWidth: number,
  naturalHeight: number,
  geometry: PetAtlasGeometry,
): MiniGrid | null {
  if (naturalWidth <= 0 || naturalHeight <= 0) return null;
  const scale = naturalWidth / (geometry.columns * geometry.frameWidth);
  if (!(scale > 0) || scale > 1) return null;
  const cellWidth = Math.max(1, Math.round(geometry.frameWidth * scale));
  const cellHeight = Math.max(1, Math.round(geometry.frameHeight * scale));
  const expectedHeight = geometry.rows * cellHeight;
  const tolerance = Math.max(2, expectedHeight * 0.02);
  if (Math.abs(naturalHeight - expectedHeight) > tolerance) return null;
  return { cellWidth, cellHeight };
}

/** 裁一格 → webp blob → objectURL；blob 异常小视为整格透明（约定图缺帧）返回 null。 */
async function cropCellToUrl(bitmap: ImageBitmap, cellWidth: number, cellHeight: number): Promise<string | null> {
  const canvas = document.createElement("canvas");
  canvas.width = cellWidth;
  canvas.height = cellHeight;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.drawImage(bitmap, 0, 0, cellWidth, cellHeight, 0, 0, cellWidth, cellHeight);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
  if (blob === null || blob.size < 400) return null;
  return URL.createObjectURL(blob);
}

/** 缓存 key：清单地址 + 目标格宽（dpr 变化/显示尺寸不同 = 不同帧图）。 */

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();
/** LRU 上限：卡片全量滚过的宠物数一般 <20，溢出才淘汰（revoke objectURL） */
const CACHE_CAP = 32;

function touch(key: string, url: string): void {
  cache.delete(key);
  cache.set(key, url);
  while (cache.size > CACHE_CAP) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = cache.get(oldestKey);
    cache.delete(oldestKey);
    if (oldest !== undefined) URL.revokeObjectURL(oldest);
  }
}

/** 清空静帧缓存（重扫描/移除宠物后调用；进行中的加载结果仍会入缓存，无害）。 */
export function clearPreviewFrameCache(): void {
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
}

/**
 * 加载预览静帧：preview.webp 裁 (0,0) 格 → 回落整张图集裁 idle 首帧。
 * 成功返回图片 objectURL（缓存命中为同步 resolved）；不可用返回 null
 *（调用方回退整装 <Pet manifest={source}>）。
 */
export async function loadPreviewFrame(
  source: string,
  frameTargetPx: number,
): Promise<string | null> {
  const key = `${source}|${frameTargetPx}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    touch(key, cached);
    return cached;
  }
  const running = inflight.get(key);
  if (running !== undefined) return running;

  const task = (async (): Promise<string | null> => {
    try {
      const base = source.replace(/[^/]*$/, "");
      const { json } = await fetchPetJson(source);
      const resolved = resolvePetManifest(json, base);
      if (!resolved.ok) return null;
      const pet = resolved.pet;
      const idle = pet.clips.idle;
      // idle 非 atlas（APNG/动图/static 宠）：素材本来就小，回退整装路径
      if (idle === undefined || idle.kind !== "atlas" || pet.geometry === null || pet.spritesheetUrl === null) {
        return null;
      }
      const geometry = pet.geometry;

      // ---- 一级：preview.webp 缩微图（仅契约默认 idle 行 0 才能保证 (0,0) 是 idle 首帧）----
      if (idle.row === 0) {
        try {
          const { bytes, mime } = await fetchPetBytes(`${base}preview.webp`);
          const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
          const grid = previewMiniGrid(bitmap.width, bitmap.height, geometry);
          const url = grid !== null ? await cropCellToUrl(bitmap, grid.cellWidth, grid.cellHeight) : null;
          bitmap.close();
          if (url !== null) {
            touch(key, url);
            return url;
          }
        } catch {
          // preview 缺失/不是约定网格 → 落到图集路径
        }
      }

      // ---- 二级：整张图集解码+缩放后裁 idle 首帧 ----
      const plan = previewFramePlan(geometry, idle.row, frameTargetPx);
      const { bytes, mime } = await fetchPetBytes(pet.spritesheetUrl);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }), {
        resizeWidth: plan.resizeWidth,
        resizeHeight: plan.resizeHeight,
        resizeQuality: "high",
      });
      const canvas = document.createElement("canvas");
      canvas.width = plan.frameWidth;
      canvas.height = plan.frameHeight;
      const ctx = canvas.getContext("2d");
      let url: string | null = null;
      if (ctx !== null) {
        ctx.drawImage(bitmap, 0, plan.cropY, plan.frameWidth, plan.frameHeight, 0, 0, plan.frameWidth, plan.frameHeight);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
        if (blob !== null && blob.size > 0) url = URL.createObjectURL(blob);
      }
      bitmap.close();
      if (url === null) return null;
      touch(key, url);
      return url;
    } catch {
      // 解码 API 缺失 / 资源不可达 / webp 编码失败：一律回退整装路径
      return null;
    }
  })();

  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}
