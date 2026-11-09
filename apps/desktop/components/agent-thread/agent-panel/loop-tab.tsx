"use client";

/**
 * 「链路追踪」tab（header「更多」唤起，tab.sessionId 绑定 sidecar 会话）：
 * 两种切法共用同一份 traces 数据——
 * - 瀑布：按真实时序看 span（开始/结束、等待关系），可拖时间轴回放整条链路；
 * - 迭代：一次迭代 = 模型意图 → N 个工具 → 结果回喂。
 *
 * 数据两条来源：
 * - 历史：trace_query 读 traces/<sessionId>.jsonl（完整 run）
 * - 在飞：trace_live_query 只读 traces/<sessionId>.live.jsonl（小文件，可轮询）
 * 按 traceId 去重合并，避免 run 收尾瞬间出现两行。
 *
 * 进程中断的 run 会以 partial + outcome.reason="interrupted" 出现——那是从增量
 * 落盘抢救回来的，只到最后一个闭合的轮（这是 trace 唯一的崩溃兜底）。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type FC } from "react";
import { Loader2Icon, RefreshCwIcon, WaypointsIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { toLoopRuns } from "@/lib/pi/loop-adapter";
import { piRequest, type PiTraceRun } from "@/lib/pi/pi-bridge";
import { usePanelActivity } from "@/lib/panels/panel-activity";
import type { PanelTab } from "@/lib/panels/panel-tabs";
import { LoopExplorer } from "./loop-view";
import { TraceExplorer } from "./trace-view";
import { TabEmpty } from "./tab-empty";

/** 在飞时的轮询间隔。轮级粒度（turn_end 才落盘），2s 足够，不必更密 */
const LIVE_POLL_MS = 2_000;

type ViewMode = "trace" | "iteration";

/** 按 traceId 合并：在飞/中断的记录优先（它们比历史行新） */
function mergeRecords(history: PiTraceRun[], live: PiTraceRun[]): PiTraceRun[] {
  const byId = new Map<string, PiTraceRun>();
  for (const r of history) byId.set(r.traceId ?? r.runId, r);
  for (const r of live) byId.set(r.traceId ?? r.runId, r);
  return [...byId.values()].sort((a, b) => b.startMs - a.startMs);
}

const ViewSwitch: FC<{ mode: ViewMode; onChange: (mode: ViewMode) => void }> = ({
  mode,
  onChange,
}) => (
  <div className="flex shrink-0 items-center gap-0.5 rounded-md border p-0.5">
    {(
      [
        { id: "trace" as const, label: "瀑布" },
        { id: "iteration" as const, label: "迭代" },
      ] satisfies { id: ViewMode; label: string }[]
    ).map(({ id, label }) => (
      <button
        key={id}
        type="button"
        onClick={() => onChange(id)}
        data-active={mode === id}
        aria-pressed={mode === id}
        className={cn(
          "hover:bg-muted rounded px-1.5 py-0.5 text-2xs transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
          mode === id && "bg-selected text-foreground font-medium",
        )}
      >
        {label}
      </button>
    ))}
  </div>
);

export const LoopTab: FC<{ tab: PanelTab }> = ({ tab }) => {
  const sessionId = tab.sessionId;
  const [mode, setMode] = useState<ViewMode>("trace");
  const [records, setRecords] = useState<PiTraceRun[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const { runningCount } = usePanelActivity();
  // 上一次拉到的在飞记录（轮询期间由它带着历史一起合并）
  const liveRef = useRef<PiTraceRun[]>([]);
  const historyRef = useRef<PiTraceRun[]>([]);

  const loadHistory = useCallback(async () => {
    if (!sessionId) return;
    setRefreshing(true);
    try {
      const res = await piRequest<{ type: "trace_query"; runs: PiTraceRun[] }>({
        type: "trace_query",
        sessionId,
        limit: 200,
      });
      historyRef.current = res.runs;
      setRecords(mergeRecords(historyRef.current, liveRef.current));
    } catch {
      // sidecar 不可用：保留现状（首次失败视为无轨迹，不报错刷屏）
      setRecords((prev) => prev ?? []);
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
      liveRef.current = res.runs;
      setRecords(mergeRecords(historyRef.current, liveRef.current));
      return true;
    } catch {
      return false;
    }
  }, [sessionId]);

  useEffect(() => {
    liveRef.current = [];
    historyRef.current = [];
    setRecords(null);
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

  // 迭代模型只在迭代视图里需要；records 稳定时别跟着工具栏状态反复重算
  const loopRuns = useMemo(
    () => (mode === "iteration" && records ? toLoopRuns(records) : []),
    [mode, records],
  );

  if (!sessionId)
    return <TabEmpty icon={WaypointsIcon} text="当前会话尚未关联运行轨迹" />;
  if (records === null)
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-1.5 text-xs leading-[1.35]">
        <Loader2Icon className="size-3.5 animate-spin" />
        读取轨迹…
      </div>
    );

  const toolbar = (
    <>
      <WaypointsIcon className="text-muted-foreground size-3.5 shrink-0" />
      <ViewSwitch mode={mode} onChange={setMode} />
      <span className="text-muted-foreground hidden text-2xs @[520px]:inline">
        {mode === "trace" ? "按时间查看 span 与回放" : "按迭代查看意图与工具"}
      </span>
      <button
        type="button"
        onClick={() => void loadHistory().then(loadLive)}
        className="hover:bg-muted hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded outline-none focus-visible:ring-1 focus-visible:ring-ring"
        title="重新拉取"
        aria-label="重新拉取轨迹"
      >
        <RefreshCwIcon className={cn("size-3", refreshing && "animate-spin")} />
      </button>
    </>
  );

  if (mode === "iteration") {
    return (
      <LoopExplorer
        runs={loopRuns}
        simulateLiveTraceId={loopRuns.find((r) => r.durationMs === null)?.traceId ?? null}
        toolbar={toolbar}
        empty="本会话还没有运行轨迹：跑一轮对话后，每次 agent 运行都会记在这里"
      />
    );
  }

  return (
    <TraceExplorer
      records={records}
      toolbar={toolbar}
      empty="本会话还没有运行轨迹：跑一轮对话后，每次 agent 运行都会记在这里"
    />
  );
};
