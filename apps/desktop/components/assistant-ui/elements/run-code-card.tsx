"use client";

/**
 * PTC（run_code）卡片：活卡片 + 展开详情。
 *
 * 设计对齐两个参照：
 * - MiniMax：收起态 = 一行标题（模型给的 description）；正常输出不铺在聊天卡里；
 *   子调用计数聚合，不逐条铺。
 * - Kova Task 卡（子智能体）：运行中每秒 elapsed 心跳、状态徽标实时点亮——
 *   run_code 与 Task 同构（一次委派、内部 N 个子动作），复用同一交互心智。
 *
 * 展开区：脚本 Shiki 高亮（复用 @streamdown/code 的模块级 highlighter 缓存，
 * 与 markdown 渲染共享预热，不额外建实例）、失败子调用逐条、输出头尾 1 KiB、
 * 外置回执只留一句路径。
 */

import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { code as shikiCode, type HighlightResult } from "@streamdown/code";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  LoaderCircleIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type PtcChildCallView = {
  id?: string;
  name: string;
  args?: string;
  status: "running" | "ok" | "error" | "cancelled";
  error?: string;
};

export type PtcDetailsView = {
  calls?: PtcChildCallView[];
  wallTimeMs?: number;
  description?: string;
};

const RUN_CODE_HEADER =
  /^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n/;

export function stripRunCodeHeader(text: string): string {
  return text.replace(RUN_CODE_HEADER, "").trim();
}

/**
 * tool-budget 外置回执（`[Tool output externalized]` 开头）：剥出 artifact 路径，
 * 其余英文说明（bytes / read strategy / pointer 提示）是写给模型的，用户不渲染。
 */
export function splitRunCodeReceipt(
  text: string,
): { reference?: string; body: string } {
  const marker = "[Tool output externalized]";
  if (!text.startsWith(marker)) return { body: text };
  const lines = text.slice(marker.length).trim().split("\n");
  const referenceLine = lines.find(
    (line) => line.startsWith("Artifact path:") || line.trim().startsWith("/"),
  );
  const reference = referenceLine?.replace(/^Artifact path:\s*/, "").trim();
  return { reference, body: "" };
}

/** 展开区的输出预览：头尾各 1 KiB，中间省略（超长/外置场景同款）。 */
function runCodeOutputPreview(text: string, half = 1024): string {
  if (text.length <= half * 2) return text;
  return `${text.slice(0, half)}\n\n[… 中间 ${text.length - half * 2} 字符已省略，全文已存盘 …]\n\n${text.slice(-half)}`;
}

/* ------------------------------ elapsed 心跳 ------------------------------ */

/**
 * 运行中每秒一拍（Task 卡同款）：以 `Date.now() - 锚点` 现算，不依赖 props 里的
 * 静态 wallTimeMs —— 那是 sidecar 最后一次 onUpdate 的快照，两次 update 之间
 * 不变，直接渲染它数字不会跳。
 *
 * 锚点 = running 起点的时刻：wallTimeMs 是「脚本已运行多久」的最近快照，所以
 * running 首次出现（或从 pause 类中断恢复）时记 `Date.now() - wallTimeMs`；
 * wallTimeMs 缺席（首个 update 之前）就记当下。结算后停止跳动，回落显示
 * sidecar 的最终 wallTimeMs（与结果头部的 Wall time 同源）。
 */
