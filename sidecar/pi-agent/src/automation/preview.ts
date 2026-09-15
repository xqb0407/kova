/**
 * 本地文件（非 vendored）：排期预览 —— 管理表单/前端展示"未来 N 个触发点"，
 * 复用 vendored 校验（resolveScheduledTaskDefinition 对非法 cron/interval/
 * 过期 once 抛错），这里翻译成 {error} 返回而非抛出（表单要红字提示）。
 * 触发点语义与各类型真实调度一致：cron = croner 未来 tick；
 * interval = 从预览时刻起每周期一格（重启后 setInterval 语义）；
 * once = 唯一目标时刻。
 */
import { Cron } from "croner";
import {
  resolveScheduledTaskDefinition,
  scheduleExpressionForCroner,
  type ScheduledTaskType,
} from "./index";

const MAX_RUNS = 10;

export type PreviewInput = {
  type?: unknown;
  schedule?: unknown;
  count?: unknown;
};

export type PreviewResult = { runs: string[] } | { error: string };

export function previewSchedule(
  input: PreviewInput,
  nowMs: number = Date.now(),
): PreviewResult {
  try {
    const def = resolveScheduledTaskDefinition({
      type: input.type as ScheduledTaskType,
      schedule: typeof input.schedule === "string" ? input.schedule : undefined,
    });
    const n = Math.min(
      MAX_RUNS,
      Math.max(1, Math.floor(typeof input.count === "number" ? input.count : 5)),
    );
    if (def.type === "interval") {
      const runs: string[] = [];
      for (let k = 1; k <= n; k++) {
        runs.push(new Date(nowMs + k * def.intervalSeconds * 1000).toISOString());
      }
      return { runs };
    }
    if (def.type === "once") {
      // resolveOnceSchedule 已保证是未来时刻并归一为 ISO
      return { runs: [def.schedule] };
    }
    const cron = new Cron(scheduleExpressionForCroner(def.schedule), { paused: true });
    const dates = cron.nextRuns(n, new Date(nowMs));
    cron.stop();
    return { runs: dates.map((d) => d.toISOString()) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
