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
import { fmtTokens } from "@/lib/model/model-format";
import {
  cacheMissCause,
  cacheMissHeadline,
  compactContext,
  contextTokenBreakdown,
  fetchContextInfo,
  hasCacheMissCause,
  markManualCompaction,
  markManualCompactionStart,
  setContextMirrorFromPull,
  usePiContextMirror,
} from "@/lib/pi/pi-context";
import { clearManualCompactionMarker } from "@/lib/pi/pi-compaction-marker";
import { usePiThreadState } from "@/lib/pi/pi-runtime";
import type { PiContextInfo } from "@/lib/pi/pi-bridge";
import { Separator } from "../ui/separator";

/**
 * 上下文占用查看器（composer 区，模型选择器旁）：点击弹出当前会话的
 * 上下文读数——容量、消息/系统提示词/工具占用、近 N 轮与累计缓存命中率、
 * 缓存重算归因、压缩状态。
 * 数据全部由 sidecar 现算；占用环走 §7 推送镜像（轮收尾 context_changed
 * 直更，首挂/切线程水合拉一次，常显占用与距自动压缩），popover 打开才
 * 拉完整 context_info（分项/命中率/压缩代数不在推送里）。
 * 附「立即压缩」按钮：走 compact 命令手动触发 compaction（运行中会被拒绝）。
 *
 * 版式约定（同一事实只陈述一次，阅读路径从上到下收窄）：
 *   - 摘要区：模型名 + 占用百分比 + 占用条 + 图例行（绝对值 / 阈值与余量），
 *     总占用、容量、阈值、余量只在这里出现；
 *   - 构成表与缓存行共用同一条 Tokens/占比 右对齐数值轨道；
 *   - 颜色只用于占用条的分区（行首圆点与条同色同序），缓存/状态保持灰阶；
 *   - 页脚只留压缩状态与操作（阈值信息不再重复）。
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
        // 弧长变化（每轮收尾镜像直更）平滑生长；系统降级动效时直接切换
        className={cn(
          color,
          "transition-[stroke-dasharray] duration-500 ease-out motion-reduce:transition-none",
        )}
      />
    </svg>
  );
};

const pctOf = (n: number, total: number): string =>
  total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "—";

/* ------------------------------ 滚动数字 ------------------------------ */

/** 数字窗口的基线补偿（em）：数字位窗口是 overflow:hidden 的行内块，CSS 规定
 *  这种盒的基线落在盒底；把盒底对齐正文基线，窗口内的数字才与相邻文字齐平。
 *  补偿量由字体度量推出（盒顶到基线 = (1em − (A+D))/2 + A），canvas 量一次
 *  当前界面字体即可，跨字号按 em 等比——不写死经验值，换字体/平台自然跟着变。 */
function measureDigitBaselineShiftEm(): number {
  const FALLBACK = 0.15; // 量不到（SSR / 无 canvas）时的保守值
  if (typeof document === "undefined") return FALLBACK;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return FALLBACK;
  const family = getComputedStyle(document.body).fontFamily;
  const size = 100;
  ctx.font = `${size}px ${family || "sans-serif"}`;
  const m = ctx.measureText("0");
  const ascent = m.fontBoundingBoxAscent;
  const descent = m.fontBoundingBoxDescent;
  if (!Number.isFinite(ascent) || !Number.isFinite(descent)) return FALLBACK;
  const baselineFromTop = (size - (ascent + descent)) / 2 + ascent;
  return (size - baselineFromTop) / size;
}

const DIGIT_BASELINE_SHIFT_EM = measureDigitBaselineShiftEm();
const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/** 逐位滚动数字：按字符拆开，数字位各占一个 1em 高的裁切窗口，窗口内 0-9
 *  竖排，值变化时整列滚到目标数字（纯 CSS transform 过渡，无动画库依赖；
 *  prefers-reduced-motion 下不动）。用在会跳变的读数上——弹层打开回填、
 *  手动压缩后重算，滚动让"数据刷新"可感知而不是硬切；小数点/千分位/单位
 *  等非数字字符原样静态渲染。 */
