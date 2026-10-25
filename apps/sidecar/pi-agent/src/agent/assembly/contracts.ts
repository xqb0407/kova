/**
 * 每轮装配层（capability assembly）的公共契约。
 *
 * 设计边界（clean-room）：这里只定义 kova 自己的装配语义——能力在安装窗口内
 * 声明贡献（工具 / 提示词片段 / 提醒 / 钩子），会话级与回合级分别装配。
 * 不引入外部项目的类型、命名或代码。
 */
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentMessage,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import type { ApprovalLevel, SessionMode } from "../../types";

/** 提示词事实只用到这三个字段（pi-ai 的 Model 结构兼容）。 */
export type CapabilityModelInfo = {
  provider: string;
  id: string;
  name?: string;
};

/** 会话级快照：工具与系统提示词后缀只依赖这些事实。 */
export interface SessionSnapshot {
  readonly sessionId: string;
  readonly threadId: string;
  readonly cwd: string;
  readonly mode: SessionMode;
  readonly appMode: string;
  readonly model: CapabilityModelInfo | null;
}

/** 回合级快照：用户提示词前缀与提醒只依赖这些事实。 */
export interface TurnSnapshot extends SessionSnapshot {
  readonly turnId: string;
  readonly messages: readonly AgentMessage[];
  readonly userText: string;
  readonly approvalLevel: ApprovalLevel;
}

/** 渲染后的提醒。宿主只负责注入，不再二次包装。 */
export interface Reminder {
  readonly text: string;
  /** 数值大的先注入；同值按能力注册顺序稳定排序。 */
  readonly priority?: number;
  /** 同 key 在单轮内只注入一次。 */
  readonly key?: string;
}

export interface TurnEndToolResult {
  readonly toolName: string;
  readonly isError: boolean;
  readonly text: string;
}

/** 回合收尾时提供给能力的宿主事实；能力不接触 agent 本体。 */
export interface TurnEndInfo {
  readonly stopRequested: boolean;
  readonly toolResults: readonly TurnEndToolResult[];
  /**
   * 把一条提醒排入"下一步"：只在循环确认继续时随下一次模型请求注入；
   * 本轮就是最后一轮时随轮末丢弃，绝不会留到下一次用户 prompt。
   */
  queueReminder(text: string): void;
}

export type ToolFactory = (
  snapshot: SessionSnapshot,
) => AgentTool | readonly AgentTool[] | null | undefined;

export type SystemTextContributor = (
  snapshot: SessionSnapshot,
) => string | null | undefined | Promise<string | null | undefined>;

export type UserTextContributor = (
  snapshot: TurnSnapshot,
) => string | null | undefined | Promise<string | null | undefined>;

export type ReminderContributor = (
  snapshot: TurnSnapshot,
) => Reminder | null | undefined | Promise<Reminder | null | undefined>;

export type ToolBeforeHandler = (
  context: BeforeToolCallContext,
  snapshot: TurnSnapshot,
) => BeforeToolCallResult | undefined | Promise<BeforeToolCallResult | undefined>;

export type ToolAfterHandler = (
  context: AfterToolCallContext,
  snapshot: TurnSnapshot,
) => AfterToolCallResult | undefined | Promise<AfterToolCallResult | undefined>;

export type TurnEndHandler = (
  info: TurnEndInfo,
  snapshot: TurnSnapshot,
) => void | Promise<void>;

export interface HookEntry<T> {
  readonly capabilityId: string;
  readonly order: number;
  readonly handler: T;
}

export interface AssemblyDiagnostics {
  readonly enabled: readonly string[];
  readonly disabled: readonly string[];
}

/** 会话级装配结果：工具表与系统提示词后缀。 */
export interface SessionPlan {
  readonly tools: AgentTool[];
  readonly systemSuffix: string;
  readonly diagnostics: AssemblyDiagnostics;
}

/** 回合级装配结果：用户提示词前缀、提醒与钩子快照。 */
export interface TurnPlan {
  readonly snapshot: TurnSnapshot;
  readonly userPrefix: string;
  readonly reminders: readonly Reminder[];
  readonly hooks: {
    readonly toolBefore: readonly HookEntry<ToolBeforeHandler>[];
    readonly toolAfter: readonly HookEntry<ToolAfterHandler>[];
    readonly turnEnd: readonly HookEntry<TurnEndHandler>[];
  };
  readonly diagnostics: AssemblyDiagnostics;
}

export interface CapabilityContributionStats {
  readonly tools: number;
  readonly systemTexts: number;
  readonly userTexts: number;
  readonly reminders: number;
  readonly toolBefore: number;
  readonly toolAfter: number;
  readonly turnEnd: number;
}

export interface CapabilityState {
  readonly id: string;
  readonly title?: string;
  readonly enabled: boolean;
  readonly contributions: CapabilityContributionStats;
}

/**
 * 能力在 init() 期间拿到的注册面。
 *
 * 约束：注册方法只能在 `install()` 执行期间调用；把 host 保存下来、
 * 在安装窗口之外补注册会直接抛错。`params` 是只读快照，随安装时的配置生成。
 */
export interface CapabilityHost {
  /**
   * 安装时的参数快照。需要跟随设置实时变化的参数请用
   * `readCapabilityParams(id)`（settings.ts），不要把这里当作实时视图。
   */
  readonly params: Readonly<Record<string, unknown>>;
  /**
   * 贡献工具。工具进入 baseTools，但仍受 `toolsForMode` 的模式白名单过滤：
   * ask/plan 等只读模式默认看不到能力工具，新增工具时需同步维护白名单。
   */
  tool(factory: ToolFactory): void;
  systemText(contributor: SystemTextContributor): void;
  /**
   * 回合级用户提示词前缀。注意：它会拼进真实用户消息里，用户在气泡中可见、
   * 随转录保存——需要"用户不可见"的系统提醒请用 reminder（收尾注入）。
   */
  userText(contributor: UserTextContributor): void;
  reminder(contributor: ReminderContributor): void;
  onToolBefore(handler: ToolBeforeHandler, order?: number): void;
  onToolAfter(handler: ToolAfterHandler, order?: number): void;
  onTurnEnd(handler: TurnEndHandler, order?: number): void;
}

export interface Capability {
  readonly id: string;
  readonly title?: string;
  /** 设置里没有显式开关时的默认值；缺省关闭。 */
  readonly defaultEnabled?: boolean;
  install(host: CapabilityHost): void | Promise<void>;
  /** 会话被驱逐/删除时清理按会话累积的内存状态；失败由注册表吞掉。 */
  disposeSession?(sessionId: string): void;
}
