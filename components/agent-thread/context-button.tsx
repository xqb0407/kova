"use client";

import { useCallback, useEffect, useState, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import { Loader2Icon } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { fmtTokens } from "@/lib/model-format";
import {
  compactContext,
  fetchContextInfo,
  markManualCompaction,
  markManualCompactionStart,
} from "@/lib/pi-context";
import { clearManualCompactionMarker } from "@/lib/pi-compaction-marker";
import type { PiContextInfo } from "@/lib/pi-bridge";

/**
 * 上下文占用查看器（composer 区，模型选择器旁）：点击弹出当前会话的
 * 上下文读数——容量、消息/系统提示词/工具占用、平均缓存命中率、压缩状态。
 * 数据全部由 sidecar 现算（context_info 命令），打开时才拉取。
 * 附「立即压缩」按钮：走 compact 命令手动触发 compaction（运行中会被拒绝）。
 */

/** 占用圆环：18px 描边环，弧长按 已用/容量 比例，颜色随占用升温 */
const UsageRing: FC<{ pct: number | null }> = ({ pct }) => {
  const r = 7;
  const c = 2 * Math.PI * r;
  const f = pct === null ? 0 : Math.min(1, Math.max(0, pct));
  const color =
    pct !== null && pct >= 0.9
      ? "stroke-red-500"
      : pct !== null && pct >= 0.7
        ? "stroke-amber-500"
        : "stroke-sky-500";
  return (
    <svg viewBox="0 0 18 18" className="size-[18px] shrink-0" aria-hidden>
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        strokeWidth="2.5"
        className="stroke-muted-foreground/25"
      />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${f * c} ${c}`}
        transform="rotate(-90 9 9)"
        className={color}
      />
    </svg>
  );
};

const pctOf = (n: number, total: number): string =>
  total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "—";

type MeterRow = { label: string; tokens: number; dotClass: string };

export const ContextButton: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const messageCount = useAuiState((s) => s.thread.messages.length);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<PiContextInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [compacting, setCompacting] = useState(false);

  const load = useCallback(async () => {
    if (!threadId) return;
    setLoading(true);
    setLoadError(null);
    try {
      setInfo(await fetchContextInfo(threadId));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  // 圆环常驻读数：会话产生消息后拉一次；每轮消息增减（回合结束）自动刷新
  useEffect(() => {
    if (!threadId || messageCount === 0) return;
    let cancelled = false;
    fetchContextInfo(threadId)
      .then((i) => {
        if (!cancelled) {
          setInfo(i);
          setLoadError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, messageCount]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) void load();
  };

  const compact = async () => {
    if (!threadId) return;
    setCompacting(true);
    // 先打 start marker：消息流尾部即时显示「正在压缩上下文…」（请求-响应期间的过程反馈）
    markManualCompactionStart(threadId);
    try {
      const res = await compactContext(threadId);
      toast.add({
        title: res.summarized ? "上下文已压缩" : "上下文已重置为新窗口（摘要失败兜底）",
        description: `压缩前 ${fmtTokens(res.tokensBefore)} tokens`,
        type: "success",
      });
      // 替换为完成态分隔线（持续显示，历史装载后由重建的分隔线接管）
      markManualCompaction(threadId, res);
      await load();
    } catch (err) {
      // 失败撤掉「正在压缩」marker，只留 toast 提示
      clearManualCompactionMarker(threadId);
      toast.add({
        title: "压缩失败",
        description: err instanceof Error ? err.message : String(err),
        type: "error",
      });
    } finally {
      setCompacting(false);
    }
  };

  // 空对话没有上下文可看，不占 composer 位
  if (!threadId || messageCount === 0) return null;

  const used = info
    ? info.messageTokens + info.systemPromptTokens + info.toolTokens
    : 0;
  const usedPct = info && info.contextWindow > 0 ? used / info.contextWindow : null;
  const rows: MeterRow[] = info
    ? [
        { label: "消息占用", tokens: info.messageTokens, dotClass: "bg-sky-500" },
        { label: "系统提示词占用", tokens: info.systemPromptTokens, dotClass: "bg-violet-500" },
        { label: "工具占用", tokens: info.toolTokens, dotClass: "bg-amber-500" },
      ]
    : [];

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-slot="aui-composer-context"
            aria-label="Context usage"
            title={
              usedPct === null
                ? "上下文占用"
                : `上下文占用 ${(usedPct * 100).toFixed(1)}%`
            }
            className={cn(
              "hover:bg-muted inline-flex h-7 items-center gap-1 rounded-full px-2 text-sm text-muted-foreground transition-colors hover:text-foreground",
              info?.needsCompaction && "text-amber-600 dark:text-amber-400",
            )}
          >
            <UsageRing pct={usedPct} />
            {usedPct !== null && (
              <span className="tabular-nums">{Math.round(usedPct * 100)}%</span>
            )}
          </button>
        }
      />
      <PopoverContent align="end" side="top" className="w-80">
        <div className="flex flex-col gap-3 p-1">
          {/* 头部：模型 + 容量 */}
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-medium">
              {info?.model?.name ?? "上下文"}
            </span>
            {info && (
              <span className="text-muted-foreground shrink-0 text-xs">
                容量 {fmtTokens(info.contextWindow)}
              </span>
            )}
          </div>

          {loading && !info ? (
            <div className="text-muted-foreground flex items-center gap-2 py-4 text-sm">
              <Loader2Icon className="size-4 animate-spin" />
              读取中…
            </div>
          ) : loadError && !info ? (
            <div className="text-destructive flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 break-words">{loadError}</span>
              <Button size="sm" variant="ghost" onClick={() => void load()}>
                重试
              </Button>
            </div>
          ) : info ? (
            <>
              {/* 占用条：三段堆叠，竖线为压缩阈值位置 */}
              <div className="bg-muted relative h-2 w-full overflow-hidden rounded-full">
                <div className="absolute inset-0 flex">
                  <div
                    className="bg-sky-500"
                    style={{ width: `${(info.messageTokens / Math.max(1, info.contextWindow)) * 100}%` }}
                  />
                  <div
                    className="bg-violet-500"
                    style={{ width: `${(info.systemPromptTokens / Math.max(1, info.contextWindow)) * 100}%` }}
                  />
                  <div
                    className="bg-amber-500"
                    style={{ width: `${(info.toolTokens / Math.max(1, info.contextWindow)) * 100}%` }}
                  />
                </div>
                {info.hardLimit > 0 && (
                  <div
                    className="bg-foreground/70 absolute top-0 h-full w-px"
                    style={{ left: `${(info.hardLimit / Math.max(1, info.contextWindow)) * 100}%` }}
                  />
                )}
              </div>

              <div className="flex flex-col gap-1.5 text-sm">
                {rows.map((r) => (
                  <div key={r.label} className="flex items-center gap-2">
                    <span className={cn("size-2 shrink-0 rounded-full", r.dotClass)} />
                    <span className="text-muted-foreground flex-1">{r.label}</span>
                    <span className="tabular-nums">{fmtTokens(r.tokens)}</span>
                    <span className="text-muted-foreground w-14 text-right tabular-nums">
                      {pctOf(r.tokens, info.contextWindow)}
                    </span>
                  </div>
                ))}
                {/* cacheRead+cacheWrite 全零 = 该 provider 根本不报缓存字段（OpenAI 兼容
                    端点常不回传 prompt_tokens_details.cached_tokens），与真实 0% 区分展示 */}
                <div className="flex items-center gap-2">
                  <span className="size-2 shrink-0 rounded-full bg-emerald-500" />
                  <span className="text-muted-foreground flex-1">平均缓存命中率</span>
                  <span
                    className={cn(
                      "tabular-nums",
                      info.cacheHitRate !== null &&
                        info.usage.cacheRead + info.usage.cacheWrite === 0 &&
                        "text-muted-foreground",
                    )}
                  >
                    {info.cacheHitRate === null
                      ? "—"
                      : info.usage.cacheRead + info.usage.cacheWrite === 0
                        ? "未上报"
                        : `${(info.cacheHitRate * 100).toFixed(1)}%`}
                  </span>
                  <span className="text-muted-foreground w-14 text-right text-xs">
                    {info.cacheHitRate === null
                      ? "无用量"
                      : info.usage.cacheRead + info.usage.cacheWrite === 0
                        ? "无缓存字段"
                        : `${fmtTokens(info.usage.cacheRead)} 命中`}
                  </span>
                </div>
              </div>

              {/* 压缩状态 */}
              <div className="text-muted-foreground border-t pt-2 text-xs">
                {info.needsCompaction ? (
                  <span className="text-amber-600 dark:text-amber-400">
                    已越过压缩阈值（{fmtTokens(info.hardLimit)}），下次发送前自动压缩
                  </span>
                ) : info.generation === 0 ? (
                  <span>共 {info.messageCount} 条消息 · 尚未压缩过</span>
                ) : (
                  <span>
                    已压缩 {info.generation} 次 · 最近一次前{" "}
                    {fmtTokens(info.lastCompaction?.tokensBefore ?? 0)} tokens
                    {info.lastCompaction && !info.lastCompaction.summarized
                      ? "（未摘要直接开新窗口）"
                      : ""}
                  </span>
                )}
              </div>

              <Button
                size="sm"
                variant="outline"
                disabled={compacting || loading || isRunning}
                title={isRunning ? "回复进行中，完成后可手动压缩" : undefined}
                onClick={() => void compact()}
              >
                {compacting ? (
                  <>
                    <Loader2Icon className="size-3.5 animate-spin" />
                    压缩中…
                  </>
                ) : (
                  "立即压缩"
                )}
              </Button>
            </>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
};
