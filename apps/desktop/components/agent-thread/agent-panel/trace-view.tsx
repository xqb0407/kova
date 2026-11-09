"use client";

/**
 * 链路追踪（瀑布视图）：一次 agent run 的 span 时间轴 + 回放 + 检查器。
 *
 * 与 loop-view 的分工：那边按迭代读「模型意图 → 工具 → 回喂」，这里按真实时序
 * 读「谁先开始、谁等谁、总耗时花在哪」。回放把时间轴变成可拖的游标：游标之前
 * 的 span 着色，之后只留灰色轨道，点「回放」从头走一遍，用来复现一次失败链路
 * 的先后关系。
 *
 * 布局按面板宽度自适应：宽面板检查器在右侧；窄面板（默认 500px）落到下方，
 * 不挤压时间轴的可读宽度。
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from "react";
import {
  BanIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleXIcon,
  CpuIcon,
  HistoryIcon,
  LayersIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  Repeat2Icon,
  RotateCcwIcon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { extractIntent } from "@/lib/pi/loop-adapter";
import type { PiTraceRun } from "@/lib/pi/pi-bridge";
import {
  defaultCollapsed,
  flattenTraceSpans,
  formatTraceDate,
  formatTraceDuration,
  formatTraceTick,
  formatTraceTokens,
  traceRunFlags,
  traceStatusLabel,
  traceTimeTicks,
  traceUsageTotal,
  toTraceViewRuns,
  type TraceCategory,
  type TraceRow,
  type TraceSpanNode,
  type TraceUsage,
  type TraceViewRun,
} from "@/lib/pi/trace-view-model";

/* ============================== 展示常量 ============================== */

type IconComponent = FC<{ className?: string }>;

const CATEGORY_META: Record<
  TraceCategory,
  {
    label: string;
    icon: IconComponent;
    dot: string;
    bar: string;
    text: string;
    pill: string;
  }
> = {
  agent: {
    label: "Agent",
    icon: BotIcon,
    dot: "bg-sky-500",
    bar: "bg-sky-500",
    text: "text-sky-600 dark:text-sky-400",
    pill: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  llm: {
    label: "LLM",
    icon: CpuIcon,
    dot: "bg-violet-500",
    bar: "bg-violet-500",
    text: "text-violet-600 dark:text-violet-400",
    pill: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
  tool: {
    label: "工具",
    icon: WrenchIcon,
    dot: "bg-teal-500",
    bar: "bg-teal-500",
    text: "text-teal-600 dark:text-teal-400",
    pill: "border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-300",
  },
  retry: {
    label: "重试",
    icon: Repeat2Icon,
    dot: "bg-amber-500",
    bar: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
    pill: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
};

const KIND_LABEL: Record<TraceSpanNode["kind"], string> = {
  run: "Agent",
  turn: "轮次",
  llm_call: "LLM 调用",
  tool_call: "工具调用",
  retry: "Provider 重试",
};

const TONE_PILL: Record<"ok" | "warn" | "error" | "live", string> = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  error: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  live: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
};

const TONE_DOT: Record<"ok" | "warn" | "error" | "live", string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-rose-500",
  live: "bg-sky-500",
};

const shortModel = (model: string | undefined): string | undefined => {
  if (!model) return undefined;
  const i = model.lastIndexOf("/");
  return i >= 0 && i < model.length - 1 ? model.slice(i + 1) : model;
};

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

const pct = (part: number, total: number): number =>
  total > 0 ? clamp((part / total) * 100, 0, 100) : 0;

/* ============================== 小部件 ============================== */

const SectionLabel: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="text-2xs text-muted-foreground font-medium tracking-[0.05em] uppercase">
    {children}
  </div>
);

const StatusPill: FC<{ run: TraceViewRun }> = ({ run }) => {
  const base = traceStatusLabel(run);
  // 回放每 33ms 刷新一次父组件；flags 只跟 run 树有关，别跟着游标重算
  const flags = useMemo(() => traceRunFlags(run.root), [run.root]);
  const running = run.running;
  let tone = running ? "live" : base.tone;
  let label = running ? "运行中" : base.label;
  // 成功收尾但链路里有失败/重试：仍算完成，用告警色把「不干净」标出来
  if (!running && tone === "ok" && (flags.failures > 0 || flags.retries > 0)) {
    tone = "warn";
    const bits = [
      flags.retries > 0 ? `${flags.retries} 次重试` : null,
      flags.failures > 0 ? `${flags.failures} 个失败` : null,
    ].filter(Boolean);
    label = `${label} · ${bits.join(" · ")}`;
  }
  const Icon =
    tone === "live"
      ? Loader2Icon
      : tone === "error"
        ? CircleXIcon
        : tone === "warn"
          ? CircleAlertIcon
          : CircleCheckIcon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium",
        TONE_PILL[tone],
      )}
    >
      <Icon className={cn("size-3 shrink-0", tone === "live" && "animate-spin")} />
      {label}
    </span>
  );
};

