/**
 * goal 模式纯逻辑层（零 I/O、零依赖）：目标态、状态机迁移表、安全阀判定盘面。
 *
 * 分层理由同 todo/todo-state.ts——把状态机与副作用彻底分开，安全阀的判定顺序
 * 因此可以纯函数单测，不需要起 Agent、不碰磁盘。
 *
 * 状态机四态：
 *   active    自治循环中（每个 turn 边界判定是否再续一轮）
 *   paused    安全阀触发 / 用户输入接管 / 手动暂停——可 resume 回到 active
 *   blocked   模型主动报告死锁（需要外部动作才能推进），可 resume
 *   complete  终态
 *
 * 过期护栏：所有终结性迁移都必须带 expectedGoalId 比对（transitionGoal 内部做）。
 * 模型排队中的 tool_call 可能在用户换目标之后才落地，没有护栏就会让「旧目标的
 * 完成」把「新目标」标成完成——这是自治循环里唯一无法靠类型系统挡住的一类错。
 */
import { createHash, randomUUID } from "node:crypto";

/* ----------------------------- 为什么没有 token 预算 -----------------------------
 *
 * 早期版本有第四道安全阀：目标可带一个 token 预算，超限后转入 budget_limited
 * 并注入一条「只准调 goal_complete」的收尾轮。已整体删除，原因不是实现困难，
 * 而是这条阀从设计上就说不清：
 *
 *   1. 用户无法预判。一个「把测试跑通」的目标可能花 20k 也可能 2M，预算填多少
 *      都是猜。填小了目标被腰斩，填大了等于没设。
 *   2. 它按累计量截断，不看进度。同一目标跑到第 4 轮和第 24 轮花掉的 token
 *      可能一样多，预算并不知道该在哪停。
 *   3. 收尾轮本身要再烧一次模型请求去写完成说明，而此时用户已经看不到「还剩
 *      多少目标没做完」这个事实——它用一个模型自己判断的「完成」覆盖了预算。
 *
 * tokensUsed 因此降级为纯展示字段（常驻条上的一个计数），不参与任何停机判定。
 * 真正的停机由三条语义明确的阀承担：轮次上限（可预期）、无进展检测（同一盘面
 * 原地打转）、用户输入即接管（人随时能叫停）。想省配额的用户有轮次上限和随时
 * 打断；目标真的很贵时，正确反应是让人看见消耗并自己决定，而不是让程序在某个
 * 他没定的数字上自动刹车。
 * -------------------------------------------------------------------------------- */

/* --------------------------------- 工具名 --------------------------------- */

/** 目标模式专属工具。goal_complete / goal_blocked 均须独占 tool call 批次。 */
export const GOAL_TOOL_NAMES = {
  complete: "goal_complete",
  blocked: "goal_blocked",
} as const;

export const GOAL_TOOL_NAME_LIST: readonly string[] = [
  GOAL_TOOL_NAMES.complete,
  GOAL_TOOL_NAMES.blocked,
];

export function isGoalToolName(name: string): boolean {
  return GOAL_TOOL_NAME_LIST.includes(name);
}

/* --------------------------------- 类型 --------------------------------- */

export type GoalStatus = "active" | "paused" | "blocked" | "complete";

export type Goal = {
  id: string;
  /** 用户设定/首次发送的目标原文 */
  objective: string;
  status: GoalStatus;
  startedAt: number;
  updatedAt: number;
  /** 已结算的自动续跑轮数（轮次上限的计数口径；续跑注入本身不计，只在结算时 +1） */
  turnCount: number;
  /**
   * 这条目标烧掉的 token 累计（**单调递增**：轮边界把 run 上的增量折进来，只加不减）。
   * 计入主模型每一轮的用量与子代理的用量；目标暂停期间在别处花的、以及建目标之前
   * 花的都不算。只用于常驻条展示，不参与任何停机判定——见文件头「为什么没有 token 预算」。
   */
  tokensUsed: number;
  /** 上一轮 assistant 输出的归一化指纹，用于无进展检测 */
  lastOutputFingerprint?: string;
  /** 连续「零工具调用 + 输出与上轮相同」的轮数 */
  stallTurns: number;
  /**
   * 这条目标的自动续跑轮数上限（null = 不限）。
   *
   * 为什么挂在目标上而不是全局设置：该跑多少轮取决于任务本身——「补个 README」
   * 和「把整个鉴权重构完」差两个数量级，全局值注定对一半任务是错的。所以它随目标
   * 落盘、随目标回放，用户在常驻条上按当前这条任务调。
   */
  maxAutoTurns: number | null;
  /** paused / blocked 的说明，进 composer 常驻条 */
  pauseReason?: string;
  /** complete 时模型的完成说明 */
  completionSummary?: string;
};

