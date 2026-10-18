"use client";

/**
 * 本地文件 → `kova://file/<绝对路径>` URL。
 *
 * 用途：HTML 预览 iframe 的 src。此前用 srcDoc，文档基址是 about:srcdoc，
 * 页面里相对路径的图片/CSS/JS 全部解析失败（"加载不了静态图片"就是这个）；
 * 换成真实 URL 后基址就是文件自身的目录，相对资源自然能取到。
 *
 * 主进程侧只放行「当前 workspace / task-workspace / 资料库根」子树内真实存在
 * 的文件（fs-cmds.isTrustedFilePath），其余一律 403。
 */
import { isDesktop } from "@/lib/desktop-env";

export function localFileUrl(cwd: string, rel: string): string {
  const base = cwd.replace(/[\\/]+$/, "");
  const abs = rel ? `${base}/${rel}` : base;
  const posix = abs.replace(/\\/g, "/");
  const rooted = posix.startsWith("/") ? posix : `/${posix}`; // Windows: /C:/Users/…
  return `kova://file${rooted
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")}`;
}

/** 仅桌面壳可用（网页端没有 kova:// 协议） */
export function canUseLocalFileUrl(): boolean {
  return isDesktop();
}