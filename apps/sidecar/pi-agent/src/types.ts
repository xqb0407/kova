/** 跨模块共享类型 */
import type { Agent, AgentContext, AgentTool } from "@earendil-works/pi-agent-core";
import type * as ai from "ai";
import type { ApprovalLevel, ExternalDir } from "pi-protocol";
import type { RetryBudget } from "./model/provider-retry";
import type { TraceRunRecorder } from "./protocol/trace";
import type { ThemeRef } from "./design-md/store";
import type { AppMode } from "./agent/app-mode";
import type { CacheWarmer } from "./agent/cache-warmer";
import type { TurnPlan } from "./agent/assembly/contracts";

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
  /** prompt cache TTL（秒）：cache warmer 只对声明过的模型工作 */
  promptCache?: { short?: number; long?: number };
};

/** 模型行里**显式存过**的属性（null = 该属性仍是继承态，生效值来自目录种子或缺省猜测）。
 *  list_custom_providers 随模型摘要回传：编辑弹窗靠它区分"用户填过的值"与"算出来的值"，
 *  保存时只回写用户真正改过的字段，避免把目录真值/归一化命中的值反写成显式值冻住。 */
export type StoredModelAttrs = {
  name: string | null;
  reasoning: boolean | null;
  contextWindow: number | null;
  maxTokens: number | null;
  input: unknown[] | null;
  cost: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  } | null;
  promptCache: { short?: number; long?: number } | null;
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
  approvalLevel?: ApprovalLevel;
  modelProvider?: string;
  modelId?: string;
  /** 会话级思考档位偏好（undefined = 从未定靶选过，跟随默认档位） */
  thinkingLevel?: string;
  /** 会话级工作模式偏好（undefined = 本会话从未切换过，跟随全局默认 pi.app_mode） */
  appMode?: "work" | "code" | "design";
  /** 会话级目标轮数上限偏好（数字字符串："0" = 不限；undefined = 从未定过） */
  goalMaxTurns?: string;
  /** 会话级验收标准启动模式（undefined = 从未定过，新目标默认 auto） */
  goalAcceptanceMode?: "auto" | "manual" | "skip";
  /** 会话级目标时长上限（分钟字符串；"0" = 不限；undefined = 从未定过） */
  goalMaxDuration?: string;
  /** 会话归属的项目 id（新模型唯一归属依据）；旧端/旧会话缺省 */
  projectId?: string;
  /** 会话归属的虚拟项目主目录（cwd 是附加根时回主目录）；旧端缺省 */
  projectCwd?: string;
  /** 会话类型（加性）：缺省 = 普通任务；"side_chat" = 划词辅助会话 */
  kind?: "side_chat";
  /** 辅助会话的父会话 id（kind=side_chat 时存在） */
  parentSessionId?: string;
  /** 会话来源（加性）：缺省 = 桌面创建；"im" = IM 通道创建 */
  origin?: "im";
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
      /** write/edit 的文件路径（结构化，产物卡用；老记录缺席时回退 argsSummary） */
      filePath?: string;
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
      /** 是否留有可 resume 的存档历史（面板据此启用/禁用续聊输入行） */
      canResume?: boolean;
      at: number;
    }
  /** provider 请求被限流/瞬断后的自动重试（delegate 无自己的 UI 流，靠活动流上屏） */
  | {
      kind: "retry";
      attempt: number;
      maxRetries: number;
      delayMs: number;
      code: string;
      message?: string;
      at: number;
    }
  /** 已受理的插入消息（SendMessage / 对话页输入；子代理下个模型调用边界消费） */
  | { kind: "message"; text: string; at: number };

/**
 * 一条委派的历史消息存档（resume 用；每轮随 activity 落盘）。
 * toolResult 必须带 toolCallId/toolName：只存 role+content 会让续聊时的
 * provider 请求出现"没有 id 的 tool 消息"，OpenAI 兼容端点直接拒绝。
 */
export type SubagentHistoryMessage =
  | { role: "user"; content: unknown; timestamp?: number }
  | {
      role: "assistant";
      content: unknown;
      timestamp?: number;
      stopReason?: string;
      errorMessage?: string;
    }
  | {
      role: "toolResult";
      content: unknown;
      toolCallId: string;
      toolName: string;
      isError?: boolean;
      timestamp?: number;
    };

