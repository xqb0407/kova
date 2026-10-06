"use client";

/**
 * 【临时测量页】单轮超长 + 流式：一条消息里上千个 part 的每帧渲染成本。
 *
 * 要回答的三个问题（都能用 query 开关切换）：
 *  1. 渲染成本随 part 数怎么涨、贵在哪一帧（<Profiler> 收 actualDuration）。
 *  2. 投影侧切块（MAX_PARTS_PER_OUTPUT）值不值 —— `msgs=N` 把同一批 part 摊到
 *     N 条消息上，对照 msgs=1（切块前）与 msgs=8（切块后）。
 *  3. 右侧 panel 打开为什么更卡 —— `panel=1` 挂上真实的 <AgentPanel />。
 *
 * 跑法（不需要 Tauri：Tauri 外壳只提供 sidecar 传输，渲染层是纯 Next，
 * tauri.conf.json 的 devUrl 就是 http://localhost:3000）：
 *   cd apps/desktop && bun run dev
 *   bun scripts/measure-dev-preview.mjs \
 *     "http://localhost:3000/dev-preview/long-turn?steps=800&chunks=30&msgs=1&panel=1"
 *
 * 注意：next dev 是 React 开发模式（含额外检查与 Profiler 开销），绝对值偏悲观，
 * 看不同配置之间的**相对差**才有意义。要绝对值就 `bun run build` 后静态 serve
 * out/（output: export）。报告写进 <pre data-slot="diag">，供 CDP 抓取。
 *
 * 不要用 --dump-dom --virtual-time-budget：虚拟时间会把 performance.now() 一起
 * 虚拟化，而 React 的 Profiler 内部就用它算 actualDuration，读数会全变成 0。
 */

import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useLocalRuntime,
} from "@assistant-ui/react";
import type {
  ChatModelAdapter,
  ThreadAssistantMessagePart,
  ThreadMessageLike,
} from "@assistant-ui/react";
import {
  Profiler,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type RefObject,
} from "react";
import { AssistantMessage } from "@/components/agent-thread/assistant-message";
import { UserMessage } from "@/components/agent-thread/user-message";
import { CompactionDataUI } from "@/components/agent-thread/compaction-banner";
import { ImageDataUI } from "@/components/assistant-ui/elements/image-data";
import {
  TurnSlot,
  TurnTimingRecorder,
} from "@/components/agent-thread/turn-summary";
import { AgentPanel } from "@/components/agent-thread/agent-panel";
import { focusPanelTab, setCurrentPanelThread } from "@/lib/panels/panel-tabs";

type Part = ThreadAssistantMessagePart;
type Cfg = {
  steps: number;
  chunks: number;
  msgs: number;
  panel: boolean;
  /** 打开哪个 panel 标签：file:<toolCallId>（文件视图，useFilePart 那条重扫描
   *  只有在文件标签打开时才挂载——panel 挂着但没开标签时开销≈0，测不出东西） */
  open: string | null;
  /** 把最终报告 POST 到这个地址（sendBeacon）。某些浏览器（Safari/WebKit，
   *  也就是 Tauri 桌面端同款引擎）没法被无头驱动读 DOM，只能让页面自己回传。 */
  report: string | null;
  /** 每帧流式正文重复次数：动画负载旋钮（逐词动画的成本靠它放大） */
  words: number;
};
const DEFAULTS: Cfg = {
  steps: 800,
  chunks: 30,
  msgs: 1,
  panel: false,
  open: null,
  report: null,
  words: 8,
};

/** 一段工具输出（贴近真实：read 一个源文件） */
const toolOutput = (step: number): string =>
  Array.from(
    { length: 30 },
    (_, i) => `export const value${i} = compute(${step}, ${i});`,
  ).join("\n");

/** 每步两个 part（思考 + 工具调用），与真实投影的量级同构 */
const stepParts = (steps: number): Part[] => {
  const parts: Part[] = [];
  for (let s = 0; s < steps; s++) {
    parts.push({ type: "reasoning", text: `第 ${s} 步：先看一下这个文件。` });
    parts.push({
      type: "tool-call",
      toolCallId: `c${s}`,
      toolName: "read",
      args: { path: `/repo/src/module-${s}.ts` },
      argsText: JSON.stringify({ path: `/repo/src/module-${s}.ts` }),
      result: toolOutput(s),
      status: { type: "complete", reason: "stop" },
    } as Part);
  }
  return parts;
};

const assistantMessage = (id: string, content: Part[]): ThreadMessageLike => ({
  id,
  role: "assistant",
  content,
  status: { type: "complete", reason: "stop" },
});

type LiveFacts = { parts: number; msgs: number; running: boolean; slot: string };
type Commit = {
  parts: number;
  ms: number;
  threadRunning: boolean;
  domNodes?: number;
};

