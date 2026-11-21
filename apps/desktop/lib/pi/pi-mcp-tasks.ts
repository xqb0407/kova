"use client";

/**
 * MCP 任务进度的兼容再导出层：实现并入 pi-interactions（与审批/提问同店），
 * 本模块保住既有导入路径（pi-client-base 消费）。新代码直接 import pi-interactions。
 */
export {
  type McpTaskProgressView,
  clearMcpTasks,
  removeMcpTask,
  updateMcpTaskProgress,
  useMcpTaskProgress,
} from "@/lib/pi/pi-interactions";
