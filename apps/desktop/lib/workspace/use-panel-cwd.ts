"use client";

import { useEffect, useState } from "react";
import { taskWorkspaceDir } from "./task-workspace";
import { useWorkspace } from "./workspace-store";

/**
 * 面板/产物相关视图的"有效工作目录"三级解析：
 *   标签绑定目录 → 当前工作区 → app 任务工作区（PI_TASK_CWD 同源）。
 *
 * 第三级兜底是「工作」模式（未选自定义 workspace）的关键：agent 的产物落在
 * 任务工作区，面板的列文档/建档/换绑、产物卡的「在画布中打开」必须跟它同源，
 * 否则这些入口在没有工作区时全部失明（Rust 侧 resolve_root 已把该目录放行
 * 为第二可信根，读写都合法）。任务工作区路径要异步解析（appDataDir），
 * 解析完成后本钩子自动重渲染。
 */
export function usePanelCwd(tabCwd?: string | null): string | null {
  const workspace = useWorkspace();
  const [fallbackCwd, setFallbackCwd] = useState<string | null>(null);
  useEffect(() => {
    if (tabCwd || workspace) return;
    let cancelled = false;
    void taskWorkspaceDir().then((d) => {
      if (!cancelled && d) setFallbackCwd(d);
    });
    return () => {
      cancelled = true;
    };
  }, [tabCwd, workspace]);
  return tabCwd ?? workspace ?? fallbackCwd;
}
