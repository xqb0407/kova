"use client";

// 轮次折叠（Codex 风格）：一轮 = 用户发消息 → 本次 loop 结束。轮结束后，
// 中间步骤（工具调用、思考、过程性正文）收起成一行工作摘要，保留用户气泡与
// 最终回答——收起的是过程不是结论，长会话里被砍掉的是 DOM 的大头（工具行 +
// 过程 markdown），草稿仍能从头读到尾（见 thread.tsx 的接线）。
//
// 摘要行同时是折叠开关：默认收起，点开回到完整消息流；展开状态再点收起。
// 用户手动开合是显式覆盖，自动策略（非最新轮收起）不再翻回去。

import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { ChevronDownIcon } from "lucide-react";
import type { FC, ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { useT } from "@/lib/i18n";
import { AssistantMessage } from "./assistant-message";
import { useScrollLock } from "@/hooks/use-scroll-lock";
import {
  getTurnIndex,
  isModelChangeOnlyMessage,
  messageIndexById,
  packTurnSlot,
  packTurnSummary,
  parseTurnSlot,
  parseTurnSummary,
  resolveTurnSlotPresentation,
  type TurnSlotInfo,
} from "@/lib/panels/message-turns";
import {
  expandTurn,
  getTurnTiming,
  noteTurnEnd,
  noteTurnStart,
  resolveObservedTurnTimingWrite,
  restartTurnTiming,
  scopedTurnKey,
  setTurnCollapsed,
  useTurnCollapsed,
  useTurnDurationMs,
} from "@/lib/panels/turn-collapse";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** 展开/收起：时长与缓动和 reasoning / 工具组同一套（globals.css 的
 *  collapsible-down/up 高度关键帧按这个时长跑，chevron 与内层淡入淡出同拍） */
const PROCESS_ANIMATION_MS = 200;
const PROCESS_EASE = "ease-[cubic-bezier(0.32,0.72,0,1)]";

/**
 * 中文时长（对齐 Codex 的「已工作 4 分 8 秒」）：秒级不带前缀，分秒才给分。
 * 词典 chat.duration.*，按当前语言取模板（调用时解析，组件经 useT 订阅重渲染）。
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return t("chat.duration.hoursMinutes", { hours, minutes });
  if (minutes > 0) return t("chat.duration.minutesSeconds", { minutes, seconds });
  return t("chat.duration.seconds", { seconds });
}

/**
 * 轮内「过程」区：与 reasoning 同款的展开动画（Base UI Collapsible 的高度
 * 关键帧 + 同款缓动 + 内层 fade/slide/blur + 动画期间钉住视口滚动），收起后
 * 面板整体卸载，DOM 收益与之前「直接不渲染」一致。
 *
 * 间距数学（消息组是 gap-y-6 的 flex 列）：root 用 -mt-6 抵消自己那一段
 * 间隙，内层 pt-6 计入动画高度。于是收起时净贡献 0（回答紧跟在摘要行下方
 * 24px，与不加包裹时完全一致），展开时行与过程之间视觉仍是 24px——两端都
 * 不跳；若把 padding 放 root 上，收起后会多出 24px 空档。
 */
const TurnProcess: FC<{ collapsed: boolean; children: ReactNode }> = ({
  collapsed,
  children,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const lockScroll = useScrollLock(rootRef, PROCESS_ANIMATION_MS);
  const prevCollapsed = useRef(collapsed);
  useLayoutEffect(() => {
    if (prevCollapsed.current === collapsed) return;
    prevCollapsed.current = collapsed;
    // 高度动画期间钉住滚动位置（reasoning 同款），避免长过程展开时视口乱跳
    lockScroll();
  }, [collapsed, lockScroll]);

  return (
    <Collapsible
      ref={rootRef}
      open={!collapsed}
      className="-mt-6"
      style={{ ["--animation-duration" as string]: `${PROCESS_ANIMATION_MS}ms` }}
    >
      <CollapsibleContent
        className={cn(
          "group/collapsible-content overflow-hidden outline-none",
          PROCESS_EASE,
          "motion-reduce:animate-none",
          "data-closed:animate-collapsible-up",
          "data-open:animate-collapsible-down",
          "data-closed:fill-mode-forwards",
          "data-closed:pointer-events-none",
          "[--tw-duration:var(--animation-duration)]",
        )}
      >
        <div
          data-slot="aui_turn-process"
          className={cn(
            // overflow-hidden：挡掉消息尾部操作栏槽位（h-7.5 -mb-7.5）向下溢出的
            // 30px——Base UI 用面板 scrollHeight 当动画目标高度，不裁的话高度会
            // 量多一截，动画收尾时再跳回去。过程消息本来就没有操作栏（轮中不挂），
            // 裁剪不会切掉任何可见内容。
            "overflow-hidden pt-2",
            "transform-gpu",
            PROCESS_EASE,
            "motion-reduce:animate-none",
            "group-data-open/collapsible-content:animate-in",
            "group-data-closed/collapsible-content:animate-out",
            "group-data-open/collapsible-content:fade-in-0",
            "group-data-closed/collapsible-content:fade-out-0",
            "group-data-open/collapsible-content:slide-in-from-top-2",
            "group-data-closed/collapsible-content:slide-out-to-top-2",
            "group-data-open/collapsible-content:blur-in-[2px]",
            "group-data-closed/collapsible-content:blur-out-[2px]",
            "group-data-open/collapsible-content:animation-duration-(--animation-duration)",
            "group-data-closed/collapsible-content:animation-duration-(--animation-duration)",
          )}
        >
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

/**
 * 消息槽（Codex 风格的三种呈现）：
 *  - 轮首：用户气泡照常，底下跟工作摘要行（本轮过程已收起时）
 *  - 轮末：最终回答照常渲染（折叠时也保留）
 *  - 轮中：折叠时不渲染（过程性消息整体不挂载）
 * 工具成图与思考/工具行同属过程面：折叠态整条卸载（长轮里的截图很重，收起
 * 后不该继续解码），展开即按原位显示。
 * 压缩分隔线一律归过程区（轮中/轮末同理，见 dividerOnly 分支）：收起态不在
 * 外部露线，展开后各条仍在它发生时的那条消息位置上
 * 编辑中的消息强制展开（thread.tsx 已把该条换成 EditComposer，这里把整轮
 * 放开，避免出现「编辑器孤零零挂在收起的过程里」）。
 */
export const TurnSlot: FC<{
  messageId: string;
  isEditing: boolean;
  children: ReactNode;
}> = ({ messageId, isEditing, children }) => {
  const packed = useAuiState((s) => packTurnSlot(s.thread.messages, messageId));
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  // 线程级运行中：轮内消息状态位有空窗（压缩期间没有消息在流），末轮的
  // 纯分隔线消息靠它判定「还在跑」——与 TurnWorkSummary 的 running 同款
  const threadRunning = useAuiState((s) => s.thread.isRunning);
  const slot = useMemo(() => parseTurnSlot(packed), [packed]);
  const scopedKey = slot ? scopedTurnKey(threadId, slot.turnKey) : "";
  // 默认收起（对齐 dsh-message-fold / Codex）：收的是"已经结束的中间步骤"，
  // 不是正在跑的那一步——跑的过程中旧步骤收起成一行，当前这条照常实时渲染
  // （见下面的拆分条件：流式中的轮末整条渲染，正在跑的工具行看得见）。
  // 用户的显式开合优先，自动策略不翻回去。
  const collapsed = useTurnCollapsed(scopedKey, false);
  // 分支顺序是行为的一部分（锁在 resolveTurnSlotPresentation 的单测里）
  const presentation = slot
    ? resolveTurnSlotPresentation(slot, { isEditing, threadRunning })
    : null;
  // 模型切换分隔线是轮间事件，不走过程折叠：收起态也必须看得见（解释这一轮
  // 为什么换了模型、缓存为何重建）。压缩线仍按过程记录收进折叠区。
  const alwaysVisible = useAuiState((s) => {
    const idx = messageIndexById(s.thread.messages, messageId);
    const message = idx >= 0 ? s.thread.messages[idx] : undefined;
    return message ? isModelChangeOnlyMessage(message) : false;
  });

  useEffect(() => {
    if (isEditing && scopedKey) expandTurn(scopedKey);
  }, [isEditing, scopedKey]);

  if (!slot || !presentation) return <>{children}</>;
  if (presentation === "summary") {
    return (
      <>
        {children}
        {/* 一行一轮、常驻：任务一开始（用户发出消息）就有——运行中是「工作中 +
            计时」，结束变「已工作 X」；展开/收起后都在，能再点回去 */}
        <TurnWorkSummary slot={slot} scopedKey={scopedKey} collapsed={collapsed} />
      </>
    );
  }
  // 非最新轮、或「被手动中断」的轮末：拆成「过程（可收起）」+「回答正文（始终
  // 可见）」。最后一条消息里夹带的工具调用/思考归过程面，收起后不再漏在外面；
  // process 面与 answer 面在两种状态下位置都不变（只是面板开合），开合平滑、
  // 正文不会重挂。中断轮不参与"最新轮保持展开"（流已结束，可安全拆分）。
  // 轮末：「已结束的」才拆成 过程（可收起）+ 正文；还在流式的整条渲染
  // （正文与工具的交错不重排，正在跑的工具行也看得见）
  // isAnswerTail：空闲/手动压缩在轮末留下一列独立的分隔线消息，轮末身份归
  // 分隔线，但答案面同样要拆出来——否则答案成了轮中消息，收起后连带消失
  // dividerOnly：纯分隔线消息没有答案面，不进拆分（空 answer 面会多留一个
  // 空节点），整条归过程区——收起隐藏，展开回它自己的位置
  if (presentation === "split") {
    return (
      <>
        <TurnProcess collapsed={collapsed}>
          <AssistantMessage variant="process" />
        </TurnProcess>
        <AssistantMessage variant="answer" />
      </>
    );
  }
  // 整条渲染：流式中的轮末（正文与工具交错不重排）。纯分隔线消息在压缩进行中
  // 也走这里——它此刻就是最新一条，横幅（正在压缩上下文… → 已压缩）是这一段
  // 唯一的进度反馈，静默几十秒的摘要生成没有提示会像卡死；判定同 TurnWorkSummary
  // （轮内流状态为空窗，末轮要看线程级 isRunning）
  if (presentation === "full") return <>{children}</>;
  // 正在进行的轮：过程照常展开。
  // 合并成一条消息的时代，「正在跑的那一步可见」天然成立——轮末整条渲染，而一轮
  // 只有那一条消息。投影侧按 part 数切块后，一轮会有多条过程消息，不放开的话除
  // 末块外都会被默认收起（收起即整块卸载），跑的过程中只剩最后一块可见。
  // TurnProcess 根节点的 -mt-6 抵消消息组的 gap-y-6，所以块与块之间不多出间距。
  if (presentation === "forced") {
    return <TurnProcess collapsed={false}>{children}</TurnProcess>;
  }
  // 模型切换分隔线：轮间事件，收起态也常显（不走过程折叠）
  if (alwaysVisible) return <>{children}</>;
  // 轮中过程 / 压缩分隔线：包进可动画的过程区（收起时整块卸载）
  return <TurnProcess collapsed={collapsed}>{children}</TurnProcess>;
};

/** 一行工作摘要：耗时 · 工具 · 文件，兼作收起/展开开关 */
/** 运行中的秒表：每秒只重渲染这一小段文字。
 *  原先 tick 挂在 TurnWorkSummary 上，每秒会把整块摘要（连同 packTurnSummary
 *  选区解析）一起重渲染；dev 实测长会话里每次 1Hz tick 触发约 90ms 的 React
 *  任务，流式期间就是稳定掉帧。 */
const LiveElapsed: FC<{ running: boolean; startedAt: number | undefined }> = ({
  running,
  startedAt,
}) => {
  const t = useT();
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running || startedAt === undefined) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);

  const elapsedMs =
    running && startedAt !== undefined ? Date.now() - startedAt : undefined;
  // 只让不变的「工作中」扫光，逐秒变化的数字放在外面：文字长度每帧变化
  // 会打断扫光节奏，也让读秒显得闪烁。
  if (elapsedMs === undefined || elapsedMs < 1000) {
    return (
      <span className="tabular-nums shimmer">
        {t("chat.turnSummary.working")}
      </span>
    );
  }
  return (
    <span className="tabular-nums">
      <span className="shimmer">{t("chat.turnSummary.working")}</span>
      {` ${formatDuration(elapsedMs)}`}
    </span>
  );
};

/**
 * 摘要行下方的分隔线：1px 细线，运行中叠一道扫光，结束后回到静态。
 *
 * 动效只用 background + transform：Windows 高 DPI 下 mask / filter 会把 1px
 * 细线合成进独立图层再画，容易发虚（同 shimmer 的 mask 教训）；颜色不用
 * color-mix(var())，后者构建期可能被展平成不透明色。具体样式与减弱动效/
 * 高对比度回退在 globals.css 的 .aui-turn-rule-*。
 */
const TurnRule: FC<{ running: boolean }> = ({ running }) => {
  if (!running) {
    return (
      <div
        aria-hidden
        data-slot="aui_turn-rule"
        className="aui-turn-rule-static absolute inset-x-0 bottom-0 h-px"
      />
    );
  }
  return (
    <div
      aria-hidden
      data-slot="aui_turn-rule"
      className="absolute inset-x-0 bottom-0 h-px"
    >
      <div className="aui-turn-rule-track absolute inset-0" />
      {/* overflow-hidden 只把扫光裁在线段内，不是 mask */}
      <div className="absolute inset-0 overflow-hidden">
        <span className="aui-turn-rule-comet" />
      </div>
    </div>
  );
};

const TurnWorkSummary: FC<{
  slot: TurnSlotInfo;
  scopedKey: string;
  collapsed: boolean;
}> = ({ slot, scopedKey, collapsed }) => {
  const t = useT();
  const packed = useAuiState((s) =>
    packTurnSummary(s.thread.messages, slot.turnKey),
  );
  const summary = useMemo(() => parseTurnSummary(packed), [packed]);
  const threadRunning = useAuiState((s) => s.thread.isRunning);
  // 耗时只看**本轮自己**是否还在流：threadRunning 是线程级标志，下一轮一开始
  // 它就为 true，拿它判会把所有历史轮的耗时一起判成"进行中"→ undefined，
  // 行面文案从「已工作 X」集体退回「本轮过程」（实测：发新消息后上一轮的
  // 大折叠时间变成本轮过程）。slot.turnRunning 只描述本轮。
  const durationMs = useTurnDurationMs(scopedKey, summary.timingEnd, slot.turnRunning);

  // 「还在进行」看轮内流状态 + 线程状态（见 TurnSlot 的注释：线程级标志有空窗）
  const running = slot.turnRunning || (slot.isLastTurn && threadRunning);
  const startedAt = getTurnTiming(scopedKey)?.start;

  // 行面只放耗时（对齐 Codex 的「已工作 4 分 8 秒 ›」）；工具/文件计数挪到
  // 悬停提示，信息不丢又不堆在行上。耗时缺失时统一退回「本轮过程」：权威
  // 工时由 sidecar 的 turn_timing 行提供，缺失只说明旧转录/尚未收尾，不再用
  // 「N 条较早消息」这种容易被当成消息条数的计数文案。
  const label =
    durationMs !== undefined
      ? t("chat.turnSummary.workedFor", { time: formatDuration(durationMs) })
      : t("chat.turnSummary.processFallback");
  const details: string[] = [];
  if (summary.toolCount > 0) details.push(t("chat.turnSummary.toolsCount", { count: summary.toolCount }));
  if (summary.fileCount > 0) details.push(t("chat.turnSummary.filesCount", { count: summary.fileCount }));
  const title = [
    collapsed ? t("chat.turnSummary.expandTitle") : t("chat.turnSummary.collapseTitle"),
    ...details,
  ].join(t("chat.turnSummary.titleJoin"));

  // 运行中的折叠箭头只在轮中真有独立消息时才有语义（compaction/bashExecution
  // 等旁支行投影成独立 assistant 消息、包在 TurnProcess 里可收可开）。pi 投影
  // 把一轮的 assistant+toolResult 合并成一条消息：过程正整条实时渲染（TurnSlot
  // 只在轮次结束后才拆「过程+回答」），箭头无处可作用，点击还会悄悄写下折叠
  // 覆盖、收尾后这轮被意外展开——这种时候渲染成纯进度行，无箭头不可点。
  const hasMidTurnMessages = summary.messageCount > 2;
  // 首 token 前只有「连接中」：大折叠行不占位，避免两个 loading 叠在一起。
  // 内容一出现摘要行再出现，计时台账也在内容出现时才开始打点。
  if (running && !hasMidTurnMessages && !summary.hasContent) return null;
  if (running && !hasMidTurnMessages) {
    return (
      <div
        data-slot="aui_turn-summary"
        className="relative mx-auto -mt-3 w-full max-w-(--thread-max-width) px-2 pb-3"
      >
        <div className="text-muted-foreground flex w-fit cursor-default items-center gap-1.5 rounded-md py-0.5 text-sm">
          <LiveElapsed running startedAt={startedAt} />
        </div>
        <TurnRule running />
      </div>
    );
  }

  // 运行中一律显示（发出消息就有这一行）；已结束的轮只在「真有过程可展开」
  // 时占位——纯聊天轮（无思考、无工具）过程面是空的，耗时再准也留不下内容，
  // 那就整行撤掉，而不是留一个点开空白的开关等用户刷新页面
  if (!running && !summary.hasProcess) return null;

  return (
    <div
      data-slot="aui_turn-summary"
      className="relative mx-auto -mt-3 w-full max-w-(--thread-max-width) px-2 pb-3"
      // 动画时长变量落在行容器上：chevron 的 transition 与过程区高度动画同拍
      style={{ ["--animation-duration" as string]: `${PROCESS_ANIMATION_MS}ms` }}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        title={title}
        onClick={() => setTurnCollapsed(scopedKey, !collapsed)}
        className={cn(
          "text-muted-foreground hover:text-foreground group/turn-summary flex w-fit cursor-pointer items-center gap-1.5 rounded-md py-0.5 text-sm transition-colors",
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
        )}
      >
        {running ? (
          <LiveElapsed running startedAt={startedAt} />
        ) : (
          <span className="tabular-nums">{label}</span>
        )}
        {/* 收起时右指、展开时下指：与过程区的高度动画同一时长/缓动（reasoning 同款） */}
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-(--animation-duration) motion-reduce:transition-none",
            PROCESS_EASE,
            collapsed ? "-rotate-90" : "rotate-0",
          )}
          aria-hidden
        />
      </button>
      <TurnRule running={running} />
    </div>
  );
};

