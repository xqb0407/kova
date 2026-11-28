/**
 * 收件箱连接器事项触发器（L1d）：连接器轮询发现新事项 → connector 触发器。
 *
 * 职责边界（与 file/git watcher 不同）：没有独立 watcher/timer——轮询由
 * inbox-connectors 管理器承担（凭证/代理/限流退避都是它的），本模块只在
 * 每轮 commitSnapshot 后被动消费"新事项"。触发器的定义事实源在 sidecar
 * （triggers.json），fire 前经 trigger-rpc 现读（与 trigger-im 同款
 * fire-and-forget，不阻塞轮询）。
 *
 * 语义纪律（调用方 inbox-connectors/manager 保证）：
 * - 仅在快照成功推给 sidecar 后触发——seenKeys 只在 push 成功后前进，
 *   提前触发会在重试轮对同一批事项重复 fire；
 * - 首次成功同步只记已见不触发（primed=false 时不进来），避免启动时对
 *   存量事项爆发触发；
 * - 同一触发器每批次至多 fire 一次，摘要只列命中该触发器过滤条件的事项
 *   （≤5 + …N more，对齐 file watcher 的防抖聚合，避免打爆全局并发闸）。
 */
import { logInfo, logWarn } from "./logging";
import { fireHostTrigger, listHostTriggers } from "./trigger-rpc";
import {
  connectorFireSummary,
  matchConnectorTriggersWithItems,
  type ConnectorItemLike,
  type ConnectorProvider,
} from "./trigger-connector-match";

/**
 * 连接器轮询产出的新事项入口（fire-and-forget）。itemKey 判重的去重面由
 * inbox-connectors 的 seenKeys 承担；这里不设冷却——每轮轮询对同一触发器
 * 至多一次 fire，天然限频。
 */
export function fireConnectorTriggers(
  provider: ConnectorProvider | string,
  connectorId: string,
  items: readonly ConnectorItemLike[],
): void {
  if (items.length === 0) return;
  void (async () => {
    let triggers;
    try {
      triggers = await listHostTriggers();
    } catch (err) {
      logWarn(
        `[triggers] connector list failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const matched = matchConnectorTriggersWithItems(triggers, {
      provider,
      connectorId,
      items: [...items],
    });
    if (matched.length === 0) return;
    for (const { trigger, items: matchedItems } of matched) {
      // 摘要只含命中该触发器过滤条件的事项：{{trigger.summary}} 是 run 的
      // 唯一上下文来源，把未命中的批次混进去会误导 prompt
      const summary = connectorFireSummary(provider, matchedItems);
      try {
        const task = await fireHostTrigger(trigger.taskId, {
          type: "connector",
          id: trigger.id,
          summary,
        });
        if (!task) {
          logWarn(`[triggers] connector trigger ${trigger.id}: task not found`);
          continue;
        }
        logInfo(`[triggers] fired connector trigger ${trigger.id} (${provider})`);
      } catch (err) {
        logWarn(
          `[triggers] connector fire failed (${trigger.id}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  })();
}
