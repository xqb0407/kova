"use client";

import { useEffect } from "react";
import { RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CrashFallback, formatCrashDetail } from "@/components/ui/error-boundary";
import { reportFrontendError } from "@/lib/frontend-logging";

/**
 * 整棵应用树（page.tsx 及其子树，根 layout 除外）的最后一道兜底。
 *
 * 组件内部已经按主区 / 面板标签各自包了 ErrorBoundary，能局部恢复的 crash
 * 不会走到这里；能走到这里说明崩在没被包住的地方，或者是 Boundaries 自己
 * 挂了。渲染在根 layout 内部，globals.css 照常生效。
 */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    // 接住之后不会再冒泡到 window，显式补一次落盘
    reportFrontendError(formatCrashDetail(error, "应用主界面"));
  }, [error]);

  return (
    <div className="bg-background flex h-dvh flex-col items-center justify-center">
      <CrashFallback
        className="flex-1"
        title="应用出了点问题"
        detail={formatCrashDetail(error, "应用主界面")}
        onRetry={retry}
      />
      <div className="pb-10">
        <Button variant="ghost" size="sm" onClick={() => location.reload()}>
          <RotateCcwIcon />
          重新加载窗口
        </Button>
      </div>
    </div>
  );
}
