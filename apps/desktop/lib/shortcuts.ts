"use client";

import { invoke } from "@/desktop-bridge/core";
import { useSyncExternalStore } from "react";
import { isDesktop } from "@/lib/desktop-env";
import { t } from "@/lib/i18n";

/**
 * 应用级快捷键（设置 → 快捷键）：目前是 ⌘K 搜索命令面板、⌘B 侧边栏开合。
 * 绑定持久化于 SQLite kv 表（key = KV_KEY，整包 JSON），远程网页端回落
 * localStorage 按客户端保存；监听方（clone-thread-shell / sidebar）经
 * useShortcuts 订阅，改动即时生效（重建 listener）。
 * mod 在匹配时对 metaKey 与 ctrlKey 等价（⌘K 在 mac 记录、win 下 Ctrl+K 同样命中，
 * 与历史行为一致）；shift/alt 严格相等。
 */

export type ShortcutActionId =
  | "toggleSearch"
  | "toggleSidebar"
  | "newThread"
  | "openSettings"
  | "openAutomations"
  | "toggleAgentPanel"
  | "toggleTerminal"
  | "toggleTheme"
  | "sendMessage"
  | "newline";

/** 动作生效范围：global = document 级监听；composer = 仅输入框内生效（不进全局监听） */
export type ShortcutScope = "global" | "composer";

/** 一条绑定：key 为主键的 KeyboardEvent.key 小写形式（修饰键不入此字段） */
export type ShortcutConfig = {
  key: string;
  /** ⌘(macOS) / Ctrl(其他平台)，匹配时 metaKey 与 ctrlKey 等价 */
  mod: boolean;
  shift: boolean;
  alt: boolean;
};

export type ShortcutBindings = Record<ShortcutActionId, ShortcutConfig>;

export const SHORTCUT_ACTIONS: {
  id: ShortcutActionId;
  labelKey: string;
  descKey: string;
  scope: ShortcutScope;
  default: ShortcutConfig;
}[] = [
  {
    id: "toggleSearch",
    labelKey: "settings.shortcuts.actions.toggleSearch.label",
    descKey: "settings.shortcuts.actions.toggleSearch.desc",
    scope: "global",
    default: { key: "k", mod: true, shift: false, alt: false },
  },
  {
    id: "newThread",
    labelKey: "settings.shortcuts.actions.newThread.label",
    descKey: "settings.shortcuts.actions.newThread.desc",
    scope: "global",
    default: { key: "n", mod: true, shift: false, alt: false },
  },
  {
    id: "toggleSidebar",
    labelKey: "settings.shortcuts.actions.toggleSidebar.label",
    descKey: "settings.shortcuts.actions.toggleSidebar.desc",
    scope: "global",
    default: { key: "b", mod: true, shift: false, alt: false },
  },
  {
    id: "toggleAgentPanel",
    labelKey: "settings.shortcuts.actions.toggleAgentPanel.label",
    descKey: "settings.shortcuts.actions.toggleAgentPanel.desc",
    scope: "global",
    default: { key: "j", mod: true, shift: false, alt: false },
  },
  {
    // 底缘终端坞（VSCode 集成终端同款键位语义：⌘/Ctrl + `）
    id: "toggleTerminal",
    labelKey: "settings.shortcuts.actions.toggleTerminal.label",
    descKey: "settings.shortcuts.actions.toggleTerminal.desc",
    scope: "global",
    default: { key: "`", mod: true, shift: false, alt: false },
  },
  {
    id: "openSettings",
    labelKey: "settings.shortcuts.actions.openSettings.label",
    descKey: "settings.shortcuts.actions.openSettings.desc",
    scope: "global",
    default: { key: ",", mod: true, shift: false, alt: false },
  },
  {
    id: "openAutomations",
    labelKey: "settings.shortcuts.actions.openAutomations.label",
    descKey: "settings.shortcuts.actions.openAutomations.desc",
    scope: "global",
    default: { key: "a", mod: true, shift: true, alt: false },
  },
  {
    id: "toggleTheme",
    labelKey: "settings.shortcuts.actions.toggleTheme.label",
    descKey: "settings.shortcuts.actions.toggleTheme.desc",
    scope: "global",
    default: { key: "t", mod: true, shift: false, alt: true },
  },
  {
    id: "sendMessage",
    labelKey: "settings.shortcuts.actions.sendMessage.label",
    descKey: "settings.shortcuts.actions.sendMessage.desc",
    scope: "composer",
    default: { key: "enter", mod: false, shift: false, alt: false },
  },
  {
    id: "newline",
    labelKey: "settings.shortcuts.actions.newline.label",
    descKey: "settings.shortcuts.actions.newline.desc",
    scope: "composer",
    default: { key: "enter", mod: false, shift: true, alt: false },
  },
];

