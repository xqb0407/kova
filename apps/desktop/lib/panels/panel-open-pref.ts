"use client";

/**
 * 面板开合状态：**按会话分区**持久化（localStorage 键 agent-panel-open-v2）。
 * 键空间与 panel-tabs 的标签桶一致：sessionId 为准；草稿期（__LOCALID_）
 * 先记草稿键，绑定后由 rekeyPanelOpenPref 迁移。
 *
 * 为什么要分区：旧实现是全局单键（agent-panel-open）——A 会话里打开面板，
 * 切到 B 也保持打开，等于切会话顺手改了另一个会话的面板版面（用户实报）。
 * 现在每个会话各记各的开合：手动开只影响该会话本身。
 *
 * 读写纪律：
 * - 只记"用户手动开/收"（收起按钮、快捷键、拖拽落位、显式展开事件）；
 *   切会话时按记忆恢复是跟随行为，由 Base 直接 setState，不经这里。
 * - 存储是无界会话集合，写入时 LRU 截断防膨胀；坏档/无 localStorage
 *   （SSR、隐私模式）一律按"无记录"处理 = 收起。
 */
const STORAGE_KEY = "agent-panel-open-v2";
const MAX_THREADS = 200;

type StoredOpenMap = Record<string, 1>;

function readMap(): StoredOpenMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as StoredOpenMap) : {};
  } catch {
    return {};
  }
}

function writeMap(map: StoredOpenMap): void {
  try {
    // LRU 截断：对象键序 = 插入序，重建时把最新键放到最后
    const keys = Object.keys(map);
    if (keys.length > MAX_THREADS) {
      const trimmed: StoredOpenMap = {};
      for (const k of keys.slice(keys.length - MAX_THREADS)) trimmed[k] = 1;
      map = trimmed;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* 存储被禁用：静默降级为仅内存态 */
  }
}

/** 该会话是否记住了"面板打开"；无记录/无键 → false（默认收起）。纯读，不写。 */
export function readPanelOpenPref(sessionKey: string | null | undefined): boolean {
  if (!sessionKey) return false;
  return sessionKey in readMap();
}

/** 记住该会话的面板开合（用户手动开/收；open=false 时清除记录 = 默认收起） */
export function writePanelOpenPref(sessionKey: string | null | undefined, open: boolean): void {
  if (!sessionKey) return;
  const map = readMap();
  if (open) {
    const next: StoredOpenMap = {};
    for (const k of Object.keys(map)) if (k !== sessionKey) next[k] = 1;
    next[sessionKey] = 1;
    writeMap(next);
  } else {
    if (!(sessionKey in map)) return;
    delete map[sessionKey];
    writeMap(map);
  }
}

/** 草稿 id → sessionId 的分区迁移（与 panel-tabs 的 rekeyPanelThread 同点调用） */
export function rekeyPanelOpenPref(from: string, to: string): void {
  if (!from || !to || from === to) return;
  const map = readMap();
  if (!(from in map)) return;
  const next: StoredOpenMap = {};
  for (const k of Object.keys(map)) if (k !== from && k !== to) next[k] = 1;
  next[to] = 1;
  writeMap(next);
}
