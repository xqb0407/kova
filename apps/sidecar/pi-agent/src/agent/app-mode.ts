/**
 * 应用工作模式（work / code）：设置 → 通用里的全局开关，控制系统提示词的
 * 人群附加段。git UI 显隐与消息工具行形态在前端（lib/app-mode.ts 镜像 store），
 * 本模块只管 sidecar 侧的事实源。
 * - 事实源：SQLite kv（pi.app_mode）；启动 initAppMode() 恢复，非法值回落 "code"
 * - 注入点：modes.ts composeModeSystemPrompt 在个性化段之后插入 workModePromptBlock()；
 *   code 模式（默认）为空串，默认提示词与旧版字节级一致
 * - 变更：protocol set_app_mode → applyAppMode 落 kv + 逐 running 会话重排系统
 *   提示词（set_personalization 同款广播），下一轮请求即生效
 * - 与会话级 agent/plan 模式（modes.ts 状态机）正交：那个切权限，这个切人群定位
 */
import { kvGet, kvSet } from "../storage/hostdb";
import { logErr } from "../log";

export type AppMode = "work" | "code";

export const APP_MODE_KV_KEY = "pi.app_mode";
export const DEFAULT_APP_MODE: AppMode = "code";

let current: AppMode = DEFAULT_APP_MODE;

/** 任意来源（kv JSON / 协议消息）的宽松规整：仅接受两档字面量，其余回落 code */
export function normalizeAppMode(raw: unknown): AppMode {
  return raw === "work" ? "work" : "code";
}

/** 启动恢复：kv 读回；失败保持默认（不阻断启动） */
export async function initAppMode(): Promise<void> {
  try {
    const row = await kvGet(APP_MODE_KV_KEY);
    if (row?.value) {
      const parsed: unknown = JSON.parse(row.value);
      current = normalizeAppMode(parsed);
    }
  } catch (err) {
    logErr("app-mode: load failed:", err);
  }
}

/** 测试辅助：仅清内存不落 kv（模拟进程重启后内存为默认的起点） */
export function resetAppModeForTest(): void {
  current = DEFAULT_APP_MODE;
}

export function getAppMode(): AppMode {
  return current;
}

/** 应用新模式：内存即时生效；持久化失败仅记日志（下次启动回落） */
export async function applyAppMode(raw: unknown): Promise<AppMode> {
  const next = normalizeAppMode(raw);
  current = next;
  try {
    await kvSet(APP_MODE_KV_KEY, JSON.stringify(next));
  } catch (err) {
    logErr("app-mode: persist failed:", err);
  }
  return next;
}

/** work 模式的系统提示词附加段：面向非工程用户的交付物导向协作；显式声明冲突时
 *  以本段优先（压过核心段的编码纪律）。code 模式返回空串（composeModeSystemPrompt
 *  过滤空段，默认提示词字节级不变） */
export function workModePromptBlock(): string {
  if (current !== "work") return "";
  return [
    "You are operating in Work mode. The user is generally a non-engineer (product, operations, data, research). Optimize for finished deliverables - documents, spreadsheets, presentations, research summaries, and web artifacts - rather than code.",
    "Where these instructions conflict with coding-specific defaults above, this mode's instructions take precedence.",
    "Reply in plain language: avoid code jargon unless asked, and explain technical trade-offs simply.",
    "Prefer producing complete artifacts (files, HTML reports) over chat-only answers. If a task touches code files, keep changes minimal and explain them in non-technical terms.",
  ].join("\n");
}
