"use client";

import { initNotifyPopups } from "@/lib/popup";
import { initNotifySounds } from "@/lib/sounds";
import { initWebhookDispatcher } from "@/lib/webhook-dispatcher";
import { startAutomationLiveWatch } from "@/lib/automation-live";
import { initAutomationSessionMap } from "@/lib/automations";
import { requestOpenSession } from "@/lib/open-session";
import { isTauri } from "@/lib/tauri";

/**
 * 通知管线装配：把三个消费者（提示音、弹窗通知、webhook 派发）挂到 agent 事件总线。
 * AppRuntimeProvider 挂载时调用一次；未来加系统通知/托盘闪烁同样在这里接线，
 * 事件生产方（transport/store）无需感知任何消费者存在。
 */
let started = false;

export function initNotifyPipeline(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  initNotifySounds();
  initNotifyPopups();
  initWebhookDispatcher();
  // 定时任务自发通知帧的唯一常挂消费者（automation.task.* 事件的生产方；
  // 管理页/徽标 hook 各自还会兜底再调一次，幂等）
  startAutomationLiveWatch();
  // 会话归属记账 + 清单种子（侧边栏 ⚡ 徽标与管理页共用的数据底座）
  initAutomationSessionMap();
  // 通知点击 → 打开会话：桌面版 tauri-plugin-notification 是 notify-rust 薄封装，
  // 没有点击回调；等价路径是"点击通知卡片 → 系统激活应用 → 窗口重新获焦"。
  // 失焦后再次回焦时向 Rust 取走 30s 内的待发会话（一次性、消费即清）转成开窗
  // 事件由 Base 切会话；命令失败/无待发都静默（通知本身已发出，不丢打扰只丢跳转）
  if (isTauri()) {
    void (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      let wasBlurred = false;
      window.addEventListener("blur", () => {
        wasBlurred = true;
      });
      window.addEventListener("focus", () => {
        if (!wasBlurred) return; // 启动即前台等伪回焦不消费
        wasBlurred = false;
        void invoke<string | null>("notify_consume_pending_session")
          .then((sid) => {
            if (sid) requestOpenSession(sid);
          })
          .catch(() => {});
      });
    })().catch(() => {});
  }
}
