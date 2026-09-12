"use client";

import { focusPanelTab, type PanelTabExtra, type PanelTabType } from "./panel-tabs";

/**
 * 消息工具行 → 右侧 AgentPanel 的定向打开：
 * - bash      → 终端标签，focus=toolCallId（展开并滚到那条命令）
 * - read      → 文件标签，focus=toolCallId（渲染该次读取结果）
 * - edit/write→ 审查标签，focus=文件路径（展开并滚到该文件的 diff）
 * - WebFetch  → 浏览器标签，url=目标地址（复用既有标签并导航过去）
 * - plan_write（含历史 SubmitPlan/SubmitGoal）→ 文件标签，focus=提交 toolCallId
 *   （渲染 args 里的计划/提案 Markdown 快照，见 file-view）
 * 复用优先（focusPanelTab），并派发 base.tsx 监听的 `agent-panel:open`
 * 把收起的面板展开（compact 浮层同样生效）。
 */

const basename = (path: string): string => {
  const norm = path.replace(/\\/g, "/");
  return norm.slice(norm.lastIndexOf("/") + 1) || norm;
};

/** 工具行可打开面板的目标；参数未成形（args 流式中）返回 null */
export function toolPanelTarget(
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown> | undefined,
): { type: PanelTabType; extra: PanelTabExtra } | null {
  if (toolName === "bash") {
    if (typeof args?.command !== "string" || !args.command) return null;
    return { type: "terminal", extra: { focus: toolCallId } };
  }
  if (toolName === "WebFetch") {
    if (typeof args?.url !== "string" || !args.url) return null;
    let title = args.url;
    try {
      title = new URL(args.url).hostname;
    } catch {
      // 非法 URL：标题用原文，浏览器标签自己会 normalizeUrl
    }
    return { type: "browser", extra: { url: args.url, title } };
  }
  if (
    toolName === "plan_write" ||
    toolName === "SubmitPlan" ||
    toolName === "SubmitGoal"
  ) {
    const title =
      typeof args?.title === "string" && args.title
        ? args.title
        : toolName === "SubmitGoal"
          ? "目标"
          : "计划";
    return { type: "file", extra: { focus: toolCallId, title } };
  }
  const filePath =
    toolName === "read" || toolName === "edit" || toolName === "write"
      ? typeof args?.file_path === "string" && args.file_path
        ? args.file_path
        : null
      : null;
  if (!filePath) return null;
  if (toolName === "read") {
    return { type: "file", extra: { focus: toolCallId, title: basename(filePath) } };
  }
  // 审查标签可能被检查点入口带着 cwd/checkpoint 复用：定位到工具 diff 时清掉
  return {
    type: "review",
    extra: { focus: filePath, title: basename(filePath), cwd: undefined, checkpoint: undefined },
  };
}

/** 该行是否有可打开的面板视图（决定行的主点击是否激活） */
export function hasToolPanel(toolName: string): boolean {
  return (
    toolName === "bash" ||
    toolName === "read" ||
    toolName === "edit" ||
    toolName === "write" ||
    toolName === "WebFetch" ||
    toolName === "plan_write" ||
    toolName === "SubmitPlan" ||
    toolName === "SubmitGoal"
  );
}

export function openToolCallPanel(
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown> | undefined,
): void {
  const target = toolPanelTarget(toolName, toolCallId, args);
  if (!target) return;
  focusPanelTab(target.type, target.extra);
  window.dispatchEvent(new Event("agent-panel:open"));
}

/** 路径匹配（工具 args 可能带 workspace 前缀，git 侧是仓库相对路径） */
export function pathMatches(focus: string, path: string): boolean {
  const a = focus.replace(/\\/g, "/");
  const b = path.replace(/\\/g, "/");
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}
