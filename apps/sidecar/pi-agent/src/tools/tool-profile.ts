/**
 * 工具面档位（kv key = pi.toolProfile）。
 *
 * "coding" 档只收纯创作/辅助类工具（generate_image 文生图、see_image 视觉辅助、
 * open_plugin_panel 面板唤起）——它们与编码调试无关；browser_*、screenshot、
 * kb_search/kb_read、open_file、search_external_files 在排查 web 应用和查资料时
 * 是刚需，一律保留。"full"（默认）保持全量工具面。翻转经 set_tool_profile 落 kv
 * 并整组重建活动会话工具表（resolve.reloadToolProfile，与视觉/记忆开关同机制）。
 * 与 vision/browser 配置同一缓存模式：异步 init 载内存，buildTools 同步读。
 */
import { kvGet, kvSet } from "../storage/hostdb";
import { logErr } from "../log";

export const TOOL_PROFILE_KV_KEY = "pi.toolProfile";

export type ToolProfile = "full" | "coding";

let current: ToolProfile = "full";

export function getToolProfile(): ToolProfile {
  return current;
}

/** 编码档剔除清单：只收与编码调试无关的创作/辅助类工具 */
export const CODING_PROFILE_DROPPED_TOOLS: ReadonlySet<string> = new Set([
  "generate_image",
  "see_image",
  "open_plugin_panel",
]);

export function isDroppedInCodingProfile(name: string): boolean {
  return CODING_PROFILE_DROPPED_TOOLS.has(name);
}

function normalizeToolProfile(raw: unknown): ToolProfile {
  return raw === "coding" ? "coding" : "full";
}

/** 启动恢复：kv 里的 JSON `{"profile": "coding"}` 载入内存；失败保持默认（full） */
export async function initToolProfile(): Promise<void> {
  try {
    const row = await kvGet(TOOL_PROFILE_KV_KEY);
    if (row?.value) {
      current = normalizeToolProfile(JSON.parse(row.value)?.profile);
    }
  } catch (err) {
    logErr("tool-profile: load failed:", err);
  }
}

/** 应用新档位：内存即时生效并落 kv；持久化失败仅记日志（下次启动回落）。
 *  raw 接受 "coding"/"full" 字符串或 { profile: ToolProfile } 整包。 */
export async function applyToolProfile(raw: unknown): Promise<ToolProfile> {
  const value = typeof raw === "string" ? raw : (raw as { profile?: unknown } | null)?.profile;
  current = normalizeToolProfile(value);
  try {
    await kvSet(TOOL_PROFILE_KV_KEY, JSON.stringify({ profile: current }));
  } catch (err) {
    logErr("tool-profile: persist failed:", err);
  }
  return current;
}

/** 测试辅助：直接置内存态（不落 kv） */
export function resetToolProfileForTest(next?: ToolProfile): void {
  current = next ?? "full";
}