const Stat: FC<{ label: string; value: string; title?: string }> = ({
  label,
  value,
  title,
}) => (
  <div className="min-w-0 text-right" title={title}>
    <div className="text-2xs text-muted-foreground truncate">{label}</div>
    <div className="text-sm font-medium tabular-nums @[620px]:text-base">{value}</div>
  </div>
);

/* ============================== 回放状态 ============================== */

type ReplayState = {
  active: boolean;
  positionMs: number;
  playing: boolean;
  speed: number;
};

type RunTraceProps = {
  run: TraceViewRun;
  runs: TraceViewRun[];
  onPickRun: (traceId: string) => void;
};

const RunTrace: FC<RunTraceProps> = ({ run, runs, onPickRun }) => {
  const duration = Math.max(1, run.durationMs);
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    defaultCollapsed(run.root),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replay, setReplay] = useState<ReplayState>({
    active: false,
    positionMs: duration,
    playing: false,
    speed: 1,
  });
  const posRef = useRef(duration);

  const rows = useMemo(
    () => flattenTraceSpans(run.root, collapsed),
    [run.root, collapsed],
  );
  const selected = useMemo(
    () => (selectedId ? findNode(run.root, selectedId) : null),
    [run.root, selectedId],
  );

  const startReplay = useCallback(() => {
    posRef.current = 0;
    setReplay({ active: true, positionMs: 0, playing: true, speed: 1 });
  }, []);

  const exitReplay = useCallback(() => {
    posRef.current = duration;
    setReplay((s) => ({ ...s, active: false, playing: false, positionMs: duration }));
  }, [duration]);

  const togglePlay = useCallback(() => {
    setReplay((s) => {
      if (!s.active) {
        posRef.current = 0;
        return { active: true, positionMs: 0, playing: true, speed: 1 };
      }
      if (s.playing) return { ...s, playing: false };
      const fromStart = s.positionMs >= duration;
      const next = fromStart ? 0 : s.positionMs;
      posRef.current = next;
      return { ...s, positionMs: next, playing: true };
    });
  }, [duration]);

  const seek = useCallback(
    (ms: number) => {
      const next = clamp(ms, 0, duration);
      posRef.current = next;
      // 手动拖时间轴视为暂停态：让用户停在要看的那一刻
      setReplay((s) => ({ ...s, active: true, playing: false, positionMs: next }));
    },
    [duration],
  );

  const cycleSpeed = useCallback(() => {
    setReplay((s) => ({ ...s, speed: s.speed >= 4 ? 1 : s.speed * 2 }));
  }, []);

  // 回放推进：按墙钟锚点计算位置。用 interval 而不是 rAF——面板/窗口在后台时
  // rAF 会被完全暂停，回来时游标还停在原地；墙钟锚点让节流后的下一次 tick
  // 直接追上真实经过的时间。
  useEffect(() => {
    if (!replay.active || !replay.playing) return;
    const anchorWall = performance.now();
    const anchorPos = posRef.current;
    const timer = setInterval(() => {
      const next = Math.min(
        duration,
        anchorPos + (performance.now() - anchorWall) * replay.speed,
      );
      posRef.current = next;
      if (next >= duration) {
        setReplay((s) => ({ ...s, positionMs: duration, playing: false }));
        clearInterval(timer);
        return;
      }
      setReplay((s) => ({ ...s, positionMs: next }));
    }, 33);
    return () => clearInterval(timer);
  }, [replay.active, replay.playing, replay.speed, duration]);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-card">
        <RunHeader
          run={run}
          runs={runs}
          onPickRun={onPickRun}
          replay={replay}
          onStartReplay={startReplay}
          onExitReplay={exitReplay}
          onTogglePlay={togglePlay}
          onCycleSpeed={cycleSpeed}
        />
        <div className="flex min-h-0 flex-1 flex-col border-t @[860px]:flex-row">
          <Waterfall
            run={run}
            rows={rows}
            collapsed={collapsed}
            onToggleCollapse={toggleCollapse}
            selectedId={selectedId}
            onSelect={setSelectedId}
            replay={replay}
            onSeek={seek}
            onTogglePlay={togglePlay}
          />
          <SpanInspector
            span={selected}
            run={run}
            replay={replay}
            onClose={() => setSelectedId(null)}
          />
        </div>
      </div>
    </div>
  );
};

function findNode(root: TraceSpanNode, id: string): TraceSpanNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

/* ============================== 头部 ============================== */

