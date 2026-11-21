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
 * **线程级**挂载（thread.tsx ViewportFooter，composer 上方、排队条同区）：
 * provider 重试发生在首个 message_start 之前——那之前投影里没有任何 assistant
 * 消息，挂在消息体里的状态行在「首轮请求被限流」这个最常见场景下无处渲染
 * （2026-11-07 审查发现）。原挂消息流尾会随最后一条消息的位置浮动（首轮在
 * 用户气泡下方、轮中在 AI 气泡下方），同一重试周期两处接力跳动（2026-11-13
 * 用户反馈）；锚进 footer 后位置恒定不随消息流移动。
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
    // 列宽包裹：footer 自带对话宽度约束（max-w-(--thread-max-width)），这里
    // 再包一层是给 Marker 与 composer 卡边缘对齐留 px-2 内缩（与消息列的
    // 「工作摘要」行文字起点一致；ShareSelectionToolbar 的 mx-1 同目的）。
    // -mb-2：footer 的 gap-4 是 16px，composer 上方悬浮条族走 mb-2（8px）
    // 间距约定（见 composer.tsx 的间距注释）——负边距抵掉一半 gap，与
    // 排队条/审批卡的视觉节奏一致。
    <div className="mx-auto -mb-2 w-full max-w-(--thread-max-width) px-2">
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
