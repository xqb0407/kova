/**
 * 桌宠模块 · 清单解析归一化（纯函数，无 React / DOM）。
 *
 * 吃两种写法：
 * - 我们的 `pet.json` 超集：`spritesheet` + 几何字段；`motions` 可整体省略（全落默认行表），
 *   也可以逐动作写资源路径（APNG / 动图 WebP）或行定义覆盖；
 * - Codex 官方包：`spritesheetPath` + `spriteVersionNumber`，原样识别。
 *
 * 动作资源按扩展名分派 clip 形态：`.apng/.webp/.gif` → `animated`（`<img>` 原生播放），
 * 其余图片扩展 → `static`；`.webm/.mov/…` 视频扩展名明确报错（视频不进 v1，见 types.ts）。
 *
 * 入参是用户数据，解析**不抛异常**：返回 `{ ok: true, pet } | { ok: false, error }`。
 */

import type { PetClip, PetManifest, PetMotion, PetMotionSpec, ResolvedPet } from "./types";
import {
  ATLAS_ROWS,
  PET_ATLAS_COLUMNS,
  PET_ATLAS_ROWS_V1,
  PET_ATLAS_ROWS_V2,
  PET_FRAME_HEIGHT,
  PET_FRAME_WIDTH,
} from "./atlas";
import { PET_MOTIONS } from "./types";

/** 视频扩展名：解析层直接报错，不静默当成图片渲染。 */
const VIDEO_EXTS = new Set(["webm", "mov", "mp4", "m4v", "avi", "mkv", "ogv"]);

/** 浏览器 `<img>` 能原生连播的动图扩展名。 */
const ANIMATED_IMAGE_EXTS = new Set(["apng", "gif", "webp"]);

/** 单帧图片扩展名（动图形态里的回落形态）。 */
const STATIC_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "avif", "bmp", "ico", "svg"]);

export type PetResolveResult = { ok: true; pet: ResolvedPet } | { ok: false; error: string };

function extOf(src: string): string {
  const dot = src.lastIndexOf(".");
  if (dot < 0) return "";
  const q = src.indexOf("?", dot);
  return src.slice(dot + 1, q < 0 ? undefined : q).toLowerCase();
}

/** 相对地址按 `baseUrl` 拼；绝对地址（协议头或根相对）原样返回。 */
export function resolvePetUrl(src: string, baseUrl?: string): string {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(src)) return src;
  if (!baseUrl) return src;
  return `${baseUrl.replace(/\/+$/, "")}/${src.replace(/^\/+/, "")}`;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 动作 spec → clip 的公共入口；`fallback` 提供图集缺省行。 */
function clipForSpec(
  spec: PetMotionSpec,
  motion: PetMotion,
  baseUrl: string | undefined,
  atlasSrc: string | null,
): PetClip | { error: string } {
  if (typeof spec === "number") {
    if (!atlasSrc) return { error: `动作 ${motion} 用了行号写法，但清单没有 spritesheet` };
    const base = ATLAS_ROWS[motion];
    return {
      kind: "atlas",
      src: atlasSrc,
      row: Math.max(0, Math.floor(spec)),
      frames: base.frames,
      interval: base.interval,
      durations: base.durations,
      loop: base.loop,
    };
  }

  if (typeof spec === "string") {
    return clipForSrc(spec, motion, baseUrl);
  }

  const src = typeof spec.src === "string" ? spec.src : undefined;
  if (src !== undefined) {
    const clip = clipForSrc(src, motion, baseUrl);
    if ("error" in clip) return clip;
    // 对象写法只允许覆盖循环语义（只对 animated 有意义；static 单帧没有循环概念）
    if (spec.loop === undefined || clip.kind !== "animated") return clip;
    return { ...clip, loop: spec.loop };
  }

  if (!atlasSrc) return { error: `动作 ${motion} 的对象写法缺少 src（清单也没有 spritesheet）` };
  const base = ATLAS_ROWS[motion];
  const row = isFiniteNumber(spec.row) ? Math.max(0, Math.floor(spec.row)) : base.row;
  const frames = isFiniteNumber(spec.frames) && spec.frames >= 1 ? Math.floor(spec.frames) : base.frames;
  const interval = isFiniteNumber(spec.interval) && spec.interval > 0 ? spec.interval : base.interval;
  const durations = Array.isArray(spec.durations) && spec.durations.every((d) => isFiniteNumber(d) && d > 0)
    ? spec.durations
    : base.durations;
  return {
    kind: "atlas",
    src: atlasSrc,
    row,
    frames,
    interval,
    durations,
    loop: spec.loop ?? base.loop,
  };
}