/** 运行下拉条目：单独 memo，回放刷新的每一帧不重算所有 run 的 flags */
const RunMenuItems = memo(function RunMenuItems({
  runs,
  onPickRun,
}: {
  runs: TraceViewRun[];
  onPickRun: (traceId: string) => void;
}) {
  return (
    <>
      {runs.map((r) => {
        const flags = traceRunFlags(r.root);
        const tone = r.running
          ? "live"
          : r.status === "error"
            ? "error"
            : flags.failures > 0 || flags.retries > 0
              ? "warn"
              : r.status === "aborted"
                ? "warn"
                : "ok";
        return (
          <DropdownMenuItem
            key={r.traceId}
            onClick={() => onPickRun(r.traceId)}
            className="flex-col items-stretch gap-0.5"
          >
            <span className="flex items-center gap-1.5">
              <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone])} />
              <span className="text-xs font-medium tabular-nums">
                {formatTraceDate(r.startMs)}
              </span>
              <span className="text-3xs text-muted-foreground ml-auto tabular-nums">
                {formatTraceDuration(r.durationMs)}
              </span>
            </span>
            <span className="text-2xs text-muted-foreground truncate">
              {r.agentName ?? shortModel(r.model) ?? "agent"} · {r.spanCount} span ·{" "}
              {formatTraceTokens(traceUsageTotal(r.usage))} tok
            </span>
          </DropdownMenuItem>
        );
      })}
    </>
  );
});

