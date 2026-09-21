"use client";

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { isTauri } from "@/lib/tauri";
import type { AgentEventName } from "@/lib/pi/agent-events";

/**
 * Webhook 端点配置存储：SQLite kv（桌面）/ localStorage（网页），与快捷键同款双路。
 * - events "*" 订阅全部，否则按 agent-events 注册表勾选
 * - secret 用于加签：generic=X-Pi-Signature 头（HMAC-SHA256 hex），
 *   dingtalk/feishu=平台各自的签名算法（见 webhook-dispatcher.ts）
 * 发送通道与订阅过滤在 webhook-dispatcher.ts，本文件只管配置 CRUD 与持久化。
 */

export type WebhookFormat = "generic" | "dingtalk" | "feishu" | "slack";

export const WEBHOOK_FORMATS: { value: WebhookFormat; label: string }[] = [
  { value: "generic", label: "通用 JSON" },
  { value: "dingtalk", label: "钉钉机器人" },
  { value: "feishu", label: "飞书机器人" },
  { value: "slack", label: "Slack" },
];

export interface WebhookEndpoint {
  id: string;
  name: string;
  url: string;
  /** 可选加签密钥 */
  secret?: string;
  format: WebhookFormat;
  /** "*" = 订阅全部事件 */
  events: AgentEventName[] | "*";
  enabled: boolean;
}

const KV_KEY = "webhooks";

let endpoints: WebhookEndpoint[] = [];
const EMPTY: WebhookEndpoint[] = [];
const listeners = new Set<() => void>();
let loaded = false;

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getWebhookEndpoints(): WebhookEndpoint[] {
  return endpoints;
}

export function useWebhookEndpoints(): WebhookEndpoint[] {
  return useSyncExternalStore(subscribe, getWebhookEndpoints, () => EMPTY);
}

function persist(list: WebhookEndpoint[]) {
  const value = JSON.stringify(list);
  if (isTauri()) {
    void invoke("kv_set", { key: KV_KEY, value }).catch(() => {});
  } else {
    try {
      window.localStorage.setItem(KV_KEY, value);
    } catch {
      // 存储不可用时仅本次会话生效
    }
  }
}

/** 启动时从 kv/localStorage 恢复，dispatcher 初始化时调用 */
export async function initWebhooks(): Promise<void> {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = isTauri()
      ? await invoke<string | null>("kv_get", { key: KV_KEY })
      : window.localStorage.getItem(KV_KEY);
    if (typeof raw === "string" && raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) endpoints = parsed as WebhookEndpoint[];
      emit();
    }
  } catch {
    // 数据损坏时回落空列表
  }
}

export function addWebhook(endpoint: Omit<WebhookEndpoint, "id">): WebhookEndpoint {
  const full: WebhookEndpoint = { ...endpoint, id: crypto.randomUUID() };
  endpoints = [...endpoints, full];
  persist(endpoints);
  emit();
  return full;
}

export function updateWebhook(id: string, patch: Partial<Omit<WebhookEndpoint, "id">>): void {
  endpoints = endpoints.map((e) => (e.id === id ? { ...e, ...patch, id } : e));
  persist(endpoints);
  emit();
}

export function removeWebhook(id: string): void {
  endpoints = endpoints.filter((e) => e.id !== id);
  persist(endpoints);
  emit();
}