/** 一次停机判定的入参：轮次上限来自目标自身，停滞阈值来自全局常量 */
export type GoalLimits = {
  /** 自动续跑轮数上限，null = 不限 */
  maxAutoTurns: number | null;
  /** 连续无进展轮数上限，null = 不检测 */
  maxStallTurns: number | null;
};

/**
 * 新建目标的默认轮次上限：300 轮而不是个位数。
 *
 * 一次「把重构做完」的目标跨几百轮很常见，25 这种量级只够跑个开场。轮次上限的
 * 职责不是省配额（那已经没有 token 额度在管），而是「别在没人看着的时候无限跑
 * 下去」——无进展检测负责抓原地打转，用户随时能打断，所以默认给一个宽松但有限的值。
 *
 * 这只是**默认值**：目标一旦建好就自带自己的上限（见 Goal.maxAutoTurns），用户在
 * 常驻条上按任务改，0 表示不限。
 */
export const DEFAULT_MAX_AUTO_TURNS = 300;

/** 用户在常驻条上可填的轮次区间（0 单独表示不限） */
export const GOAL_TURN_LIMIT_MIN = 1;
export const GOAL_TURN_LIMIT_MAX = 5_000;

/** 停滞阈值：不开放给用户调（理由见 goal-continuation.ts 顶部） */
export const DEFAULT_MAX_STALL_TURNS = 3;

/** 从目标盘面 + 全局常量组装一次判定用的安全阀参数 */
export function limitsFor(
  goal: Pick<Goal, "maxAutoTurns">,
  maxStallTurns: number | null = DEFAULT_MAX_STALL_TURNS,
): GoalLimits {
  return { maxAutoTurns: goal.maxAutoTurns, maxStallTurns };
}

/** 把一个来路不明的轮次上限规整成合法值；undefined/null/0 → 不限，脏值回落默认 */
export function normalizeTurnLimitValue(raw: unknown): number | null {
  if (raw === null || raw === 0) return null;
  if (raw === undefined) return DEFAULT_MAX_AUTO_TURNS;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MAX_AUTO_TURNS;
  const n = Math.round(raw);
  if (n < 0) return DEFAULT_MAX_AUTO_TURNS;
  return Math.min(GOAL_TURN_LIMIT_MAX, Math.max(GOAL_TURN_LIMIT_MIN, n));
}

export const MAX_GOAL_OBJECTIVE_LENGTH = 4_000;
export const MAX_GOAL_SUMMARY_LENGTH = 4_000;
export const MAX_GOAL_REASON_LENGTH = 1_000;
export const MAX_GOAL_ID_LENGTH = 128;

/* ------------------------------- 状态迁移表 ------------------------------- */

/** 同态迁移恒接受（no-op）。complete 是唯一不可离开的终态。 */
const VALID_TRANSITIONS: Record<GoalStatus, ReadonlySet<GoalStatus>> = {
  active: new Set(["active", "paused", "blocked", "complete"]),
  paused: new Set(["active", "paused", "blocked", "complete"]),
  blocked: new Set(["active", "paused", "blocked", "complete"]),
  complete: new Set(),
};

export function isTransitionValid(from: GoalStatus, to: GoalStatus): boolean {
  if (from === to) return true;
  return VALID_TRANSITIONS[from].has(to);
}

/** 目标是否还能被 resume 拉回 active（用于常驻条的按钮态） */
export function isResumableStatus(status: GoalStatus): boolean {
  return status === "paused" || status === "blocked";
}

/* -------------------------------- 生命周期 -------------------------------- */

/**
 * 建目标。maxAutoTurns 由调用方给（用户在常驻条上的预设），不传用默认 300；
 * 传 null 表示这条目标不限轮次。
 */
export function createGoal(
  objective: string,
  maxAutoTurns: number | null = DEFAULT_MAX_AUTO_TURNS,
): Goal {
  const now = Date.now();
  return {
    id: randomUUID(),
    objective: objective.trim(),
    status: "active",
    startedAt: now,
    updatedAt: now,
    turnCount: 0,
    tokensUsed: 0,
    stallTurns: 0,
    maxAutoTurns,
  };
}

