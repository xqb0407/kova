/**
 * 桌面桥 · 桌宠：悬浮窗控制、事件转发、气泡跳会话、透明窗点击穿透。
 * 命令实现见 apps/electron/main/pet-window.ts。
 */
import { invokeBridge } from "./_host";

/** 事件帧（与主窗口 agent-events 的 AgentEvent 同形，经主进程转投悬浮窗）。 */
export interface PetAgentEventFrame {
  name: string;
  threadId?: string;
  data?: Record<string, unknown>;
  occurredAt?: number;
}

/** 主窗口 → 主进程 → 悬浮窗 的事件转发（悬浮窗未开时主进程静默丢弃）。 */
export async function relayPetEvent(frame: PetAgentEventFrame): Promise<void> {
  await invokeBridge("pet_relay_event", frame as unknown as Record<string, unknown>);
}

/** 悬浮窗显隐（未创建时创建并显示）。 */
export async function togglePetWindow(): Promise<void> {
  await invokeBridge("pet_window_toggle");
}

export async function showPetWindow(): Promise<void> {
  await invokeBridge("pet_window_show");
}

export async function hidePetWindow(): Promise<void> {
  await invokeBridge("pet_window_hide");
}

export async function isPetWindowVisible(): Promise<boolean> {
  return invokeBridge<boolean>("pet_window_is_visible");
}

/** 透明窗点击穿透开关：指针进入宠物/气泡/拖拽条时关，离开时开（forward 保留 move）。 */
export async function setPetIgnoreMouse(ignore: boolean): Promise<void> {
  await invokeBridge("pet_ignore_mouse", { ignore });
}

/** 右键原生菜单（OS 层浮层，不遮宠物本体）。动作码由主进程执行/转播。 */
export async function petContextMenu(
  items: { label: string; action: string }[],
): Promise<void> {
  await invokeBridge("pet_context_menu", { items });
}

/** 气泡点击 → 聚焦主窗口并打开对应会话。 */
export async function focusPetSession(sessionId: string): Promise<void> {
  await invokeBridge("pet_focus_session", { sessionId });
}

/** 左键点宠物 → 只聚焦主窗口（不开会话）。 */
export async function focusPetMainWindow(): Promise<void> {
  await invokeBridge("pet_focus_main");
}

/** 画布跟随显示尺寸变化（主进程 setSize，clamp 在工作区内）。 */
/* ---- 宠物库（目录扫描）：放文件夹进 pets 目录即出现，无需"添加" ---- */

export interface PetLibraryScanResult {
  dir: string;
  pets: { dir: string; rel: string; name: string; configUrl: string }[];
}

export async function scanPetLibrary(): Promise<PetLibraryScanResult> {
  return invokeBridge<PetLibraryScanResult>("pet_library_scan");
}

export async function readPetAsset(rel: string): Promise<{ base64: string; mime: string }> {
  return invokeBridge<{ base64: string; mime: string }>("pet_asset_read", { rel });
}

export async function openPetsDir(): Promise<void> {
  await invokeBridge("pet_open_dir");
}

/** 悬浮窗画布跟随显示尺寸变化（主进程 setSize，clamp 在工作区内）。 */
export async function setPetWindowSize(width: number, height: number): Promise<void> {
  await invokeBridge("pet_window_set_size", { width, height });
}

/**
 * 偏好已变更 → 主进程广播给所有窗口，**载荷携带完整偏好 JSON**。
 * localStorage 的 storage 事件在多窗口下不可靠，跨窗口同步走这条显式链；
 * 本窗口不靠它（patchPetPrefs 已原地更新）。
 */
export async function notifyPetPrefsChanged(prefsJson: string): Promise<void> {
  await invokeBridge("pet_prefs_changed", { prefs: prefsJson });
}

/** 右键菜单「打开设置」→ 聚焦主窗口并跳到桌宠分区（网页端同 window 事件直发）。 */
export async function openPetSettings(): Promise<void> {
  await invokeBridge("pet_open_settings");
}

/* ---- 程序化拖窗：pointer 事件 → 主进程 setPosition（见 main/pet-window.ts）---- */

export async function beginPetDrag(): Promise<void> {
  await invokeBridge("pet_window_begin_drag");
}

/** 相对拖拽起点的累计屏幕偏移（DIP）。 */
export async function movePetWindowOffset(ox: number, oy: number): Promise<void> {
  await invokeBridge("pet_window_move_offset", { ox, oy });
}

export async function endPetDrag(): Promise<void> {
  await invokeBridge("pet_window_end_drag");
}
