"use client";

/**
 * 钩子 systemMessage 的全局 toast：
 * sidecar 在钩子 stdout 输出 systemMessage 时发 hook_message 自发帧，
 * 这里挂在通道注册表上（含远程 provider 换代重挂），收到即 toast。
 *
 * 只在用户可见的桌面 UI 展示；远程网关不转发该帧（文本可能含本机路径）。
 */

import { toast } from "@/components/ui/toast";
import { t } from "@/lib/i18n";
import {
  addPiChannelListener,
  peekPiChannel,
  type PiChannel,
  type PiHookMessageFrame,
} from "@/lib/pi/pi-channel";

let installed = false;
let unsubscribe: (() => void) | undefined;
let attached: PiChannel | null | undefined;

function show(frame: PiHookMessageFrame): void {
  const text = frame.text.trim();
  if (!text) return;
  const name = frame.hookName?.trim();
  toast.warning({
    title: name ? t("settings.hooks.toastTitle", { name }) : t("settings.hooks.title"),
    description: text,
    duration: 6000,
  });
}

function attach(channel: PiChannel | null): void {
  if (channel === attached) return;
  attached = channel;
  unsubscribe?.();
  unsubscribe = undefined;
  const subscribe = channel?.subscribeHookMessages;
  if (!subscribe) return;
  let result: (() => void) | Promise<() => void>;
  try {
    result = subscribe.call(channel, show);
  } catch {
    // 订阅安装异常不能打断 setPiChannel 的其它监听器（如 sessions 同步）
    return;
  }
  if (typeof result === "function") {
    unsubscribe = result;
    return;
  }
  void result
    .then((off) => {
      // 通道在异步登记期间又换了：旧订阅立即退掉
      if (attached === channel) unsubscribe = off;
      else off();
    })
    .catch(() => {});
}

/** 全局安装一次（AppRuntimeProvider 挂载时调用）；随通道注册/换代重挂 */
export function installHookMessageToasts(): void {
  if (installed) return;
  installed = true;
  addPiChannelListener(attach);
  attach(peekPiChannel());
}
