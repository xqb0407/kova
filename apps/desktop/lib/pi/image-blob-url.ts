"use client";

/**
 * data URL → Blob URL。
 *
 * 动机（真机实测，见 ~/Library/Logs/com.kova.assistant.dev/<日期>/web.log 的
 * `[perf]` 行）：一次带出图的任务里，DOM 上驻留着 15 张内联图、合计 **6.5MB**
 * base64 —— data URL 直接挂在 `img.src` 上，实测 fps 6.0、单帧 345ms。base64 比
 * 原始字节大 1/3，且整串以属性形式留在 DOM 里（内存、属性处理、每次 style/layout
 * 都按它算）。换成 Blob URL 后 DOM 只留一个短字符串，字节以二进制只驻留一份。
 *
 * 缓存按**内容指纹**（长度 + 首/中/尾各采样一段的哈希）而不是按完整字符串：
 * 用完整串做键等于把 base64 又留在 Map 里，省不下内存。采样三段 4KB 的碰撞概率
 * 对真实图片可忽略；万一日后出现极相似的长图误命中，症状是显示错图——若担心，
 * 可改成对完整串做一次 SHA-1（代价是首帧要等异步哈希）。
 *
 * 注意：这是渲染期可调用的幂等缓存（同一 src 只会转一次），不 revoke 已用的
 * URL 直到被 LRU 淘汰——已挂到 img 上的 URL 中途 revoke 会让图裂。
 */

/** 最多缓存多少张：长会话里避免对象 URL 无限积累 */
const MAX_ENTRIES = 300;

/** 指纹 → objectURL */
const cache = new Map<string, string>();

/** FNV-1a：对 8KB 片段够快也够散 */
const fnv1a = (s: string, seed = 0x811c9dc5): number => {
  let h = seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

const SAMPLE = 4096;

const fingerprint = (dataUrl: string): string => {
  const n = dataUrl.length;
  const mid = Math.max(0, (n >> 1) - (SAMPLE >> 1));
  return [
    n,
    fnv1a(dataUrl.slice(0, SAMPLE)),
    fnv1a(dataUrl.slice(mid, mid + SAMPLE)),
    fnv1a(dataUrl.slice(-SAMPLE)),
  ].join(":");
};

const dataUrlToBlob = (dataUrl: string): Blob | null => {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const header = dataUrl.slice(0, comma);
  if (!/;base64/i.test(header)) return null;
  const mime = /data:([^;,]+)/.exec(header)?.[1] ?? "application/octet-stream";
  try {
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
};

/**
 * 把内联 data URL 换成 Blob URL（同步、幂等、有缓存）；不是 data URL 或转换失败
 * 时**原样返回**——绝不因为优化而不显示图。
 */
export const blobUrlFor = (src: string): string => {
  if (!src.startsWith("data:")) return src;
  const key = fingerprint(src);
  const hit = cache.get(key);
  if (hit) return hit;
  const blob = dataUrlToBlob(src);
  if (!blob) return src;
  const url = URL.createObjectURL(blob);
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      const stale = cache.get(oldest);
      if (stale) URL.revokeObjectURL(stale);
      cache.delete(oldest);
    }
  }
  cache.set(key, url);
  return url;
};

/* ------------------------------- 缩略图 ------------------------------- */

/**
 * 瓦片的缩略图。
 *
 * 为什么必须做：瓦片只显示一两百像素，却在解码/绘制**全尺寸**原图——实测一次
 * 带图任务的绘制段 258ms、fps 9-18，而 WebKit 的图片解码多数在主线程上（这正是
 * 同一套代码在 Chrome 不卡、在桌面端卡的根因）。把瓦片的源换成缩略图，绘制像素
 * 量差上百倍；解码那一次也用 createImageBitmap 挪到主线程外，且全会话只做一次。
 *
 * 失败一律退回原图（绝不因为优化而不显示图）。
 */
const THUMB_MAX_PX = 384;
const thumbs = new Map<string, string>();
const thumbJobs = new Map<string, Promise<string | undefined>>();

/** 命中缓存的缩略图；没有返回 undefined */
export const getThumb = (src: string): string | undefined => thumbs.get(fingerprint(src));

/**
 * 生成（或复用）缩略图，返回缩略图 URL；不适用/失败返回 undefined。
 * 幂等：同一张图并发调用只会跑一次任务。
 */
export const ensureThumb = (src: string): Promise<string | undefined> => {
  if (!src.startsWith("data:") && !src.startsWith("blob:")) {
    return Promise.resolve(undefined);
  }
  const key = fingerprint(src);
  const cached = thumbs.get(key);
  if (cached) return Promise.resolve(cached);
  const running = thumbJobs.get(key);
  if (running) return running;

  const job = (async () => {
    try {
      const blob = src.startsWith("blob:")
        ? await (await fetch(src)).blob()
        : dataUrlToBlob(src);
      if (!blob) return undefined;
      // createImageBitmap 的解码在实现上可离开主线程——这是整件事的关键
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, THUMB_MAX_PX / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        bitmap.close();
        return undefined;
      }
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      const out = await new Promise<Blob | null>((r) =>
        canvas.toBlob(r, "image/webp", 0.8),
      );
      if (!out) return undefined;
      const url = URL.createObjectURL(out);
      // 缩略图很小，上限放到比原图缓存更宽
      if (thumbs.size >= MAX_ENTRIES) {
        const oldest = thumbs.keys().next().value;
        if (oldest !== undefined) {
          const stale = thumbs.get(oldest);
          if (stale) URL.revokeObjectURL(stale);
          thumbs.delete(oldest);
        }
      }
      thumbs.set(key, url);
      return url;
    } catch {
      return undefined; // 失败退回原图
    } finally {
      thumbJobs.delete(key);
    }
  })();
  thumbJobs.set(key, job);
  return job;
};