export default function LongTurnPreviewPage() {
  // query 只能在浏览器里读；初始态与 SSR 一致（null），挂载后补上，避免
  // hydration 不匹配（在 useState 初始化器里读 window 会两边渲染不一致）。
  const [cfg, setCfg] = useState<Cfg | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const num = (k: string, d: number) => Math.max(1, Number(q.get(k) ?? d) || d);
    setCfg({
      steps: num("steps", DEFAULTS.steps),
      chunks: num("chunks", DEFAULTS.chunks),
      msgs: num("msgs", DEFAULTS.msgs),
      panel: q.get("panel") === "1",
      open: q.get("open"),
      report: q.get("report"),
      words: num("words", DEFAULTS.words),
    });
  }, []);

  const preRef = useRef<HTMLPreElement>(null);
  return (
    <div className="flex h-screen flex-col">
      <div className="text-muted-foreground px-3 py-1 text-xs">
        long-turn harness ·{" "}
        {cfg
          ? `steps=${cfg.steps} · part≈${cfg.steps * 2 + 1} · chunks=${cfg.chunks} · msgs=${cfg.msgs} · panel=${cfg.panel ? 1 : 0} · open=${cfg.open ?? "-"}`
          : "读取参数…"}
      </div>
      {/* cfg 就位后才建 runtime：initialMessages 只在 runtime 创建时吃一次，
          参数必须在它之前定下来（否则 msgs 永远按默认值切） */}
      {cfg ? (
        <HarnessBody
          key={`${cfg.steps}-${cfg.chunks}-${cfg.msgs}-${cfg.panel}`}
          cfg={cfg}
          preRef={preRef}
        />
      ) : (
        <div className="flex-1" />
      )}
      <pre
        ref={preRef}
        data-slot="diag"
        className="bg-muted m-2 max-h-52 shrink-0 overflow-auto rounded p-2 font-mono text-xs whitespace-pre-wrap"
      >
        等流式跑起来…
      </pre>
    </div>
  );
}

