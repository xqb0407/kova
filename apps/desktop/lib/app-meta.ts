"use client";

import { getAppVersion, isTauri } from "@/lib/tauri";

/**
 * 崩溃/卡顿报告里的应用指纹。
 *
 * 拿到一堆堆栈却不知道对应哪个 build 是没法排查的，所以每次上报都带上
 * 版本与平台。这里做进程内缓存：版本只能异步取（Tauri 调 getVersion），
 * 而上报路径（错误边界的 componentDidCatch、反馈页预填）都在渲染期，
 * 必须同步可读。AppRuntimeProvider 挂载时预热，绝大多数时候早已就绪。
 */

let version: string | null = null;
let platform: string | null = null;
let primed = false;

/** 与 tauri.conf.json 的 productName 对齐 */
const APP_NAME = "扣瓦";

function detectPlatform(): string {
  if (typeof navigator === "undefined") return "unknown";
  // 桌面包在 Tauri webview 里，UA 带平台；远程网页走真实浏览器 UA
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "unknown";
}

/** 挂载时调一次，把版本/平台填进缓存 */
export function primeAppMeta(): void {
  if (primed) return;
  primed = true;
  platform = detectPlatform();
  if (!isTauri()) return;
  void getAppVersion()
    .then((v) => {
      version = v ?? null;
    })
    .catch(() => {});
}

/** 同步读取应用指纹，形如 `扣瓦 0.1.0 / macOS`；版本未就绪时退化为 "unknown" */
export function appMetaLine(): string {
  // 平台是纯同步推导的，兜底顺手算上——万一 prime 没跑到（比如远程网页端
  // 的独立入口），报告里也不该平白丢一个能拿到的字段
  return `${APP_NAME} ${version ?? "unknown"} / ${platform ?? detectPlatform()}`;
}