const KV_KEY = "ui.shortcuts";
const LS_KEY = "ui.shortcuts";

const MODIFIER_KEYS = new Set(["meta", "control", "alt", "shift", "os"]);

const DEFAULT_BINDINGS: ShortcutBindings = Object.fromEntries(
  SHORTCUT_ACTIONS.map((a) => [a.id, { ...a.default }]),
) as ShortcutBindings;

let bindings: ShortcutBindings = structuredClone(DEFAULT_BINDINGS);
const listeners = new Set<() => void>();
let initialized = false;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getShortcuts(): ShortcutBindings {
  return bindings;
}

export function useShortcuts(): ShortcutBindings {
  return useSyncExternalStore(
    subscribe,
    getShortcuts,
    () => DEFAULT_BINDINGS,
  );
}

/** 宽松规整：未知 action / 字段类型非法时回落该项默认值 */
function normalizeBindings(raw: unknown): ShortcutBindings {
  const next = structuredClone(DEFAULT_BINDINGS);
  if (!raw || typeof raw !== "object") return next;
  for (const action of SHORTCUT_ACTIONS) {
    const item = (raw as Record<string, unknown>)[action.id];
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    if (typeof c.key === "string" && c.key) {
      next[action.id] = {
        key: c.key.toLowerCase(),
        mod: c.mod === true,
        shift: c.shift === true,
        alt: c.alt === true,
      };
    }
  }
  return next;
}

/** 从 SQLite kv（桌面）/ localStorage（网页）恢复，client bundle 加载即执行 */
export async function initShortcuts(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    let raw: string | null = null;
    if (isDesktop()) raw = await invoke<string | null>("kv_get", { key: KV_KEY });
    else raw = window.localStorage.getItem(LS_KEY);
    if (raw) {
      bindings = normalizeBindings(JSON.parse(raw));
      emit();
    }
  } catch {
    // 存储不可用 / 数据损坏：保持默认绑定
  }
}

function persist() {
  const json = JSON.stringify(bindings);
  try {
    window.localStorage.setItem(LS_KEY, json);
  } catch {
    // localStorage 不可用时仅本次会话生效
  }
  if (isDesktop()) {
    void invoke("kv_set", { key: KV_KEY, value: json }).catch(() => {});
  }
}

export type SetBindingResult = { ok: true } | { ok: false; error: string };

/** 更新一条绑定：先过合法性校验（含动作作用域），再查与其他 action 的冲突；通过即生效并持久化 */
export function setShortcutBinding(
  id: ShortcutActionId,
  config: ShortcutConfig,
): SetBindingResult {
  const invalid = validateBinding(id, config);
  if (invalid) return { ok: false, error: invalid };
  for (const action of SHORTCUT_ACTIONS) {
    if (action.id !== id && configsEqual(bindings[action.id], config)) {
      return { ok: false, error: t("settings.shortcuts.conflict", { label: t(action.labelKey) }) };
    }
  }
  bindings = { ...bindings, [id]: { ...config } };
  persist();
  emit();
  return { ok: true };
}

/** 恢复某条绑定为默认值 */
export function resetShortcutBinding(id: ShortcutActionId): void {
  bindings = { ...bindings, [id]: { ...DEFAULT_BINDINGS[id] } };
  persist();
  emit();
}

/* ------------------------------ 匹配 / 录制 / 展示 ------------------------------ */

/** KeyboardEvent.key → 绑定主键：统一小写（字母与命名键 alike） */
function normalizeKey(key: string): string {
  return key.toLowerCase();
}

