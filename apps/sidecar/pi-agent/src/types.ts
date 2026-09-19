/** 跨模块共享类型 */
import type { Agent, AgentContext, AgentTool } from "@earendil-works/pi-agent-core";
import type * as ai from "ai";
import type { RetryBudget } from "./provider-retry";
import type { TraceRunRecorder } from "./trace";

/** AI SDK UI 消息类型（协议流与 JSONL 持久化都用它） */
export type UIMessage = ai.UIMessage;
export type UIMessageChunk = ai.UIMessageChunk;

/**
 * 图片 UI 投影 part 的 data 载荷（chunk `{type:"data-image", id, data}` /
 * UIMessage data part）。投影与大小闸门见 image-parts.ts，设计 docs/image-part-design.md。
 */
export type PiImagePartData = {
  /** 内联 data URL：`data:<mimeType>;base64,...` */
  src: string;
  mimeType: string;
  /** 解码后原始字节（base64 长度 ×3/4 近似；渲染角标用） */
  bytes: number;
  /** 产出该图的工具调用 id；非工具来源（P1 模型直出）为 null */
  toolCallId: string | null;
  /** 产出图的工具名 */
  toolName?: string;
  /** 可访问名：结果首个文本块首行（≤120 字符） */
  alt?: string;
};

/** 自定义端点的模型规格（custom_providers 模型行 / add_custom_provider 的 models 元素） */
export type CustomModelSpec = {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  /** 模态列表，如 ["text"] / ["text","image"] */
  input?: unknown[];
  /** 单价（每 token），如 { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } */
  cost?: Record<string, unknown>;
};

/** 自定义提供商支持的接口格式 */
export type CustomApiKind =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages";

/** 会话列表项（给前端渲染列表用） */
export type SessionSummary = {
  sessionId: string; // 会话 id（索引表主键 / JSONL 文件名）
  name?: string;
  firstMessage: string;
  messageCount: number;
  modified: string; // ISO
  cwd: string;
  archived?: boolean; // 归档标记：列表默认隐藏，正文不动
  /** 会话级偏好（undefined = 从未变更过；切回会话时恢复模式/模型用） */
  mode?: "agent" | "plan";
  approvalLevel?: "ask" | "auto-edit" | "auto";
  modelProvider?: string;
  modelId?: string;
};

/** 子代理一次执行的最终状态 */
export type SubagentRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "truncated"
  | "aborted"
  | "stopped";

/** SubagentRun 的收敛结果（report 是唯一进入父代理上下文的内容） */
export type SubagentRunResult = {
  agentName: string;
  modelId: string;
  status: SubagentRunStatus;
  report: string;
  turns: number;
  toolCalls: number;
  error?: { code: string; message: string };
};

/**
 * 子代理运行活动的归一化条目：SubagentRun 把 delegate 的 AgentEvent 折成本项，
 * 一路进 DelegationRecord.activity（快照补水合用），一路以无 id 通知行
 * {type:"subagent_activity", delegationId, item} 广播（宿主原样转发，同 turn_changed）。
 * 前端面板 tab 据此流式渲染 delegate 内部过程；不进父转录。
 */
export type SubagentActivityItem =
  /** delegate 新一轮开始（n = 轮次序号） */
  | { kind: "turn"; n: number; at: number }
  /** 思考块增量流（id 为 delegate 内内容索引的稳定 id） */
  | { kind: "thinking"; op: "start" | "delta" | "end"; id: string; delta?: string; at: number }
  /** 正文增量流（报告叙述文本） */
  | { kind: "text"; op: "start" | "delta" | "end"; id: string; delta?: string; at: number }
  /** delegate 的工具调用起止（参数/结果只带单行摘要，不带原文） */
  | {
      kind: "tool";
      op: "start" | "end";
      toolCallId: string;
      toolName: string;
      argsSummary?: string;
      resultSummary?: string;
      failed?: boolean;
      at: number;
    }
  /** 结算终态（settleDelegation 时发出；report 截断后随带，供面板展示最终报告） */
  | {
      kind: "status";
      status: SubagentRunStatus;
      turns: number;
      toolCalls: number;
      report?: string;
      at: number;
    };

/** 一次 Task 委派的登记项（会话级注册表，后台运行、TaskWait 收敛） */
export type DelegationRecord = {
  delegationId: string;
  agentName: string;
  modelId: string;
  status: SubagentRunStatus;
  /** Task 的 description 参数：给用户看的一行短描述（消息行与面板 tab 标题） */
  description?: string;
  /** 运行活动流的内存环形缓冲（见 pushActivity 的上限与丢弃策略） */
  activity: SubagentActivityItem[];
  /** TaskStop / 用户 Stop 置位，结算时把 aborted 归类为 stopped */
  stopRequested: boolean;
  startedAt: number;
  completedAt?: number;
  turns: number;
  toolCalls: number;
  result?: SubagentRunResult;
  /** 报告已通过 TaskWait 或恢复 prompt 交给父代理，避免重复投递 */
  reportedToParent: boolean;
  /** 结算信号：TaskWait 等它，SubagentRun 完成时 resolve */
  completion: Promise<void>;
  resolveCompletion: () => void;
  abort: () => void;
};

