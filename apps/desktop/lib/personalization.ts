"use client";

/**
 * 个性化（设置 → 个性化）：回复风格 / 称呼与身份 / 人设 / 自定义指令。
 * 事实源在 sidecar——结构化字段存 SQLite kv；人设与自定义指令存全局目录身份文件
 * （~/.xulux/soul.md、rules.md，可外部编辑，get 回实时内容）+ 活动会话系统提示词
 * 热替换。这里只做镜像缓存：启动 get_personalization 水合，保存走 set_personalization。
 * 桌面与远程网页共用同一链路（远程经 WS 转发到同一 sidecar），桌面端无需
 * 直接读写 Tauri kv，远程改动也能持久化。
 */
import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi-bridge";
import type {
  PiPersonalization,
  PiPersonalizationBuiltinStyle,
  PiPersonalizationCustomStyle,
  PiPersonalizationPaths,
  PiPersonalizationStyle,
  PiPersonalizationStyleOverride,
} from "@/lib/pi-bridge";
export type PersonalizationCustomStyle = PiPersonalizationCustomStyle;
export type PersonalizationBuiltinStyle = PiPersonalizationBuiltinStyle;
export type PersonalizationStyleOverride = PiPersonalizationStyleOverride;
/** 本地镜像整包：styles/styleOverrides 收口为必有数组（旧版 sidecar 响应缺省时水合为 []） */
export type Personalization =
  Omit<PiPersonalization, "styles" | "styleOverrides"> & {
    styles: PersonalizationCustomStyle[];
    styleOverrides: PersonalizationStyleOverride[];
  };
export type PersonalizationStyle = PiPersonalizationStyle;
export type PersonalizationPaths = PiPersonalizationPaths;

export const DEFAULT_PERSONALIZATION: Personalization = {
  style: "default",
  styles: [],
  styleOverrides: [],
  userName: "",
  assistantName: "",
  persona: "",
  customInstructions: "",
};

/* ------------------------------ 自定义回复风格 ------------------------------ */

/** 自定义风格 id 前缀（与 sidecar CUSTOM_STYLE_ID_PREFIX 一致；style = `custom:<id>`） */
export const CUSTOM_STYLE_ID_PREFIX = "custom:" as const;

