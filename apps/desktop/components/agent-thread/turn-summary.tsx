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
import { AssistantMessage } from "./assistant-message";
import { useScrollLock } from "@/hooks/use-scroll-lock";
import {
  getTurnIndex,
  packTurnSlotWithKeep,
  packTurnSummary,
  parseTurnSlotWithKeep,
  parseTurnSummary,
  type TurnSlotInfo,
} from "@/lib/panels/message-turns";
import {
  expandTurn,
  getTurnTiming,
  noteTurnEnd,
  noteTurnStart,
  resolveTurnTimingWrite,
  restartTurnTiming,
  scopedTurnKey,
  setTurnCollapsed,
  useTurnCollapsed,
  useTurnDurationMs,
} from "@/lib/panels/turn-collapse";
import { cn } from "@/lib/utils";

/** 展开/收起：时长与缓动和 reasoning / 工具组同一套（globals.css 的
 *  collapsible-down/up 高度关键帧按这个时长跑，chevron 与内层淡入淡出同拍） */
const PROCESS_ANIMATION_MS = 200;
const PROCESS_EASE = "ease-[cubic-bezier(0.32,0.72,0,1)]";

/** 中文时长（对齐 Codex 的「已工作 4 分 8 秒」）：秒级不带前缀，分秒才给分 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
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
 * 压缩分隔线一律归过程区（轮中/轮末同理，见 keepsVisible 与 dividerOnly
 * 两处分支）：收起态不在外部露线，展开后各条仍在它发生时的那条消息位置上
 * 编辑中的消息强制展开（thread.tsx 已把该条换成 EditComposer，这里把整轮
 * 放开，避免出现「编辑器孤零零挂在收起的过程里」）。
 */