const RunHeader: FC<{
  run: TraceViewRun;
  runs: TraceViewRun[];
  onPickRun: (traceId: string) => void;
  replay: ReplayState;
  onStartReplay: () => void;
  onExitReplay: () => void;
  onTogglePlay: () => void;
  onCycleSpeed: () => void;
}> = ({
  run,
  runs,
  onPickRun,
  replay,
  onStartReplay,
  onExitReplay,
  onTogglePlay,
  onCycleSpeed,
}) => {
  const headline = useMemo(() => firstIntent(run.root), [run.root]);
  const runLabel = run.agentName ?? shortModel(run.model) ?? "Agent";
  const title = headline ? `${runLabel} · ${headline}` : runLabel;
  const runIndex = runs.findIndex((r) => r.traceId === run.traceId);
  const totalTokens = traceUsageTotal(run.usage);

  return (
    <div className="shrink-0 px-3 pt-2.5 pb-2">
      <div className="text-2xs text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="max-w-[45%] truncate font-mono">
          run_{run.traceId.slice(0, 8)}
        </span>
        <span aria-hidden>·</span>
        <span className="shrink-0">{formatTraceDate(run.startMs)}</span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label="切换运行记录"
                className="hover:bg-muted hover:text-foreground flex items-center gap-1 rounded px-1 py-0.5 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            }
          >
            <HistoryIcon className="size-3" />
            <span className="tabular-nums">
              {runIndex >= 0 ? runIndex + 1 : 1}/{runs.length}
            </span>
            <ChevronDownIcon className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <RunMenuItems runs={runs} onPickRun={onPickRun} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mt-1.5 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2
            className="text-foreground truncate text-sm leading-5 font-semibold @[620px]:text-base @[620px]:leading-6"
            title={title}
          >
            {title}
          </h2>
          <div className="mt-1.5">
            <StatusPill run={run} />
          </div>
        </div>
        <div className="grid shrink-0 grid-cols-4 gap-x-2 @[620px]:gap-x-4">
          <Stat label="时长" value={formatTraceDuration(run.durationMs)} />
          <Stat label="跨度" value={String(run.spanCount)} />
          <Stat
            label="Tokens"
            value={formatTraceTokens(totalTokens)}
            title={`输入 ${run.usage.input.toLocaleString()} · 输出 ${run.usage.output.toLocaleString()} · 缓存读 ${run.usage.cacheRead.toLocaleString()} · 缓存写 ${run.usage.cacheWrite.toLocaleString()}`}
          />
          <Stat
            label="缓存"
            value={formatTraceTokens(run.usage.cacheRead)}
            title="缓存命中的输入 token（不重复计费的部分）"
          />
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t pt-2">
        {(Object.keys(CATEGORY_META) as TraceCategory[]).map((key) => {
          const meta = CATEGORY_META[key];
          return (
            <span
              key={key}
              className="text-muted-foreground flex items-center gap-1 rounded-full border border-border/70 px-1.5 py-0.5 text-2xs"
            >
              <span className={cn("size-1.5 rounded-full", meta.dot)} />
              {meta.label}
            </span>
          );
        })}

        <div className="ml-auto flex items-center gap-1">
          {replay.active ? (
            <>
              <span className="text-foreground font-mono text-3xs tabular-nums">
                {formatTraceDuration(replay.positionMs)}
              </span>
              <span className="text-muted-foreground text-3xs">/</span>
              <span className="text-muted-foreground font-mono text-3xs tabular-nums">
                {formatTraceDuration(run.durationMs)}
              </span>
              <TooltipIconButton
                tooltip={
                  replay.playing
                    ? "暂停回放"
                    : replay.positionMs >= run.durationMs
                      ? "从头回放"
                      : "继续回放"
                }
                onClick={onTogglePlay}
                className="size-6 focus-visible:ring-1 focus-visible:ring-ring"
              >
                {replay.playing ? (
                  <PauseIcon className="size-3" />
                ) : (
                  <PlayIcon className="size-3" />
                )}
              </TooltipIconButton>
              <button
                type="button"
                onClick={onCycleSpeed}
                className="hover:bg-muted text-muted-foreground hover:text-foreground rounded px-1 py-0.5 font-mono text-3xs tabular-nums transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label={`回放速度 ${replay.speed} 倍，点击切换`}
                title="回放速度"
              >
                {replay.speed}×
              </button>
              <TooltipIconButton
                tooltip="退出回放"
                onClick={onExitReplay}
                className="size-6 focus-visible:ring-1 focus-visible:ring-ring"
              >
                <XIcon className="size-3" />
              </TooltipIconButton>
            </>
          ) : (
            <button
              type="button"
              onClick={onStartReplay}
              className="hover:bg-muted text-foreground flex items-center gap-1 rounded-full border border-border/80 px-2 py-0.5 text-2xs transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <RotateCcwIcon className="size-3" />
              回放
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/** 第一个 LLM 回复的首句：整条 run 的任务摘要（与迭代视图的 intent 同源） */
function firstIntent(root: TraceSpanNode): string | undefined {
  const walk = (span: TraceSpanNode): string | undefined => {
    if (span.kind === "llm_call" && span.detail?.response) {
      const intent = extractIntent(span.detail.response);
      if (intent) return intent;
    }
    for (const child of span.children) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(root);
}

/* ============================== 瀑布 ============================== */

const Waterfall: FC<{
  run: TraceViewRun;
  rows: TraceRow[];
  collapsed: ReadonlySet<string>;
  onToggleCollapse: (id: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  replay: ReplayState;
  onSeek: (ms: number) => void;
  onTogglePlay: () => void;
}> = ({
  run,
  rows,
  collapsed,
  onToggleCollapse,
  selectedId,
  onSelect,
  replay,
  onSeek,
  onTogglePlay,
}) => {
  const duration = Math.max(1, run.durationMs);
  const ticks = useMemo(() => traceTimeTicks(duration, 5), [duration]);
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const playheadPct = replay.active ? pct(replay.positionMs, duration) : 0;

  const seekFromClientX = (clientX: number) => {
    const el = rulerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    onSeek(clamp((clientX - rect.left) / rect.width, 0, 1) * duration);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col [--trace-label-w:150px] @[720px]:[--trace-label-w:210px]">
      {/* 刻度尺：既是时间轴表头，也是回放的拖拽/键盘入口 */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2">
        <span className="text-2xs text-muted-foreground w-[var(--trace-label-w)] shrink-0">
          跨度
        </span>
        <div
          ref={rulerRef}
          role="slider"
          tabIndex={0}
          aria-label="回放时间轴"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(replay.active ? replay.positionMs : duration)}
          aria-valuetext={`${formatTraceDuration(
            replay.active ? replay.positionMs : duration,
          )} / ${formatTraceDuration(duration)}`}
          onPointerDown={(e) => {
            draggingRef.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            seekFromClientX(e.clientX);
          }}
          onPointerMove={(e) => {
            if (draggingRef.current) seekFromClientX(e.clientX);
          }}
          onPointerUp={(e) => {
            draggingRef.current = false;
            e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onPointerCancel={() => {
            draggingRef.current = false;
          }}
          onKeyDown={(e) => {
            const step = Math.max(50, duration / 100);
            // 非回放态游标视为停在末尾：ArrowLeft 从这里往回拖，而不是从 0 开始
            const current = replay.active ? replay.positionMs : duration;
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              onSeek(clamp(current + (e.key === "ArrowRight" ? step : -step), 0, duration));
            } else if (e.key === "Home") {
              e.preventDefault();
              onSeek(0);
            } else if (e.key === "End") {
              e.preventDefault();
              onSeek(duration);
            } else if (e.key === " " || e.key === "Enter") {
              e.preventDefault();
              onTogglePlay();
            }
          }}
          className="relative h-6 min-w-0 flex-1 cursor-ew-resize touch-none rounded outline-none select-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {ticks.map((t, i) => {
            const left = pct(t, duration);
            return (
              <span
                key={t}
                className={cn(
                  "text-3xs text-muted-foreground pointer-events-none absolute top-0 font-mono tabular-nums",
                  i === 0
                    ? "translate-x-0"
                    : left > 94
                      ? "-translate-x-full"
                      : "-translate-x-1/2",
                )}
                style={{ left: `${left}%` }}
                aria-hidden
              >
                {formatTraceTick(t)}
              </span>
            );
          })}
          {replay.active ? (
            <span
              className="bg-foreground border-card pointer-events-none absolute bottom-0 size-2 -translate-x-1/2 translate-y-1/2 rounded-full border"
              style={{ left: `${playheadPct}%` }}
              aria-hidden
            />
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative">
          <div role="tree" aria-label="调用跨度">
            {rows.map(({ span, depth }) => {
              const startRel = clamp(span.startMs - run.startMs, 0, duration);
              const endRel =
                span.endMs != null
                  ? clamp(span.endMs - run.startMs, startRel, duration)
                  : duration;
              const revealMs = replay.active ? replay.positionMs : duration;
              const progress = !replay.active
                ? 1
                : revealMs >= endRel
                  ? 1
                  : revealMs <= startRel
                    ? 0
                    : (revealMs - startRel) / Math.max(1, endRel - startRel);
              return (
                <SpanRow
                  key={span.id}
                  span={span}
                  depth={depth}
                  runStartMs={run.startMs}
                  duration={duration}
                  progress={progress}
                  started={!replay.active || progress > 0}
                  selected={selectedId === span.id}
                  collapsed={collapsed.has(span.id)}
                  onSelect={onSelect}
                  onToggleCollapse={onToggleCollapse}
                />
              );
            })}
          </div>
          {/* 垂直网格：与行的时间轴列对齐；放 tree 外面，tree 的子节点只留 treeitem */}
          <div
            className="pointer-events-none absolute inset-y-0"
            style={{ left: "calc(var(--trace-label-w) + 16px)", right: 8 }}
            aria-hidden
          >
            {ticks.map((t) => (
              <span
                key={t}
                className="bg-border/60 absolute inset-y-0 w-px"
                style={{ left: `${pct(t, duration)}%` }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* 回放游标：盖在行区之上，不参与命中（拖拽走刻度尺） */}
      {replay.active ? (
        <div
          className="pointer-events-none absolute top-8 bottom-0"
          style={{ left: "calc(var(--trace-label-w) + 16px)", right: 8 }}
          aria-hidden
        >
          <div
            className="bg-foreground/60 absolute inset-y-0 w-px"
            style={{ left: `${playheadPct}%` }}
          />
        </div>
      ) : null}
    </div>
  );
};

const SpanRow = memo(function SpanRow({
  span,
  depth,
  runStartMs,
  duration,
  progress,
  started,
  selected,
  collapsed,
  onSelect,
  onToggleCollapse,
}: {
  span: TraceSpanNode;
  depth: number;
  runStartMs: number;
  duration: number;
  /** 回放进度 0..1；已揭示/未开始的行走同一个值，memo 才能跳过重渲染 */
  progress: number;
  started: boolean;
  selected: boolean;
  collapsed: boolean;
  onSelect: (id: string) => void;
  onToggleCollapse: (id: string) => void;
}) {
  const isRoot = depth === 0;
  const hasChildren = span.children.length > 0;
  const meta = CATEGORY_META[span.category];
  const Icon = isRoot ? BotIcon : span.kind === "turn" ? LayersIcon : meta.icon;
  const startRel = clamp(span.startMs - runStartMs, 0, duration);
  const endRel =
    span.endMs != null ? clamp(span.endMs - runStartMs, startRel, duration) : duration;
  const left = pct(startRel, duration);
  const width = Math.max(0.4, pct(endRel - startRel, duration));
  const failed = span.status === "error";
  const aborted = span.status === "aborted";
  const running = span.status === "running";
  const barClass = failed
    ? "bg-rose-500"
    : aborted
      ? "bg-muted-foreground/45"
      : isRoot
        ? "bg-sky-500"
        : span.kind === "turn"
          ? "bg-sky-500/45"
          : meta.bar;
  const durationLabel = span.endMs != null ? endRel - startRel : null;
  // 标签优先跟在条形后；贴右边放不下就翻到条形前；条形横跨大半屏时（单轮
  // run 常见）两侧都没有空间，改成贴时间轴右缘的实底小签，避免压到名字列
  const labelAfterBar = left + width <= 82;
  const labelBeforeBar = !labelAfterBar && left >= 30;

  return (
    <div
      role="treeitem"
      tabIndex={0}
      aria-selected={selected}
      aria-level={depth + 1}
      aria-expanded={hasChildren ? !collapsed : undefined}
      onClick={() => onSelect(span.id)}
      onKeyDown={(e) => {
        // 树的键盘模型：右展开 / 左收起，Enter 或空格选中详情
        if (e.target !== e.currentTarget) return;
        if (hasChildren && e.key === "ArrowRight" && collapsed) {
          e.preventDefault();
          onToggleCollapse(span.id);
          return;
        }
        if (hasChildren && e.key === "ArrowLeft" && !collapsed) {
          e.preventDefault();
          onToggleCollapse(span.id);
          return;
        }
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(span.id);
        }
      }}
      className={cn(
        "group flex h-7 w-full cursor-pointer items-center gap-2 px-2 text-left transition-colors outline-none focus-visible:bg-muted focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
        selected ? "bg-selected" : "hover:bg-muted/60",
      )}
    >
      <span
        className="flex min-w-0 shrink-0 items-center gap-1"
        style={{
          width: "var(--trace-label-w)",
          paddingLeft: depth * 10,
        }}
      >
        {hasChildren ? (
          <span
            aria-hidden
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse(span.id);
            }}
            className="hover:bg-muted text-muted-foreground group-hover:text-foreground flex size-4 shrink-0 cursor-pointer items-center justify-center rounded transition-colors"
          >
            <ChevronRightIcon
              className={cn(
                "size-3 transition-transform duration-150",
                !collapsed && "rotate-90",
              )}
            />
          </span>
        ) : (
          <span className="size-4 shrink-0" aria-hidden />
        )}
        <Icon
          className={cn(
            "size-3 shrink-0",
            failed
              ? "text-rose-500"
              : aborted
                ? "text-muted-foreground"
                : meta.text,
            !started && "opacity-60",
          )}
        />
        <span
          className={cn(
            "truncate text-xs",
            failed
              ? "text-rose-600 dark:text-rose-400 font-medium"
              : aborted
                ? "text-muted-foreground"
                : started
                  ? "text-foreground"
                  : "text-muted-foreground",
          )}
          title={span.name}
        >
          {span.name}
        </span>
        {failed ? (
          <TriangleAlertIcon className="size-3 shrink-0 text-rose-500" />
        ) : aborted ? (
          <BanIcon className="size-3 shrink-0 text-muted-foreground" />
        ) : running ? (
          <Loader2Icon className="size-3 shrink-0 animate-spin text-amber-500" />
        ) : null}
      </span>

      <span className="relative h-full min-w-0 flex-1">
        {/* 灰色轨道：回放未到达时只剩它，位置与跨度仍可读 */}
        <span
          className={cn(
            "bg-muted absolute top-1/2 -translate-y-1/2 rounded-full",
            isRoot ? "h-2.5" : span.kind === "turn" ? "h-2" : "h-1.5",
          )}
          style={{ left: `${left}%`, width: `${width}%`, minWidth: 2 }}
        />
        {progress > 0 ? (
          <span
            className={cn(
              "absolute top-1/2 -translate-y-1/2 overflow-hidden rounded-full",
              isRoot ? "h-2.5" : span.kind === "turn" ? "h-2" : "h-1.5",
            )}
            style={{ left: `${left}%`, width: `${width}%`, minWidth: 2 }}
          >
            <span
              className={cn(
                "block h-full w-full origin-left rounded-full",
                barClass,
                running && "motion-safe:animate-pulse",
              )}
              style={{ transform: `scaleX(${progress})` }}
            />
          </span>
        ) : null}

        {/* 耗时贴在条形之后；靠右放不下时翻到条形左侧 */}
        {!isRoot && durationLabel != null ? (
          <span
            className={cn(
              "absolute top-1/2 -translate-y-1/2 font-mono text-3xs tabular-nums",
              started ? "text-muted-foreground" : "text-muted-foreground/70",
              !labelAfterBar && !labelBeforeBar && "bg-card text-foreground rounded-sm px-1",
            )}
            style={
              labelAfterBar
                ? { left: `calc(${left + width}% + 6px)` }
                : labelBeforeBar
                  ? { right: `calc(${100 - left}% + 6px)` }
                  : { right: 2 }
            }
          >
            {formatTraceDuration(durationLabel)}
          </span>
        ) : null}
      </span>
    </div>
  );
});

/* ============================== 检查器 ============================== */

type DetailSection = { label: string; value: string };

const prettyJson = (raw: string): string => {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};

function detailSections(span: TraceSpanNode): DetailSection[] {
  const out: DetailSection[] = [];
  if (span.kind === "run" || span.kind === "turn") {
    const llms = span.children.filter((c) => c.kind === "llm_call").length;
    const tools = span.children.filter((c) => c.kind === "tool_call").length;
    if (llms || tools) {
      out.push({
        label: "本轮概览",
        value: `${llms} 次模型调用 · ${tools} 个工具调用`,
      });
    }
  }
  if (span.kind === "turn") {
    const firstLlm = span.children.find(
      (c) => c.kind === "llm_call" && c.detail?.response,
    );
    if (firstLlm?.detail?.response) {
      out.push({ label: "模型说明", value: firstLlm.detail.response });
    }
  }
  if (span.kind === "llm_call") {
    if (span.detail?.request) {
      out.push({ label: "请求上下文", value: span.detail.request });
    }
    if (span.detail?.response) {
      out.push({ label: "回复", value: span.detail.response });
    }
  }
  if (span.kind === "tool_call") {
    const args = span.attrs.args;
    if (args != null) {
      out.push({
        label: "入参",
        value: typeof args === "string" ? prettyJson(args) : JSON.stringify(args, null, 2),
      });
    }
    if (span.detail?.response) {
      out.push({ label: "出参", value: span.detail.response });
    }
  }
  if (span.kind === "retry") {
    const message = span.attrs.message;
    if (message != null) out.push({ label: "重试原因", value: String(message) });
  }
  // 失败原因由检查器顶部的「状态」块专门渲染，这里不再重复一份
  return out;
}

const SpanInspector: FC<{
  span: TraceSpanNode | null;
  run: TraceViewRun;
  replay: ReplayState;
  onClose: () => void;
}> = ({ span, run, replay, onClose }) => {
  const sections = useMemo(() => (span ? detailSections(span) : []), [span]);
  const duration = Math.max(1, run.durationMs);

  return (
    <div
      className={cn(
        "flex min-h-0 shrink-0 flex-col border-t @[860px]:h-full @[860px]:w-[300px] @[860px]:border-t-0 @[860px]:border-l",
        span ? "h-[42%]" : "hidden @[860px]:flex",
      )}
    >
      {!span ? (
        <RunOverview run={run} />
      ) : (
        <SpanDetail
          span={span}
          run={run}
          duration={duration}
          replay={replay}
          sections={sections}
          onClose={onClose}
        />
      )}
    </div>
  );
};

const SpanDetail: FC<{
  span: TraceSpanNode;
  run: TraceViewRun;
  duration: number;
  replay: ReplayState;
  sections: DetailSection[];
  onClose: () => void;
}> = ({ span, run, duration, replay, sections, onClose }) => {
  const meta = CATEGORY_META[span.category];
  const Icon = span.kind === "turn" ? LayersIcon : meta.icon;
  const startRel = clamp(span.startMs - run.startMs, 0, duration);
  const endRel =
    span.endMs != null ? clamp(span.endMs - run.startMs, startRel, duration) : duration;
  const barLeft = pct(startRel, duration);
  const barWidth = Math.max(0.6, pct(endRel - startRel, duration));
  const failed = span.status === "error";
  const aborted = span.status === "aborted";
  // 时序条与行内条形同色：分类色/失败红/中止灰，避免同一 span 在两处颜色打架
  const barClass = failed
    ? "bg-rose-500"
    : aborted
      ? "bg-muted-foreground/45"
      : span.kind === "turn"
        ? "bg-sky-500/45"
        : span.kind === "run"
          ? "bg-sky-500"
          : meta.bar;
  const usage = span.usage && traceUsageTotal(span.usage) > 0 ? span.usage : null;

  return (
    <>
      <div className="flex shrink-0 items-start gap-2 border-b px-3 py-2">
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md border",
            meta.pill,
          )}
        >
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-1.5 py-0.5 text-2xs font-medium",
              meta.pill,
            )}
          >
            {span.kind === "turn" ? "轮次" : KIND_LABEL[span.kind]}
          </span>
          <div className="text-foreground mt-0.5 truncate text-xs font-medium" title={span.name}>
            {span.name}
          </div>
        </div>
        <TooltipIconButton
          tooltip="关闭详情"
          onClick={onClose}
          className="size-6 focus-visible:ring-1 focus-visible:ring-ring"
        >
          <XIcon className="size-3" />
        </TooltipIconButton>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2.5">
        <section>
          <div className="flex items-baseline justify-between">
            <SectionLabel>时序</SectionLabel>
            <span className="text-foreground font-mono text-2xs tabular-nums">
              {formatTraceDuration(endRel - startRel)}
            </span>
          </div>
          <div className="bg-muted relative mt-1.5 h-1.5 rounded-full">
            <div
              className={cn("absolute inset-y-0 rounded-full", barClass)}
              style={{ left: `${barLeft}%`, width: `${barWidth}%` }}
            />
            {replay.active ? (
              <div
                className="bg-foreground absolute -inset-y-1 w-px"
                style={{ left: `${pct(replay.positionMs, duration)}%` }}
                aria-hidden
              />
            ) : null}
          </div>
          <div className="text-muted-foreground mt-1 flex justify-between font-mono text-2xs tabular-nums">
            <span>开始 {formatTraceDuration(startRel)}</span>
            <span>结束 {formatTraceDuration(endRel)}</span>
          </div>
        </section>

        {failed && typeof span.attrs.errorMessage === "string" ? (
          <section>
            <SectionLabel>状态</SectionLabel>
            <div className="border-rose-500/30 bg-rose-500/8 mt-1 flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-2xs leading-relaxed text-rose-700 dark:text-rose-300">
              <CircleXIcon className="mt-0.5 size-3 shrink-0" />
              <span className="min-w-0 break-words">{span.attrs.errorMessage}</span>
            </div>
          </section>
        ) : null}

        {aborted ? (
          <section>
            <SectionLabel>状态</SectionLabel>
            <div className="border-border bg-muted/40 text-muted-foreground mt-1 flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-2xs leading-relaxed">
              <BanIcon className="mt-0.5 size-3 shrink-0" />
              <span className="min-w-0 break-words">
                已中止（用户停止或连接断开），这次调用没有正常收尾。
              </span>
            </div>
          </section>
        ) : null}

        {usage ? <UsageGrid usage={usage} /> : null}

        {sections.map((section) => (
          <section key={section.label}>
            <SectionLabel>{section.label}</SectionLabel>
            <pre className="bg-muted/40 mt-1 max-h-56 overflow-auto rounded-md border border-border/60 p-2 font-mono text-2xs leading-relaxed break-words whitespace-pre-wrap">
              {section.value}
            </pre>
          </section>
        ))}

        <section>
          <SectionLabel>属性</SectionLabel>
          <AttrTable attrs={span.attrs} exclude={["args", "errorMessage"]} />
        </section>
      </div>
    </>
  );
};

const UsageGrid: FC<{ usage: TraceUsage }> = ({ usage }) => (
  <section>
    <SectionLabel>用量</SectionLabel>
    <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border px-2 py-1.5 text-2xs">
      <UsageRow label="输入" value={usage.input} />
      <UsageRow label="输出" value={usage.output} />
      <UsageRow label="缓存读" value={usage.cacheRead} />
      <UsageRow label="缓存写" value={usage.cacheWrite} />
    </div>
  </section>
);

const AttrTable: FC<{
  attrs: Record<string, string | number | boolean>;
  exclude?: readonly string[];
}> = ({ attrs, exclude = [] }) => {
  const entries = Object.entries(attrs).filter(([key]) => !exclude.includes(key));
  if (entries.length === 0) {
    return <div className="text-muted-foreground mt-1 text-2xs">无</div>;
  }
  return (
    <div className="mt-1 overflow-hidden rounded-md border">
      {entries.map(([key, value], i) => (
        <div
          key={key}
          className={cn(
            "flex gap-2 px-2 py-1.5 text-2xs",
            i > 0 && "border-t border-border/60",
          )}
        >
          <span className="text-muted-foreground w-24 shrink-0 truncate font-mono">{key}</span>
          <span className="text-foreground min-w-0 flex-1 break-all font-mono">
            {formatAttrValue(key, value)}
          </span>
        </div>
      ))}
    </div>
  );
};

/** 未选中任何 span 时（宽面板右侧）的常驻概览：别让整列只剩一句提示 */
const RunOverview: FC<{ run: TraceViewRun }> = ({ run }) => (
  <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-md border",
          CATEGORY_META.agent.pill,
        )}
      >
        <BotIcon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <SectionLabel>运行概览</SectionLabel>
        <div className="text-foreground truncate text-xs font-medium">{run.root.name}</div>
      </div>
    </div>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2.5">
      <section>
        <SectionLabel>状态</SectionLabel>
        <div className="mt-1">
          <StatusPill run={run} />
        </div>
      </section>
      <UsageGrid usage={run.usage} />
      <section>
        <SectionLabel>属性</SectionLabel>
        <AttrTable attrs={run.root.attrs} />
      </section>
      <p className="text-muted-foreground text-2xs leading-relaxed">
        点左侧任意一行，查看该跨度（span）的时序、输入输出与属性。
      </p>
    </div>
  </div>
);

