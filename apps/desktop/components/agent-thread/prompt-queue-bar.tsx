"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { usePiQueue } from "@/lib/pi/pi-runtime";
import {
  addSteeredBadge,
  clearSteeredBadges,
  removeSteeredBadge,
  useSteeredBadges,
} from "@/lib/pi/pi-steer-intent";
import { CheckIcon, MergeIcon, XIcon, ZapIcon } from "lucide-react";
import { useEffect, useRef, useState, type FC } from "react";
import { cn } from "cn";

/**
 * prompt 排队条（composer 上方）——迁移 4a：数据源 = react-pi state.queue
 * （sidecar queue_update 事件驱动，条目 id = 真实 reqId）。全部操作只有三个：
 *  - 并入当前回复（steer）：注入活跃轮，不中止本轮；成功后条目转入「已并入
 *    当前回复」徽标区（本地记账，多条折叠为一行，防越并越长），宿主轮流收尾
 *    时徽标消失——并入内容已随本轮回复呈现，不再回填独立气泡
 *  - 立即发送（promote）：中止当前轮、该项插队马上执行
 *  - 删除（cancel）：取消排队项
 * 排队中的消息不进消息列表（sidecar 调度后才落盘转录）——react-pi 原生满足
 * 「调度前不显示气泡」，无需旧链路的 remove/reveal 信号同步。
 *
 * 刷新接力泵（收敛版）：运行轮重挂由 connect + 快照自愈承担（迁移阶段 3）；
 * 队列非空时订阅保活（见 usePiRuntime），sidecar 串行链派发的下一轮
 * agent_start 原生可见——泵只剩一种场景：sidecar 重启后无链节的孤儿队列。
 * 挂载/快照恢复（队列从空变非空）与 isRunning 下降沿时探测：线程空闲且队列
 * 非空 → queue_pop（sidecar 守卫 isTurnBusy + hasPromptChain 双保险，链节
 * 在时绝不误弹）→ 弹出队首按文本走正常发送路径重发。
 */
