/**
 * IM 通道管理器：适配器实例生命周期编排。
 * - 启动恢复：initImManager() 在 store 就绪后调用，为每个 enabled 且已绑定
 *   的通道启动适配器（微信 cursor 由适配器自行从 kv 续传）
 * - 配置变更：reconcileChannel(id) 按最新配置停/启对应实例（设置页每次
 *   save/toggle/绑定后调用）
 * - 退出收尾：stopAllImChannels() 挂 before-quit
 * 状态快照：im_channels_status 从各适配器 status() 汇总（含未启动实例）。
 */
import { logInfo, logWarn } from "../logging";
import {
  registerImAdapterFactory,
  getImAdapter,
  peekImAdapter,
  removeImAdapter,
  listImAdapterPlatforms,
} from "./registry";
import { WechatAdapter } from "./adapters/wechat/wechat-adapter";
import {
  listChannelConfigs,
  getWechatCredential,
} from "./router";
import type { ImChannelStatus, ImPlatform } from "./types";
import type { ImInboundMessage } from "./types";
import { handleInbound } from "./router";

let initialized = false;

/** 平台工厂登记（模块加载即注册；新平台在此加一行） */
export function registerImAdapterFactories(): void {
  registerImAdapterFactory("wechat", (channelId) => new WechatAdapter(channelId));
}

const runningChannels = new Set<string>();

/** 同通道 reconcile 串行化：保存/绑定/轮询确认可能并发触发，
 *  交错执行会出现「刚 start 又被另一个 stop」的竞态 */
const reconcileChains = new Map<string, Promise<void>>();

export function reconcileChannel(channelId: string): Promise<void> {
  const prev = reconcileChains.get(channelId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => reconcileChannelInner(channelId));
  reconcileChains.set(channelId, next);
  void next.finally(() => {
    if (reconcileChains.get(channelId) === next) reconcileChains.delete(channelId);
  }).catch(() => {});
  return next;
}

async function reconcileChannelInner(channelId: string): Promise<void> {
  const cfg = listChannelConfigs().find((c) => c.id === channelId);
  if (!cfg) {
    await stopChannel(channelId);
    for (const platform of listImAdapterPlatforms()) {
      removeImAdapter(platform, channelId);
    }
    return;
  }
  if (!cfg.enabled || !cfg.platform) {
    await stopChannel(channelId);
    return;
  }
  const platform = cfg.platform as ImPlatform;
  const adapter = getImAdapter(platform, channelId);
  if (!adapter) {
    logWarn(`[im/manager] no adapter for platform=${cfg.platform}`);
    return;
  }
  const credentials = platform === "wechat" ? getWechatCredential(channelId) : { botToken: "", botId: "", baseUrl: "" };
  if (platform === "wechat" && !credentials.botToken) {
    await adapter.stop();
    runningChannels.delete(channelId);
    return;
  }
  await adapter.stop();
  await adapter.start(
    {
      channelId,
      credentials,
      onStatus: (status) => {
        logInfo(`[im/manager] channel=${channelId} status=${status.state}`);
      },
    },
    (msg: ImInboundMessage) => {
      void handleInbound(msg);
    },
  );
  runningChannels.add(channelId);
  logInfo(`[im/manager] channel started: ${channelId} (${cfg.platform})`);
}

async function stopChannel(channelId: string): Promise<void> {
  for (const platform of listImAdapterPlatforms()) {
    const adapter = peekImAdapter(platform, channelId);
    if (adapter) await adapter.stop();
  }
  runningChannels.delete(channelId);
}

/** 启动恢复：把所有 enabled 通道收敛一遍 */
export async function initImManager(): Promise<void> {
  if (initialized) return;
  initialized = true;
  registerImAdapterFactories();
  const list = listChannelConfigs();
  for (const cfg of list) {
    try {
      await reconcileChannel(cfg.id);
    } catch (e: unknown) {
      logWarn(`[im/manager] restore channel=${cfg.id} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  logInfo(`[im/manager] restored ${list.length} channel(s)`);
}

/** 全停（before-quit） */
export async function stopAllImChannels(): Promise<void> {
  for (const channelId of [...runningChannels]) {
    try {
      await stopChannel(channelId);
    } catch {
      /* ignore */
    }
  }
}

/** 状态快照：channelId → ImChannelStatus（前端 im_channels_status 消费）。
 *  只读已存在的实例（peek，不惰性创建）：未趋动的通道一律未绑定/未连接，
 *  避免每次状态轮询都新建适配器对象。 */
export function channelStatuses(): Record<string, ImChannelStatus> {
  const out: Record<string, ImChannelStatus> = {};
  for (const cfg of listChannelConfigs()) {
    const bound =
      cfg.platform === "wechat" ? Boolean(getWechatCredential(cfg.id).botToken) : false;
    if (!runningChannels.has(cfg.id)) {
      out[cfg.id] = { state: "unbound" };
      continue;
    }
    const adapter = peekImAdapter(cfg.platform as ImPlatform, cfg.id);
    const s = adapter?.status() ?? { state: "unbound" as const };
    out[cfg.id] = bound && s.state === "unbound" ? { state: "connecting" } : s;
  }
  return out;
}

/** 未绑定判定辅助（命令层组装 ImChannel 行用） */
export function isChannelBound(platform: string, channelId: string): boolean {
  if (platform === "wechat") return Boolean(getWechatCredential(channelId).botToken);
  return false;
}
