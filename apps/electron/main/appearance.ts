/**
 * 窗口背景材质（对齐 appearance.rs）：acrylic/mica 平台就近映射；
 * sync_webview_surface 翻转表面透明度（材质关 → 不透明拿回 ClearType）。
 */
import { BrowserWindow } from "electron";
import { kvGet, kvSet, kvDelete } from "./store";

export const KV_KEY = "appearance.effect";

type EffectName = "acrylic" | "mica" | null;

function normalize(effect: unknown): EffectName {
  if (typeof effect !== "string" || effect.length === 0 || effect === "none") return null;
  return effect === "acrylic" || effect === "mica" ? effect : null;
}

export function apply(win: BrowserWindow, effect: EffectName): void {
  try {
    if (process.platform === "darwin") {
      // macOS 系统材质：Sidebar（透模糊）/ UnderWindowBackground
      win.setVibrancy(effect === null ? null : effect === "acrylic" ? "sidebar" : "under-window");
      win.setBackgroundColor(effect === null ? "#ffffffff" : "#00000000");
    } else if (process.platform === "win32") {
      win.setBackgroundMaterial(effect === null ? "none" : effect === "acrylic" ? "acrylic" : "mica");
    } else {
      win.setBackgroundColor(effect === null ? "#ffffffff" : "#00000000");
    }
  } catch (e: any) {
    throw new Error(`failed to set window effects: ${e?.message ?? e}`);
  }
}

/** 材质开 → 表面透明；材质关 → 不透明（仅动背景，不碰窗口材质合成） */
function applyWebviewSurface(win: BrowserWindow, effect: EffectName): void {
  try {
    win.setBackgroundColor(effect === null ? "#ffffffff" : "#00000000");
  } catch (e) {
    console.warn("[appearance] set webview background failed:", e);
  }
}

function currentEffect(): EffectName {
  try {
    return normalize(kvGet(KV_KEY));
  } catch {
    return null;
  }
}

export function setupAppearanceCommands(register: (name: string, fn: (args: any, ctx: any) => any) => void): void {
  register("set_window_effect", (a, ctx) => {
    const name = normalize(a.effect);
    if (a.effect != null && a.effect !== "" && a.effect !== "none" && name === null) {
      throw new Error(`unsupported window effect: ${a.effect}`);
    }
    const win = BrowserWindow.fromWebContents(ctx.sender);
    if (!win) throw new Error("no window");
    apply(win, name);
    applyWebviewSurface(win, name);
    if (name) kvSet(KV_KEY, name);
    else kvDelete(KV_KEY);
    return null;
  });
  register("sync_webview_surface", (_a, ctx) => {
    const win = BrowserWindow.fromWebContents(ctx.sender);
    if (win) applyWebviewSurface(win, currentEffect());
    return null;
  });
}

/** 启动恢复：读取持久化设置并应用（失败不阻塞启动） */
export function restore(win: BrowserWindow): void {
  const effect = currentEffect();
  if (!effect) return;
  try {
    apply(win, effect);
  } catch (e) {
    console.warn("[appearance]", e);
  }
}