/** 从按键事件提取绑定；纯修饰键按下返回 null（录制时等待主键） */
export function eventToConfig(event: KeyboardEvent): ShortcutConfig | null {
  if (MODIFIER_KEYS.has(normalizeKey(event.key))) return null;
  return {
    key: normalizeKey(event.key),
    mod: event.metaKey || event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
  };
}

/** 事件是否命中绑定（mod 对 meta/ctrl 等价，其余严格相等） */
export function matchesShortcut(
  event: KeyboardEvent,
  config: ShortcutConfig,
): boolean {
  return (
    normalizeKey(event.key) === config.key &&
    (event.metaKey || event.ctrlKey) === config.mod &&
    event.shiftKey === config.shift &&
    event.altKey === config.alt
  );
}

export function configsEqual(a: ShortcutConfig, b: ShortcutConfig): boolean {
  return (
    a.key === b.key && a.mod === b.mod && a.shift === b.shift && a.alt === b.alt
  );
}

/**
 * 快捷键合法性：
 * - 全局动作：必须带 ⌘/Ctrl 或 Alt，或使用 F1–F12。监听挂在 document 级，
 *   纯字母/数字键会劫持一切文本输入。
 * - 输入框动作：作用域锁定在 composer 内，允许裸 Enter / Shift+Enter；其余仍
 *   需修饰符或功能键（否则劫持打字）。
 */
export function shortcutError(
  config: ShortcutConfig,
  scope: ShortcutScope = "global",
): string | null {
  if (/^f([1-9]|1[0-2])$/.test(config.key)) return null;
  if (config.mod || config.alt) return null;
  if (scope === "composer" && config.key === "enter") return null;
  return scope === "composer"
    ? t("settings.shortcuts.errModifierComposer")
    : t("settings.shortcuts.errModifierGlobal");
}

/** 按动作作用域校验，并对「换行」施加编辑器限制（仅 Enter 家族可实现换行）。 */
export function validateBinding(
  id: ShortcutActionId,
  config: ShortcutConfig,
): string | null {
  const action = SHORTCUT_ACTIONS.find((a) => a.id === id);
  const scope = action?.scope ?? "global";
  if (id === "newline" && config.key !== "enter") {
    return t("settings.shortcuts.errNewline");
  }
  return shortcutError(config, scope);
}

/**
 * 由「发送」绑定推导 composer 输入组件的 submitMode。组件原生 Enter 处理只认
 * 两种：裸 Enter 提交（enter）、⌘/Ctrl+Enter 提交（ctrlEnter）。其余组合返回
 * "none"，交调用方用外部 keydown 监听拦截（此时 Enter 落回组件默认 → 换行）。
 */
export function resolveComposerSubmitMode(
  send: ShortcutConfig,
): "enter" | "ctrlEnter" | "none" {
  if (send.key !== "enter" || send.alt || send.shift) return "none";
  if (!send.mod) return "enter";
  return "ctrlEnter";
}

/** 是否仍是出厂绑定（设置页据此显隐「重置」） */
export function isDefaultBinding(id: ShortcutActionId): boolean {
  return configsEqual(bindings[id], DEFAULT_BINDINGS[id]);
}

const KEY_LABELS: Record<string, string> = {
  " ": "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  enter: "↵",
  escape: "Esc",
  tab: "⇥",
  backspace: "⌫",
  delete: "⌫",
};

export function formatShortcutKey(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key];
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/** 展示分段：mac 用 ⌘/⌥/⇧，其他平台用 Ctrl/Alt/Shift */
export function formatShortcutParts(
  config: ShortcutConfig,
  isMac: boolean,
): string[] {
  const parts: string[] = [];
  if (config.mod) parts.push(isMac ? "⌘" : "Ctrl");
  if (config.alt) parts.push(isMac ? "⌥" : "Alt");
  if (config.shift) parts.push(isMac ? "⇧" : "Shift");
  parts.push(formatShortcutKey(config.key));
  return parts;
}

// client bundle 加载即恢复（SSR 端 isDesktop() 为 false，跳过 kv）
void initShortcuts();
