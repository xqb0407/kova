"use client";

/**
 * 钩子 systemMessage 的全局 toast：
 * sidecar 在钩子 stdout 输出 systemMessage 时发 hook_message 自发帧，
 * 这里挂在通道注册表上（含远程 provider 换代重挂），收到即 toast。
 * 桌面与远程端都展示（remote 网关已把 hook_message 加入广播白名单）。
 *
 * 防刷屏：同内容短窗去重 + 全局限流；长文本只截断展示，sidecar 日志仍保留全文。
 */

import { toast } from "@/components/ui/toast";
import { t } from "@/lib/i18n";
import {
  addPiChannelListener,
  peekPiChannel,
  type PiChannel,
  type PiHookMessageFrame,
} from "@/lib/pi/pi-channel";

/** 同内容窗口内不重复弹（toast 自身只对“仍在显示”的去重） */
const DEDUPE_MS = 3_000;
/** 全局速率：窗口内最多 5 条，超出静默丢弃（避免一个高频钩子刷屏） */
const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT = 5;
/** 展示截断：toast 文案不铺 2000 字（sidecar 日志仍有全文） */
const MAX_DISPLAY_CHARS = 600;

let installed = false;
let unsubscribe: (() => void) | undefined;
let attached: PiChannel | null | undefined;
const lastShown = new Map<string, number>();
let shownAt: number[] = [];

function shortId(value: string | undefined): string | undefined {
  const id = value?.trim();
  return id ? id.slice(0, 8) : undefined;
}

function show(frame: PiHookMessageFrame): void {
  const text = frame.text.trim();
  if (!text) return;

  const now = Date.now();
  // 同内容短窗去重（key 含会话，避免不同会话的同文提示互相吞掉）
  const key = `${frame.hookName ?? ""}\u0000${frame.event ?? ""}\u0000${
    frame.sessionId ?? ""
  }\u0000${text}`;
  for (const [oldKey, at] of lastShown) {
    if (now - at > DEDUPE_MS) lastShown.delete(oldKey);
  }
  if (lastShown.has(key)) return;
  // 全局限流
  shownAt = shownAt.filter((at) => now - at <= RATE_WINDOW_MS);
  if (shownAt.length >= RATE_LIMIT) return;
  shownAt.push(now);
  lastShown.set(key, now);

  const body =
    text.length > MAX_DISPLAY_CHARS ? `${text.slice(0, MAX_DISPLAY_CHARS)}…` : text;
  const meta = [
    frame.event,
    shortId(frame.sessionId ?? frame.threadId)
      ? t("settings.hooks.toastSession", {
          id: shortId(frame.sessionId ?? frame.threadId)!,
        })
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const name = frame.hookName?.trim();
  toast.warning({
    title: name ? t("settings.hooks.toastTitle", { name }) : t("settings.hooks.title"),
    description: meta ? `${body}\n\n${meta}` : body,
    duration: 6000,
  });
}

function attach(channel: PiChannel | null): void {
  if (channel === attached) return;
  unsubscribe?.();
  unsubscribe = undefined;

  const subscribe = channel?.subscribeHookMessages;
  if (!subscribe) {
    attached = channel;
    return;
  }
  let result: (() => void) | Promise<() => void>;
  try {
    result = subscribe.call(channel, show);
  } catch {
    // 订阅安装异常不能打断 setPiChannel 的其它监听器（如 sessions 同步）；
    // attached 不落值，下次同通道注册还会重试。
    attached = undefined;
    return;
  }
  attached = channel;
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
    .catch(() => {
      // 异步安装失败：允许下一次通道注册重试
      if (attached === channel) attached = undefined;
    });
}

/** 测试钩子：清空去重/限流窗口（不影响已安装的订阅） */
export function resetHookMessageToastStateForTest(): void {
  lastShown.clear();
  shownAt = [];
}

/** 全局安装一次（AppRuntimeProvider 挂载时调用）；随通道注册/换代重挂 */
export function installHookMessageToasts(): void {
  if (installed) return;
  installed = true;
  addPiChannelListener(attach);
  attach(peekPiChannel());
}
