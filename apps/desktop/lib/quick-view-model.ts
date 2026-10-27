/**
 * 快速查看浮层的展示模型（纯函数，不碰 store/hook）：
 * 组件层把各数据源喂进来，这里只做「数据 → 渲染行」的映射，
 * 让映射规则可以脱离 React 单测（todoRows/taskDelegations/groupArtifacts）。
 * 状态语义与右侧面板同源：计划区块（plan-section）的任务映射、
 * 产物页签（artifacts-tab）的打开模式判定、Task 工具行（tool-row.aui）
 * 的委派字段提取，三处口径在此各有一份镜像，改动要三边对齐。
 */

import type { TodoTask } from "@/lib/pi/pi-todo";
import {
  openModeFor,
  type ArtifactOpenMode,
  type MessageArtifact,
} from "@/lib/panels/artifacts";

/* ------------------------------ 进度行 ------------------------------ */

export type QuickTodoRow = {
  id: string;
  /** 徽标序号 = 任务自身 id（todo 工具的 1-based 递增序，deleted 墓碑会留洞） */
  badge: number;
  text: string;
  state: "done" | "active" | "pending";
};

/** 任务快照 → 渲染行：deleted 墓碑剔除；进行中优先显示 activeForm；
 *  保留快照原序（计划区块同款：按状态重排会让清单在完成时跳位） */
export function todoRows(tasks: readonly TodoTask[]): QuickTodoRow[] {
  const rows: QuickTodoRow[] = [];
  for (const task of tasks) {
    if (task.status === "deleted") continue;
    rows.push({
      id: String(task.id),
      badge: task.id,
      text:
        task.status === "in_progress" && task.activeForm
          ? task.activeForm
          : task.subject,
      state:
        task.status === "completed"
          ? "done"
          : task.status === "in_progress"
            ? "active"
            : "pending",
    });
  }
  return rows;
}

/* ------------------------------ 子智能体行 ------------------------------ */

/** 消息 part 的最小结构面（assistant-ui 的 ThreadMessage 可结构化赋值） */
export type QuickMessagePart = {
  type?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
};
export type QuickMessage = {
  role?: string;
  content?: readonly QuickMessagePart[];
};

export type QuickDelegationRow = {
  toolCallId: string;
  agentName: string;
  description: string;
  /** Task 工具的原始结果：历史重建（无绑定 chunk）时组件侧据此解析 delegationId */
  result: unknown;
};

function strArg(args: unknown, key: string): string {
  if (!args || typeof args !== "object") return "";
  const v = (args as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

/** 消息流 → Task 委派行（按出现序）：同一委派不会重复出现，
 *  流式早期 args 未成形时用空串占位（组件侧由 store 补齐名称） */
export function taskDelegations(
  messages: readonly QuickMessage[],
): QuickDelegationRow[] {
  const rows: QuickDelegationRow[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content ?? []) {
      if (part?.type !== "tool-call" || part.toolName !== "Task") continue;
      if (!part.toolCallId) continue;
      rows.push({
        toolCallId: part.toolCallId,
        agentName: strArg(part.args, "agent"),
        description: strArg(part.args, "description"),
        result: part.result,
      });
    }
  }
  return rows;
}

/* ------------------------------ 交付物分组 ------------------------------ */

export type QuickArtifactGroups = {
  /** 浏览器可预览（HTML 等）：file:// 喂原生 webview 那类 */
  preview: MessageArtifact[];
  /** 其余交付文件（代码/文档/压缩包…） */
  workspace: MessageArtifact[];
};

/** 产物按打开模式分两组（预览组仅桌面壳成立，file:// 预览在网页端不可用）。
 *  openMode 缺省时按扩展名推导（与产物页签的 ArtifactRow 同一款兜底） */
export function groupArtifacts(
  artifacts: readonly MessageArtifact[],
  options: { canPreview: boolean },
): QuickArtifactGroups {
  const groups: QuickArtifactGroups = { preview: [], workspace: [] };
  for (const artifact of artifacts) {
    const mode: ArtifactOpenMode = artifact.openMode ?? openModeFor(artifact.path);
    if (options.canPreview && mode === "browser") groups.preview.push(artifact);
    else groups.workspace.push(artifact);
  }
  return groups;
}
