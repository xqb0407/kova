/**
 * IM 通道对外状态判定（纯函数）：manager 的 channelStatuses 与单测共用。
 *
 * 输入是进程内事实：
 * - running：manager 是否已登记该通道（start 已受理）；
 * - bound：凭据是否仍存在；
 * - adapterState：适配器自己报告的状态；
 * - inboundActive：最近是否真的收到过入站消息。
 *
 * 规则优先级：未启动 → unbound；适配器 error/reauth 不被入站兜底覆盖；
 * connecting/unbound 但确实收到过消息 → connected；已绑定却报 unbound → connecting。
 */
import type { ImChannelStatus } from "./types";

export function effectiveChannelStatus(args: {
  running: boolean;
  bound: boolean;
  adapterState?: ImChannelStatus;
  inboundActive: boolean;
}): ImChannelStatus {
  if (!args.running) return { state: "unbound" };
  let status = args.adapterState ?? { state: "unbound" as const };
  if (
    args.bound &&
    args.inboundActive &&
    (status.state === "connecting" || status.state === "unbound")
  ) {
    status = { state: "connected" };
  }
  return args.bound && status.state === "unbound"
    ? { state: "connecting" }
    : status;
}