/** 改这条目标的轮次上限（不动状态；调低到已跑轮数以下由调用方处理） */
export function setTurnLimit(goal: Goal, raw: unknown): Goal {
  return { ...goal, maxAutoTurns: normalizeTurnLimitValue(raw), updatedAt: Date.now() };
}

/**
 * 唯一迁移出口。expectedGoalId 不匹配返回 undefined（调用方当过期护栏拒掉），
 * 非法迁移同样返回 undefined——状态机不抛异常，过渡期被判无效的目标宁可不动。
 */
export function transitionGoal(
  goal: Goal,
  to: GoalStatus,
  opts: { expectedGoalId?: string; reason?: string; summary?: string } = {},
): Goal | undefined {
  if (opts.expectedGoalId !== undefined && opts.expectedGoalId !== goal.id) {
    return undefined;
  }
  if (!isTransitionValid(goal.status, to)) return undefined;
  const now = Date.now();
  return {
    ...goal,
    status: to,
    updatedAt: now,
    // 离开 active 时清掉指纹：resume 后第一轮不与暂停前的那轮比较
    ...(to === "active" ? {} : { lastOutputFingerprint: undefined }),
    ...(to === "complete"
      ? { completionSummary: opts.summary ?? goal.completionSummary }
      : {}),
    pauseReason:
      to === "paused" || to === "blocked"
        ? (opts.reason ?? goal.pauseReason)
        : to === "complete"
          ? undefined
          : goal.pauseReason,
  };
}

/** 一轮自动续跑结算：轮数 +1、用量按当前值落定、updatedAt 推进 */
export function settleGoalTurn(goal: Goal, tokensUsed: number): Goal {
  return {
    ...goal,
    turnCount: goal.turnCount + 1,
    tokensUsed: Math.max(0, tokensUsed),
    updatedAt: Date.now(),
  };
}

/**
 * 安全 epoch 重置：轮次与停滞计数清零、指纹丢弃。
 * 用户纠偏、手动 resume、模型被中断后调用——否则用户干预一次就白白吃掉
 * 半个轮次预算，「继续」的起点也不干净。
 */
export function resetSafetyEpoch(goal: Goal): Goal {
  return {
    ...goal,
    turnCount: 0,
    stallTurns: 0,
    lastOutputFingerprint: undefined,
    updatedAt: Date.now(),
  };
}

/* ------------------------------- 无进展检测 ------------------------------- */

/**
 * 归一化本轮 assistant 可见输出后取指纹。
 * 归一化的目的是让「重新措辞一遍同样的话」也能被判为同一轮输出——
 * 模型原地打转时几乎总会换标点或加一句铺垫，不归一化就永远判不出来。
 */
export function fingerprintAssistantOutput(text: string): string | undefined {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim();
  // 纯标点/空白说明这一轮没有任何实质输出，视为「没输出」而非「有输出」
  if (normalized === "" || /^[\p{P}\s]+$/u.test(normalized)) return undefined;
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/** 从 assistant 消息里抽出全部 text 块拼接（忽略 thinking 与 toolCall） */
export function visibleAssistantText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string } | null;
    if (b?.type !== "text" || typeof b.text !== "string") continue;
    parts.push(b.text);
  }
  return parts.join("\n");
}

/** 该轮 assistant 消息里是否出现过工具调用 */
export function hasToolCall(message: unknown): boolean {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) => (block as { type?: string } | null)?.type === "toolCall",
  );
}

/**
 * 该轮是否调过「目标工具之外」的工具——即真的干了活。
 *
 * 与 hasToolCall 的区别只在一种轮次上有意义：模型调 goal_complete / goal_blocked
 * 但被拒（过期护栏或「说没做完」的正则）。那种轮次里唯一的工具调用是目标工具，
 * 而它什么也没改变，模型拿到的是一句「重新试试」。把它算成进展会让停滞检测永远
 * 归零，模型可以靠反复用错 goal_id 空转到撞轮次上限。
 */
export function hasSubstantiveToolCall(message: unknown): boolean {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const b = block as { type?: string; name?: string } | null;
    return (
      b?.type === "toolCall" &&
      (typeof b.name !== "string" || !isGoalToolName(b.name))
    );
  });
}

/** 该轮 assistant 消息里是否点名了某个目标工具 */
export function hasGoalToolCall(message: unknown, names: readonly string[]): boolean {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const b = block as { type?: string; name?: string } | null;
    return b?.type === "toolCall" && typeof b.name === "string" && names.includes(b.name);
  });
}

