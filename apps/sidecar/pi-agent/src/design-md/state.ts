/**
 * 「最近一次使用」的全局兜底（SQLite kv `pi.design_theme`）：
 * 会话级当前主题的事实源在会话偏好列（sessions.design_theme，NULL = 从未选过），
 * 本模块只做两件事——每次 set 时顺手记一份最近值；新会话/无偏好列旧会话恢复时，
 * 取这份最近值作初始（同 pi.mode「新会话初始模式取最近一次」的语义）。
 * null（不使用主题）也是一个合法记忆值。
 */
import { kvGet, kvSet } from "../storage/hostdb";
import { logErr } from "../log";
import { normalizeThemeRef, type ThemeRef } from "./store";

export const DESIGN_THEME_KV_KEY = "pi.design_theme";

let lastUsed: ThemeRef | null = null;

/** 启动恢复：kv JSON 宽松规整；失败保持 null（不阻断启动） */
export async function initDesignThemeState(): Promise<void> {
  try {
    const row = await kvGet(DESIGN_THEME_KV_KEY);
    if (row?.value) {
      lastUsed = normalizeThemeRef(JSON.parse(row.value));
    }
  } catch (err) {
    logErr("design-md: last-used load failed:", err);
  }
}

export function getLastUsedDesignTheme(): ThemeRef | null {
  return lastUsed;
}

/** 主题偏好列序列化：ref → JSON 字符串；null（不使用主题）→ ""（显式值，区别于 NULL 的"从未设置"） */
export function encodeThemeColumn(ref: ThemeRef | null): string {
  return ref ? JSON.stringify(ref) : "";
}

/** 主题偏好列解析：NULL（从未设置）→ undefined（调用方回落最近使用）；""/损坏 → null（显式不使用） */
export function decodeThemeColumn(raw: string | null): ThemeRef | null | undefined {
  if (raw === null) return undefined;
  if (!raw) return null;
  try {
    return normalizeThemeRef(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 记一份最近值（set_design_theme 成功后调用；持久化失败仅日志） */
export async function setLastUsedDesignTheme(ref: ThemeRef | null): Promise<void> {
  lastUsed = ref;
  try {
    await kvSet(DESIGN_THEME_KV_KEY, JSON.stringify(ref));
  } catch (err) {
    logErr("design-md: last-used persist failed:", err);
  }
}

/** 测试辅助：清内存值（模拟进程重启起点） */
export function resetDesignThemeStateForTest(): void {
  lastUsed = null;
}
