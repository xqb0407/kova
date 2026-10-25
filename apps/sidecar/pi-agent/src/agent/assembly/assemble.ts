/**
 * 装配结果的消费辅助：提醒渲染、工具钩子链、回合收尾钩子。
 *
 * 钩子链原则：
 * - tool:before 是策略位，但单个能力抛错不能把工具链整体打崩——记日志后跳过。
 * - tool:after 支持部分覆盖（content/details/isError），按 order 依次 reduce，
 *   后一个能力看到前一个的结果。
 * - turn:end 是通知位，失败只记日志。
 */
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentMessage,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import { CAPABILITY_REMINDER_PREFIX } from "pi-protocol";
import { logErr } from "../../log";
import type { CapabilityRegistry } from "./registry";
import type {
  Reminder,
  SessionPlan,
  SessionSnapshot,
  TurnEndInfo,
  TurnPlan,
  TurnSnapshot,
} from "./contracts";

/** 把提醒渲染成模型可读的 system-reminder 块；空列表返回空串。 */
export function renderReminders(reminders: readonly Reminder[]): string {
  if (reminders.length === 0) return "";
  return reminders
    .map((reminder) => `<system-reminder>\n${reminder.text.trim()}\n</system-reminder>`)
    .join("\n\n");
}

/**
 * 能力收尾提醒转成下一条 user 消息。调用方只在 prepareNextTurnWithContext
 * （循环确认继续）里使用，最终轮排队的提醒由轮末清理丢弃。
 * 哨兵前缀与 auto-continue/goal-continue 同款：模型侧自解释，UI 各投影路径
 * （sidecar + 桌面/移动）按前缀隐藏，不渲染成用户气泡。
 */
export function reminderMessages(texts: readonly string[]): AgentMessage[] {
  return texts
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({
      role: "user" as const,
      content:
        `${CAPABILITY_REMINDER_PREFIX}` +
        `<system-reminder>\n${text}\n</system-reminder>`,
      timestamp: Date.now(),
    }));
}

/** 装配失败时的兜底计划：不贡献任何内容，保证主流程继续。 */
export function emptyTurnPlan(snapshot: TurnSnapshot): TurnPlan {
  return {
    snapshot,
    userPrefix: "",
    reminders: [],
    hooks: { toolBefore: [], toolAfter: [], turnEnd: [] },
    diagnostics: { enabled: [], disabled: [] },
  };
}

/**
 * 会话级装配的可用性兜底：能力写错（重复工具名、贡献函数抛错）不能让
 * 会话无法物化——退回种子工具表并记日志，诊断经 get_capabilities 可见。
 */
export async function assembleSessionOrFallback(
  registry: CapabilityRegistry,
  snapshot: SessionSnapshot,
  seedTools: readonly AgentTool[],
): Promise<SessionPlan> {
  try {
    return await registry.assembleSession(snapshot, seedTools);
  } catch (error) {
    logErr(
      "capabilities: session assembly failed; falling back to seed tools:",
      error,
    );
    return {
      tools: [...seedTools],
      systemSuffix: "",
      diagnostics: { enabled: [], disabled: [] },
    };
  }
}

export async function runToolBeforeHooks(
  plan: TurnPlan | undefined,
  context: BeforeToolCallContext,
): Promise<BeforeToolCallResult | undefined> {
  if (!plan || plan.hooks.toolBefore.length === 0) return undefined;
  for (const entry of plan.hooks.toolBefore) {
    try {
      const result = await entry.handler(context, plan.snapshot);
      if (result?.block) return result;
    } catch (error) {
      logErr(`capability:${entry.capabilityId}: tool:before failed:`, error);
    }
  }
  return undefined;
}

export async function runToolAfterHooks(
  plan: TurnPlan | undefined,
  context: AfterToolCallContext,
): Promise<AfterToolCallResult | undefined> {
  if (!plan || plan.hooks.toolAfter.length === 0) return undefined;

  let result = context.result;
  let isError = context.isError;
  const merged: AfterToolCallResult = {};
  let changed = false;

  for (const entry of plan.hooks.toolAfter) {
    try {
      const override = await entry.handler(
        { ...context, result, isError },
        plan.snapshot,
      );
      if (!override) continue;
      changed = true;
      if (override.content !== undefined) {
        result = { ...result, content: override.content };
      }
      if (override.details !== undefined) {
        result = { ...result, details: override.details };
      }
      if (override.isError !== undefined) {
        isError = override.isError;
      }
      Object.assign(merged, override);
    } catch (error) {
      logErr(`capability:${entry.capabilityId}: tool:after failed:`, error);
    }
  }

  return changed ? merged : undefined;
}

export async function runTurnEndHooks(
  plan: TurnPlan | undefined,
  info: TurnEndInfo,
): Promise<void> {
  if (!plan || plan.hooks.turnEnd.length === 0) return;
  for (const entry of plan.hooks.turnEnd) {
    try {
      await entry.handler(info, plan.snapshot);
    } catch (error) {
      logErr(`capability:${entry.capabilityId}: turn:end failed:`, error);
    }
  }
}
