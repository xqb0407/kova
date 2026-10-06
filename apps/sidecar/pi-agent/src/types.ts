/** 跨模块共享类型 */
import type { Agent, AgentContext, AgentTool } from "@earendil-works/pi-agent-core";
import type * as ai from "ai";
import type { RetryBudget } from "./model/provider-retry";
import type { TraceRunRecorder } from "./protocol/trace";
import type { ThemeRef } from "./design-md/store";
import type { AppMode } from "./agent/app-mode";

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
  mode?: "agent" | "plan" | "ask";
  approvalLevel?: "ask" | "workspace-write" | "auto-edit" | "auto";
  modelProvider?: string;
  modelId?: string;
  /** 会话级思考档位偏好（undefined = 从未定靶选过，跟随默认档位） */
  thinkingLevel?: string;
  /** 会话级工作模式偏好（undefined = 本会话从未切换过，跟随全局默认 pi.app_mode） */
  appMode?: "work" | "code" | "design";
  /** 会话级目标轮数上限偏好（数字字符串："0" = 不限；undefined = 从未定过） */
  goalMaxTurns?: string;
};

/** 子代理一次执行的最终状态 */
export type SubagentRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "truncated"
  | "aborted"
  | "stopped"
  /** 进程中断：持久化时仍是 running、重启后从磁盘回读的委派（见 subagent/activity-store.ts） */
  | "interrupted";