function clipForSrc(src: string, motion: PetMotion, baseUrl: string | undefined): PetClip | { error: string } {
  const ext = extOf(src);
  if (VIDEO_EXTS.has(ext)) {
    return { error: `动作 ${motion} 指向视频（.${ext}）：视频通道暂未支持，请改用图集或动图` };
  }
  const url = resolvePetUrl(src, baseUrl);
  if (ANIMATED_IMAGE_EXTS.has(ext)) return { kind: "animated", src: url, loop: true };
  if (STATIC_IMAGE_EXTS.has(ext)) return { kind: "static", src: url };
  return { error: `动作 ${motion} 的资源扩展名不认识：${src}` };
}

/**
 * 解析并归一化清单。`baseUrl` 用于把 `motions` 里的相对资源路径拼成可加载地址
 *（图集地址在组件层单独解析，这里存原始值，便于宿主换缓存通道）。
 */
export function resolvePetManifest(raw: unknown, baseUrl?: string): PetResolveResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "pet 清单必须是 JSON 对象" };
  }
  const m = raw as PetManifest;

  // ---- 图集几何（有 spritesheet 才有意义）----
  const spritesheetRaw = typeof m.spritesheet === "string"
    ? m.spritesheet
    : typeof m.spritesheetPath === "string"
    ? m.spritesheetPath
    : undefined;
  let geometry: ResolvedPet["geometry"] = null;
  let atlasSrc: string | null = null;
  if (spritesheetRaw !== undefined) {
    const spriteVersion = m.spriteVersionNumber;
    const rows = isFiniteNumber(m.rows) && m.rows >= 1
      ? Math.floor(m.rows)
      : spriteVersion === 2
      ? PET_ATLAS_ROWS_V2
      : PET_ATLAS_ROWS_V1;
    geometry = {
      columns: isFiniteNumber(m.columns) && m.columns >= 1 ? Math.floor(m.columns) : PET_ATLAS_COLUMNS,
      rows,
      frameWidth: isFiniteNumber(m.frameWidth) && m.frameWidth >= 1 ? Math.floor(m.frameWidth) : PET_FRAME_WIDTH,
      frameHeight: isFiniteNumber(m.frameHeight) && m.frameHeight >= 1 ? Math.floor(m.frameHeight) : PET_FRAME_HEIGHT,
    };
    atlasSrc = resolvePetUrl(spritesheetRaw, baseUrl);
  }

  // ---- 动作 → clip ----
  const clips: Partial<Record<PetMotion, PetClip>> = {};
  const specs = (typeof m.motions === "object" && m.motions !== null ? m.motions : {}) as Partial<
    Record<PetMotion, PetMotionSpec>
  >;
  for (const motion of PET_MOTIONS) {
    const spec = specs[motion];
    if (spec !== undefined) {
      const clip = clipForSpec(spec, motion, baseUrl, atlasSrc);
      if ("error" in clip) return { ok: false, error: clip.error };
      clips[motion] = clip;
      continue;
    }
    if (atlasSrc !== null) {
      // 图集模式：没写 = 落契约默认行表
      const base = ATLAS_ROWS[motion];
      clips[motion] = { kind: "atlas", src: atlasSrc, ...base };
    }
  }

  if (Object.keys(clips).length === 0) {
    return { ok: false, error: "清单里既没有 spritesheet 也没有可用的 motions" };
  }

  return {
    ok: true,
    pet: {
      meta: { id: m.id, displayName: m.displayName, description: m.description },
      geometry,
      spritesheetUrl: atlasSrc,
      clips,
    },
  };
}

/** 取动作的 clip；动作缺失回落 idle，再缺失返回 null（调用方决定显示什么）。 */
export function clipForMotion(pet: ResolvedPet, motion: PetMotion): PetClip | null {
  return pet.clips[motion] ?? pet.clips.idle ?? null;
}
