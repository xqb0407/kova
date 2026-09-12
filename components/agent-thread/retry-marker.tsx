"use client";

import { useAuiState } from "@assistant-ui/react";
import { RefreshCwIcon } from "lucide-react";
import { type FC, useEffect, useState } from "react";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";

/**
 * provider 自动重试的状态行（用法与样式对齐 harness nextjs-app 的 base.tsx）：
 * data-retry part 不在 parts 流里就地渲染，`RetryMarker` 挂在 assistant 消息
 * 内容顶部只渲染一次，attempt 原地更新；`useRetryState` 只看流末消息的末位
 * part——新内容到达或 sidecar 补发 phase resolved 时自动消失。
 *
 * `useRetryState` 同时也被用来限定"只有末条消息才亮"：线程里每条 assistant
 * 消息都挂了一个 `RetryMarker`，不按消息过滤的话，历史消息会跟着当前轮的
 * 重试一起渲染出多份状态行。
 */

type RetryData = {
  phase?: "retrying" | "resolved";
  attempt?: number;
  maxRetries?: number;
  /** 本次退避等待（毫秒），驱动倒计时 */
  delayMs?: number;
  /** 错误分类码（NETWORK_ERROR / PROVIDER_RATE_LIMITED / ...） */
  code?: string;
  /** provider 错误文本（sidecar 已脱敏截断） */
  error?: string;
};

/** 重试状态追踪（基于消息）：仅当本条消息是会话末条、且末位 part 是未结算的重试事件 */
export function useRetryState(): RetryData | null {
  return useAuiState((s) => {
    // `RetryMarker` 挂在每条 assistant 消息底部，这里按消息作用域过滤，
    // 只让末条消息亮——历史消息在下一轮重试时不再重复渲染状态行。
    if (!s.message.isLast || s.message.role !== "assistant") return null;
    const part = s.message.content[
      s.message.content.length - 1
    ] as unknown as {
      type?: string;
      name?: string;
      data?: RetryData;
    };
    if (part?.type !== "data" || part.name !== "retry") return null;
    const data = part.data;
    if (!data || (data.phase ?? "retrying") === "resolved") return null;
    return data;
  });
}

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

export const RetryMarker: FC = () => {
  const state = useRetryState();
  if (!state) return null;
  const attempt = state.attempt ?? 1;
  const maxRetries = state.maxRetries ?? 10;
  return (
    <Marker role="status" title={state.error}>
      <MarkerIcon>
        <RefreshCwIcon className="animate-spin" />
      </MarkerIcon>
      <MarkerContent className="shimmer">
        <RetryLabel
          key={`${attempt}-${state.delayMs ?? 0}`}
          attempt={attempt}
          maxRetries={maxRetries}
          delayMs={state.delayMs ?? 0}
        />
      </MarkerContent>
    </Marker>
  );
};
