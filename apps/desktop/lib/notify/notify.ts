"use client";

import { initNotifyPopups } from "@/lib/notify/popup";
import { initNotifySounds } from "@/lib/notify/sounds";
import { initWebhookDispatcher } from "@/lib/notify/webhook-dispatcher";
import { startAutomationLiveWatch } from "@/lib/automation/automation-live";
import { initAutomationSessionMap } from "@/lib/automation/automations";
import { requestOpenSession } from "@/lib/pi/open-session";
import { isDesktop } from "@/lib/desktop-env";

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
  // 通知点击 → 打开会话：主进程 Electron Notification 的 click 事件派发
  // notify:open-session；只有用户真的点了通知才切会话，普通窗口回焦不再
  // 把用户带到另一个正在等审批/回答的会话。
  if (isDesktop()) {
    void import("@/desktop-bridge/event")
      .then(({ listen }) =>
        listen<string>("notify:open-session", (event) => {
          if (typeof event.payload === "string" && event.payload) {
            requestOpenSession(event.payload);
          }
        }),
      )
      .catch(() => {});
  }
}