/** 一次 Task 委派的登记项（会话级注册表，后台运行、TaskWait 收敛） */
export type DelegationRecord = {
  delegationId: string;
  agentName: string;
  modelId: string;
  /** UHP backend: last response id, used as previous_response_id on resume. */
  externalResponseId?: string;
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
  /** delegate 会话历史（每轮结束存档；resume 时作为初始上下文） */
  history?: SubagentHistoryMessage[];
  /** SubagentRun 注入的历史提取闭包（settle 时调用一次存档） */
  archiveHistory?: () => SubagentHistoryMessage[];
  /** SubagentRun 注入的插话闭包（running 时给 SendMessage/对话页用） */
  sendMessage?: (text: string) => boolean;
  /** 父会话三要素（resume 时按需物化父会话；Task 启动时回填，活动文件 meta 携带重启后仍可续聊） */
  ownerSession?: { sessionId: string; threadId: string; cwd: string };
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

/** 远程执行目标（SSH）：会话绑定后工具调用经 SSH 在远端执行 */
export type RemoteTarget = {
  /** 主机名/IP 或 ~/.ssh/config 别名（别名时 port/username 交由 ssh config 解析） */
  host: string;
  port?: number;
  username?: string;
  /** 私钥路径（可选；缺省走 agent / 默认密钥） */
  privateKeyPath?: string;
  /**
   * 密码（仅密码认证主机）：只存在于进程内存与 SSH 连接配置，
   * **绝不写入转录 header / 日志**（见 sanitizeRemoteForHeader）。
   */
  password?: string;
};

/** 去掉密码等秘密后的远程目标（转录 header 落盘唯一允许的形状） */
export function sanitizeRemoteForHeader(remote: RemoteTarget): Omit<RemoteTarget, "password"> {
  const { password: _password, ...rest } = remote;
  return rest;
}

/** threadId 对应的活动会话（每个前端线程一个 Agent 实例） */
export type Running = {
  agent: Agent;
  /** 所属前端线程 id（队列/事件路由/中断都按线程隔离） */
  threadId: string;
  sessionId: string;
  cwd: string;
  /** 会话类型（索引行 kind）："" / undefined = 普通任务；"side_chat" = 划词辅助会话 */
  sessionKind?: string;
  /**
   * 远程执行目标（SSH）：会话绑定后 bash/read/write/edit 等工具调用改经 SSH
   * 在远端执行（见 tools/remote/）。null/缺省 = 本地会话（走 Rust 宿主）。
   * 事实源：转录 header 的 remote 字段（新建时写入、恢复时读回；DB 无此列）。
   */
  remoteTarget?: RemoteTarget | null;
  /** 持久化 cwd（会话绑定的工作目录；空串 = 建会话时未选目录，允许后续补绑） */
  persistedCwd?: string;
  /** 外部协议（UHP）配置的会话级附加系统提示词；稳定段，进系统提示词尾部。 */
  harnessSystemPrompt?: string | null;
  /**
   * 项目虚拟目录（本项目的附加代码工程根目录）：只按绝对路径访问，
   * 提供指令文件、技能与可检索文件。事实源 projects.project_folders；
   * 普通任务会话（无 cwd）恒为空。
   */
  externalDirs: ExternalDir[];
  /** 项目归属（NULL/缺省 = 普通任务/旧会话/远程会话） */
  projectId?: string | null;
  persistedSeq: number; // state.messages 中已入账（落盘或压缩合成）的前缀长度
  /** JSONL 行 seq 分配器：消息行与 compaction 行共用，文件内单调（压缩后不撞号） */
  jsonlSeq: number;
  /** 已安装的压缩检查点代数（0 = 从未压缩；新 checkpoint 取 +1） */
  compactionGeneration: number;
  /** 压缩摘要请求的中止句柄（用户 Stop 时 abort） */
  compactionAbort?: AbortController;
  /**
   * 压缩进行中标志：thread_snapshot 的 metadata.compactionActive 数据源。
   * 与 compaction_start/end 线程事件同生命周期（runCompaction 进出时置位/清零），
   * 快照直出它做权威值——前端在 running 态下的事件丢失（切走/换代）不再粘住
   * 压缩横幅（事件是增量，快照是权威）。
   */
  compactionActive?: boolean;
  /**
   * 手动压缩的完成门闩：compact 在管理队列外跑 provider 请求，同一会话的新
   * prompt 在轮初等它收尾，避免压缩写 checkpoint 与新一轮初始化并发。
   */
  compactionPromise?: Promise<void>;
  /** stream.ts 检测到上下文溢出错误后置位，dispatchPrompt 结算恢复 */
  pendingOverflowRecovery: boolean;
  /** 本轮 provider 请求的重试预算（429/瞬时各自封顶，每个 prompt 轮重置） */
  providerRetry: RetryBudget;
  /** streamFn 接线处的 fetch 包装回传的失败响应捕获（status + 可延迟头） */
  retryCapture: {
    status?: number;
    headers?: Readonly<Record<string, string>>;
  };
  /**
   * 已被证实拒图的模型集合（键 provider/modelId，见 model/image-rejection.ts）：
   * 元数据标成支持图像但端点真拒图时，provider-retry 的拒图修复重试成功后把
   * 该模型记进来，后续轮次 streamFn 入口直接预剥图，免掉每次的必败首请求。
   * 进程内存活；重启丢失只是再失败重试一次。
   */
  imageRejectionModels?: Set<string>;
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
  /** 当前/最近一轮的 turn id（= prompt reqId）：Codex hooks payload 的 turn_id 来源 */
  turnId?: string;
  /** 本轮派发时刻（链节真正接棒开跑时记一次）：轮收尾写 turn_timing 行的起点 */
  turnStartedAt?: number;
  /** 本轮首个 assistant 内容到达时刻（首 token/思考/工具块）：前端展示耗时
   *  从这里起算，不含「连接中」等待；无回复的轮不记，摘要行不显示耗时 */
  turnFirstResponseAt?: number;
  /** 本轮首条 user 消息行的转录 seq（persist 时捕获）：turn_timing 的轮锚点。
   *  没有锚点的轮（会话解析失败、无用户行的自动化轮）不写工时行。 */
  turnAnchorSeq?: number;
  /** turn_timing 行已写标记：收尾与崩溃兜底两条路径共用，保证每轮最多一行 */
  turnTimingWritten?: boolean;
  /** prompt cache 保活器：每次会话请求 start，轮收尾 onAgentSettled，
   *  会话驱逐 cancel（见 agent/cache-warmer.ts） */
  cacheWarmer?: CacheWarmer;
  /** runPromptTurn 收尾段（finally）置位：此刻起不再受理 steer——挂起 finish
   *  的补发已随收尾执行过，之后再受理的并入其 finish 永远没人补发（前端
   *  「已并入」徽标滞留不消失） */
  turnEnding?: boolean;
  /** 待发送的 SessionStart 钩子来源：resolveSession 物化会话时置位，首个
   *  真实用户回合开跑时消费（见 prompt-pipeline.fireSessionStartHook）。
   *  主题/目标按钮/手动压缩等管理请求也会物化 run，不能直接触发外部命令。 */
  sessionStartSource?: "create" | "resume";
  /** 本轮 abort 是否保留队列自动派发（promote「立即发送」置位）：Stop 语义
   *  默认在收尾后暂停队列等用户显式恢复（对齐成熟实现），promote 触发的主动
   *  中止则必须让队首继续跑，不能暂停。收尾段读取后复位。 */
  preserveQueueOnStop?: boolean;
  /** 本轮 Stop 是否丢弃排队项（IM 等没有排队 UI/继续入口的调用方置位）：
   *  收尾时取消整队而不是保留为暂停态。收尾段读取后复位。 */
  discardQueueOnStop?: boolean;
  /** 本轮「并入当前轮」注入登记（steerIntoActiveRun 追加，轮末随
   *  findUnansweredSteers 回收清空；见 SteerEntry 注释） */
  steerEntries?: SteerEntry[];
  /** 本用户 prompt 轮内"length 截断无 toolCall"已注入的自动续跑次数（每轮重置，见 context.ts；缺省视为 0） */
  lengthContinues?: number;
  /** 本用户 prompt 轮内 autoVerify 已注入的验证 followUp 次数（每轮重置，同 lengthContinues；缺省视为 0） */
  verifyContinues?: number;
  /** 本用户 prompt 轮内 Stop 钩子要求继续工作的次数（每轮重置；防钩子死循环） */
  stopHookContinues?: number;
  /** 当前模式（agent = 正常执行；plan = 只读勘察 + 计划编写；ask = 纯问答只读；goal = 完整工具集 + 自治续跑） */
  mode: SessionMode;
  /** 逐工具审批级别（ask = 每次确认；workspace-write = 工作区内免确认；auto-edit = 编辑免确认；review = 模型逐次判风险；auto = 全免） */
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
   * 本会话的验收标准启动模式预设。undefined = 从未定过（新目标默认 auto）。
   * 事实源：sessions.goal_acceptance_mode 偏好列。
   */
  goalAcceptanceMode?: "auto" | "manual" | "skip";
  /**
   * 本会话的目标活跃时长上限预设（秒）。三态同 goalMaxTurns：
   * undefined = 从未定过（新目标默认 2 小时）；null = 明确不限；number = 具体秒数。
   * 事实源：sessions.goal_max_duration 偏好列（分钟文本）。
   */
  goalMaxDurationSeconds?: number | null;
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
  /**
   * PTC 开关的会话快照：resolveSession 物化 run 时读取一次。
   * 已有会话不随设置页翻转而换工具表（避免打断前缀缓存），新会话才生效。
   */
  ptcEnabled?: boolean;
  /** 懒创建的 run_code 工具；只读子工具目录变化时按签名重建（见 tools/ptc/run-code-tool.ts） */
  ptcTool?: AgentTool;
  ptcToolSignature?: string;
  /** 会话级能力贡献的系统提示词后缀（空串 = 无贡献；随工具表一起重建） */
  capabilitySystemSuffix?: string;
  /** 本轮能力装配结果（钩子快照与提醒）：dispatchPrompt 开头写入，轮末清理 */
  turnCapabilities?: TurnPlan;
  /** 能力收尾时排入的提醒：只在循环继续时注入，轮末丢弃（见 prepareNextTurn） */
  capabilityReminders?: string[];
  /**
   * 上次已应用的系统提示词分段（modes.composeRunPromptParts 的 blocks）。
   * 只用于判断“哪一段变了”：skills/externalDirs/memory/instructions 变化走尾部更新，
   * 其余段变化整体重写。
   */
  promptBlocks?: Record<string, string>;
  /**
   * 尚未投递到模型的尾部提示词更新（skills / externalDirs / memory / instructions / 日期）。
   * 按 key 去重；轮初或循环继续时投递，投递即清空。
   */
  pendingPromptUpdates?: { key: string; text: string }[];
  /** 上次投递的宿主日历日（YYYY-MM-DD）：跨天才追加日期提醒。 */
  lastEnvDate?: string;
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
  /** remember = 用户点的是「允许并记住」（只有带可写根上下文的审批才有意义）；
   *  reason = 拒绝时用户填写的修改意见（plan_exit 用它区分「修订」与「停止」） */
  resolve: (outcome: { approved: boolean; remember: boolean; reason?: string }) => void;
  /** 结算来源：confirm = 用户点了批准/拒绝；clear = Stop/新 prompt 兜底清理 */
  settledBy?: "confirm" | "clear";
  /**
   * 点「允许并记住」时应写进本机清单的那条根，以及解析它的工作区。
   * 只在 workspace-write 档的写类工具上带——其余审批（bash、配置类、MCP）
   * 没有「一条可记住的路径」可言，卡上也就不会出现第三个按钮。
   */
  rememberRoot?: string;
  /** bash 的命令词前缀规则（点「记住」时按 deriveCommandRules 记下）：见 rememberCommand */
  rememberCommand?: string;
  cwd?: string;
  /**
   * 发起这次审批的委派 id（子代理的调用才带）。
   *
   * 存在的理由：子代理的 await 挂在工具调用里，abort 断不了它（BeforeToolCallContext
   * 不带 signal），TaskStop / 委派结算必须按这个标记把它名下的挂起项结算掉，
   * 否则那张卡永远没人答、那个子代理永远不返回。
   */
  delegationId?: string;
  /**
   * 发起这次审批的 run_code 工具调用 id（PTC 子调用才带）。
   *
   * 与 delegationId 同一条存在理由：脚本的 deadline/abort 断不了挂在审批上的
   * runToolCall，脚本已带着部分结果返回、模型已继续对话，那张卡再被批准就是把
   * 结果写给一个无人等待的调用——脚本结束（finalize）时按这个标记结算（见
   * clearApprovalsForRunCode）。
   */
  parentToolCallId?: string;
};

/* ------------------------------- 模式与审批 ------------------------------- */

/** 会话模式：agent 正常执行；plan 只读勘察 + 编写实施计划（plan_exit 批准后回 agent 实施）；ask 纯问答（只读工具子集，不改工作区）；goal 自治目标（完整工具集 + 跨轮续跑，靠 goal_complete/goal_blocked 收尾） */
export type SessionMode = "agent" | "plan" | "ask" | "goal";

/**
 * 逐工具审批级别（按"问多少"从紧到松排列）：
 * - ask：bash/write/edit 每次执行前都要用户确认（变更前确认）
 * - workspace-write：**工作区内的** write/edit 免确认，工作区之外（含别的项目）
 *   一律确认；bash 与配置类工具照常确认（改成工作区前缀外的路径要你点头）
 * - auto-edit：write/edit 全部放行（含工作区外），bash 仍确认（自动编辑）
 * - review：不问人，由模型逐次判风险（低放行、高风险拦截）；审查失败退回弹卡
 * - auto：全部自动放行（完全访问）
 *
 * workspace-write 的边界由 agent/workspace-boundary.ts 判定（软链接按真实落点算）。
 * 它管不住 bash——一条命令能写到任何地方，参数里看不出目标路径，所以 bash 在这一档
 * 仍然弹确认；要真正等价需要 OS 级沙箱。
 *
 * 字面量清单的单源在 pi-protocol 的 APPROVAL_LEVELS（协议、sidecar、桌面/移动端
 * 共读一份，见 docs/permission-modes.md）。
 */
export type { ApprovalLevel };

/** 计划审批状态机：inactive（agent 模式）↔ planning（plan 模式；执行确认挂起由 pendingToolApprovals 承担） */
export type PlanningState = "inactive" | "planning";