export const TurnSlot: FC<{
  messageId: string;
  isEditing: boolean;
  children: ReactNode;
}> = ({ messageId, isEditing, children }) => {
  const packed = useAuiState((s) =>
    packTurnSlotWithKeep(
      s.thread.messages,
      messageId,
      // 工具成图（data-image）是本轮交付物——轮中消息带它时折叠后照常渲染，
      // 不然收起后外层看不到图。压缩分隔线不豁免：它按真实落点归过程面，
      // 收起时随之隐藏（同轮多次压缩不再在收起后堆成一列），展开即见原位。
      s.message.content.some(
        (part) => part.type === "data" && part.name === "image",
      ),
    ),
  );
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  // 线程级运行中：轮内消息状态位有空窗（压缩期间没有消息在流），末轮的
  // 纯分隔线消息靠它判定「还在跑」——与 TurnWorkSummary 的 running 同款
  const threadRunning = useAuiState((s) => s.thread.isRunning);
  const parsed = useMemo(() => parseTurnSlotWithKeep(packed), [packed]);
  const slot = parsed?.slot ?? null;
  const scopedKey = slot ? scopedTurnKey(threadId, slot.turnKey) : "";
  // 默认收起（对齐 dsh-message-fold / Codex）：收的是"已经结束的中间步骤"，
  // 不是正在跑的那一步——跑的过程中旧步骤收起成一行，当前这条照常实时渲染
  // （见下面的拆分条件：流式中的轮末整条渲染，正在跑的工具行看得见）。
  // 用户的显式开合优先，自动策略不翻回去。
  const collapsed = useTurnCollapsed(scopedKey, false);

  useEffect(() => {
    if (isEditing && scopedKey) expandTurn(scopedKey);
  }, [isEditing, scopedKey]);

  if (!slot) return <>{children}</>;
  if (slot.isTurnStart) {
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
  if ((slot.isTurnEnd || slot.isAnswerTail) && !slot.dividerOnly && !isEditing && !slot.turnRunning) {
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
  // 轮中成图保命（keepsVisible）：交付物不随过程收起
  const streamingTurnEnd =
    slot.isTurnEnd &&
    (!slot.dividerOnly ||
      slot.turnRunning ||
      (slot.isLastTurn && threadRunning));
  if (streamingTurnEnd || isEditing || parsed?.keepsVisible) return <>{children}</>;
  // 轮中过程 / 纯分隔线消息：包进可动画的过程区（收起时整块卸载）
  return <TurnProcess collapsed={collapsed}>{children}</TurnProcess>;
};

/** 一行工作摘要：耗时 · 工具 · 文件，兼作收起/展开开关 */
const TurnWorkSummary: FC<{
  slot: TurnSlotInfo;
  scopedKey: string;
  collapsed: boolean;
}> = ({ slot, scopedKey, collapsed }) => {
  const packed = useAuiState((s) =>
    packTurnSummary(s.thread.messages, slot.turnKey),
  );
  const summary = useMemo(() => parseTurnSummary(packed), [packed]);
  const threadRunning = useAuiState((s) => s.thread.isRunning);
  const durationMs = useTurnDurationMs(scopedKey, summary.timingEnd, threadRunning);

  // 「还在进行」看轮内流状态 + 线程状态（见 TurnSlot 的注释：线程级标志有空窗）
  const running = slot.turnRunning || (slot.isLastTurn && threadRunning);
  // 运行中的秒表：每秒 tick 一次，从台账里的开始时刻算起
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const startedAt = getTurnTiming(scopedKey)?.start;
  const elapsedMs = running && startedAt !== undefined ? Date.now() - startedAt : undefined;

  // 行面只放耗时（对齐 Codex 的「已工作 4 分 8 秒 ›」）；工具/文件计数挪到
  // 悬停提示，信息不丢又不堆在行上
  const label = running
    ? elapsedMs !== undefined && elapsedMs >= 1000
      ? `工作中 ${formatDuration(elapsedMs)}`
      : "工作中"
    : durationMs !== undefined
      ? `已工作 ${formatDuration(durationMs)}`
      : summary.collapsedCount > 0
        ? `${summary.collapsedCount} 条较早消息`
        : "本轮过程";
  const details: string[] = [];
  if (summary.toolCount > 0) details.push(`${summary.toolCount} 工具`);
  if (summary.fileCount > 0) details.push(`${summary.fileCount} 文件`);
  const title = [collapsed ? "展开本轮过程" : "收起本轮过程", ...details].join(" · ");

  // 运行中的折叠箭头只在轮中真有独立消息时才有语义（compaction/bashExecution
  // 等旁支行投影成独立 assistant 消息、包在 TurnProcess 里可收可开）。pi 投影
  // 把一轮的 assistant+toolResult 合并成一条消息：过程正整条实时渲染（TurnSlot
  // 只在轮次结束后才拆「过程+回答」），箭头无处可作用，点击还会悄悄写下折叠
  // 覆盖、收尾后这轮被意外展开——这种时候渲染成纯进度行，无箭头不可点。
  const hasMidTurnMessages = summary.messageCount > 2;
  if (running && !hasMidTurnMessages) {
    return (
      <div
        data-slot="aui_turn-summary"
        className="border-border/60 mx-auto -mt-3 w-full max-w-(--thread-max-width) border-b px-2 pb-3"
      >
        <div className="text-muted-foreground flex w-fit cursor-default items-center gap-1.5 rounded-md py-0.5 text-sm">
          <span className="tabular-nums shimmer motion-reduce:animate-none">{label}</span>
        </div>
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
      className="border-border/60 mx-auto -mt-3 w-full max-w-(--thread-max-width) border-b px-2 pb-3"
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
        <span className={cn("tabular-nums", running && "shimmer motion-reduce:animate-none")}>
          {label}
        </span>
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
  const lastTurnInfo = useAuiState((s) => {
    const index = getTurnIndex(s.thread.messages);
    const last = index.turns.at(-1);
    if (!last) return "";
    const live = last.running || s.thread.isRunning;
    return `${last.key}|${live ? 1 : 0}`;
  });
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const prevKeyRef = useRef("");
  useEffect(() => {
    const [key, live] = lastTurnInfo.split("|");
    if (!key) return;
    const scoped = scopedTurnKey(threadId, key);
    // 换轮了：上一轮若还在进行中就被换下（steer / 排队项插入），给它补记结束
    if (prevKeyRef.current && prevKeyRef.current !== key) {
      noteTurnEnd(scopedTurnKey(threadId, prevKeyRef.current), Date.now());
    }
    prevKeyRef.current = key;
    const action = resolveTurnTimingWrite(getTurnTiming(scoped), live === "1");
    if (action === "start") noteTurnStart(scoped, Date.now());
    else if (action === "restart") restartTurnTiming(scoped, Date.now());
    else noteTurnEnd(scoped, Date.now());
  }, [lastTurnInfo, threadId]);
  return null;
};
