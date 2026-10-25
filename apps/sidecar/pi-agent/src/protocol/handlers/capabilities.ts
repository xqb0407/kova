/**
 * 能力装配层的控制面：读取诊断快照、应用开关。
 * 变更只重建驻留 run 的工具表与系统提示词，不重建 Agent。
 */
import type { CommandHandler } from "../command";
import { send } from "../stream";
import {
  applyCapabilityEnablement,
  applyCapabilitySettings,
  getCapabilitiesPayload,
} from "../../agent/assembly";
import { logErr } from "../../log";

function sessionIdOf(msg: Record<string, unknown>): string | undefined {
  const value = msg.sessionId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const handlers: Record<string, CommandHandler> = {
  get_capabilities: async (reqId, msg) => {
    send({
      id: reqId,
      type: "capabilities",
      ...getCapabilitiesPayload(sessionIdOf(msg)),
    });
  },

  set_capabilities: async (reqId, msg) => {
    if (msg.settings === undefined) {
      throw new Error("set_capabilities: settings is required");
    }
    // 目前只有全局开关；带 sessionId 误用会被静默忽略，显式拒绝更能暴露调用方错误
    if (sessionIdOf(msg)) {
      throw new Error("set_capabilities: applies globally; sessionId is not accepted");
    }
    const settings = await applyCapabilitySettings(msg.settings);
    applyCapabilityEnablement(settings);
    // 动态导入：sessions/resolve 经 automation 链回到 protocol.ts，静态导入
    // 会在模块初始化时形成环（protocol.ts 的 registry 读到尚未初始化的 handler）。
    const { reloadCapabilityTools } = await import("../../sessions/resolve");
    // 设置此刻已持久化：重建逐 run 隔离，失败面回报给前端而不是整个命令报错
    const reloadFailures = await reloadCapabilityTools();
    for (const failure of reloadFailures) {
      // 失败的 run 保留旧工具表，下一次 resolve/重载自愈；日志留痕便于排查
      logErr(
        `set_capabilities: run reload failed (${failure.threadId}):`,
        failure.message,
      );
    }
    send({
      id: reqId,
      type: "capabilities",
      ...getCapabilitiesPayload(),
      ...(reloadFailures.length > 0 ? { reloadFailures } : {}),
    });
  },
};