const RollingDigits: FC<{ text: string }> = ({ text }) => (
  <>
    {Array.from(text).map((ch, i) =>
      ch >= "0" && ch <= "9" ? (
        <span
          key={i}
          className="inline-block h-[1em] overflow-hidden"
          style={{ verticalAlign: `${-DIGIT_BASELINE_SHIFT_EM}em` }}
        >
          <span
            className="block transition-transform duration-300 ease-out motion-reduce:transition-none"
            style={{ transform: `translateY(-${Number(ch)}em)` }}
          >
            {DIGITS.map((d) => (
              <span key={d} className="block h-[1em] text-center leading-[1em]">
                {d}
              </span>
            ))}
          </span>
        </span>
      ) : (
        <span key={i}>{ch}</span>
      ),
    )}
  </>
);

type MeterRow = { label: string; tokens: number; dotClass: string };

export const ContextButton: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const messageCount = useAuiState((s) => s.thread.messages.length);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  // §7 推送镜像：占用环的常态数据源（轮收尾 context_changed 直更）
  const mirror = usePiContextMirror(threadId);
  // react-pi 状态里的 context_usage 读数（迁移 4c 双轨之二，thread_event
  // 直驱）：镜像缺位（切线程后尚未收轮等）时兜底环显示
  const liveUsage = usePiThreadState((s) => s.contextUsage);
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
      const res = await fetchContextInfo(threadId);
      setInfo(res);
      // 完整读数顺带校准镜像（拉取胜推送：口径同源、时间更新）
      setContextMirrorFromPull(threadId, res);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) void load();
  };

  const compact = async () => {
    if (!threadId) return;
    setCompacting(true);
    // 压缩边界 = 点击时刻的消息前缀；start/complete 共用同一锚点，
    // 保证后续新消息渲染在分隔线之下而不是把它顶到列表尾部
    const anchorIndex = messageCount;
    // 先打 start marker：即时显示「正在压缩上下文…」（请求-响应期间的过程反馈）
    markManualCompactionStart(threadId, anchorIndex);
    try {
      const res = await compactContext(threadId);
      toast.add({
        title: res.summarized ? "上下文已压缩" : "上下文已重置为新窗口（摘要失败兜底）",
        description: `压缩前 ${fmtTokens(res.tokensBefore)} tokens`,
        type: "success",
      });
      // 替换为完成态分隔线（持续显示，历史装载后由重建的分隔线接管）
      markManualCompaction(threadId, res, anchorIndex);
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

  // 占用环数据源：§7 镜像优先（轮收尾推送直更，常态在线），完整读数次之，
  // react-pi 的 context_usage 读数（迁移 4c 双轨）最后兜底。
  // usedTokens 是 sidecar 统一口径的请求总占用（usage 已含系统提示词/工具，
  // 不得再叠加两项——重复计数会把环推到虚高越线）；旧 sidecar 缺字段时三项相加
  const used = mirror
    ? mirror.usedTokens
    : info
      ? (info.usedTokens ?? info.messageTokens + info.systemPromptTokens + info.toolTokens)
      : (liveUsage?.tokens ?? 0);
  const capacity = mirror
    ? mirror.contextWindow
    : info
      ? info.contextWindow
      : (liveUsage?.contextWindow ?? 0);
  // 自动压缩阈值（hardLimit）：占用距它的百分比常显在 title/popover
  const threshold = mirror ? mirror.threshold : info ? info.hardLimit : 0;
  const usedPct = capacity > 0 ? used / capacity : null;
  const needsCompact = info
    ? info.needsCompaction
    : threshold > 0 && used >= threshold;
  // 距阈值的余量直接用 token 表示：百分比容易被读成"阈值是 90%"
  const remainingTokens =
    threshold > 0 ? Math.max(0, threshold - used) : null;
  const thresholdPct =
    capacity > 0 && threshold > 0
      ? Math.round((threshold / capacity) * 100)
      : null;
  // 占用条/分项行按「请求总占用的分区」呈现（三段相加 = usedTokens，与占用环、
  // 压缩守卫、阈值竖线同一口径；直接相加会把系统提示词/工具重复计一遍）
  const parts = info ? contextTokenBreakdown(info) : null;
  // 端点是否上报缓存字段：cacheRead/cacheWrite 全零 = 该 provider 不给缓存数据
  //（OpenAI 兼容端点常不回传 prompt_tokens_details.cached_tokens），与"真 0 命中"
  // 区分展示——命中率与重算量两行共用这一判据
  const cacheReporting = info
    ? info.usage.cacheRead + info.usage.cacheWrite > 0
    : false;
  // 重算行归因：优先最近一次有明确原因的重算串（空闲过久 / 模型切换）。
  // 最新一串若只是几 K token 的噪声 miss，会把过期这笔大头藏掉
  const missHeadline = info ? cacheMissHeadline(info.cacheMisses) : null;
  const missTitle = (() => {
    const m = info?.cacheMisses;
    if (!m) return undefined;
    const parts = [
      "重算量 = 上一轮 prompt 里未被缓存读到的部分（地板 1024 token）",
    ];
    if (m.lastMiss) {
      const streak = m.lastMiss.streak ?? 1;
      const tokens = m.lastMiss.tokens.toLocaleString();
      parts.push(
        streak > 1
          ? `最近一串重算：连续 ${streak} 轮，首轮 ${tokens} token（${cacheMissCause(m.lastMiss)}）`
          : `最近一次重算 ${tokens} token（${cacheMissCause(m.lastMiss)}）`,
      );
    }
    const attributed = m.lastAttributedMiss;
    if (attributed && !hasCacheMissCause(m.lastMiss)) {
      const streak = attributed.streak ?? 1;
      const tokens = attributed.streakTokens ?? attributed.tokens;
      parts.push(
        `最近一次有明确原因：${cacheMissCause(attributed)}，${streak > 1 ? `连续 ${streak} 轮共 ` : ""}${tokens.toLocaleString()} token`,
      );
    }
    return parts.join("；");
  })();
  const rows: MeterRow[] = parts
    ? [
        { label: "消息", tokens: parts.message, dotClass: "bg-sky-500" },
        { label: "系统提示词", tokens: parts.system, dotClass: "bg-violet-500" },
        { label: "工具调用", tokens: parts.tool, dotClass: "bg-amber-500" },
      ]
    : [];

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-slot="aui-composer-context"
            aria-label={
              usedPct === null
                ? "Context usage"
                : `Context usage ${(usedPct * 100).toFixed(1)}%`
            }
            title={
              usedPct === null
                ? "上下文占用"
                : `上下文占用 ${(usedPct * 100).toFixed(1)}%${
                    needsCompact
                      ? " · 已越过自动压缩阈值"
                      : remainingTokens !== null
                        ? ` · 距阈值 ${fmtTokens(remainingTokens)}`
                        : ""
                  }`
            }
            className="hover:bg-muted inline-flex h-7 items-center rounded-full px-1.5 transition-colors"
          >
            {/* 只留占用环：弧长/颜色已表意，精确读数在 title 与弹层里 */}
            <UsageRing pct={usedPct} />
          </button>
        }
      />
      <PopoverContent align="end" side="top" className="w-88 border-border/60">
        <div className="flex flex-col gap-3">
          {info && parts ? (
            <>
              {/* 摘要区：模型名 + 占用百分比 + 占用条 + 图例行。总占用/容量/
                  阈值/余量只在这里出现一次，下方分项与页脚不再重复总量 */}
              <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium text-foreground">
                    {info.model?.name ?? "上下文"}
                  </span>
                  {/* 容量是模型规格（不随会话变化），与模型名同行；用量读法在
                      图例行——容量全panel只出现这一次 */}
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    容量 {fmtTokens(info.contextWindow)}
                  </span>
                </div>
                {/* 当前占用行：百分比为主读数，绝对值为辅（两者都只此一处） */}
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-lg leading-none font-semibold text-foreground tabular-nums">
                    <RollingDigits text={pctOf(parts.used, info.contextWindow)} />
                  </span>
                  <span className="text-muted-foreground/70 text-xs tabular-nums">
                    已用 <RollingDigits text={parts.used.toLocaleString()} /> tokens
                  </span>
                </div>
                {/* 占用条：三段堆叠（= 请求总占用的分区），竖线为压缩阈值位置 */}
                <div
                  className="bg-muted relative h-2 w-full overflow-hidden rounded-full"
                  title={`请求总占用 ${pctOf(parts.used, info.contextWindow)} · 自动压缩阈值 ${fmtTokens(info.hardLimit)}`}
                >
                  {/* 段宽/阈值线随数据刷新平滑过渡（打开回填、压缩后重算），
                      系统降级动效时直接切换 */}
                  <div className="absolute inset-0 flex">
                    <div
                      className="bg-sky-500 transition-[width] duration-500 ease-out motion-reduce:transition-none"
                      style={{ width: `${(parts.message / Math.max(1, info.contextWindow)) * 100}%` }}
                    />
                    <div
                      className="bg-violet-500 transition-[width] duration-500 ease-out motion-reduce:transition-none"
                      style={{ width: `${(parts.system / Math.max(1, info.contextWindow)) * 100}%` }}
                    />
                    <div
                      className="bg-amber-500 transition-[width] duration-500 ease-out motion-reduce:transition-none"
                      style={{ width: `${(parts.tool / Math.max(1, info.contextWindow)) * 100}%` }}
                    />
                  </div>
                  {info.hardLimit > 0 && (
                    <div
                      className="bg-foreground/50 absolute top-0 h-full w-px"
                      style={{ left: `${(info.hardLimit / Math.max(1, info.contextWindow)) * 100}%` }}
                    />
                  )}
                </div>
                {/* 图例行：阈值位置 | 余量（同一行分列在占用条两端下方） */}
                <div className="text-muted-foreground/70 flex items-center justify-between gap-2 text-xs tabular-nums">
                  <span title={`自动压缩阈值 ${fmtTokens(info.hardLimit)} tokens`}>
                    {info.hardLimit <= 0
                      ? "自动压缩阈值 —"
                      : `自动压缩 ${
                          thresholdPct !== null
                            ? `${thresholdPct}%`
                            : fmtTokens(info.hardLimit)
                        }`}
                  </span>
                  <span
                    className={cn(
                      info.needsCompaction && "text-amber-600 dark:text-amber-400",
                    )}
                  >
                    {info.needsCompaction ? (
                      "已越过自动压缩阈值"
                    ) : remainingTokens !== null ? (
                      <>
                        距阈值 <RollingDigits text={fmtTokens(remainingTokens)} />
                      </>
                    ) : (
                      ""
                    )}
                  </span>
                </div>
              </div>

              {/* 构成表：三段与占用条同色同序；Tokens/占比两列右对齐，
                  与下方缓存行数值同轨（总量已由摘要区承载，不再设合计行） */}
              <div className="flex flex-col gap-1.5 text-sm">
                <div className="text-muted-foreground/60 flex items-center gap-2 text-xs font-medium tracking-wide">
                  <span className="size-1.5 shrink-0" />
                  <span className="flex-1">占用构成</span>
                  <span className="w-14 text-right">Tokens</span>
                  <span className="w-12 text-right">占比</span>
                </div>
                {rows.map((r) => (
                  <div key={r.label} className="flex items-center gap-2">
                    <span className={cn("size-1.5 shrink-0 rounded-full", r.dotClass)} />
                    <span className="text-muted-foreground flex-1 text-xs">{r.label}</span>
                    <span className="text-foreground/80 w-14 text-right text-xs tabular-nums">
                      <RollingDigits text={r.tokens.toLocaleString()} />
                    </span>
                    <span className="text-foreground/80 w-12 text-right text-xs tabular-nums">
                      <RollingDigits text={pctOf(r.tokens, info.contextWindow)} />
                    </span>
                  </div>
                ))}
              </div>

              {/* 缓存：与上表数值同轨（百分比贴同一条右基准线）；行首留空点
                  保持缩进对齐（不占条分区，因此不配色）。端点不上报缓存字段时
                  整段不占位，只在页脚状态里带一句「缓存未上报」 */}
              {cacheReporting ? (
                <div className="border-border/40 flex flex-col gap-1.5 border-t pt-2.5 text-sm">
                  {/* 主数字 = 最近 N 轮 token 加权命中率：冷启动与偶发整段重算会
                      长期压低累计值，短窗才反映当前稳态。窗口写进标签——只写
                      「缓存命中率」会被读成会话平均（累计在下一行） */}
                  <div
                    className="flex items-center gap-2"
                    title={
                      info.cacheMisses?.recent?.requests
                        ? `最近 ${info.cacheMisses.recent.requests} 轮：ΣcacheRead / Σprompt（token 加权）`
                        : "全历史累计命中率"
                    }
                  >
                    <span className="size-1.5 shrink-0" />
                    <span className="text-muted-foreground flex-1 text-xs">
                      缓存命中率
                      {info.cacheMisses?.recent?.requests ? (
                        <span className="text-muted-foreground/60">
                          {` · 近 ${info.cacheMisses.recent.requests} 轮`}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-foreground/80 w-12 text-right text-xs tabular-nums">
                      {info.cacheMisses?.recent?.hitRate == null ? (
                        info.cacheHitRate === null ? (
                          "-"
                        ) : (
                          <RollingDigits
                            text={`${(info.cacheHitRate * 100).toFixed(1)}%`}
                          />
                        )
                      ) : (
                        <RollingDigits
                          text={`${(info.cacheMisses.recent.hitRate * 100).toFixed(1)}%`}
                        />
                      )}
                    </span>
                  </div>
                  {/* 全历史累计：长会话里几乎不动，与近 N 轮并列看长期水位；
                      近 N 轮缺数据时主数字已回落到累计，这行不再重复 */}
                  {info.cacheHitRate != null &&
                  info.cacheMisses?.recent?.hitRate != null ? (
                    <div
                      className="flex items-center gap-2"
                      title="全历史累计：ΣcacheRead / Σprompt（含冷启动与压缩重建轮）"
                    >
                      <span className="size-1.5 shrink-0" />
                      <span className="text-muted-foreground flex-1 text-xs">累计</span>
                      <span className="text-foreground/80 w-12 text-right text-xs tabular-nums">
                        <RollingDigits text={`${(info.cacheHitRate * 100).toFixed(1)}%`} />
                      </span>
                    </div>
                  ) : null}
                  {/* 最近一次请求：与近 10 轮/累计并列，便于和 pi-main 的 footer 口径对账 */}
                  {info.cacheMisses?.lastRequest ? (
                    <div
                      className="flex items-center gap-2"
                      title={`最近一次请求：${info.cacheMisses.lastRequest.cached.toLocaleString()} / ${info.cacheMisses.lastRequest.prompt.toLocaleString()} token 命中`}
                    >
                      <span className="size-1.5 shrink-0" />
                      <span className="text-muted-foreground flex-1 text-xs">最近一次</span>
                      <span className="text-foreground/80 w-12 text-right text-xs tabular-nums">
                        {info.cacheMisses.lastRequest.hitRate == null
                          ? "-"
                          : `${(info.cacheMisses.lastRequest.hitRate * 100).toFixed(1)}%`}
                      </span>
                    </div>
                  ) : null}
                  {/* 缓存重算（pi 口径）：上一轮 prompt 里没被缓存读到的 token 量；
                      归因优先取最近一次有明确原因的重算串（过期/换模型），并带
                      连续轮数——只看最后一轮会把过期后的连带轮误报成「未归因」 */}
                  {info.cacheMisses?.missedTokens != null ? (
                    <div className="flex items-center gap-2" title={missTitle}>
                      <span className="size-1.5 shrink-0" />
                      <span className="text-muted-foreground flex-1 text-xs">
                        缓存重算
                        <span className="text-muted-foreground/60">
                          （{info.cacheMisses?.missCount ?? 0} 次
                          {missHeadline ? `，最近原因：${missHeadline}` : ""}
                          ）
                        </span>
                      </span>
                      <span className="text-foreground/80 shrink-0 text-right text-xs tabular-nums">
                        <RollingDigits
                          text={(info.cacheMisses?.missedTokens ?? 0).toLocaleString()}
                        />
                        <span className="text-muted-foreground/60 ml-0.5 text-xs">
                          tokens
                        </span>
                      </span>
                    </div>
                  ) : (info.cacheMisses?.requests ?? 0) > 1 ? (
                    <div
                      className="flex items-center gap-2"
                      title={`单请求重处理 ≥2000 token 且 ≥5% 记一次 miss；已排除 ${info.cacheMisses?.rebuilds ?? 0} 次预期重建`}
                    >
                      <span className="size-1.5 shrink-0" />
                      <span className="text-muted-foreground flex-1">
                        逐请求缓存 miss
                      </span>
                      <span className="text-foreground/80 w-14 text-right text-xs tabular-nums">
                        {info.cacheMisses?.misses ?? 0}/
                        {Math.max(
                          0,
                          (info.cacheMisses?.requests ?? 0) -
                            1 -
                            (info.cacheMisses?.rebuilds ?? 0),
                        )}
                      </span>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <Separator className="bg-border/40" />

              {/* 页脚：压缩状态 + 操作（阈值/余量已归图例行，这里不再重复） */}
              <div className="flex items-center justify-between gap-2">
                <span
                  className="text-muted-foreground min-w-0 truncate text-xs"
                  title={
                    info.lastCompaction
                      ? `最近一次压缩前 ${fmtTokens(info.lastCompaction.tokensBefore)} tokens${
                          info.lastCompaction.summarized
                            ? ""
                            : "（摘要失败，保留最近对话）"
                        }`
                      : undefined
                  }
                >
                  {info.needsCompaction
                    ? "已越过压缩阈值 · 发送前自动压缩"
                    : info.generation === 0
                      ? `共 ${info.messageCount} 条消息 · 未压缩`
                      : `已压缩 ${info.generation} 次`}
                  {!cacheReporting ? " · 缓存未上报" : ""}
                </span>
                <Button
                  size="sm"
                  className="h-7 shrink-0 px-2.5 text-xs border! border-border/40 cursor-pointer"
                  disabled={compacting || loading || isRunning}
                  title={
                    isRunning
                      ? "回复进行中，完成后可手动压缩"
                      : "手动压缩上下文"
                  }
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
              </div>
            </>
          ) : loading ? (
            <div className="text-muted-foreground flex items-center gap-2 py-3 text-xs">
              <Loader2Icon className="size-3.5 animate-spin" />
              读取中…
            </div>
          ) : loadError ? (
            <div className="text-destructive flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 break-words">{loadError}</span>
              <Button
                size="xs"
                variant="ghost"
                className="h-6 shrink-0 text-xs"
                onClick={() => void load()}
              >
                重试
              </Button>
            </div>
          ) : mirror ? (
            // 完整读数还没到位、但 §7 推送镜像已在：摘要区的无分项版本
            <div className="flex flex-col gap-2 py-0.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium text-foreground">
                  上下文
                </span>
                {capacity > 0 && (
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    容量 {fmtTokens(capacity)}
                  </span>
                )}
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-lg leading-none font-semibold text-foreground tabular-nums">
                  {usedPct === null ? (
                    "—"
                  ) : (
                    <RollingDigits text={`${(usedPct * 100).toFixed(1)}%`} />
                  )}
                </span>
                <span className="text-muted-foreground/70 text-xs tabular-nums">
                  已用 <RollingDigits text={used.toLocaleString()} /> tokens
                </span>
              </div>
              <div className="text-muted-foreground/70 flex justify-end text-xs tabular-nums">
                <span
                  className={cn(
                    needsCompact && "text-amber-600 dark:text-amber-400",
                  )}
                >
                  {needsCompact
                    ? "已越过自动压缩阈值"
                    : remainingTokens !== null
                      ? `距阈值 ${fmtTokens(remainingTokens)}`
                      : ""}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
};
