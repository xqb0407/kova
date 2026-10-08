"use client";

/**
 * Agent loop tab（header「更多」唤起，tab.sessionId 绑定 sidecar 会话）。
 *
 * 与「链路追踪」tab 的分工：那边是 span 瀑布（按 llm/tool/retry 类型看耗时），
 * 这边是迭代视图（一次迭代 = 模型意图 → N 个工具 → 结果回喂）。同一个会话
 * 同一份 traces 数据，两种切法。
 *
 * 数据两条来源：
 * - 历史：trace_query 读 traces/<sessionId>.jsonl（完整 run）
 * - 在飞：trace_live_query 只读 traces/<sessionId>.live.jsonl（小文件，可轮询）
 * 按 traceId 去重合并，避免 run 收尾瞬间出现两行。
 *
 * 进程中断的 run 会以 partial + outcome.reason="interrupted" 出现——那是从增量
 * 落盘抢救回来的，只到最后一个闭合的轮（这是 trace 唯一的崩溃兜底）。
 */

import { useCallback, useEffect, useRef, useState, type FC } from "react";
import { Loader2Icon, RefreshCwIcon, WaypointsIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { toLoopRuns } from "@/lib/pi/loop-adapter";
import { piRequest, type PiTraceRun } from "@/lib/pi/pi-bridge";
import type { LoopRun } from "@/lib/pi/loop-model";
import { usePanelActivity } from "@/lib/panels/panel-activity";
import type { PanelTab } from "@/lib/panels/panel-tabs";
import { LoopExplorer } from "./loop-view";
import { TabEmpty } from "./tab-empty";

/** 在飞时的轮询间隔。轮级粒度（turn_end 才落盘），2s 足够，不必更密 */
const LIVE_POLL_MS = 2_000;

/** 按 traceId 合并：在飞/中断的记录优先（它们比历史行新） */
function mergeRuns(history: LoopRun[], live: LoopRun[]): LoopRun[] {
  const byId = new Map<string, LoopRun>();
  for (const r of history) byId.set(r.traceId, r);
  for (const r of live) byId.set(r.traceId, r);
  return [...byId.values()].sort((a, b) => b.startMs - a.startMs);
}

export const LoopTab: FC<{ tab: PanelTab }> = ({ tab }) => {
  const sessionId = tab.sessionId;
  const [runs, setRuns] = useState<LoopRun[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const { runningCount } = usePanelActivity();
  // 上一次拉到的在飞记录（轮询期间由它带着历史一起合并）
  const liveRef = useRef<LoopRun[]>([]);
  const historyRef = useRef<LoopRun[]>([]);

  const loadHistory = useCallback(async () => {
    if (!sessionId) return;
    setRefreshing(true);
    try {
      const res = await piRequest<{ type: "trace_query"; runs: PiTraceRun[] }>({
        type: "trace_query",
        sessionId,
        limit: 200,
      });
      historyRef.current = toLoopRuns(res.runs);
      setRuns(mergeRuns(historyRef.current, liveRef.current));
    } catch {
      // sidecar 不可用：保留现状（首次失败视为无轨迹，不报错刷屏）
      setRuns((prev) => prev ?? []);
    } finally {
      setRefreshing(false);
    }
  }, [sessionId]);

  // 在飞记录：只读小文件。命令在老 sidecar 上可能不存在（dev 模式热更新错配），
  // 失败就静默停掉轮询，不能让 tab 崩
  const loadLive = useCallback(async (): Promise<boolean> => {
    if (!sessionId) return false;
    try {
      const res = await piRequest<{ type: "trace_live_query"; runs: PiTraceRun[] }>({
        type: "trace_live_query",
        sessionId,
      });
      liveRef.current = toLoopRuns(res.runs);
      setRuns(mergeRuns(historyRef.current, liveRef.current));
      return true;
    } catch {
      return false;
    }
  }, [sessionId]);

  useEffect(() => {
    liveRef.current = [];
    historyRef.current = [];
    void (async () => {
      await loadHistory();
      await loadLive();
    })();
  }, [loadHistory, loadLive]);

  // 有在途活动时按秒轮询在飞文件；空闲时停（不在飞就没有新东西）
  useEffect(() => {
    if (!sessionId || runningCount === 0) return;
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      void loadLive().then((ok) => {
        if (!ok) {
          stopped = true;
          clearInterval(timer);
        }
      });
    }, LIVE_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [sessionId, runningCount, loadLive]);

  // 活动边沿（有在途工具 → 全空闲）：run 刚收尾落盘，重拉一次完整历史
  const prevRunningRef = useRef(runningCount);
  useEffect(() => {
    if (prevRunningRef.current > 0 && runningCount === 0) {
      void (async () => {
        await loadHistory();
        // 收尾后 live 里本 run 的行已被清，刷新一下免得残留
        await loadLive();
      })();
    }
    prevRunningRef.current = runningCount;
  }, [runningCount, loadHistory, loadLive]);

  if (!sessionId)
    return <TabEmpty icon={WaypointsIcon} text="当前会话尚未关联运行轨迹" />;
  if (runs === null)
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-1.5 text-[12px] leading-[1.35]">
        <Loader2Icon className="size-3.5 animate-spin" />
        读取轨迹…
      </div>
    );

  return (
    <LoopExplorer
      runs={runs}
      // 在飞的 run 由 adapter 编码成 durationMs=null（中断残留则已定格成有限时长），
      // 据此交给视图渲染「运行中」与未收口步骤的脉冲
      simulateLiveTraceId={runs.find((r) => r.durationMs === null)?.traceId ?? null}
      toolbar={
        <>
          <WaypointsIcon className="text-muted-foreground size-3.5 shrink-0" />
          <span className="text-muted-foreground text-[11px]">
            按迭代查看循环结构
          </span>
          <button
            type="button"
            onClick={() => void loadHistory().then(loadLive)}
            className="hover:bg-muted hover:text-foreground ml-auto flex size-6 items-center justify-center rounded"
            title="重新拉取"
          >
            <RefreshCwIcon className={cn("size-3", refreshing && "animate-spin")} />
          </button>
        </>
      }
      empty="本会话还没有运行轨迹：跑一轮对话后，每次 agent 运行都会记在这里"
    />
  );
};