/** 生成自定义风格条目 id（前端生成；sidecar normalize 收口 64 字符） */
export function makeCustomStyleId(): string {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`;
  return uuid.replace(/-/g, "").slice(0, 12);
}

/** 自定义风格的档位取值 */
export const customStyleValue = (id: string): PersonalizationStyle =>
  `${CUSTOM_STYLE_ID_PREFIX}${id}` as PersonalizationStyle;

/** 与 sidecar normalize 同款的收口上限（编辑弹窗即时截断，最终以后端为准） */
export const CUSTOM_STYLES_MAX = 20;
export const CUSTOM_STYLE_NAME_MAX_CHARS = 24;
export const CUSTOM_STYLE_PROMPT_MAX_CHARS = 4_000;
export const CUSTOM_STYLE_UNNAMED = "未命名风格";

/** 回复风格内置档位（设置页选项；value 与 sidecar STYLE_PROMPTS 一一对应） */
export const PERSONALIZATION_STYLE_OPTIONS: {
  value: PersonalizationBuiltinStyle;
  label: string;
  desc: string;
}[] = [
  { value: "default", label: "默认", desc: "平衡的日常协作语气" },
  { value: "professional", label: "专业", desc: "精炼、结构化、先给结论" },
  { value: "friendly", label: "亲和", desc: "轻松友好，更像伙伴" },
  { value: "imaginative", label: "天马行空", desc: "创意发散，先发散再收敛" },
  { value: "blunt", label: "直言不讳", desc: "有话直说，不绕弯子" },
  { value: "guiding", label: "启发引导", desc: "多提问引导，带你推导" },
];

/** 内置档默认提示词镜像（与 sidecar STYLE_PROMPTS 同步维护；仅作编辑弹窗回填与
 *  覆盖判定，注入真值始终以 sidecar 为准） */
export const BUILTIN_STYLE_PROMPTS: Record<PersonalizationBuiltinStyle, string> = {
  default: "",
  professional:
    "Reply style - professional: be precise, structured and to the point. Lead with the conclusion, keep a neutral businesslike tone, and skip filler and pleasantries.",
  friendly:
    "Reply style - warm and approachable: keep a friendly conversational tone, acknowledge the user's context, and stay encouraging without being saccharine.",
  imaginative:
    "Reply style - imaginative: bring creative angles, analogies and bold ideas into the discussion; explore unconventional options before settling on the pragmatic one. Say clearly when you are brainstorming versus giving a firm recommendation.",
  blunt:
    "Reply style - direct: say what you actually think without hedging or softening. Point out flaws, risks and bad ideas plainly; no filler praise. Stay respectful but never sugarcoat.",
  guiding:
    "Reply style - guiding: prefer short well-aimed questions and options with trade-offs over handing over complete answers, so the user reaches conclusions themselves. When the user asks for a direct answer, give it first and explain the reasoning briefly after.",
};

/** 内置档的覆盖记录（未覆盖返回 undefined） */
export function findStyleOverride(
  overrides: PersonalizationStyleOverride[],
  id: PersonalizationBuiltinStyle,
): PersonalizationStyleOverride | undefined {
  return overrides.find((o) => o.id === id);
}

/** 内置档的有效展示名/提示词：有覆盖用覆盖，否则回落默认标签/内置文案 */
export const effectiveBuiltinName = (
  id: PersonalizationBuiltinStyle,
  ov?: PersonalizationStyleOverride,
): string => ov?.name.trim() || PERSONALIZATION_STYLE_OPTIONS.find((o) => o.value === id)!.label;

export const effectiveBuiltinPrompt = (
  id: PersonalizationBuiltinStyle,
  ov?: PersonalizationStyleOverride,
): string => ov?.prompt.trim() || BUILTIN_STYLE_PROMPTS[id];

/** 该内置档是否处于「已改动」态（改过名/文案，或被隐藏；决定恢复入口） */
export const isBuiltinModified = (ov?: PersonalizationStyleOverride): boolean =>
  !!ov && (!!ov.name.trim() || !!ov.prompt.trim() || ov.hidden);

let current: Personalization = DEFAULT_PERSONALIZATION;
/** 身份文件绝对路径（sidecar 启动响应返回，运行期不变；null = 旧版 sidecar 未提供） */
let currentPaths: PersonalizationPaths | null = null;
const listeners = new Set<() => void>();
let initialized = false;

/** 身份文件绝对路径（设置页展示外部编辑入口用） */
export function getPersonalizationPaths(): PersonalizationPaths | null {
  return currentPaths;
}

export function usePersonalizationPaths(): PersonalizationPaths | null {
  return useSyncExternalStore(
    subscribe,
    () => currentPaths,
    () => null,
  );
}

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPersonalization(): Personalization {
  return current;
}

export function usePersonalization(): Personalization {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_PERSONALIZATION,
  );
}

/** 从 sidecar 水合镜像（启动时调用一次；sidecar 不可用则保持默认） */
export async function initPersonalization(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const res = await piRequest<{
      type: "personalization";
      settings: PiPersonalization;
      paths?: PersonalizationPaths;
    }>({ type: "get_personalization" });
    current = {
      ...DEFAULT_PERSONALIZATION,
      ...res.settings,
      styles: Array.isArray(res.settings.styles) ? res.settings.styles : [],
      styleOverrides: Array.isArray(res.settings.styleOverrides)
        ? res.settings.styleOverrides
        : [],
    };
    currentPaths = res.paths ?? null;
    emit();
  } catch {
    // sidecar 不可用（启动早期/连接断开）：保持默认，保存时仍会尝试
  }
}

/** 保存个性化设置：乐观更新本地镜像；sidecar 落 SQLite 并热更新活动会话，
 *  失败时回滚并抛出（设置页据此提示） */
export async function savePersonalization(next: Personalization): Promise<void> {
  const previous = current;
  current = next;
  emit();
  try {
    await piRequest({ type: "set_personalization", settings: next });
  } catch (err) {
    current = previous;
    emit();
    throw err;
  }
}

// client bundle 加载即水合（SSR 端不请求，getServerSnapshot 返回默认值）
void initPersonalization();
