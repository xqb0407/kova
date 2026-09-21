"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FC,
} from "react";
// useAuiState 取 store 包的导出：span scope 的类型增强（ScopeRegistry）挂在
// @assistant-ui/store 上，react 主包的 AssistantState 里没有 span
import { AuiConfig, AuiProvider, useAuiState } from "@assistant-ui/store";
import { SpanPrimitive, SpanResource } from "@assistant-ui/react-o11y";
import { Separator } from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  ChevronRightIcon,
  DownloadIcon,
  Loader2Icon,
  RefreshCwIcon,
  WaypointsIcon,
  XIcon,
} from "lucide-react";
import { piRequest, type PiTraceRun } from "@/lib/pi-bridge";
import {
  exportTraceRunsJson,
  traceRunToSpanData,
  type TraceSpanInspect,
} from "@/lib/trace-adapter";
import { usePanelActivity } from "@/lib/panel-activity";
import { cn } from "@/lib/utils";
import type { PanelTab } from "@/lib/panel-tabs";
import { TabEmpty } from "./tab-empty";

/**
 * 链路追踪 tab（header「更多」唤起，tab.sessionId 绑定 sidecar 会话）：
 * 左列 run 列表（倒序），右侧选中 run 的 span 瀑布 + 检查器。
 * 渲染用 @assistant-ui/react-o11y 的 headless primitives（SpanResource +
 * SpanPrimitive），数据经 lib/trace-adapter 从 PiTraceRun 扁平化。
 * 点击 span 打开检查器：属性键值 + llm_call 的请求上下文/回复正文（sidecar
 * 内容捕获的截断渲染）。
 * 直播不做：在飞 run 不在 traces 文件里，线程活动边沿（runningCount → 0）
 * 或手动刷新时重查一次。
 */

/** 面板局部字号档位：「Aa」按钮循环 标准→大→特大，系数落在根节点 --tfss，
 *  面板内字号全部写成 arbitrary calc 乘 var(--tfss) 的形式随它缩放。
 *  全局设置字号只缩放 rem 类（根元素 font-size），这里大量固定 px 读数不跟随，
 *  故轨迹面板自带调节。localStorage 持久化（键 ui.trace-font-step）。
 *  ⚠ 注释里不要出现完整的 text-[...] 类名字面量——Tailwind 扫描器会把它当类提走。 */
const TRACE_FONT_STEPS = [1, 1.15, 1.32];
const TRACE_FONT_STEP_LABELS = ["标准", "大", "特大"];
const TRACE_FONT_STEP_KEY = "ui.trace-font-step";

const SOURCE_LABEL: Record<PiTraceRun["source"], string> = {
  ui: "会话",
  automation: "定时任务",
  subagent: "子代理",
};

const fmtMs = (ms: number): string =>
  ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;

