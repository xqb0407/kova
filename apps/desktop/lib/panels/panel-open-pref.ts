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
 * 三态（分区之后又实报"每次切会话都得重新打开"）：
 *   1 = 用户开过（记住展开）/ 0 = 用户明确关过（尊重关闭）/ **缺键 = 从没表过态**。
 * 缺键不再直接等于收起——resolvePanelOpenPref 拿"该会话有没有标签等着"兜底：
 * 后台会话里 agent 开的标签不能藏在收起的面板后面（切过去标签自然出现），
 * 没标签的会话照旧默认收起。必须有这个三态：只有"明确关过"才配否定兜底，
 * 否则切会话那一手程序落位会把"从没碰过"写成"关过"，兜底永远不生效。
 *
 * 读写纪律：
 * - 只记"用户手动开/收"（收起按钮、快捷键、拖拽落位、显式展开事件）；
 *   切会话时按记忆恢复是跟随行为，由 Base 直接 setState，不经这里。
 *   程序落位（切会话 snap、闸门收放、动画收尾）一律不回写，判定见
 *   panelResizeContradictsState。
 * - 存储是无界会话集合，写入时 LRU 截断防膨胀；坏档/无 localStorage
 *   （SSR、隐私模式）一律按"无记录"处理 = 交给兜底。
 */
const STORAGE_KEY = "agent-panel-open-v2";
const MAX_THREADS = 200;

/** 1 = 用户开过；0 = 用户明确关过；缺键 = 从没表过态 */
type StoredOpenMap = Record<string, 1 | 0>;

function readMap(): StoredOpenMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    // 只认 1/0：坏档（null、字符串、"1" 之类）按无记录处理，不猜语义
    const out: StoredOpenMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === 1 || v === 0) out[k] = v;
    }
    return out;
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
      for (const k of keys.slice(-MAX_THREADS)) trimmed[k] = map[k]!;
      map = trimmed;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* 存储被禁用：静默降级为仅内存态 */
  }
}

/** 该会话的用户表态：true=开过 / false=明确关过 / null=从没表过态。纯读，不写。 */
export function readPanelOpenPref(
  sessionKey: string | null | undefined,
): boolean | null {
  if (!sessionKey) return null;
  const v = readMap()[sessionKey];
  return v === undefined ? null : v === 1;
}

/** 该会话该不该展开：用户表态优先；从没表过态看标签——有标签等着（后台 agent
 *  开的、切过去就该看见的）就展开，没有则收起。 */
export function resolvePanelOpenPref(
  sessionKey: string | null | undefined,
  hasTabs: boolean,
): boolean {
  return readPanelOpenPref(sessionKey) ?? hasTabs;
}

/**
 * 一次面板尺寸落位是否**与面板状态相反**——相反 = 用户把面板拉到了状态之外
 * （拖拽到 minSize 以下自动折叠、从收起态拖回来、双击落位），此刻的尺寸才
 * 代表"用户意图"，据此回写记忆；一致 = 程序落位（切会话 snap、显示闸收放、
 * 动画收尾），尺寸只是状态在追赶，绝不能回写——否则切会话那一手收起会把
 * 目标会话写成"明确关过"。
 */
export function panelResizeContradictsState(
  collapsed: boolean,
  panelShown: boolean,
): boolean {
  return collapsed !== !panelShown;
}

/** 记住该会话的面板开合（用户手动开/收；open=false 记 0 = 明确关过） */
export function writePanelOpenPref(
  sessionKey: string | null | undefined,
  open: boolean,
): void {
  if (!sessionKey) return;
  const map = readMap();
  // 重建把该键放到最后：LRU 新近度（与 panel-tabs 的 touch 同款）
  const next: StoredOpenMap = {};
  for (const k of Object.keys(map)) if (k !== sessionKey) next[k] = map[k]!;
  next[sessionKey] = open ? 1 : 0;
  writeMap(next);
}

/** 草稿 id → sessionId 的分区迁移（与 panel-tabs 的 rekeyPanelThread 同点调用）。
 *  表态跟着会话走：明确关过的 0 也要迁，否则绑定 sessionId 后会被兜底重新撑开 */
export function rekeyPanelOpenPref(from: string, to: string): void {
  if (!from || !to || from === to) return;
  const map = readMap();
  if (!(from in map)) return;
  const moved = map[from]!;
  const next: StoredOpenMap = {};
  for (const k of Object.keys(map)) if (k !== from && k !== to) next[k] = map[k]!;
  next[to] = moved;
  writeMap(next);
}