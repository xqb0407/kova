"use client";

/**
 * 【临时验证页，验证后删除】链路追踪 / Agent loop 视图的开发预览。
 *
 * 视图本体与面板 tab 共用：
 * - trace-view.tsx：span 瀑布 + 回放 + 检查器（录制数据见 trace-fixtures.ts）
 * - loop-view.tsx：迭代视图（录制数据见 fixtures.ts）
 * 这里只负责数据源与视图切换：
 * - 录制：静态 fixtures，用来在没跑真会话时把形态摆出来
 * - 真实：list_sessions 选会话 → trace_query 拉该会话 traces
 *
 * 真实源需要 sidecar 通道，只有桌面端有——裸浏览器打开这个路由时
 * getPiChannel 会兜底造桌面通道然后炸在 invoke 上，所以这里显式挡掉。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { isDesktop } from "@/lib/desktop-env";
import { toLoopRuns } from "@/lib/pi/loop-adapter";
import { piRequest, type PiSessionSummary, type PiTraceRun } from "@/lib/pi/pi-bridge";
import { LoopExplorer } from "@/components/agent-thread/agent-panel/loop-view";
import { TraceExplorer } from "@/components/agent-thread/agent-panel/trace-view";
import { RUNS, RUN_SCALE } from "./fixtures";
import { TRACE_RUNS } from "./trace-fixtures";

/** 真实源在非 桌面壳环境下不可用（没有 sidecar 通道） */
const NEED_DESKTOP = "真实数据需要桌面端（Electron）环境：请用 electron --dev 打开本页";

type Source = "fixture" | "live";
type View = "trace" | "iteration";

export default function AgentLoopDevPreview() {
  const [source, setSource] = useState<Source>("fixture");
  const [view, setView] = useState<View>("trace");
  const [sessions, setSessions] = useState<PiSessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [records, setRecords] = useState<PiTraceRun[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [simulateLive, setSimulateLive] = useState(true);

  const load = useCallback(async (sid: string) => {
    setLoading(true);
    setErr(null);
    try {
      const res = await piRequest<{ type: "trace_query"; runs: PiTraceRun[] }>({
        type: "trace_query",
        sessionId: sid,
        limit: 200,
      });
      setRecords(res.runs);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "轨迹读取失败");
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // 切到真实源：先拉会话清单，默认最近一个，再拉它的轨迹
  useEffect(() => {
    if (source !== "live") return;
    if (!isDesktop()) {
      setErr(NEED_DESKTOP);
      setRecords([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setErr(null);
      try {
        const res = await piRequest<{ type: "sessions"; sessions: PiSessionSummary[] }>({
          type: "list_sessions",
        });
        if (cancelled) return;
        // modified 是 ISO 字符串（packages/pi-protocol sessionSummarySchema），字典序即时间序
        const list = [...res.sessions].sort((a, b) => b.modified.localeCompare(a.modified));
        setSessions(list);
        const first = list[0]?.sessionId ?? null;
        setSessionId(first);
        if (first) await load(first);
        else {
          setRecords([]);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : "会话清单读取失败");
          setRecords([]);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, load]);

  const onPickSession = useCallback(
    (sid: string) => {
      setSessionId(sid);
      void load(sid);
    },
    [load],
  );

  const fixtureRuns = useMemo(
    () => [...RUNS, RUN_SCALE].sort((a, b) => b.startMs - a.startMs),
    [],
  );
  const allRecords = source === "live" ? (records ?? []) : TRACE_RUNS;
  const loopRuns = source === "live" ? toLoopRuns(allRecords) : fixtureRuns;
  // 录制源下第一条按开关渲染成在飞；真实源下由 durationMs=null / partial 自然表达
  const liveTraceId =
    source === "fixture" && simulateLive ? (fixtureRuns[0]?.traceId ?? null) : null;

  const empty =
    loading ? (
      <span className="flex items-center gap-1.5">
        <Loader2Icon className="size-3.5 animate-spin" />
        读取轨迹…
      </span>
    ) : (
      // 失败原因优先于「还没轨迹」：否则环境问题会被误读成「没跑过会话」
      (err ??
        (source === "live"
          ? "这个会话还没有轨迹文件：跑一轮对话后，每次 agent 运行都会记在这里"
          : "没有可展示的运行"))
    );

  const toolbar = (
    <>
      <ActivityIcon className="size-3.5 shrink-0" />
      <span className="text-2xs font-semibold">Agent Loop</span>

      <div className="ml-1 flex shrink-0 items-center gap-0.5 rounded border p-0.5">
        {(
          [
            { id: "fixture" as const, label: "录制" },
            { id: "live" as const, label: "真实" },
          ] satisfies { id: Source; label: string }[]
        ).map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setSource(id);
              setErr(null);
            }}
            data-active={source === id}
            className={cn(
              "hover:bg-muted rounded px-1.5 py-0.5 text-2xs",
              source === id && "bg-selected font-medium",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-0.5 rounded border p-0.5">
        {(
          [
            { id: "trace" as const, label: "瀑布" },
            { id: "iteration" as const, label: "迭代" },
          ] satisfies { id: View; label: string }[]
        ).map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setView(id)}
            data-active={view === id}
            className={cn(
              "hover:bg-muted rounded px-1.5 py-0.5 text-2xs",
              view === id && "bg-selected font-medium",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {source === "live" ? (
        <>
          <select
            value={sessionId ?? ""}
            onChange={(e) => onPickSession(e.target.value)}
            className="border-border bg-background max-w-[240px] rounded border px-1.5 py-0.5 text-xs"
          >
            {sessions.length === 0 ? <option value="">（无会话）</option> : null}
            {sessions.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>
                {(s.name ?? s.sessionId).slice(0, 32)} · {s.messageCount} 条
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => sessionId && void load(sessionId)}
            className="hover:bg-muted flex size-6 shrink-0 items-center justify-center rounded"
            title="重新拉取轨迹（在飞 run 不在 traces 文件里，跑完才出现）"
          >
            <RefreshCwIcon className={cn("size-3", loading && "animate-spin")} />
          </button>
        </>
      ) : null}

      {source === "fixture" && view === "iteration" ? (
        <label className="flex shrink-0 cursor-pointer items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={simulateLive}
            onChange={(e) => setSimulateLive(e.target.checked)}
            className="accent-primary size-3.5"
          />
          <span className={simulateLive ? "text-amber-600 dark:text-amber-400" : ""}>
            模拟运行中
          </span>
        </label>
      ) : null}

      {err ? (
        <span className="truncate text-xs text-red-500" title={err}>
          {err}
        </span>
      ) : null}
    </>
  );

  return (
    <div className="bg-background text-foreground h-screen overflow-hidden">
      {view === "trace" ? (
        <TraceExplorer records={allRecords} toolbar={toolbar} empty={empty} />
      ) : (
        <LoopExplorer
          runs={loopRuns}
          simulateLiveTraceId={liveTraceId}
          toolbar={toolbar}
          empty={empty}
        />
      )}
    </div>
  );
}
