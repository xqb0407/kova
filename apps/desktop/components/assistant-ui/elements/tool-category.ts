/**
 * 工具 → 分组类别（对话里的工具行/折叠组共用）：terminal=命令流水、
 * inspect=查阅（读文件/检索）、modify=编辑改动、browser=浏览器操作。
 *
 * 未列出的工具归通用组。browser_* 按前缀归组，不逐个枚举——sidecar 的浏览器
 * 工具族有近 20 个，枚举会随新增工具漂移；单行图标与组头图标共用这一判断。
 */
export type ToolCategory = "terminal" | "inspect" | "modify" | "browser";

/** 具名工具 → 类别（其余见 {@link toolCategory} 的 browser_ 前缀兜底） */
const NAMED: Record<string, ToolCategory> = {
  bash: "terminal",
  read: "inspect",
  glob: "inspect",
  grep: "inspect",
  WebFetch: "inspect",
  WebSearch: "inspect",
  memory_read: "inspect",
  memory_search: "inspect",
  use_skill: "inspect",
  edit: "modify",
  write: "modify",
};

export const toolCategory = (toolName: string): ToolCategory | undefined =>
  NAMED[toolName] ??
  (toolName.startsWith("browser_") ? "browser" : undefined);