export function useRunCodeElapsed(
  running: boolean,
  wallTimeMs: number | undefined,
): string | undefined {
  const [, setTick] = useState(0);
  const anchorRef = useRef<number | undefined>(undefined);
  const wasRunning = useRef(false);

  useEffect(() => {
    if (running) {
      // running 开始/恢复：锚定一次。wallTimeMs 已知时反推起点，保证多轮
      // run_code 之间互不串表（每张卡自己的 wallTimeMs 各自归零）。
      anchorRef.current = Date.now() - (wallTimeMs ?? 0);
      wasRunning.current = true;
      const timer = setInterval(() => setTick((x) => x + 1), 1000);
      return () => clearInterval(timer);
    }
    // 结算：清锚点，让回落路径读 sidecar 的终值
    if (wasRunning.current) {
      wasRunning.current = false;
      anchorRef.current = undefined;
    }
    return undefined;
    // wallTimeMs 变化不重建定时器：锚点只在 running 边沿设置一次
  }, [running]);

  if (!running) return undefined;
  const anchor =
    anchorRef.current ?? Date.now() - (wallTimeMs ?? 0);
  return `${((Date.now() - anchor) / 1000).toFixed(1)}s`;
}

/* ------------------------------ 状态徽标条 ------------------------------ */

/** `✓2 ⟳1` 式迷你状态条：不展开也能看到子调用进度。全 0 时不渲染。 */
export const RunCodeStatusPips: FC<{ calls: PtcChildCallView[] }> = ({
  calls,
}) => {
  if (calls.length === 0) return null;
  const ok = calls.filter((c) => c.status === "ok").length;
  const running = calls.filter((c) => c.status === "running").length;
  const error = calls.filter(
    (c) => c.status === "error" || c.status === "cancelled",
  ).length;
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
      {ok > 0 ? (
        <span className="flex items-center gap-0.5 text-emerald-600/80 dark:text-emerald-400/80">
          <CheckIcon className="size-3" />
          {ok}
        </span>
      ) : null}
      {running > 0 ? (
        <span className="flex items-center gap-0.5 text-muted-foreground">
          <LoaderCircleIcon className="size-3 animate-spin" />
          {running}
        </span>
      ) : null}
      {error > 0 ? (
        <span className="flex items-center gap-0.5 text-destructive">
          <XIcon className="size-3" />
          {error}
        </span>
      ) : null}
    </span>
  );
};

/* --------------------------- 脚本 Shiki 高亮块 --------------------------- */

type HighlightState =
  | { kind: "pending" }
  | { kind: "ready"; tokens: HighlightResult }
  | { kind: "fallback" };

/**
 * 用 @streamdown/code 的模块级 highlighter（与 markdown 渲染共享缓存与预热，
 * 不新建 Shiki 实例）把脚本染成 token。javascript 已在 prewarm 名单里，
 * 首个 run_code 卡大概率同步/近同步命中。
 */
function useShikiTokens(code: string): HighlightState {
  const [state, setState] = useState<HighlightState>({ kind: "pending" });
  useEffect(() => {
    let alive = true;
    setState({ kind: "pending" });
    const trimmed = code.trimEnd();
    if (!trimmed) {
      setState({ kind: "fallback" });
      return;
    }
    const themes = shikiCode.getThemes();
    const result = shikiCode.highlight(
      { code: trimmed, language: "javascript", themes },
      (tokens) => {
        if (alive) setState({ kind: "ready", tokens });
      },
    );
    // 同步命中（缓存已有）直接用
    if (result) {
      if (alive) setState({ kind: "ready", tokens: result });
      return;
    }
    return () => {
      alive = false;
    };
  }, [code]);
  return state;
}

const HIGHLIGHT_MAX_CHARS = 8 * 1024;

/** 高亮脚本块：高亮范围恒为前 8 KiB（超长全文 tokenize 会顿主线程），
 *  其余行以灰文本渲染在同一个 pre 里，展开/收起只改变可见范围。 */
