/**
 * 项目自定义显示名（侧栏项目组 / 工作区胶囊 / 顶栏徽章共用）。
 *
 * 项目身份仍是 cwd；这里只给用户一个比目录名更顺口的名字。存储按 cwd 落
 * localStorage，与项目外观（project-appearance）同款纪律：
 * - 模块级 Map + useSyncExternalStore，只让 primitive（版本号）参与订阅；
 * - 读入时逐条校验，坏数据静默丢弃；
 * - LRU 上限，避免项目数增长后无限膨胀。
 *
 * 未设置时调用方回退 `pathBasename(cwd)`，不在这里兜底，避免存储层依赖 UI。
 */
import { useSyncExternalStore } from "react";
import { pathBasename } from "@/lib/workspace/path";

/** 名称长度上限：足够容纳中文项目名，也不会把侧栏撑爆 */
export const PROJECT_NAME_MAX_CHARS = 60;
const STORAGE_KEY = "project-display-name-v1";
/** 记住多少个项目的名字（LRU）：与项目外观同一上限 */
const MAX_PROJECTS = 200;

/**
 * 存储/水合时的收口：trim、去控制字符、截断超长；空串返回 null（= 未设置）。
 * 控制字符会让侧栏行高/可访问名异常，直接剔除而不是原样展示。
 */
export function normalizeProjectName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim()
    .slice(0, PROJECT_NAME_MAX_CHARS);
  return cleaned.length > 0 ? cleaned : null;
}

/** cwd → 自定义名（Map 迭代序 = 写入序，超限从头淘汰） */
let byProject = new Map<string, string>();
let hydrated = false;
let version = 0;
const listeners = new Set<() => void>();

const notify = () => {
  version += 1;
  for (const listener of listeners) listener();
};

function readStorage(): Record<string, unknown> | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function ensureHydrated(): void {
  if (hydrated) return;
  hydrated = true;
  const stored = readStorage();
  if (!stored) return;
  for (const [cwd, value] of Object.entries(stored).slice(-MAX_PROJECTS)) {
    if (!cwd) continue;
    const name = normalizeProjectName(value);
    if (name) byProject.set(cwd, name);
  }
}

function persist(): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries(byProject)),
    );
  } catch {
    /* 存储不可用（隐私模式/配额）：内存态照常工作 */
  }
}

/** 项目自定义名；未设置返回 null（调用方回退目录名） */
export function projectDisplayNameFor(cwd: string): string | null {
  if (!cwd) return null;
  ensureHydrated();
  return byProject.get(cwd) ?? null;
}

/** 覆盖设置项目显示名；传 null / 空串清除 */
export function setProjectDisplayName(cwd: string, name: string | null): void {
  if (!cwd) return;
  ensureHydrated();
  const next = normalizeProjectName(name);
  const prev = byProject.get(cwd) ?? null;
  if (prev === next) return;
  byProject.delete(cwd);
  if (next !== null) {
    byProject.set(cwd, next);
    if (byProject.size > MAX_PROJECTS) {
      for (const key of byProject.keys()) {
        if (byProject.size <= MAX_PROJECTS) break;
        byProject.delete(key);
      }
    }
  }
  persist();
  notify();
}

/** 显示名；未设置回退目录最后一段 */
export function projectLabelFor(cwd: string): string {
  if (!cwd) return "";
  return projectDisplayNameFor(cwd) ?? pathBasename(cwd);
}

/** 订阅"任何项目显示名变了"（侧栏整表重渲用，模式同项目外观） */
export function useProjectDisplayNamesVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => version,
    () => 0,
  );
}

/** React 组件直接取项目显示名；订阅版本号保证改名后立即刷新 */
export function useProjectLabel(cwd: string | null | undefined): string | null {
  useProjectDisplayNamesVersion();
  if (!cwd) return null;
  return projectLabelFor(cwd);
}

/** 测试缝：用例之间隔离（清内存态与 hydration 标记） */
export function resetProjectDisplayNamesForTest(): void {
  byProject = new Map();
  hydrated = false;
  version = 0;
  listeners.clear();
}
