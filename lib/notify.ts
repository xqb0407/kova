"use client";

import { initNotifyPopups } from "@/lib/popup";
import { initNotifySounds } from "@/lib/sounds";
import { initWebhookDispatcher } from "@/lib/webhook-dispatcher";

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
}
