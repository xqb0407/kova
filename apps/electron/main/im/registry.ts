/**
 * IM 适配器注册表：按 (platform, channelId) 双键精确寻址。
 * 一个平台可同时绑定多个 Bot（channelId 区分）；未注册的精确组合返回
 * undefined，由调用方报错——绝不跨实例兜底路由（A bot 的流量错投 B bot
 * 是最坏结果，宁可显式失败）。
 */
import type { ImChannelAdapter, ImAdapterFactory, ImPlatform } from "./types";

const factories = new Map<ImPlatform, ImAdapterFactory>();
const instances = new Map<string, ImChannelAdapter>();

function instanceKey(platform: ImPlatform, channelId: string): string {
  return `${platform}:${channelId}`;
}

export function registerImAdapterFactory(platform: ImPlatform, factory: ImAdapterFactory): void {
  factories.set(platform, factory);
}

export function listImAdapterPlatforms(): ImPlatform[] {
  return [...factories.keys()];
}

/** 取（必要时惰性创建）某通道的适配器实例 */
export function getImAdapter(platform: ImPlatform, channelId: string): ImChannelAdapter | undefined {
  const key = instanceKey(platform, channelId);
  const existing = instances.get(key);
  if (existing) return existing;
  const factory = factories.get(platform);
  if (!factory) return undefined;
  const adapter = factory(channelId);
  instances.set(key, adapter);
  return adapter;
}

/** 只读查实例（不惰性创建）：状态轮询/探活用，避免轮询本身制造实例 */
export function peekImAdapter(platform: ImPlatform, channelId: string): ImChannelAdapter | undefined {
  return instances.get(instanceKey(platform, channelId));
}

export function removeImAdapter(platform: ImPlatform, channelId: string): void {
  instances.delete(instanceKey(platform, channelId));
}