const RunCodeScriptBlock: FC<{ code: string }> = ({ code }) => {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => code.split("\n"), [code]);
  // 高亮窗口：折叠 = 前 12 行；展开 = 前 HIGHLIGHT_MAX_CHARS 字符（按行对齐）
  const highlightLimit = useMemo(() => {
    if (expanded) {
      let end = Math.min(code.length, HIGHLIGHT_MAX_CHARS);
      const nl = code.indexOf("\n", end);
      if (nl !== -1) end = nl;
      return end;
    }
    return lines.slice(0, 12).join("\n").length;
  }, [expanded, code, lines]);
  const visible = expanded ? code : lines.slice(0, 12).join("\n");
  const highlightedSource = code.slice(0, highlightLimit);
  const tailSource = code.slice(highlightLimit);
  const state = useShikiTokens(highlightedSource);
  const hiddenCount = lines.length - 12;

  return (
    <div className="bg-background overflow-hidden rounded-md border">
      <pre className="max-h-60 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
        {state.kind === "ready" ? (
          <>
            {state.tokens.tokens.map((line, i) => (
              <span key={i}>
                {line.length > 0 ? (
                  line.map((token, j) => (
                    <span key={j} style={token.color ? { color: token.color } : undefined}>
                      {token.content}
                    </span>
                  ))
                ) : (
                  <br />
                )}
                {i < state.tokens.tokens.length - 1 ? "\n" : null}
              </span>
            ))}
            {tailSource ? <span className="text-muted-foreground">{tailSource}</span> : null}
          </>
        ) : (
          visible
        )}
      </pre>
      {lines.length > 12 || code.length > HIGHLIGHT_MAX_CHARS ? (
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 border-t px-3 py-1 text-xs transition-colors"
        >
          {expanded ? (
            <>
              <ChevronUpIcon className="size-3" />
              收起
            </>
          ) : (
            <>
              <ChevronDownIcon className="size-3" />
              其余 {Math.max(hiddenCount, 0)} 行，运行时全文执行
            </>
          )}
        </button>
      ) : null}
    </div>
  );
};

/* ------------------------------ 展开详情 ------------------------------ */

export const RunCodeExpanded: FC<{
  code: string;
  calls: PtcChildCallView[];
  output: string;
  reference?: string;
  failed: boolean;
}> = ({ code, calls, output, reference, failed }) => {
  const failedCalls = calls.filter(
    (call) => call.status === "error" || call.status === "cancelled",
  );
  const summaryParts: string[] = [];
  const ok = calls.filter((c) => c.status === "ok").length;
  if (ok > 0) summaryParts.push(`${ok} 成功`);
  const errorCount = failedCalls.length;
  if (errorCount > 0) summaryParts.push(`${errorCount} 失败/取消`);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-1">
        <div className="text-muted-foreground text-xs">
          脚本{code ? ` · ${code.split("\n").length} 行` : ""}
        </div>
        <RunCodeScriptBlock code={code} />
      </div>

      {calls.length > 0 ? (
        <div className="flex flex-col gap-1">
          <div className="text-muted-foreground text-xs">
            子调用 {calls.length} 次
            {summaryParts.length > 0 ? ` · ${summaryParts.join(" · ")}` : ""}
          </div>
          {failedCalls.map((call, callIndex) => (
            <div
              key={call.id ?? `${call.name}-${call.args ?? ""}-${callIndex}`}
              className="flex min-w-0 items-start gap-2"
            >
              <span className="mt-0.5">
                {call.status === "running" ? (
                  <LoaderCircleIcon className="text-muted-foreground size-3 shrink-0 animate-spin" />
                ) : (
                  <XIcon className="text-destructive size-3 shrink-0" />
                )}
              </span>
              <span className="shrink-0 font-mono text-xs">{call.name}</span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
                {call.args ?? ""}
              </span>
              <span className="text-destructive min-w-0 max-w-[45%] truncate text-xs">
                {call.error ?? (call.status === "cancelled" ? "已取消" : "")}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {output ? (
        <div className="flex flex-col gap-1">
          <div className="text-muted-foreground text-xs">输出</div>
          <pre
            className={cn(
              "bg-background max-h-48 overflow-auto rounded-md border px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words",
              failed ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {runCodeOutputPreview(output)}
          </pre>
        </div>
      ) : null}

      {reference ? (
        <p className="text-muted-foreground truncate font-mono text-xs">
          全文已存盘：{reference}
        </p>
      ) : null}
    </div>
  );
};