const HarnessBody: FC<{
  cfg: Cfg;
  preRef: RefObject<HTMLPreElement | null>;
}> = ({ cfg, preRef }) => {
  // 把 part 摊成 msgs 条消息：前 msgs-1 条进 initialMessages（已完成的块），
  // 最后一条由 adapter 流式吐出——正是投影切块后一轮的形态（前面的块不再变）
  const { initialMessages, lastSlice } = useMemo(() => {
    const all = stepParts(cfg.steps);
    const per = Math.ceil(all.length / cfg.msgs);
    const slices: Part[][] = [];
    for (let i = 0; i < all.length; i += per) slices.push(all.slice(i, i + per));
    const head = slices.slice(0, Math.max(0, slices.length - 1));
    return {
      initialMessages: [
        {
          id: "u1",
          role: "user",
          content: [{ type: "text", text: "跑一个很长的任务" }],
        } as ThreadMessageLike,
        ...head.map((s, i) => assistantMessage(`a${i}`, s)),
      ],
      lastSlice: slices[slices.length - 1] ?? [],
    };
  }, [cfg.steps, cfg.msgs]);

  const model = useMemo<ChatModelAdapter>(
    () => ({
      async *run() {
        // 正文必须**逐帧追加**而不是整体替换：streamdown 只给「新出现的词」上
        // 入场动画（按 diff 算），整体替换几乎不产生新词，动画负载根本压不上去
        // ——那样测出来的 blurIn/fadeIn 差异是假的。
        let acc = "";
        for (let i = 1; i <= cfg.chunks; i++) {
          acc += `第${i}帧的正文内容 `.repeat(cfg.words);
          const tail: Part = { type: "text", text: acc };
          // 每个 chunk 把本块全部 part 换成新对象：模拟投影每帧重建「正在流式的
          // 那条消息」（切块前 = 整条转录；切块后 = 最后一块）
          yield {
            content: [
              ...lastSlice.map(
                (p) =>
                  ({
                    ...p,
                    args: { ...((p as { args?: object }).args ?? {}) },
                  }) as Part,
              ),
              tail,
            ],
          };
          await new Promise((r) => setTimeout(r, 0));
        }
      },
    }),
    [lastSlice, cfg.chunks, cfg.words],
  );

  const runtime = useLocalRuntime(model, { initialMessages });

  // 跑动期间的帧率采样：某些引擎（WebKit）里我拿不到别的仪器，fps 是最直接的
  // 「卡不卡」证据。animation 类开销（filter 模糊 vs opacity）只在这里显形。
  // since 用 -1 表示未开始：不能拿 0 当哨兵——rAF 的时间戳可能恰好是 0，
// 那样每帧都会重设起点，时长算出来永远是 0（踩过）
  const fpsRef = useRef({ frames: 0, worst: 0, janks: 0, raf: 0, since: -1 });
  useEffect(() => {
    const st = fpsRef.current;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      // 只在布局稳定后计数，避免把首次挂载的重活混进稳态帧率
      if (st.since < 0) st.since = now;
      if (dt < 1000) {
        st.frames += 1;
        if (dt > st.worst) st.worst = dt;
        if (dt > 33) st.janks += 1;
      }
      st.raf = requestAnimationFrame(tick);
    };
    st.raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(st.raf);
  }, []);

  const durationsRef = useRef<number[]>([]);
  const historyRef = useRef<Commit[]>([]);
  const domMeasuredRef = useRef(false);
  const liveRef = useRef<LiveFacts>({
    parts: 0,
    msgs: 0,
    running: false,
    slot: "",
  });

  const summarize = useCallback(
    (running: boolean): string => {
      const ds = durationsRef.current;
      const sorted = [...ds].sort((a, b) => a - b);
      const sum = ds.reduce((a, b) => a + b, 0);
      const pct = (p: number) =>
        sorted.length === 0
          ? 0
          : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
      const live = liveRef.current;
      const h = historyRef.current;
      const empty: Commit = { parts: 0, ms: 0, threadRunning: false };
      const heaviest = h.reduce(
        (best, c) => (c.ms > best.ms ? c : best),
        h[0] ?? empty,
      );
      const withParts = h.filter((c) => c.parts > 0);
      const maxParts = withParts.reduce(
        (best, c) => (c.parts > best.parts ? c : best),
        withParts[0] ?? empty,
      );
      return [
        `steps=${cfg.steps} msgs=${cfg.msgs} panel=${cfg.panel ? 1 : 0} chunks=${cfg.chunks} 期望 part≈${cfg.steps * 2 + 1}`,
        `实际：消息数=${live.msgs}  末条 content=${live.parts} part  ${running ? "（流式中）" : "（已结束）"}`,
        `槽位 flags=${live.slot || "(空)"}   ← isHeader isTurnEnd isLastTurn interrupted turnRunning isAnswerTail dividerOnly`,
        `提交次数 = ${ds.length}`,
        `单帧渲染 actualDuration：均值 ${(sum / Math.max(1, ds.length)).toFixed(2)}ms  p50 ${pct(0.5).toFixed(2)}ms  p95 ${pct(0.95).toFixed(2)}ms  max ${pct(0.999).toFixed(2)}ms`,
        `渲染总计 ${sum.toFixed(1)}ms / ${ds.length} 帧`,
        `最贵提交：#${h.indexOf(heaviest)} part=${heaviest.parts} ${heaviest.ms.toFixed(2)}ms threadRunning=${heaviest.threadRunning ? 1 : 0}`,
        `最大 part 提交：part=${maxParts.parts} ${maxParts.ms.toFixed(2)}ms`,
        // 末态 DOM 计数：panel 的文件视图真的挂上了会明显多出一大截元素
        `末态：全页 DOM 元素=${typeof document === "undefined" ? "-" : document.querySelectorAll("*").length}  面板文件视图=${typeof document === "undefined" ? "-" : document.querySelectorAll('[data-slot="aui_file-view"]').length}`,
      ].join("\n");
    },
    [cfg],
  );

  const onRender = useCallback(
    (_id: string, _phase: string, actualDuration: number) => {
      durationsRef.current.push(actualDuration);
      const entry: Commit = {
        parts: liveRef.current.parts,
        ms: actualDuration,
        threadRunning: liveRef.current.running,
      };
      if (entry.parts > 0 && !domMeasuredRef.current) {
        domMeasuredRef.current = true;
        entry.domNodes = document.querySelectorAll("*").length;
      }
      historyRef.current.push(entry);
      if (preRef.current) {
        preRef.current.textContent = summarize(liveRef.current.running);
      }
    },
    [preRef, summarize],
  );

  const onDone = useCallback(() => {
    setTimeout(() => {
      const st = fpsRef.current;
      const secs = st.since >= 0 ? (performance.now() - st.since) / 1000 : 0;
      const fpsLine =
        `帧率：${st.frames} 帧 / ${secs.toFixed(1)}s = ${(st.frames / Math.max(secs, 0.001)).toFixed(1)} fps` +
        ` · 最长帧间隔 ${st.worst.toFixed(0)}ms · 卡顿(>33ms) ${st.janks}`;
      const text = `${summarize(false)}\n${fpsLine}`;
      if (preRef.current) preRef.current.textContent = text;
      console.log("[long-turn]", text);
      if (cfg.report) {
        // sendBeacon：跨源 POST 且不触发预检，接收端只要把 body 落盘即可
        navigator.sendBeacon?.(cfg.report, text);
      }
    }, 500);
  }, [preRef, summarize, cfg.report]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <CompactionDataUI />
      <ImageDataUI />
      <RunDriver onDone={onDone} />
      <LiveProbe sink={liveRef} />
      {/* Profiler 必须包住「消息流 + 面板」两者：只包消息流的话面板的渲染
          时间根本不在统计里（这正是本页第一版量不出面板成本的原因） */}
      <Profiler id="long-turn-thread" onRender={onRender}>
        <div className="flex min-h-0 flex-1">
          <ThreadPrimitive.Root className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <ThreadPrimitive.Viewport
              turnAnchor="top"
              data-slot="aui_thread-viewport"
              className="relative flex flex-1 flex-col overflow-x-clip overflow-y-scroll px-4 pt-4"
            >
              <div className="flex flex-col gap-y-6">
                <ThreadPrimitive.Messages>
                  {({ message }) => (
                    <TurnSlot
                      messageId={String(message.id)}
                      isEditing={!!message.composer.isEditing}
                    >
                      {message.role === "user" ? (
                        <UserMessage />
                      ) : (
                        <AssistantMessage />
                      )}
                    </TurnSlot>
                  )}
                </ThreadPrimitive.Messages>
                <TurnTimingRecorder />
              </div>
            </ThreadPrimitive.Viewport>
          </ThreadPrimitive.Root>
          {cfg.panel ? (
            <div className="border-border w-[420px] shrink-0 border-l">
              {/* 真实右侧面板：panel=1 时它的订阅与渲染成本一起计入。
                  open=file:<toolCallId> 把文件标签打开，否则面板是空标签态，
                  file-view 那条每帧全量扫描根本不会挂载（测出来永远是 0 差异）。
                  聚焦位置很关键：工具调用在 parts 数组里的位置决定扫描走多远，
                  所以取值要给靠后的（真实使用里点的多是刚跑完的那一步）。 */}
              <PanelDriver open={cfg.open} />
              <AgentPanel onCollapse={() => undefined} />
            </div>
          ) : null}
        </div>
      </Profiler>
    </AssistantRuntimeProvider>
  );
};

