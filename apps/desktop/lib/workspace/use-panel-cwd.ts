"use client";

import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { taskWorkspaceDir, taskWorkspaceSessionDir } from "./task-workspace";
import { useWorkspace } from "./workspace-store";
import { piSessionIdForThread } from "@/lib/pi/pi-thread-adapter";

/**
 * 面板/产物相关视图的"有效工作目录"三级解析：
 *   标签绑定目录 → 当前工作区 → 任务工作区兜底。
 *
 * 第三级兜底是「工作」模式（未选自定义 workspace）的关键：无目录会话的 agent
 * 产物落在任务工作区里**按会话隔离的子目录**（sidecar taskSessionCwd =
 * <task-workspace>/<sessionId>），面板的列文档/建档/换绑、产物卡与「产物」页
 * 签的浏览器预览必须跟它同源，否则这些入口在没有工作区时全部失明（Rust 侧
 * resolve_root 已把任务工作区放行第二可信根，任意深度子路径读写都合法）。
 * 会话尚未物化的草稿线程拿不到 sessionId，先落任务工作区根（此时也不会有
 * 产物）；新链路 PiClientBase.createThread 登记完成会广播 pi:session-bound，
 * 届时重解析。
 * 任务工作区路径要异步解析（appDataDir），解析完成后本钩子自动重渲染。
 */
export function usePanelCwd(tabCwd?: string | null): string | null {
  const workspace = useWorkspace();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const [fallbackCwd, setFallbackCwd] = useState<string | null>(null);
  useEffect(() => {
    if (tabCwd || workspace) return;
    let cancelled = false;
    const resolveFallback = () => {
      const sessionId = threadId ? piSessionIdForThread(threadId) : undefined;
      void (sessionId
        ? taskWorkspaceSessionDir(sessionId)
        : taskWorkspaceDir()
      ).then((d) => {
        if (!cancelled && d) setFallbackCwd(d);
      });
    };
    resolveFallback();
    // 会话登记是晚于挂载/切线程的异步事件：监听广播重解析（幂等，仅刷兜底值）
    window.addEventListener("pi:session-bound", resolveFallback);
    return () => {
      cancelled = true;
      window.removeEventListener("pi:session-bound", resolveFallback);
    };
  }, [tabCwd, workspace, threadId]);
  return tabCwd ?? workspace ?? fallbackCwd;
}
