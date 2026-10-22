"use client";

import { useSyncExternalStore } from "react";
import { isDesktop } from "@/lib/desktop-env";
import {
  libraryGetRoot,
  librarySetRoot,
  type LibraryRootInfo,
} from "./library-files";

/**
 * 资料库根的渲染层镜像：资料库页与设置行共用一份。改位置后一处 emit、
 * 处处跟随（页面重新以新根为 cwd 拉树）。初始值异步解析（appDataDir 只有
 * 主进程知道），未就绪时消费方按 null 处理（空树/加载占位）。
 */

let info: LibraryRootInfo | null = null;
let inflight: Promise<LibraryRootInfo | null> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useLibraryRoot(): LibraryRootInfo | null {
  return useSyncExternalStore(
    subscribe,
    () => info,
    () => null,
  );
}

/** 同步读取当前根信息（不发请求）：模块级镜像在 bundle 加载即解析一次。
 *  搜索/引用构造这类非 hook 场景用；未就绪返回 null，调用方自行降级。 */
export function getLibraryRootInfo(): LibraryRootInfo | null {
  return info;
}

/** 拉取/刷新根信息（并发调用共用同一在途请求） */
export function refreshLibraryRoot(): Promise<LibraryRootInfo | null> {
  if (!isDesktop()) return Promise.resolve(null);
  inflight ??= libraryGetRoot()
    .then((r) => {
      info = r;
      emit();
      return r;
    })
    .catch(() => info)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 改资料库位置：成功返回 null，失败返回错误短码（设置行 toast 用） */
export async function changeLibraryRoot(dir: string): Promise<string | null> {
  try {
    const r = await librarySetRoot(dir);
    info = {
      root: r.root,
      defaultRoot: info?.defaultRoot ?? r.root,
      isDefault: r.root === (info?.defaultRoot ?? r.root),
      exists: true,
    };
    emit();
    void refreshLibraryRoot();
    return null;
  } catch (err) {
    return typeof err === "string" ? err : "unknown";
  }
}

// client bundle 加载即解析一次（SSR 端 isDesktop() 为 false，直接跳过）
if (isDesktop()) void refreshLibraryRoot();