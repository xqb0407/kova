/**
 * 子代理工具行的类别名/图标（面板对话列表与消息流血缘卡片共用）。
 * 归属列表只有 sidecar 能力模型里的这几种，全部给中文标签；未命中回退原始名 + 扳手。
 */
import type { ComponentType } from "react";
import {
  BookOpenIcon,
  ClipboardListIcon,
  DatabaseIcon,
  FileSearchIcon,
  GlobeIcon,
  NotebookPen,
  PencilLineIcon,
  SearchCheckIcon,
  SearchIcon,
  SquareTerminalIcon,
  WrenchIcon,
} from "lucide-react";

export type SubagentToolMeta = {
  label: string;
  icon: ComponentType<{ className?: string }>;
};

export const SUBAGENT_TOOL_META: Record<string, SubagentToolMeta> = {
  bash: { label: "终端", icon: SquareTerminalIcon },
  read: { label: "查看", icon: BookOpenIcon },
  edit: { label: "编辑", icon: PencilLineIcon },
  write: { label: "写入", icon: NotebookPen },
  glob: { label: "文件检索", icon: FileSearchIcon },
  grep: { label: "内容检索", icon: SearchIcon },
  // 子代理可经定义维度挂载的工具（见 sidecar subagent/capabilities.ts）：
  // 归属列表只有这几种，全部给中文标签，未知工具才回退原始名 + 扳手
  WebSearch: { label: "网络搜索", icon: SearchIcon },
  WebFetch: { label: "抓取网页", icon: GlobeIcon },
  use_skill: { label: "调用技能", icon: BookOpenIcon },
  todo: { label: "任务清单", icon: ClipboardListIcon },
  memory_write: { label: "记忆写入", icon: PencilLineIcon },
  memory_read: { label: "记忆读取", icon: DatabaseIcon },
  memory_search: { label: "记忆检索", icon: SearchCheckIcon },
  kb_search: { label: "知识检索", icon: SearchCheckIcon },
  kb_read: { label: "读取资料", icon: BookOpenIcon },
  mcp: { label: "MCP 调用", icon: WrenchIcon },
  task_output: { label: "后台任务输出", icon: SquareTerminalIcon },
  taskOutput: { label: "后台任务输出", icon: SquareTerminalIcon },
  task_stop: { label: "停止后台任务", icon: SquareTerminalIcon },
};

/** 工具名 → 元信息（未知工具回退原始名 + 扳手） */
export function subagentToolMeta(toolName: string): SubagentToolMeta {
  return SUBAGENT_TOOL_META[toolName] ?? { label: toolName, icon: WrenchIcon };
}
