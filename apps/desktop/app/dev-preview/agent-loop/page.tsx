"use client";

/**
 * 【临时验证页，验证后删除】Agent loop 视图的开发预览。
 *
 * 视图本体与「循环」面板 tab 共用 components/agent-thread/agent-panel/loop-view.tsx，
 * 这里只负责数据源切换：
 * - 录制：静态 fixtures（半路 / 正常+委派 / 大会话扇出 / 失败链路四种形状），
 *   用来在没跑真会话时把形态摆出来
 * - 真实：list_sessions 选会话 → trace_query 拉该会话 traces → loop-adapter 映射
 *
 * 真实源需要 sidecar 通道，只有 Tauri 桌面端有——裸浏览器打开这个路由时
 * getPiChannel 会兜底造 Tauri 通道然后炸在 invoke 上，所以这里显式挡掉。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri";
import { toLoopRuns } from "@/lib/pi/loop-adapter";
import { piRequest, type PiSessionSummary, type PiTraceRun } from "@/lib/pi/pi-bridge";
import type { LoopRun } from "@/lib/pi/loop-model";
import { LoopExplorer } from "@/components/agent-thread/agent-panel/loop-view";
import { RUNS, RUN_SCALE } from "./fixtures";

/** 真实源在非 Tauri 环境下不可用（没有 sidecar 通道） */
const NEED_DESKTOP = "真实数据需要桌面端（Tauri）环境：请用 bun run tauri:dev 打开本页";

export default function AgentLoopDevPreview() {
  const [source, setSource] = useState<"fixture" | "live">("fixture");
  const [sessions, setSessions] = useState<PiSessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [liveRuns, setLiveRuns] = useState<LoopRun[] | null>(null);
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
      setLiveRuns(toLoopRuns(res.runs).sort((a, b) => b.startMs - a.startMs));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "轨迹读取失败");
      setLiveRuns([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // 切到真实源：先拉会话清单，默认最近一个，再拉它的轨迹
  useEffect(() => {
    if (source !== "live") return;
    if (!isTauri()) {
      setErr(NEED_DESKTOP);
      setLiveRuns([]);
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
          setLiveRuns([]);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : "会话清单读取失败");
          setLiveRuns([]);
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
  const allRuns = source === "live" ? (liveRuns ?? []) : fixtureRuns;
  // 录制源下第一条按开关渲染成在飞；真实源下由 durationMs=null 自然表达
  const liveTraceId =
    source === "fixture" && simulateLive ? (fixtureRuns[0]?.traceId ?? null) : null;

  return (
    <div className="bg-background text-foreground h-screen overflow-hidden">
      <LoopExplorer
        runs={allRuns}
        simulateLiveTraceId={liveTraceId}
        toolbar={
          <>
            <ActivityIcon className="size-3.5 shrink-0" />
            <span className="text-[12px] font-semibold">Agent Loop</span>

            <div className="ml-1 flex items-center gap-0.5 rounded border p-0.5">
              {(
                [
                  { id: "fixture" as const, label: "录制" },
                  { id: "live" as const, label: "真实" },
                ] satisfies { id: "fixture" | "live"; label: string }[]
              ).map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSource(id)}
                  data-active={source === id}
                  className={cn(
                    "hover:bg-muted rounded px-1.5 py-0.5 text-[11px]",
                    source === id && "bg-muted font-medium",
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
                  className="border-border bg-background max-w-[260px] rounded border px-1.5 py-0.5 text-[11px]"
                >
                  {sessions.length === 0 ? <option value="">（无会话）</option> : null}
                  {sessions.map((s) => (
                    <option key={s.sessionId} value={s.sessionId}>
                      {(s.name ?? s.sessionId).slice(0, 36)} · {s.messageCount} 条
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => sessionId && void load(sessionId)}
                  className="hover:bg-muted flex size-6 items-center justify-center rounded"
                  title="重新拉取轨迹（在飞 run 不在 traces 文件里，跑完才出现）"
                >
                  <RefreshCwIcon className={cn("size-3", loading && "animate-spin")} />
                </button>
              </>
            ) : (
              <label className="flex cursor-pointer items-center gap-1 text-[11px]">
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
            )}

            {err ? (
              <span className="truncate text-[11px] text-red-500" title={err}>
                {err}
              </span>
            ) : null}
          </>
        }
        empty={
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
          )
        }
      />
    </div>
  );
}
