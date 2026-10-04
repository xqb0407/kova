"use client";

/**
 * 逐工具审批的兼容再导出层（设计文档 §4）：实现已并入 pi-interactions
 * 统一 store，本模块只保住既有导入路径（tool-approval-card / pi-transport）。
 * 新代码请直接 import pi-interactions。
 */
export {
  type PendingToolApprovalView,
  applyToolApprovalChunk,
  clearToolApprovals,
  usePendingToolApprovals,
  confirmToolApproval,
} from "@/lib/pi/pi-interactions";
