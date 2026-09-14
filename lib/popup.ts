"use client";

import {
  AGENT_EVENT_REGISTRY,
  subscribeAgentEvents,
  type AgentEvent,
} from "@/lib/agent-events";
import { isTauri } from "@/lib/tauri";
import { getUiPrefs } from "@/lib/ui-prefs";

/**
 * 弹窗通知：agent 生命周期事件 → 系统级桌面通知（Windows 右下角 / macOS 通知中心，
 * 最小化/切走也可见），走 tauri-plugin-notification。桌面端专属：
 * 远程浏览器（非 Tauri）一律不弹。门控：窗口失焦才发——前台看得见，不必打扰。
 * 正文动态组装（notifyBody）：标题取注册表 label，内容取事件 data
 * （prompt/错误原因/工具名/首个问题标题），注册表 desc 仅兜底。
 * 已知平台限制（只影响展示归属，逻辑两端一致、无 OS 分支）：
 *  - Windows dev（target/debug）：插件故意不设 AUMID，notify-rust 兜底借用
 *    PowerShell 的 AUMID——卡片挂 "Windows PowerShell" 名下且无图标；
 *    安装版由 NSIS 注册 AUMID，正确显示为 "Xulux Assistant" + 应用图标。
 *  - macOS：首次 requestPermission 弹系统授权框（用户可拒绝）；dev 以裸二进制
 *    （非 .app bundle）运行可能无法授权/弹出，错误均被 catch 吞掉，以打包版为准。
 */

// 系统通知权限懒申请：Windows 恒为 granted，macOS 首次调用弹系统授权框；
// 申请失败（无权限/服务异常）缓存为 false，不在每个事件上重试。
let permission: Promise<boolean> | null = null;

async function notifyDesktop(title: string, body: string): Promise<void> {
  const n = await import("@tauri-apps/plugin-notification");
  permission ??= n
    .requestPermission()
    .then((state) => state === "granted")
    .catch(() => false);
  if (await permission) n.sendNotification({ title, body });
}

/** 通知正文：从事件 data 取动态内容（prompt/错误原因/工具名/提问标题），desc 只兜底 */
function notifyBody(event: AgentEvent, fallback: string): string {
  const d = (event.data ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) =>
    typeof v === "string" && v ? (v.length > max ? `${v.slice(0, max)}…` : v) : undefined;
  switch (event.name) {
    case "agent.turn.completed":
      return str(d.prompt, 80) ? `「${str(d.prompt, 80)}」` : fallback;
    case "agent.turn.error":
      return str(d.message, 100) ?? fallback;
    case "agent.approval.pending": {
      const tool = str(d.toolName, 40);
      return tool ? `工具 ${tool} 等待批准` : fallback;
    }
    case "agent.question.pending": {
      const first = str(d.firstTitle, 60);
      const count = typeof d.count === "number" ? d.count : 0;
      if (first) return count > 1 ? `${first}（等 ${count} 个问题）` : first;
      return count > 0 ? `${count} 个问题等待回答` : fallback;
    }
    default:
      return fallback;
  }
}

let initialized = false;

/** 挂到事件总线：生命周期事件 → 失焦时按偏好发系统通知。initNotifyPipeline 调用 */
export function initNotifyPopups(): void {
  if (initialized) return;
  initialized = true;
  subscribeAgentEvents((event) => {
    if (!isTauri()) return; // 桌面端专属：远程浏览器不弹窗
    const entry = AGENT_EVENT_REGISTRY.find((e) => e.name === event.name);
    if (!entry) return; // system.test 不弹窗
    if (!getUiPrefs().popupEnabled) return;
    if (document.hasFocus()) return; // 窗口在前台：看得见，不必打扰
    void notifyDesktop(entry.label, notifyBody(event, entry.desc)).catch(() => {
      // 通知服务不可用不影响主流程
    });
  });
}
