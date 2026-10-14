/**
 * 子代理：由 Task 工具派生的有界 delegate agent 循环（对齐 PI-Desktop agent-runtime / ADR 0062）。
 *
 * delegate 是同一 sidecar 进程里的第二个 pi Agent，拥有独立的 system prompt、
 * 独立的（可固定的）模型和只属于它定义声明的工具集合。两条边界构成设计：
 * - 父代理的模型上下文只增量地收到 delegate 的最终报告（TaskWait 结果或恢复 prompt）；
 *   子消息与子工具行不进父转录（它们活在子 Agent 实例里，persist 天然不会写入）。
 * - delegate 的生命周期不惊动协议层的 turn 处理：Task 启动后立即返回，TaskWait
 *   提前收敛，turn 结束后仍未完成的由 dispatchPrompt 的收敛循环等待并投递报告。
 *   只有用户 Stop 或 TaskStop 会中止它。
 *
 * 物理布局（本文件为门面，签名与原单文件完全一致）：
 * - ./subagent/delegation.ts  委派注册表 + 活动流广播 + 收敛原语（settle/wait/心跳）
 * - ./subagent/run.ts         delegate 执行循环（独立 Agent 实例，重试/轨迹/续跑）
 * - ./subagent/tools.ts       Task/TaskWait/TaskList/TaskStop 工具组 + 管理工具
 */
export {
  // 常量
  SUBAGENT_TOOL_NAME,
  SUBAGENT_WAIT_TOOL_NAME,
  SUBAGENT_LIST_TOOL_NAME,
  SUBAGENT_STOP_TOOL_NAME,
  MAX_SUBAGENT_REPORT_CHARS,
  MAX_SUBAGENT_CONCURRENCY,
  MAX_ACTIVITY_ITEMS,
  // 委派注册表与活动流
  registerDelegation,
  pushActivity,
  summarizeToolArgs,
  getDelegationSnapshot,
  // 报告与收敛原语
  boundedReport,
  parseModelKey,
  runningDelegations,
  settleDelegation,
  delegationHeartbeat,
  delegationResumeText,
  waitForDelegations,
} from "./delegation";

export { composeSubagentSystemPrompt } from "./run";

export { buildSubagentTools } from "./tools";

/** 定义名归一（身份匹配用，事实源在 subagent-definitions） */
export { normalizeSubagentName } from "./subagent-definitions";
