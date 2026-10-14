import type { SpanData } from "@assistant-ui/react-o11y";
import type { PiTraceRun, PiTraceSpan, PiTraceStatus } from "@/lib/pi/pi-bridge";
import { isTauri } from "@/lib/tauri";

/**
 * Agent 轨迹适配层：PiTraceRun / PiTraceSpan（sidecar trace.ts 树形）→
 * @assistant-ui/react-o11y 的扁平 SpanData[]（树靠 parentSpanId 表达）。
 * react-o11y 处于 experimental，视图组件只吃 SpanData——上游形状/API 变更只改这里。
 */

const STATUS_MAP: Record<PiTraceStatus, SpanData["status"]> = {
  ok: "completed",
  error: "failed",
  aborted: "skipped",
};

const KIND_LABEL: Record<PiTraceSpan["kind"], string> = {
  turn: "轮次",
  llm_call: "LLM 调用",
  tool_call: "工具",
  retry: "重试",
};

/** 面板检查器数据：选中某个 span 后展示的属性与内容详情 */
export type TraceSpanInspect = {
  attrs?: Record<string, string | number | boolean>;
  detail?: { request?: string; response?: string };
};

/** 单个 run 的 span 树扁平化：合成一个 run 根 span（type="run"），turn 挂其下。
 * 返回 inspect map（adapter id → 属性/内容详情），供点击 span 后展示 */
export function traceRunToSpanData(run: PiTraceRun): {
  spans: SpanData[];
  inspect: Map<string, TraceSpanInspect>;
} {
  const out: SpanData[] = [];
  const inspect = new Map<string, TraceSpanInspect>();
  // run 根 id 取 traceId 前 16hex（与 OTLP 同约定，两侧可用同一套 id 对齐）；
  // 旧记录无 traceId 时回退 runId 前缀
  const rootId = (run.traceId ?? run.runId).slice(0, 16);
  let seq = 0;

  out.push({
    id: rootId,
    parentSpanId: null,
    name: run.model ?? "agent run",
    type: "run",
    status: STATUS_MAP[run.status],
    startedAt: run.startMs,
    endedAt: run.endMs || null,
    latencyMs: run.endMs ? Math.max(0, run.endMs - run.startMs) : null,
  });
  inspect.set(rootId, {
    attrs: {
      "pi.session_id": run.sessionId,
      "pi.source": run.source,
      ...(run.usage
        ? {
            inputTokens: run.usage.input,
            outputTokens: run.usage.output,
            cacheRead: run.usage.cacheRead,
            cacheWrite: run.usage.cacheWrite,
          }
        : {}),
    },
  });

  const walk = (span: PiTraceSpan, parentId: string): void => {
    // 首选记录里持久化的 spanId（面板与导出/OTLP 同源）；旧记录缺失时回退 DFS 序号
    const id = span.spanId ?? `${run.runId}:${seq++}`;
    const name =
      span.name ??
      (span.kind === "llm_call" && typeof span.attrs?.model === "string"
        ? String(span.attrs.model)
        : typeof span.attrs?.index === "number"
          ? `第 ${span.attrs.index} 轮`
          : KIND_LABEL[span.kind]);
    out.push({
      id,
      parentSpanId: span.parentSpanId ?? parentId,
      name,
      type:
        span.kind === "llm_call"
          ? "llm"
          : span.kind === "tool_call"
            ? "tool"
            : span.kind,
      status: STATUS_MAP[span.status],
      startedAt: span.startMs,
      endedAt: span.endMs || null,
      latencyMs: span.endMs ? Math.max(0, span.endMs - span.startMs) : null,
    });
    inspect.set(id, { attrs: span.attrs, detail: span.detail });
    for (const child of span.children ?? []) walk(child, id);
  };
  for (const turn of run.spans) walk(turn, rootId);
  return { spans: out, inspect };
}

/** 导出 runs 全量 JSON：桌面端走系统保存框（save 对话框 + plugin-fs 写盘），
 * 网页端 / 桌面写盘失败回退 Blob 下载。返回是否完成了导出动作 */
export async function exportTraceRunsJson(
  runs: PiTraceRun[],
  sessionId: string,
): Promise<boolean> {
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${sessionId}-traces-${date}.json`;
  const payload = JSON.stringify(runs, null, 2);

  if (isTauri()) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: filename,
        title: "导出调用轨迹",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return false;
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(path, payload);
      return true;
    } catch {
      // 权限/环境异常 → 回退 Blob 下载
    }
  }

  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