const UsageRow: FC<{ label: string; value: number }> = ({ label, value }) => (
  <span className="flex items-baseline justify-between gap-2">
    <span className="text-muted-foreground">{label}</span>
    <span className={cn("font-mono tabular-nums", value > 0 ? "text-foreground" : "text-muted-foreground")}>
      {value.toLocaleString()}
    </span>
  </span>
);

function formatAttrValue(key: string, value: string | number | boolean): string {
  if (typeof value === "number") {
    return /token|cache|read|write/i.test(key) ? value.toLocaleString() : String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return value;
}

/* ============================== 外壳 ============================== */

/**
 * 面板 tab 与 dev-preview 共用的三块：工具栏、运行卡片（头部 + 瀑布 + 检查器）。
 * 数据源（历史 / 在飞）由调用方合并成 records 后传入。
 */
export const TraceExplorer: FC<{
  records: PiTraceRun[];
  /** 顶部工具条左侧的自定义控件（视图切换、刷新等） */
  toolbar?: ReactNode;
  /** 无记录时的提示内容 */
  empty?: ReactNode;
}> = ({ records, toolbar, empty }) => {
  const runs = useMemo(() => toTraceViewRuns(records), [records]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const run = runs.find((r) => r.traceId === pickedId) ?? runs[0] ?? null;

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      {toolbar ? (
        <div className="flex h-9 shrink-0 @container items-center gap-2 border-b px-2.5">
          {toolbar}
          <span className="text-muted-foreground ml-auto shrink-0 text-2xs tabular-nums">
            {runs.length} 条运行
          </span>
        </div>
      ) : null}

      {!run ? (
        <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed">
          {empty}
        </div>
      ) : (
        <RunTrace
          key={run.traceId}
          run={run}
          runs={runs}
          onPickRun={setPickedId}
        />
      )}
    </div>
  );
};