/**
 * 直播耗时打点：末轮出现时记开始、不再"进行中"时补记结束。
 * 为什么要自己记结束：框架的流式计时在取消/中断路径不 finalize（manual stop 后
 * metadata.timing 缺失），只靠它会让停止的轮显示成「本轮过程」。
 * 历史装载的时间戳在 loadPiHistory 里播种，优先于这里的观测值。
 */
export const TurnTimingRecorder: FC = () => {
  // 打包成原始值：末轮键 + 是否"还在进行"（轮内有消息在流，或最新轮且线程在跑）
  // + 本轮实质内容条数。条数是判定"真的重跑"的基线：排队项接棒（含「立即
  // 发送」）时线程会被下一轮 agent_start 拉回 running，而末轮还是上一条——
  // 但内容条数没涨，不能据此重开计时（见 resolveObservedTurnTimingWrite）。
  // 只数非纯 data 的 assistant 消息：压缩/模型切换分隔线会在轮末追加，不算重跑。
  const lastTurnInfo = useAuiState((s) => {
    const messages = s.thread.messages;
    const last = getTurnIndex(messages).turns.at(-1);
    if (!last) return "";
    const live = last.running || s.thread.isRunning;
    let contentCount = 0;
    for (let i = last.start; i < last.end; i++) {
      const message = messages[i];
      if (message.role !== "assistant") continue;
      if (message.content.some((part) => part.type !== "data")) contentCount += 1;
    }
    return `${last.key}|${live ? 1 : 0}|${contentCount}`;
  });
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const prevRef = useRef({ key: "", contentCount: 0 });
  useEffect(() => {
    const [key, liveFlag = "0", countText = "0"] = lastTurnInfo.split("|");
    if (!key) return;
    const contentCount = Number(countText) || 0;
    const scoped = scopedTurnKey(threadId, key);
    // 换轮了：上一轮若还在进行中就被换下（steer / 排队项插入），给它补记结束
    if (prevRef.current.key && prevRef.current.key !== key) {
      noteTurnEnd(
        scopedTurnKey(threadId, prevRef.current.key),
        Date.now(),
        prevRef.current.contentCount,
      );
    }
    prevRef.current = { key, contentCount };
    const action = resolveObservedTurnTimingWrite(
      getTurnTiming(scoped),
      liveFlag === "1",
      contentCount,
    );
    if (action === "end") {
      noteTurnEnd(scoped, Date.now(), contentCount);
    } else if (contentCount > 0) {
      // 计时从 AI 首条实质内容起算：连接中阶段不 start，内容出现才开表
      if (action === "start") noteTurnStart(scoped, Date.now());
      else if (action === "restart") restartTurnTiming(scoped, Date.now());
    }
  }, [lastTurnInfo, threadId]);
  return null;
};