export const PromptQueueBar: FC = () => {
  const aui = useAui();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const { queue, cancel, promote, steer, pop } = usePiQueue();
  const steered = useSteeredBadges(threadId ?? "");
  const [busy, setBusy] = useState(false);

  // 接力泵（见头注）：pumpingRef 防重入（内含 await 链）。queue_pop 的
  // sidecar 双保险让误弹不可能——链节仍在/轮在跑时 popped 恒为 null。
  const pumpRef = useRef<() => Promise<void>>(async () => {});
  const pumpingRef = useRef(false);
  pumpRef.current = async () => {
    if (!aui || !threadId || pumpingRef.current) return;
    if (queue.steering.length === 0 && queue.followUp.length === 0) return;
    pumpingRef.current = true;
    try {
      // 在跑轮（含链节盲派发的下一轮）：订阅保活下事件原生可见，无需泵
      if (aui.thread.getState().isRunning) return;
      const popped = await pop();
      if (!popped) return;
      // 无孤儿不入此分支（popped=null）。按文本走正常发送路径重发——
      // 线程空闲即刻派发，队列条目随 queue_update 事件自然消失
      aui.composer.setText(popped.content);
      // steer:false：弹出重发若撞上竞态轮（线程又忙了）应续排队，
      // 而不是被 core 的运行中默认车道并入当前轮
      aui.composer.send({ steer: false });
    } catch (err) {
      // 通道异常：下一次下降沿/队列变化再试；留痕防"泵凭空失效"无从排查
      console.warn("[queue-pump] dispatch failed", String(err));
    } finally {
      pumpingRef.current = false;
    }
  };

  // 队列非空即探测（覆盖挂载/线程切换/快照恢复采纳孤儿队列/队列增长）；
  // 全空时 key 归零不触发。泵内部有运行态与 sidecar 双重守卫，多触发无害
  const queueKey = `${queue.steering.length}:${queue.followUp.length}:${
    queue.followUp[0]?.id ?? ""
  }`;
  useEffect(() => {
    if (queueKey === "0:0:") return;
    // 回收回队（sidecar 轮末检测「并入未获回应」自动重入队）：快照里重现的
    // 文本让位对应「已并入」徽标——并入没成功就回到排队态，不自相矛盾
    if (threadId) {
      for (const item of queue.followUp) removeSteeredBadge(threadId, item.content);
    }
    void pumpRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueKey]);

  // isRunning 下降沿：链节派发由订阅保活原生覆盖；泵兜孤儿队列，徽标随
  // 宿主轮流收尾清空（并入内容已随本轮回复呈现）
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !isRunning) {
      if (threadId) clearSteeredBadges(threadId);
      void pumpRef.current();
    }
    wasRunningRef.current = isRunning;
  }, [isRunning, threadId]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      // 无活跃轮可并入等拒绝：忽略（条目原位保留，快照下一次广播对齐）
    } finally {
      setBusy(false);
    }
  };

  // 容器常驻 + grid rows 0fr↔1fr 高度过渡：队列条目挂载/卸载（尤其调度时
  // 气泡插入与条目卸载跨帧）不再让 sticky footer 高度瞬变、把消息流瞬推
  // 一下（滚动闪跳）。条目本身的淡入由卡片 animate-in 负责，消失走直接移除。
  const items = queue.followUp;
  const hasContent = items.length > 0 || steered.length > 0;
  if (!threadId) return null;

  return (
    <div
      className="grid transition-[grid-template-rows] duration-200 ease-out"
      style={{ gridTemplateRows: hasContent ? "1fr" : "0fr" }}
      data-slot="aui-prompt-queue-bar"
      aria-hidden={!hasContent}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          className={cn(
            "flex flex-col gap-1.5",
            hasContent && "mb-2",
          )}
        >
      {/* 已并入当前回复：折叠为一条（多条并入不越堆越长），宿主轮流收尾后消失 */}
      {steered.length > 0 && steered[0] && (
        <div
          className="border-border/50 dark:border-muted-foreground/10 flex items-center gap-2 rounded-(--composer-radius) border bg-(--composer-bg) py-2 pr-3.5 pl-3.5 backdrop-blur-md"
          data-slot="aui-queue-steered"
        >
          <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
          <span
            className="text-foreground/70 min-w-0 flex-1 truncate text-sm"
            title={steered.join("\n")}
          >
            {steered.length === 1
              ? steered[0]
              : `${steered[0]} 等 ${steered.length} 条`}
          </span>
          <span className="text-muted-foreground/70 shrink-0 text-[11px] leading-none">
            已并入当前回复
          </span>
        </div>
      )}
      {items.length > 0 && (
        <div className="text-muted-foreground/70 pl-3.5 text-[11px] leading-none tabular-nums">
          {items.length} 条排队
        </div>
      )}
      {items.map((item, index) => (
        <div
          key={item.id}
          className="group border-border/50 dark:border-muted-foreground/10 flex items-center gap-2 rounded-(--composer-radius) border bg-(--composer-bg) py-2 pr-1.5 pl-3.5 backdrop-blur-md animate-in fade-in slide-in-from-bottom-1 duration-200"
        >
          <span
            className="w-3 shrink-0 text-center text-[11px] leading-none text-muted-foreground/50 tabular-nums"
            aria-label={`排队第 ${index + 1} 位`}
          >
            {index + 1}
          </span>
          <span
            className="text-foreground/70 min-w-0 flex-1 truncate text-sm"
            title={item.content}
          >
            {item.content}
          </span>
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
            <QueueIconButton
              label="并入当前回复（不中止本轮）"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await steer(item.id);
                  // 并入成功（sidecar 从队列移除该条并注入活跃轮）才记徽标；
                  // 失败时条目原位保留，不记
                  addSteeredBadge(threadId, item.content);
                })
              }
            >
              <MergeIcon className="size-3.5" />
            </QueueIconButton>
            <QueueIconButton
              label="立即发送（中止当前回复）"
              disabled={busy}
              onClick={() => void act(() => promote(item.id))}
            >
              <ZapIcon className="size-3.5" />
            </QueueIconButton>
            <QueueIconButton
              label="删除"
              disabled={busy}
              className="hover:text-destructive"
              onClick={() => void act(() => cancel(item.id))}
            >
              <XIcon className="size-3.5" />
            </QueueIconButton>
          </div>
        </div>
      ))}
        </div>
      </div>
    </div>
  );
};

const QueueIconButton: FC<{
  label: string;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ label, disabled, className, onClick, children }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    disabled={disabled}
    onClick={onClick}
    className={cn(
      "text-muted-foreground/80 hover:text-foreground inline-flex size-6 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-muted-foreground/10 disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
  >
    {children}
  </button>
);
