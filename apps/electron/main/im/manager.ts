/**
 * IM 通道管理器：适配器实例生命周期编排。
 * - 启动恢复：initImManager() 在 store 就绪后调用，为每个 enabled 且已绑定
 *   的通道启动适配器（微信 cursor 由适配器自行从 kv 续传）
 * - 配置变更：reconcileChannel(id) 按最新配置停/启对应实例（设置页每次
 *   save/toggle/绑定后调用）
 * - 退出收尾：stopAllImChannels() 挂 before-quit
 * 状态快照：im_channels_status 从各适配器 status() 汇总（含未启动实例）；
 * 适配器 onStatus 变化同时通过 im:status 事件主动推给渲染层。
 */
import { logInfo, logWarn } from "../logging";
import { emitToWindows } from "../ipc";
import {
  registerImAdapterFactory,
  getImAdapter,
  peekImAdapter,
  removeImAdapter,
  listImAdapterPlatforms,
} from "./registry";
import { WechatAdapter } from "./adapters/wechat/wechat-adapter";
import { FeishuAdapter } from "./adapters/feishu/feishu-adapter";
import { DingTalkAdapter } from "./adapters/dingtalk/dingtalk-adapter";
import { WeComAdapter } from "./adapters/wecom/wecom-adapter";
import {
  listChannelConfigs,
  getChannelCredentials,
  isChannelBoundByCredential,
} from "./router";
import type { ImChannelStatus, ImPlatform } from "./types";
import type { ImInboundMessage } from "./types";
import { effectiveChannelStatus } from "./status";
import { handleInbound } from "./router";

let initialized = false;

/** 平台工厂登记（模块加载即注册；新平台在此加一行） */
export function registerImAdapterFactories(): void {
  registerImAdapterFactory("wechat", (channelId) => new WechatAdapter(channelId));
  registerImAdapterFactory("feishu", (channelId) => new FeishuAdapter(channelId));
  registerImAdapterFactory("dingtalk", (channelId) => new DingTalkAdapter(channelId));
  registerImAdapterFactory("wecom", (channelId) => new WeComAdapter(channelId));
}

const runningChannels = new Set<string>();
/** 最近收到过入站消息的通道：能收消息 = 连接实际可用。适配器的 authenticated
 *  事件若因 SDK 时序/漏发让状态停在 connecting，用这条事实兜底纠偏。 */
const inboundActive = new Set<string>();

/** 状态变化主动推给渲染层（im:status）：详情页无需等轮询才从“连接中”翻态 */
function broadcastChannelStatuses(): void {
  try {
    emitToWindows("im:status", channelStatuses());
  } catch (e: unknown) {
    logWarn(`[im/manager] status broadcast failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** 已点亮的 IM 通道数（退出流程决定是否把“消息通道”加入进度清单） */
export function runningImChannelCount(): number {
  return runningChannels.size;
}

/** 同通道 reconcile 串行化：保存/绑定/轮询确认可能并发触发，
 *  交错执行会出现「刚 start 又被另一个 stop」的竞态 */
const reconcileChains = new Map<string, Promise<void>>();

export function reconcileChannel(channelId: string): Promise<void> {
  const prev = reconcileChains.get(channelId) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      try {
        await reconcileChannelInner(channelId);
      } finally {
        // start/stop 本身不一定触发 onStatus（例如未绑定/未启用直接返回）
        broadcastChannelStatuses();
      }
    });
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
  // 先停该通道在所有平台的实例：注册表按 (platform, channelId) 存实例，
  // 只停新平台实例会让平台切换前的旧连接继续收消息（凭据虽已从 kv 清除，
  // 适配器内存里仍留着旧副本），入站会按新配置错路由。
  await stopChannel(channelId);
  const adapter = getImAdapter(platform, channelId);
  if (!adapter) {
    logWarn(`[im/manager] no adapter for platform=${cfg.platform}`);
    return;
  }
  const credentials = getChannelCredentials(platform, channelId);
  if (!isChannelBoundByCredential(platform, channelId)) {
    runningChannels.delete(channelId);
    return;
  }
  // 先登记 running 再 start：start 内部的 onStatus(connecting) 会立刻广播，
  // 此时 snapshot 必须已经认这个通道，否则会被当成“未启动→未连接”闪一下
  runningChannels.add(channelId);
  try {
    await adapter.start(
      {
        channelId,
        credentials,
        onStatus: (status) => {
          // 断开/重连/错误后旧入站活跃标记立即失效，避免刚断线仍显示已连接
          if (status.state !== "connected") inboundActive.delete(channelId);
          logInfo(`[im/manager] channel=${channelId} status=${status.state}`);
          broadcastChannelStatuses();
        },
      },
      (msg: ImInboundMessage) => {
        // 入站消息是连接可用的最强证据：适配器若还没报 connected（认证事件
        // 漏发/时序问题），收到消息即补上并推送，别让页面一直停在“连接中”
        const state = adapter.status().state;
        if (state === "connecting" || state === "unbound") {
          inboundActive.add(channelId);
          broadcastChannelStatuses();
        }
        void handleInbound(msg);
      },
    );
  } catch (e) {
    runningChannels.delete(channelId);
    throw e;
  }
  logInfo(`[im/manager] channel started: ${channelId} (${cfg.platform})`);
}

async function stopChannel(channelId: string): Promise<void> {
  for (const platform of listImAdapterPlatforms()) {
    const adapter = peekImAdapter(platform, channelId);
    if (adapter) await adapter.stop();
  }
  runningChannels.delete(channelId);
  inboundActive.delete(channelId);
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
    const bound = isChannelBoundByCredential(cfg.platform, cfg.id);
    const running = runningChannels.has(cfg.id);
    const adapter = running
      ? peekImAdapter(cfg.platform as ImPlatform, cfg.id)
      : undefined;
    out[cfg.id] = effectiveChannelStatus({
      running,
      bound,
      adapterState: adapter?.status(),
      inboundActive: inboundActive.has(cfg.id),
    });
  }
  return out;
}

/** 未绑定判定辅助（命令层组装 ImChannel 行用） */
export function isChannelBound(platform: string, channelId: string): boolean {
  return isChannelBoundByCredential(platform, channelId);
}
