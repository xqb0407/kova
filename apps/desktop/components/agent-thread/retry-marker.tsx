"use client";

import { useAuiState } from "@assistant-ui/react";
import { RefreshCwIcon } from "lucide-react";
import { type FC, useEffect, useState } from "react";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import {
  useRetryStoreState,
  type RetryData as StoreRetryData,
} from "@/lib/pi/pi-retry-state";

/**
 * provider 自动重试的直播状态行：只表现「重试中」，结算即消失（用户口径：
 * 能看到在重试就行，成功/失败后不留痕——失败有错误卡、成功有正文）。
 *
 * **线程级**挂载（thread.tsx 流尾，LiveCompactionMarker 同位）：provider 重试
 * 发生在首个 message_start 之前——那之前投影里没有任何 assistant 消息，挂在
 * 消息体里的状态行在「首轮请求被限流」这个最常见场景下无处渲染（2026-11-07
 * 审查发现）。流尾位置天然只出现一份，也不需要按消息 isLast 过滤。
 *
 * 数据来自 pi-retry-state store（pi-client-base 把 data-retry chunk 拦成
 * per-thread 直更——桌面 wire 层不投递 data-* 消息 parts，按消息 part 找
 * 重试状态的实现在这条链路上恒为 null）。轮初 sidecar 发 idle 清台、收尾
 * 帧兜底清，Stop 拆流后卡死的 retrying 以「线程在跑」总闸兜住。
 */

type RetryData = StoreRetryData;

/** 倒计时文本；key 按尝试重挂载，下一次尝试把倒计时重置为新的退避时长 */
const RetryLabel: FC<{
  attempt: number;
  maxRetries: number;
  delayMs: number;
}> = ({ attempt, maxRetries, delayMs }) => {
  const [countdown, setCountdown] = useState(Math.ceil(delayMs / 1000));

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setInterval(() => {
      setCountdown((c) => c - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  return (
    <>
      重试中 ({attempt}/{maxRetries})
      {countdown > 0 && `，${countdown}s 后重试`}
    </>
  );
};

/**
 * 重试直播态：仅 retrying 阶段非空（resolved/idle 一律视为已结束）。
 * 供 ThreadWorkingIndicator 等让位判定共用——结算后这些行必须回来，
 * 所以这里不能把 resolved 透传出去。
 */
export function useRetryState(): RetryData | null {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const { retry } = useRetryStoreState(threadId ?? undefined);
  return retry && retry.phase === "retrying" ? retry : null;
}

export const RetryMarker: FC = () => {
  const state = useRetryState();
  const running = useAuiState((s) => s.thread.isRunning);
  if (!running || !state) return null;
  return (
    // 列宽包裹：Marker 本身是 w-full，直接挂在消息组里会贴着视口左缘（行面
    // 跑到窗口最左侧、和消息列完全脱开）。与 LiveCompactionMarker /
    // ThreadWorkingIndicator 同款：居中 + 对话宽度 + px-2，文字起点与
    // 「工作摘要」行对齐。
    <div className="mx-auto w-full max-w-(--thread-max-width) px-2">
      <Marker role="status" title={state.error}>
        <MarkerIcon>
          <RefreshCwIcon className="animate-spin" />
        </MarkerIcon>
        <MarkerContent>
          <RetryLabel
            key={`${state.attempt ?? 1}-${state.delayMs ?? 0}`}
            attempt={state.attempt ?? 1}
            maxRetries={state.maxRetries ?? 10}
            delayMs={state.delayMs ?? 0}
          />
        </MarkerContent>
      </Marker>
    </div>
  );
};
