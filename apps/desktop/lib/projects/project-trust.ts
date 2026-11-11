"use client";

/**
 * 工作区文件夹信任记录：创建/编辑工作区把新文件夹交给 agent 之前，弹一次
 * 「信任此文件夹」确认（读取、编辑、运行命令、AGENTS/.kova 钩子都可能触发）。
 * 信任按规范化后的绝对路径记在 localStorage；同一文件夹再次作为工作区
 * （或附加目录）使用时不再重复打扰。
 */
import { isWindowsPlatform } from "@/lib/desktop-env";

const STORAGE_KEY = "project-trusted-folders.v1";

/** 只做展示级规范化：去首尾空白/尾部分隔符；Windows 大小写不敏感 */
function normalize(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/u, "");
  return isWindowsPlatform() ? trimmed.toLocaleLowerCase() : trimmed;
}

function storage(): Storage | null {
  try {
    return typeof globalThis.localStorage !== "undefined"
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

function readTrusted(): Set<string> {
  try {
    const store = storage();
    if (!store) return new Set();
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

export function isProjectFolderTrusted(path: string): boolean {
  const key = normalize(path);
  return key ? readTrusted().has(key) : true;
}

/** 返回其中尚未信任的文件夹（保持原顺序、保留原始路径用于展示） */
export function untrustedProjectFolders(paths: readonly string[]): string[] {
  const trusted = readTrusted();
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = normalize(path);
    if (!key || seen.has(key) || trusted.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function trustProjectFolders(paths: readonly string[]): void {
  try {
    const store = storage();
    if (!store) return;
    const trusted = readTrusted();
    for (const path of paths) {
      const key = normalize(path);
      if (key) trusted.add(key);
    }
    store.setItem(STORAGE_KEY, JSON.stringify([...trusted]));
  } catch {
    /* 配额/隐私模式：本次确认仍然生效（不阻断创建） */
  }
}