/** threadId 对应的活动会话（每个前端线程一个 Agent 实例） */
export type Running = {
  agent: Agent;
  /** 所属前端线程 id（队列/事件路由/中断都按线程隔离） */
  threadId: string;
  sessionId: string;
  cwd: string;
  /** 持久化 cwd（会话绑定的工作目录；空串 = 建会话时未选目录，允许后续补绑） */
  persistedCwd?: string;
  persistedSeq: number; // state.messages 中已入账（落盘或压缩合成）的前缀长度
  /** JSONL 行 seq 分配器：消息行与 compaction 行共用，文件内单调（压缩后不撞号） */
  jsonlSeq: number;
  /** 已安装的压缩检查点代数（0 = 从未压缩；新 checkpoint 取 +1） */
  compactionGeneration: number;
  /** 压缩摘要请求的中止句柄（用户 Stop 时 abort） */
  compactionAbort?: AbortController;
  /** stream.ts 检测到上下文溢出错误后置位，dispatchPrompt 结算恢复 */
  pendingOverflowRecovery: boolean;
  /** 本轮 provider 请求的重试预算（429/瞬时各自封顶，每个 prompt 轮重置） */
  providerRetry: RetryBudget;
  /** streamFn 接线处的 fetch 包装回传的失败响应捕获（status + 可延迟头） */
  retryCapture: {
    status?: number;
    headers?: Readonly<Record<string, string>>;
  };
  /** 当前 data-retry part id（每 prompt 轮一个，多次尝试同 id 原地更新） */
  providerRetryChunkId: string;
  /** 重试卡片在屏标志：onRetry 置位，onSettled 发 resolved 后清除 */
  providerRetryActive: boolean;
  /** providerRetryChunkId 的轮次序号源 */
  providerRetryTurnSeq: number;
  /** 本会话的 Task 委派注册表 */
  delegations: Map<string, DelegationRecord>;
  /** 用户 Stop 置位：中止后台子代理并退出收敛循环 */
  stopRequested: boolean;
  /** 本用户 prompt 轮内"length 截断无 toolCall"已注入的自动续跑次数（每轮重置，见 context.ts；缺省视为 0） */
  lengthContinues?: number;
  /** 当前模式（agent = 正常执行；plan = 只读勘察 + 计划编写） */
  mode: SessionMode;
  /** 逐工具审批级别（ask = 每次确认；auto-edit = 编辑免确认；auto = 全免） */
  approvalLevel: ApprovalLevel;
  /** 计划状态机（见 modes.ts）：agent=inactive，plan=planning */
  planning: PlanningState;
  /** 当前会话计划文件绝对路径（plan_write 首写定名，之后覆盖写） */
  planFilePath?: string;
  /** 计划标题（首写时确定，用于文件名与审批卡展示） */
  planTitle?: string;
  /** 未过滤的基础工具目录（重建模式工具集时用） */
  baseTools: AgentTool[];
  /** Task 委派工具组（仅 agent 模式挂载） */
  subagentTools: AgentTool[];
  /** 逐工具审批：approvalId -> 挂起等待项（beforeToolCall 内 await，tool_confirm 结算） */
  pendingToolApprovals: Map<string, PendingToolApproval>;
  /**
   * 当前活跃循环的上下文快照引用（每次 beforeToolCall 捕获）。
   * 循环每轮请求都从这里读 tools/systemPrompt：模式切换时 applyMode 直接改写它，
   * 让 plan_enter / plan_exit 在**同一轮**里立即换表，而不是等下一次 prompt。
   */
  loopContext?: AgentContext;
  /** LRU 驱逐时间戳（迭代2）：resolveSession/查询命中时 touch，超上限驱逐最旧 */
  lastSeenAt: number;
  /** 本 run 的轨迹记录器（trace.ts；agent_start 懒创建，agent_end 结算清引用） */
  trace?: TraceRunRecorder;
};

/** 逐工具审批等待项（bash/write/edit 执行前等待用户确认；plan_exit 复用同一条通道） */
export type PendingToolApproval = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  resolve: (approved: boolean) => void;
  /** 结算来源：confirm = 用户点了批准/拒绝；clear = Stop/新 prompt 兜底清理 */
  settledBy?: "confirm" | "clear";
};

/* ------------------------------- 模式与审批 ------------------------------- */

/** 会话模式：agent 正常执行；plan 只读勘察 + 编写实施计划（plan_exit 批准后回 agent 实施） */
export type SessionMode = "agent" | "plan";

/**
 * 逐工具审批级别（对齐参考项目 targetPermissionMode）：
 * - ask：bash/write/edit 每次执行前都要用户确认（变更前确认）
 * - auto-edit：write/edit 自动放行，bash 仍需确认（自动编辑）
 * - auto：全部自动放行（完全访问）
 */
export type ApprovalLevel = "ask" | "auto-edit" | "auto";

/** 计划审批状态机：inactive（agent 模式）↔ planning（plan 模式；执行确认挂起由 pendingToolApprovals 承担） */
export type PlanningState = "inactive" | "planning";