/** SubagentRun 的收敛结果（report 是唯一进入父代理上下文的内容） */
export type SubagentRunResult = {
  agentName: string;
  modelId: string;
  status: SubagentRunStatus;
  report: string;
  turns: number;
  toolCalls: number;
  /**
   * 这个子代理自己烧掉的 token（四项相加，错误/中止轮不计）。
   * 它的用量不进父会话转录（独立 Agent、独立 messages），所以必须靠这里回传，
   * 否则「目标靠委派干完了大半活」时父会话的目标读数会严重少报。
   */
  tokens?: number;
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

/**
 * 一条「并入当前轮」（steer）注入的回合内记录（prompt-pipeline.steerIntoActiveRun
 * 登记，轮末回收 findUnansweredSteers 消费）。并入的投递保证是「要么被本轮回应、
 * 要么回队重发」，静默丢消息是历史事故（并入后一直不回复）：
 * - reqId/msg：回收重入 kova 队列时原样携带（展示文本 = msg.text，无前缀）；
 * - message：交给 agent.steer 的消息对象本体——pi-core 按引用把 drain 出的消息
 *   推进 state.messages（agent.js processEvents），身份判定即可区分
 *   「边界已消费」与「仍滞留内部队列」；
 * - gen：注入时的压缩代数。转录里找不到本体、队列也没有时，代数变过说明是轮间
 *   压缩把已消费的消息折进摘要（不回收），没变才是真没进转录（回收）。
 */
export type SteerEntry = {
  reqId: string;
  msg: Record<string, unknown>;
  message: unknown;
  gen: number;
  /** 该注入行落盘的转录 seq（persist 按对象身份登记）：未获回应回收时按它把行
   *  从转录撤回，气泡随条目回收一起消失（见 prompt-pipeline.withdrawInjectedSteer） */
  seq?: number;
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
  /** runPromptTurn 收尾段（finally）置位：此刻起不再受理 steer——挂起 finish
   *  的补发已随收尾执行过，之后再受理的并入其 finish 永远没人补发（前端
   *  「已并入」徽标滞留不消失） */
  turnEnding?: boolean;
  /** 本轮「并入当前轮」注入登记（steerIntoActiveRun 追加，轮末随
   *  findUnansweredSteers 回收清空；见 SteerEntry 注释） */
  steerEntries?: SteerEntry[];
  /** 本用户 prompt 轮内"length 截断无 toolCall"已注入的自动续跑次数（每轮重置，见 context.ts；缺省视为 0） */
  lengthContinues?: number;
  /** 当前模式（agent = 正常执行；plan = 只读勘察 + 计划编写；ask = 纯问答只读；goal = 完整工具集 + 自治续跑） */
  mode: SessionMode;
  /** 逐工具审批级别（ask = 每次确认；workspace-write = 工作区内免确认；auto-edit = 编辑免确认；auto = 全免） */
  approvalLevel: ApprovalLevel;
  /** 计划状态机（见 modes.ts）：agent=inactive，plan=planning，ask=inactive，goal=inactive */
  planning: PlanningState;
  /** 当前会话计划文件绝对路径（plan_write 首写定名，之后覆盖写） */
  planFilePath?: string;
  /**
   * 当前目标产物的绝对路径（建目标首写定名，之后每次目标变更覆盖写）。
   * 与 planFilePath 同型：换一份新目标就重置，重新定名。事实源在 goal_state 行，
   * 这份文件是给人看的投影（见 goal/goal-artifact.ts）。
   */
  goalFilePath?: string;
  /**
   * 本会话选中的设计主题（design 模式提示词段与 use_design_theme 缺省目标；
   * null/缺省 = 不使用主题）。事实源：sessions.design_theme 偏好列，恢复链
   * row ?? 最近使用 kv ?? null（见 sessions/resolve.ts；变更见 handlers/design-md.ts）
   */
  designTheme?: ThemeRef | null;
  /**
   * 本会话生效的工作模式（work|code|design）：决定系统提示词的模式附加段。
   * 事实源：sessions.app_mode 偏好列；从未切换过的会话跟随全局默认（kv
   * pi.app_mode），恢复链 row ?? 全局默认（见 sessions/resolve.ts）。
   * 与 mode（agent/plan/ask 权限模式）正交。变更见 handlers/preferences.ts。
   */
  appMode: AppMode;
  /**
   * 本会话的目标轮数上限预设。三态，别合并（合并过一次，代价是「用户选了不限，
   * 下次却被当成没设过」）：
   *   undefined = 本会话从未定过 → 建目标回落默认 300
   *   null      = 明确不限
   *   number    = 具体轮数
   * 事实源：sessions.goal_max_turns 偏好列；建目标时用户在常驻条上填的值优先于它，
   * 用户改上限时回写该列（见 goal.ts 的 syncGoalOnUserPrompt / setGoalMaxTurns）。
   */
  goalMaxTurns?: number | null;
  /**
   * 本次 run 已消耗、但还没结算进目标账的 token（message_end 与子代理结算时累加，
   * 目标轮边界取走后清零）。
   *
   * 为什么不从转录重算：那是「累计 − 基线」的重算值，既包含目标之外的活动
   *（暂停期间用户在别的模式里干的活），又不含子代理（用量不进父转录），还要把
   * 整个 JSONL 读一遍——目标每跑一轮读一次，是 O(n²)。现累的增量没有这三个毛病。
   */
  usagePending: number;
  /**
   * 「主题全文已在上下文里」台账（key = scope/id，value = 正文哈希）：
   * use_design_theme 重复加载短路的数据面——同 ref 同哈希返回简短确认不再
   * 贴全文；哈希变化（管理页编辑）自动失效重贴。压缩（runCompaction）整体
   * 替换消息后必须清空：全文已不在上下文，下次调用重取（design 段指令常驻
   * 驱动模型复call，自愈）。恢复的重建 run 天然空表 = 宁可重贴不谎报已加载。
   */
  designThemeLoads?: Map<string, string>;
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
  /** remember = 用户点的是「允许并记住」（只有带可写根上下文的审批才有意义） */
  resolve: (outcome: { approved: boolean; remember: boolean }) => void;
  /** 结算来源：confirm = 用户点了批准/拒绝；clear = Stop/新 prompt 兜底清理 */
  settledBy?: "confirm" | "clear";
  /**
   * 点「允许并记住」时应写进本机清单的那条根，以及解析它的工作区。
   * 只在 workspace-write 档的写类工具上带——其余审批（bash、配置类、MCP）
   * 没有「一条可记住的路径」可言，卡上也就不会出现第三个按钮。
   */
  rememberRoot?: string;
  /** bash 的整条命令（逐字相等才免确认）：见 rememberCommand */
  rememberCommand?: string;
  cwd?: string;
};

/* ------------------------------- 模式与审批 ------------------------------- */

/** 会话模式:agent 正常执行;plan 只读勘察 + 编写实施计划(plan_exit 批准后回 agent 实施);ask 纯问答(只读工具子集,不改工作区);goal 自治目标(完整工具集 + 跨轮续跑,靠 goal_complete/goal_blocked 收尾);workflow 多代理编排(模型拟剧本,执行器后台跑 Task 委派,见 workflow/) */
export type SessionMode = "agent" | "plan" | "ask" | "goal" | "workflow";

/**
 * 逐工具审批级别（按"问多少"从紧到松排列）：
 * - ask：bash/write/edit 每次执行前都要用户确认（变更前确认）
 * - workspace-write：**工作区内的** write/edit 免确认，工作区之外（含别的项目）
 *   一律确认；bash 与配置类工具照常确认（改成工作区前缀外的路径要你点头）
 * - auto-edit：write/edit 全部放行（含工作区外），bash 仍确认（自动编辑）
 * - auto：全部自动放行（完全访问）
 *
 * workspace-write 的边界由 agent/workspace-boundary.ts 判定（软链接按真实落点算）。
 * 它管不住 bash——一条命令能写到任何地方，参数里看不出目标路径，所以 bash 在这一档
 * 仍然弹确认；要真正等价需要 OS 级沙箱，见 docs/permission-modes.md。
 */
export type ApprovalLevel = "ask" | "workspace-write" | "auto-edit" | "auto";

/** 计划审批状态机：inactive（agent 模式）↔ planning（plan 模式；执行确认挂起由 pendingToolApprovals 承担） */
export type PlanningState = "inactive" | "planning";
