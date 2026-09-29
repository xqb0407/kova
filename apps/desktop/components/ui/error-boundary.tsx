"use client";

import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangleIcon,
  BugIcon,
  CheckIcon,
  CopyIcon,
  FolderOpenIcon,
  RotateCcwIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { reportFrontendError } from "@/lib/frontend-logging";
import { appMetaLine } from "@/lib/app-meta";
import { buildFeedbackIssueUrl } from "@/lib/feedback";
import { recentJankReport } from "@/lib/perf-watch";
import { openExternal } from "@/lib/external-link";
import { isTauri } from "@/lib/tauri";

/** 崩溃详情取前几帧就够定位，再长只是刷屏 */
function head(frames: string | null | undefined, n: number): string {
  if (!frames) return "";
  return frames
    .split("\n")
    .slice(0, n)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * 崩溃详情文本，复制到剪贴板 / 落盘 / 反馈预填共用同一份。
 *
 * 带上应用指纹是必须的：同一份堆栈在 0.4.0 和 0.5.0 上含义完全不同，
 * 只收到堆栈却不知道对应哪个 build 是没法排查的。崩溃前的卡顿记录也一并
 * 附上——不少「白屏」实际是主线程先卡死几秒才崩的。
 */
export function formatCrashDetail(
  error: Error,
  label: string,
  componentStack?: string | null,
): string {
  return [
    `[崩溃] ${label}`,
    appMetaLine(),
    `${error.name}: ${error.message}`,
    head(error.stack, 6),
    head(componentStack, 6),
    recentJankReport(),
  ]
    .filter(Boolean)
    .join("\n");
}

type CopyState = "idle" | "copied" | "failed";

/**
 * 崩溃态 UI：区域级与整页级共用，只靠外层容器决定尺寸。
 * 四个动作——重试交给调用方，其余三个在这里自足。
 */
export function CrashFallback({
  title,
  detail,
  onRetry,
  className,
}: {
  title: string;
  detail: string;
  onRetry: () => void;
  className?: string;
}) {
  const [copy, setCopy] = useState<CopyState>("idle");

  const handleCopy = () => {
    navigator.clipboard
      .writeText(detail)
      .then(() => setCopy("copied"))
      .catch(() => setCopy("failed"))
      .finally(() => setTimeout(() => setCopy("idle"), 2000));
  };

  const handleOpenLogs = () => {
    void invoke("open_logs_dir").catch(() => {});
  };

  // 这一步是整个崩溃处理里最值钱的：不用用户读日志、不用用户复制粘贴、
  // 不用用户手打版本号——点一下 issue 就建好，标题带崩溃点、正文带堆栈和
  // 版本与卡顿记录。用户唯一的动作是「按发送」。
  const handleReport = () => {
    openExternal(buildFeedbackIssueUrl(`崩溃：${title}`, `## 崩溃信息\n\n\`\`\`\n${detail}\n\`\`\`\n\n## 复现步骤\n\n1. \n2. \n\n## 备注\n\n`));
  };

  return (
    <div
      className={
        "text-muted-foreground/70 flex h-full flex-col items-center justify-center gap-3 px-6 text-center " +
        (className ?? "")
      }
    >
      <AlertTriangleIcon className="text-destructive/70 size-6 shrink-0" />
      <p className="text-foreground/80 text-sm font-medium">{title}</p>
      <p className="max-w-sm text-xs leading-relaxed">
        这块界面出了点问题，不影响其他部分。可以先重试，不行再看日志。
      </p>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <Button size="sm" onClick={onRetry}>
          <RotateCcwIcon />
          重试
        </Button>
        <Button size="sm" variant="outline" onClick={handleReport}>
          <BugIcon />
          打开反馈页
        </Button>
        <Button size="sm" variant="outline" onClick={handleCopy}>
          {copy === "copied" ? <CheckIcon /> : <CopyIcon />}
          {copy === "copied" ? "已复制" : copy === "failed" ? "复制失败" : "复制错误详情"}
        </Button>
        {isTauri() ? (
          <Button size="sm" variant="outline" onClick={handleOpenLogs}>
            <FolderOpenIcon />
            打开日志目录
          </Button>
        ) : null}
      </div>
      {copy === "failed" ? (
        <p className="text-destructive/80 max-w-sm text-[11px]">
          浏览器拒绝了剪贴板访问，详情请改看日志。
        </p>
      ) : null}
    </div>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
  /** 崩溃位置的名称，进日志和崩溃文案用 */
  label: string;
  /** 自定义崩溃态；不传用默认的 CrashFallback */
  fallback?: (error: Error, retry: () => void) => ReactNode;
}

/**
 * 渲染期错误边界。
 *
 * 恢复不靠内部状态位，而是靠调用点给的 key：调用方把 key 设成能代表
 * 「这块内容换了个实例」的量（当前标签 id、当前菜单），切换即重挂载，
 * 错误态自然清掉。类内那个重试按钮走 setState，只重渲本边界内的子树。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportFrontendError(formatCrashDetail(error, this.props.label, info.componentStack));
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.retry);
    return (
      <CrashFallback
        title={`${this.props.label}崩了`}
        detail={formatCrashDetail(error, this.props.label)}
        onRetry={this.retry}
      />
    );
  }

  private retry = () => this.setState({ error: null });
}