const fmtTime = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const fmtTokens = (run: PiTraceRun): string => {
  if (!run.usage) return "";
  const total =
    run.usage.input + run.usage.output + run.usage.cacheRead + run.usage.cacheWrite;
  if (!total) return "";
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k tok` : `${total} tok`;
};

const STATUS_DOT: Record<PiTraceRun["status"], string> = {
  ok: "bg-emerald-500",
  error: "bg-red-500",
  aborted: "bg-muted-foreground/40",
};

/** 单行 span：缩进树 + 状态点 + 名称 + 类型徽章 + 时间条 + 耗时；点击进检查器 */
const SpanRow: FC<{
  onSelect: (id: string) => void;
  selectedId: string | null;
}> = ({ onSelect, selectedId }) => {
  const spanId = useAuiState((s) => s.span.id);
  const latencyMs = useAuiState((s) => s.span.latencyMs);
  return (
    <SpanPrimitive.Root
      onClick={() => spanId && onSelect(spanId)}
      className={cn(
        "group hover:bg-muted/50 flex items-center gap-1.5 py-0.5 pr-2 text-[calc(12px_*_var(--tfss,1))] leading-[1.35]",
        spanId && spanId === selectedId && "bg-muted",
      )}
    >
      <SpanPrimitive.Indent />
      {/* 有子 span 才渲染（primitive 内置）；data-collapsed 由 primitive 下发 */}
      <SpanPrimitive.CollapseToggle className="text-muted-foreground hover:text-foreground flex size-3.5 shrink-0 cursor-pointer items-center justify-center">
        <ChevronRightIcon className="size-3 transition-transform data-[collapsed=true]:rotate-90" />
      </SpanPrimitive.CollapseToggle>
      <SpanPrimitive.StatusIndicator
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          // running/completed/failed/skipped（data 属性由 primitive 自带）
          "data-[span-status=completed]:bg-emerald-500 data-[span-status=failed]:bg-red-500",
          "data-[span-status=running]:bg-amber-500 data-[span-status=skipped]:bg-muted-foreground/40",
        )}
      />
      <SpanPrimitive.Name className="max-w-45 min-w-0 truncate" />
      <SpanPrimitive.TypeBadge className="bg-muted text-muted-foreground hidden shrink-0 rounded px-1 text-[calc(10px_*_var(--tfss,1))] group-hover:inline sm:inline" />
      <SpanPrimitive.Timeline className="bg-muted/60 relative h-1.5 min-w-10 flex-1 overflow-hidden rounded">
        <SpanPrimitive.TimelineBar className="bg-primary/55 absolute inset-y-0 rounded" />
      </SpanPrimitive.Timeline>
      <span className="text-muted-foreground w-12 shrink-0 text-right text-[calc(10px_*_var(--tfss,1))] tabular-nums">
        {latencyMs != null ? fmtMs(latencyMs) : ""}
      </span>
    </SpanPrimitive.Root>
  );
};

/** 竖向拖拽把手（详情面板上缘）：上下拖改变详情高度。共享 ui/resizable 的
 *  ResizableHandle 是横排样式（竖线），这里按纵向自绘（横线、hover 浮现） */
const TraceResizeHandle: FC = () => (
  <Separator
    data-slot="trace-resize-handle"
    className="group/handle relative flex h-1.5 shrink-0 cursor-row-resize items-center justify-center outline-none [&:active>div]:bg-foreground/45 [&:hover>div]:bg-foreground/25"
  >
    <div className="bg-border/50 pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 opacity-0 transition-[background-color,height,opacity] group-hover/handle:h-0.5 group-hover/handle:opacity-100 group-active/handle:h-0.5 group-active/handle:opacity-100" />
  </Separator>
);

/** 检查器：选中 span 的属性键值 + llm_call 的请求上下文/回复正文。
 *  高度由外层 ResizablePanel 控制（可拖拽），这里只做内容布局 */
const RunDetail: FC<{
  name: string;
  inspect: TraceSpanInspect;
  onClose: () => void;
}> = ({ name, inspect, onClose }) => {
  const attrs = Object.entries(inspect.attrs ?? {});
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2 text-[calc(12px_*_var(--tfss,1))] leading-[1.35]">
        <span className="text-foreground min-w-0 truncate font-medium">{name}</span>
        <span className="text-muted-foreground/60 shrink-0 text-[calc(10px_*_var(--tfss,1))]">属性与内容</span>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground ml-auto flex size-5 items-center justify-center rounded"
          title="关闭检查器"
        >
          <XIcon className="size-3" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {attrs.length > 0 ? (
          <div className="mb-2 flex flex-col gap-0.5">
            {attrs.map(([k, v]) => (
              <div key={k} className="flex gap-2 text-[calc(11px_*_var(--tfss,1))] leading-relaxed">
                <span className="text-muted-foreground w-36 shrink-0 truncate font-mono">{k}</span>
                <span className="min-w-0 break-all font-mono">{String(v)}</span>
              </div>
            ))}
          </div>
        ) : null}
        {inspect.detail?.request ? (
          <div className="mb-2">
            <div className="text-muted-foreground mb-0.5 text-[calc(11px_*_var(--tfss,1))] font-medium">
              请求上下文（截断渲染）
            </div>
            <pre className="bg-muted/40 max-h-52 overflow-auto rounded p-2 font-mono text-[calc(11px_*_var(--tfss,1))] break-all whitespace-pre-wrap">
              {inspect.detail.request}
            </pre>
          </div>
        ) : null}
        {inspect.detail?.response ? (
          <div>
            <div className="text-muted-foreground mb-0.5 text-[calc(11px_*_var(--tfss,1))] font-medium">回复</div>
            <pre className="bg-muted/40 max-h-52 overflow-auto rounded p-2 font-mono text-[calc(11px_*_var(--tfss,1))] break-all whitespace-pre-wrap">
              {inspect.detail.response}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
};

/** 瀑布 + 检查器（右列）：SpanResource 换数组即切换 run */
const RunWaterfall: FC<{
  run: PiTraceRun;
  inspectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}> = ({ run, inspectedId, onSelect, onClose }) => {
  const { spans, inspect } = useMemo(() => traceRunToSpanData(run), [run]);
  const config = useMemo(() => AuiConfig({ span: SpanResource({ spans }) }), [spans]);
  const inspectedName = inspectedId
    ? (spans.find((s) => s.id === inspectedId)?.name ?? "")
    : "";
  const inspected = inspectedId ? inspect.get(inspectedId) : undefined;
  return (
    // 竖向面板组：瀑布占余量，检查器可上下拖拽（v4：数字 = px，"70%" = 百分比）
    <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
      <ResizablePanel id="trace-waterfall" minSize={120} className="min-w-0">
        <div className="h-full overflow-y-auto px-2 py-1">
          <AuiProvider extends={null} config={config}>
            {/* 闭包组件携带选中态：SpanRow 内部经 useAuiState 读自身 id 对比高亮 */}
            <SpanPrimitive.Children
              components={{
                Span: () => <SpanRow onSelect={onSelect} selectedId={inspectedId} />,
              }}
            />
          </AuiProvider>
        </div>
      </ResizablePanel>
      {inspected ? <TraceResizeHandle /> : null}
      {inspected ? (
        <ResizablePanel
          id="trace-detail"
          defaultSize={220}
          minSize={96}
          maxSize="70%"
          className="min-w-0"
        >
          <RunDetail name={inspectedName} inspect={inspected} onClose={onClose} />
        </ResizablePanel>
      ) : null}
    </ResizablePanelGroup>
  );
};

/** run 概要条：状态/来源/模型/用量/总耗时 */
const RunSummary: FC<{ run: PiTraceRun }> = ({ run }) => (
  <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[calc(12px_*_var(--tfss,1))] leading-[1.35]">
    <span className={cn("size-1.5 rounded-full", STATUS_DOT[run.status])} />
    <span>{SOURCE_LABEL[run.source]}</span>
    <span className="text-foreground truncate font-medium">{run.model ?? "未知模型"}</span>
    <span className="tabular-nums">{fmtTokens(run)}</span>
    <span className="tabular-nums">{fmtMs(Math.max(0, run.endMs - run.startMs))}</span>
    <span className="ml-auto tabular-nums">{fmtTime(run.startMs)}</span>
  </div>
);

export const TraceTab: FC<{ tab: PanelTab }> = ({ tab }) => {
  const sessionId = tab.sessionId;
  const [runs, setRuns] = useState<PiTraceRun[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const { runningCount } = usePanelActivity();

  // 面板字号档位：静态导出 SSR 首绘=标准，挂载后从 localStorage 水合（避免水合不一致）
  const [fontStep, setFontStep] = useState(0);
  useEffect(() => {
    const n = Number(window.localStorage.getItem(TRACE_FONT_STEP_KEY));
    if (Number.isInteger(n) && n > 0 && n < TRACE_FONT_STEPS.length) setFontStep(n);
  }, []);
  const cycleFontStep = useCallback(() => {
    setFontStep((s) => {
      const next = (s + 1) % TRACE_FONT_STEPS.length;
      try {
        window.localStorage.setItem(TRACE_FONT_STEP_KEY, String(next));
      } catch {
        // 存储不可用时仅本次会话生效
      }
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    if (!sessionId) return;
    setRefreshing(true);
    try {
      const res = await piRequest<{ type: "trace_query"; runs: PiTraceRun[] }>({
        type: "trace_query",
        sessionId,
        limit: 200,
      });
      setRuns(res.runs);
    } catch {
      // sidecar 不可用：保留现状（首查失败视为无轨迹）
      setRuns((prev) => prev ?? []);
    } finally {
      setRefreshing(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 线程活动边沿（有在途工具 → 全空闲）：新 run 可能刚落盘，重查一次
  const prevRunningRef = useRef(runningCount);
  useEffect(() => {
    if (prevRunningRef.current > 0 && runningCount === 0) void load();
    prevRunningRef.current = runningCount;
  }, [runningCount, load]);

  // 倒序展示（最新在上）；默认选中最新一条，切 run 时收起检查器
  const descRuns = useMemo(() => (runs ? [...runs].reverse() : null), [runs]);
  const selected = useMemo(
    () => descRuns?.find((r) => r.runId === selectedId) ?? descRuns?.[0] ?? null,
    [descRuns, selectedId],
  );
  useEffect(() => {
    setInspectedId(null);
  }, [selected?.runId]);

  const onExport = useCallback(async () => {
    if (!runs?.length || !sessionId) return;
    await exportTraceRunsJson(runs, sessionId);
  }, [runs, sessionId]);

  if (!sessionId)
    return <TabEmpty icon={WaypointsIcon} text="当前会话尚未关联运行轨迹" />;
  if (runs === null)
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-1.5 text-[calc(12px_*_var(--tfss,1))] leading-[1.35]">
        <Loader2Icon className="size-3.5 animate-spin" />
        读取轨迹…
      </div>
    );
  if (runs.length === 0)
    return (
      <TabEmpty
        icon={WaypointsIcon}
        text="本会话还没有运行轨迹：跑一轮对话后，这里的每次 agent 运行都会记录 LLM 调用、工具与重试的时间线"
      />
    );

  return (
    <div
      className="flex h-full min-w-0 flex-col"
      style={{ "--tfss": TRACE_FONT_STEPS[fontStep] } as CSSProperties}
    >
      {/* 工具条 */}
      <div className="text-muted-foreground flex h-9 shrink-0 items-center gap-1 border-b px-2 text-[calc(12px_*_var(--tfss,1))] leading-[1.35]">
        <span>
          {runs.length} 次运行
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={cycleFontStep}
            className="hover:bg-muted hover:text-foreground flex h-7 min-w-7 items-center justify-center rounded px-1 font-semibold"
            title={`面板字号：${TRACE_FONT_STEP_LABELS[fontStep]}（点击切换）`}
          >
            Aa
          </button>
          <button
            type="button"
            onClick={() => void load()}
            className="hover:bg-muted hover:text-foreground flex size-7 items-center justify-center rounded"
            title="刷新"
          >
            <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
          </button>
          <button
            type="button"
            onClick={() => void onExport()}
            className="hover:bg-muted hover:text-foreground flex size-7 items-center justify-center rounded"
            title="导出全部轨迹（JSON）"
          >
            <DownloadIcon className="size-3.5" />
          </button>
        </div>
      </div>
      {/* 横向分组：左侧 run 列表可拖宽（分割线即把手，细线常驻） */}
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel id="trace-run-list" defaultSize={208} minSize={120} className="min-w-0">
          {/* run 列表 */}
          <div className="h-full overflow-y-auto">
            {descRuns!.map((run) => (
              <button
                key={run.runId}
                type="button"
                onClick={() => setSelectedId(run.runId)}
                data-active={selected?.runId === run.runId}
                className="hover:bg-muted/60 data-active:bg-muted flex w-full flex-col gap-0.5 border-b px-2.5 py-2 text-left text-[calc(12px_*_var(--tfss,1))] leading-[1.35]"
              >
                <span className="flex items-center gap-1.5">
                  <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[run.status])} />
                  <span className="text-foreground min-w-0 truncate font-medium">
                    {fmtTime(run.startMs)}
                  </span>
                  <span className="text-muted-foreground ml-auto shrink-0 tabular-nums">
                    {fmtMs(Math.max(0, run.endMs - run.startMs))}
                  </span>
                </span>
                <span className="text-muted-foreground flex items-center gap-1.5 pl-3">
                  <span className="min-w-0 truncate">{run.model ?? "未知模型"}</span>
                  <span className="ml-auto shrink-0">{SOURCE_LABEL[run.source]}</span>
                </span>
              </button>
            ))}
          </div>
        </ResizablePanel>
        <ResizableHandle className="[&>div]:opacity-100" />
        <ResizablePanel id="trace-run-detail" minSize={260} className="min-w-0">
          {/* 选中 run 的瀑布 + 检查器 */}
          <div className="flex h-full min-w-0 flex-col">
            {selected ? (
              <>
                <RunSummary run={selected} />
                <div className="border-t" />
                <RunWaterfall
                  run={selected}
                  inspectedId={inspectedId}
                  onSelect={setInspectedId}
                  onClose={() => setInspectedId(null)}
                />
              </>
            ) : null}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
};