/**
 * 推进停滞计数：本轮调过工具 = 一定在推进，直接清零；
 * 否则只有输出指纹与上轮**完全相同**才算又一轮原地打转。
 * 返回新盘面（不改动入参）。
 *
 * substantiveToolCallsOnly：把「只有目标工具调用」的轮次当成没调工具（理由见
 * hasSubstantiveToolCall）。目标循环的判定一律带这个开关。
 */
export function nextStallState(
  goal: Goal,
  message: unknown,
  opts: { substantiveToolCallsOnly?: boolean } = {},
): { stallTurns: number; lastOutputFingerprint?: string } {
  const progressed = opts.substantiveToolCallsOnly
    ? hasSubstantiveToolCall(message)
    : hasToolCall(message);
  if (progressed) {
    return { stallTurns: 0, lastOutputFingerprint: goal.lastOutputFingerprint };
  }
  const fingerprint = fingerprintAssistantOutput(visibleAssistantText(message));
  if (!fingerprint) return { stallTurns: 0 };
  const same = fingerprint === goal.lastOutputFingerprint;
  return {
    stallTurns: same ? goal.stallTurns + 1 : 1,
    lastOutputFingerprint: fingerprint,
  };
}

/* ------------------------------- 展示格式化 ------------------------------- */

export function formatTokenCount(value: number): string {
  if (value < 1_000) return `${value}`;
  if (value < 1_000_000) {
    const k = value / 1_000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  const m = value / 1_000_000;
  return `${Number.isInteger(m) ? m : m.toFixed(1)}m`;
}

/** composer 常驻条的一行摘要（模式行/提示文案按 status 挑） */
export function formatGoalStatus(goal: Goal, limits: GoalLimits = limitsFor(goal)): string {
  const turnPart =
    limits.maxAutoTurns === null
      ? `第 ${goal.turnCount + 1} 轮`
      : `第 ${goal.turnCount + 1}/${limits.maxAutoTurns} 轮`;
  const tokenPart = formatTokenCount(goal.tokensUsed);
  switch (goal.status) {
    case "complete":
      return "已完成";
    case "paused":
      return `已暂停 · ${turnPart} · ${tokenPart}`;
    case "blocked":
      return `受阻 · ${turnPart} · ${tokenPart}`;
    default:
      return `进行中 · ${turnPart} · ${tokenPart}`;
  }
}

/* ------------------------------ 快照卫生 ------------------------------ */

/**
 * 从持久化行还原目标：逐字段收窄，畸形值退回安全默认。
 * 历史 JSONL 行可能被撕裂（崩溃时最后一行半条），这里宁可丢掉整个目标
 * 也不能让一个 undefined 混进提示词或安全阀算术里。
 */
export function normalizeLoadedGoal(raw: unknown, now: number): Goal | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const g = raw as Partial<Goal>;
  if (typeof g.id !== "string" || !g.id) return undefined;
  if (typeof g.objective !== "string" || !g.objective.trim()) return undefined;
  if (
    g.status !== "active" &&
    g.status !== "paused" &&
    g.status !== "blocked" &&
    g.status !== "complete"
  ) {
    return undefined;
  }
  const fingerprint =
    typeof g.lastOutputFingerprint === "string" &&
    /^[a-f0-9]{64}$/u.test(g.lastOutputFingerprint)
      ? g.lastOutputFingerprint
      : undefined;
  return {
    id: g.id,
    objective: g.objective,
    status: g.status,
    startedAt: finite(g.startedAt, now),
    updatedAt: finite(g.updatedAt, now),
    turnCount: counter(g.turnCount),
    tokensUsed: finite(g.tokensUsed, 0),
    // 老行（这个字段进目标之前落的）没有 maxAutoTurns：按默认值补，不能补成
    // null——那会让一条历史目标突然变成「不限轮次」，反向放宽了安全阀
    maxAutoTurns: normalizeTurnLimitValue(g.maxAutoTurns),
    ...(fingerprint ? { lastOutputFingerprint: fingerprint } : {}),
    stallTurns: counter(g.stallTurns),
    ...(typeof g.pauseReason === "string" ? { pauseReason: g.pauseReason } : {}),
    ...(typeof g.completionSummary === "string"
      ? { completionSummary: g.completionSummary }
      : {}),
  };
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function counter(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

/** 目标文本的用户输入校验（工具与命令共用） */
export function validateObjective(raw: unknown): string | undefined {
  if (typeof raw !== "string") return "目标文本为空";
  const text = raw.trim();
  if (!text) return "目标文本为空";
  if (text.length > MAX_GOAL_OBJECTIVE_LENGTH) return "目标文本过长";
  return undefined;
}