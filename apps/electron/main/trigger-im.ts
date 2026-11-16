/**
 * IM 旁路触发器（L1c）：消息照常进绑定会话/命令处理，同时命中条件的
 * 触发器各 fire 一次 automation（不拦截、不改写会话流）。
 *
 * 并发/权限口径与其它触发源一致：run 走 scheduler.runWithContext（无人值守
 * 策略不放宽）；同触发器 5s 冷却，避免群聊连发把任务打爆。
 */
import { logInfo, logWarn } from "./logging";
import { fireHostTrigger, listHostTriggers } from "./trigger-rpc";
import { imTriggerSummary, matchImTriggers } from "./trigger-im-match";
import type { ImInboundMessage } from "./im/types";

const COOLDOWN_MS = 5_000;
const cooldownUntil = new Map<string, number>();

/** 命中即触发（fire-and-forget：不阻塞消息路由与回复链路） */
export function fireImTriggers(msg: ImInboundMessage): void {
  void (async () => {
    let triggers;
    try {
      triggers = await listHostTriggers();
    } catch (err) {
      logWarn(`[triggers] im list failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const matched = matchImTriggers(triggers, {
      platform: msg.platform,
      chatId: msg.chatId,
      text: msg.text,
    });
    if (matched.length === 0) return;
    const now = Date.now();
    for (const [id, until] of cooldownUntil) if (until <= now) cooldownUntil.delete(id);
    for (const trigger of matched) {
      if ((cooldownUntil.get(trigger.id) ?? 0) > now) continue;
      cooldownUntil.set(trigger.id, now + COOLDOWN_MS);
      try {
        const task = await fireHostTrigger(trigger.taskId, {
          type: "im",
          id: trigger.id,
          summary: imTriggerSummary(msg),
        });
        if (!task) {
          logWarn(`[triggers] im trigger ${trigger.id}: task not found`);
          continue;
        }
        logInfo(`[triggers] fired im trigger ${trigger.id} (${msg.platform})`);
      } catch (err) {
        logWarn(
          `[triggers] im fire failed (${trigger.id}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  })();
}
