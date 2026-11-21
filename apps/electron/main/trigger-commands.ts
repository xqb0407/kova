/**
 * 事件触发相关的宿主命令（L1）：webhook endpoint 信息 + watcher 就近重同步。
 * 触发器 CRUD 全部走 sidecar 协议；这里不重复实现。
 */
import { webhookPort } from "./webhook-server";
import { resyncTriggerWatchers, watcherCount } from "./trigger-watchers";

export function setupTriggerCommands(
  register: (name: string, fn: (args: any) => any) => void,
): void {
  register("webhook_info", () => ({ port: webhookPort() }));
  // UI 改完触发器后调用：main 看不到 sidecar 的写盘，不必等 30s 周期
  register("triggers_sync", async () => {
    await resyncTriggerWatchers();
    return watcherCount();
  });
}