/**
 * 把 panel 的标签打开（panel=1&open=file:c5）。
 * 必须先 setCurrentPanelThread：focusPanelTab 在 currentThreadId 为空时直接
 * 空转（面板标签按会话分桶），而 harness 没挂 Base，没人登记过当前会话。
 */
const PanelDriver: FC<{ open: string | null }> = ({ open }) => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const doneRef = useRef(false);
  useEffect(() => {
    if (!open || doneRef.current || !threadId) return;
    doneRef.current = true;
    // 等流跑起来、消息已投影出来之后再开标签（标签要按 toolCallId 去找那条 part）
    const t = setTimeout(() => {
      setCurrentPanelThread(threadId);
      const [kind, focus] = open.split(":");
      focusPanelTab((kind === "file" ? "file" : "activity") as never, {
        focus,
        title: "module.ts",
      } as never);
    }, 1200);
    return () => clearTimeout(t);
  }, [open, threadId]);
  return null;
};

/** 跑动中探针：末条消息的 part 数、消息数、槽位 flags（写 ref，不落 state） */
const LiveProbe: FC<{ sink: { current: LiveFacts } }> = ({ sink }) => {
  const parts = useAuiState((s) => s.thread.messages.at(-1)?.content.length ?? 0);
  const msgs = useAuiState((s) => s.thread.messages.length);
  const running = useAuiState((s) => s.thread.isRunning);
  const slot = useAuiState((s) => {
    const last = s.thread.messages.at(-1);
    return last
      ? `${String(s.thread.messages.length)}|${String(last.id)}`
      : "";
  });
  sink.current = { parts, msgs, running, slot };
  return null;
};

/** 发一条消息把流跑起来；append 返回 void，靠 isRunning 的下降沿判定跑完 */
const RunDriver: FC<{ onDone: () => void }> = ({ onDone }) => {
  const aui = useAui();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const startedRef = useRef(false);
  const sawRunningRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const t = setTimeout(() => {
      // parentId 必须挂到当前末条：parentId:null 会被运行时当成新分支头，
      // 前面 initialMessages 里的块全部从当前分支消失（消息数只剩 2，测的
      // 就不是「N 块 + 流式最后一块」而是「单独一整块」）
      const last = aui.thread.getState().messages.at(-1)?.id ?? null;
      void aui.thread.append({
        role: "user",
        content: [{ type: "text", text: "继续跑" }],
        parentId: last,
        sourceId: null,
        runConfig: undefined,
        startRun: true,
      } as never);
    }, 200);
    return () => clearTimeout(t);
  }, [aui]);

  useEffect(() => {
    if (isRunning) {
      sawRunningRef.current = true;
      return;
    }
    if (!sawRunningRef.current) return;
    const t = setTimeout(onDone, 0);
    return () => clearTimeout(t);
  }, [isRunning, onDone]);

  return null;
};
