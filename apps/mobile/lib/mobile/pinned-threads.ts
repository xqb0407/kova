/**
 * 会话置顶表（本机偏好）。
 *
 * 为什么存本地而不是走 sidecar：Pi 的会话元数据（list_sessions）没有
 * pinned 字段，updateCustom 也只活到下次 reload 为止。置顶是"我这台设备
 * 上想先看到哪几条"的偏好，和模型/思考档位同类——落 syncStorage 的
 * pi.* 键，重启即恢复，不污染服务端会话数据。
 */
import { useSyncExternalStore } from "react";
import { syncStorage } from "./storage";

const KEY = "pi.pinned-threads";

const read = (): string[] => {
  try {
    const raw = syncStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
};

// 冻结的数组快照：useSyncExternalStore 靠引用相等短路，toggle 时整组换新
let snapshot: string[] = Object.freeze(read()) as string[];
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

const setPinned = (ids: string[]) => {
  snapshot = Object.freeze([...ids]) as string[];
  syncStorage.setItem(KEY, JSON.stringify(ids));
  emit();
};

export const isPinned = (id: string): boolean => snapshot.includes(id);

export const togglePinned = (id: string): boolean => {
  if (snapshot.includes(id)) {
    setPinned(snapshot.filter((v) => v !== id));
    return false;
  }
  // 新置顶排在这台设备置顶顺序的最前
  setPinned([id, ...snapshot]);
  return true;
};

/** 置顶 id 列表的稳定快照（渲染安全：只在变化时换引用） */
export const usePinnedThreadIds = (): readonly string[] =>
  useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => snapshot,
    () => snapshot,
  );
