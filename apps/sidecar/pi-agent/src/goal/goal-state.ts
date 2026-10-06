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

/**
 * 目标模式专属工具。三个都必须独占 tool call 批次。
 *
 * propose 也在这一组里，理由与另两个相同且更要紧：它界定的是「协商轮到此为止」——
 * 与同一批里的 read/bash 并行会让结算顺序与勘察结果脱节（模型可能先提交了标准、
 * 之后才读到真正该写进标准的那个文件）。
 */
export const GOAL_TOOL_NAMES = {
  propose: "goal_propose_criteria",
  complete: "goal_complete",
  blocked: "goal_blocked",
} as const;

export const GOAL_TOOL_NAME_LIST: readonly string[] = [
  GOAL_TOOL_NAMES.propose,
  GOAL_TOOL_NAMES.complete,
  GOAL_TOOL_NAMES.blocked,
];

export function isGoalToolName(name: string): boolean {
  return GOAL_TOOL_NAME_LIST.includes(name);
}

/* --------------------------------- 类型 --------------------------------- */

export type GoalStatus = "active" | "paused" | "blocked" | "complete";

/* ------------------------------ 验收标准契约 ------------------------------ */

/**
 * 一条验收标准。id 由**服务端**在提议时按序分配（c1/c2/…），不是模型给的——
 * 它是完成对账的唯一键：按文本匹配会被模型换个说法就判成「缺条目」，陷入无谓的
 * 拒绝循环；按位置匹配挡不住模型重排。id 是稳定集合，两个问题一起解决。
 */
export type Criterion = { id: string; text: string };

/** 提议序号 → 标准 id（唯一的分配点，回放与对账都靠它对齐） */
export function criterionId(index: number): string {
  return `c${index + 1}`;
}

/**
 * 验收标准契约的四态。
 *
 * 为什么不用「字段缺失 = 未协商」：那会让「用户跳过标准」与「还没开始协商」
 * 分不开——跳过之后立刻又被当成没协商、要求重新提议，模型永远出不来。
 *
 * 为什么状态挂在 acceptance 而不是 Goal.status：Goal.status 只回答「循环在不在
 * 跑」（active/paused/blocked/complete），协商阶段是这个问题之外的第三种情形。
 * 分开表达意味着迁移表、pauseGoalOnModeExit、resumeGoal、停滞检测全部零改动。
 */
export type Acceptance =
  /** 协商中：等模型提议，或用户驳回后带回 feedback 等重提 */
  | { status: "pending"; feedback?: string }
  /**
   * 已提议，等用户确认——此阶段循环不跑。
   *
   * feedback 会从 pending **带过来**：用户驳回并写了意见，模型改完重新提交时，
   * 那条意见正是用户复审这一版时最需要看到的（「我提的那点它真改了吗」）。
   * 提议时就丢掉的话，卡片上永远显示不出「上一版为什么被退回」。
   */
  | { status: "proposed"; items: Criterion[]; feedback?: string }
  /** 已确认，成为完成判定的契约（意见到此已经解决，不再携带） */
  | { status: "confirmed"; items: Criterion[]; confirmedAt: number }
  /** 用户跳过 / 老目标回放：不做对账，行为与引入本机制之前一致 */
  | { status: "skipped" };

export type AcceptanceStatus = Acceptance["status"];

/** 目标当前是否处于「验收标准已生效、完成时必须逐条对账」的阶段 */
export function hasConfirmedCriteria(acceptance: Acceptance | undefined): boolean {
  return acceptance?.status === "confirmed" && acceptance.items.length > 0;
}

/** 已生效的标准清单（其余状态一律空数组，调用方无需再判 status） */
export function confirmedCriteria(acceptance: Acceptance | undefined): Criterion[] {
  if (acceptance?.status !== "confirmed") return [];
  return acceptance.items;
}

/**
 * 协商阶段（提议前 / 驳回后）：循环在跑但要写类门控拦住，且只该提议标准。
 *
 * `undefined`（字段整个缺失）**不算**协商——它只有一个来源：引入本契约之前落盘的
 * 老目标。老目标必须保持原有行为（直接执行），否则升级后每一条在跑的历史目标都会
 * 突然停下要求补一套标准。回放路径上 normalizeLoadedGoal 已经把它补成 skipped，
 * 这里再兜一层是防绕过回放直接构造 Goal 的调用点。
 */
export function isNegotiating(acceptance: Acceptance | undefined): boolean {
  return acceptance?.status === "pending";
}

/**
 * 契约还没落定（协商中 / 已提议等用户确认）——**只读边界的判据**。
 *
 * 与 isNegotiating 的区别是 proposed：从「循环该不该续跑」看，proposed 是停着的
 * 第三种情形（isNegotiating 为 false）；但从「这一轮能不能改项目文件」看，
 * proposed 和 pending 完全一样——用户还没点头，动手就失去意义。
 *
 * 两者必须分开的理由见 goal-continuation 的协商分支：那里用 isNegotiating 是对的，
 * 拿这个谓词去判会把它误当成「还该继续协商」而无限续轮。
 */
export function isContractUnsettled(acceptance: Acceptance | undefined): boolean {
  return acceptance?.status === "pending" || acceptance?.status === "proposed";
}

export type Goal = {
  id: string;
  /** 用户设定/首次发送的目标原文 */
  objective: string;
  status: GoalStatus;
  /**
   * 验收标准契约。`undefined` 只可能来自老转录行（引入本字段之前的快照），
   * 回放时由 normalizeLoadedGoal 补成 skipped——目标内不再有「未定义」这一态。
   */
  acceptance?: Acceptance;
  /**
   * 连续「什么也没做」的协商轮数。只在协商轮跑完、模型既没提议标准、这一轮也
   * 没调用任何实质工具时 +1；勘察轮（读文件、跑只读命令）一律清零重来。
   * 数到上限就暂停目标——否则模型可以永远「只说不做」地空转到撞轮次上限。
   */
  negotiationTurns: number;
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
  /**
   * 完成时的逐条对账明细（契约生效的目标才有）。存下来是为了让产物文件与
   * 「已完成」的目标能回答「它到底拿什么证明做到了」。
   */
  completionAudit?: Array<{ id: string; text: string; met: boolean; evidence: string }>;
  /**
   * 这条目标是否真的动过手（调过任何非目标工具）。
   *
   * **只在内存里翻，不落盘**：它服务于 goal_complete 的「完成声明背后必须有动作」
   * 检查，而重启后目标一律降级 paused，重新跑起来时新的动作会把它翻回来。
   * 落盘会让每个工具调用都追加一行 goal_state，代价远大于收益。
   */
  workSeen?: boolean;
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
export const MAX_CRITERION_LENGTH = 500;
/** 一条目标的验收标准条数上限。再多就不是契约而是清单了，模型也逐条验不过来 */
export const MAX_CRITERIA = 8;
/**
 * 连续的**空转**协商轮上限（见 Goal.negotiationTurns）。
 *
 * 只数「这一轮什么也没做」的轮次，勘察轮不计——在仓库里读一圈正是提出可验证
 * 标准的前提，大仓库跑十几轮勘察很正常，把那些也数进去等于惩罚刨得深。
 * 阈值与 DEFAULT_MAX_STALL_TURNS 同值同义：连续三轮零动作就停。
 */
export const DEFAULT_MAX_NEGOTIATION_TURNS = 3;
/** 用户驳回意见的长度上限（进提示词，必须有界） */
export const MAX_GOAL_FEEDBACK_LENGTH = 1_000;

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
 *
 * 新目标一律从 pending 起步：第一轮是协商轮，只勘察 + 提议验收标准，不动文件。
 * 用户在建目标时已经能选「跳过标准」（走 skipCriteria），那条路径由 UI 在确认
 * 卡片上给，不在这里分支——目标本身不知道用户打算怎么回。
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
    acceptance: { status: "pending" },
    negotiationTurns: 0,
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

/* ---------------------------- 验收标准的迁移 ---------------------------- */

/**
 * 清洗模型提来的标准清单：逐条 trim、丢空串、按文本去重（大小写与空白归一后比较）、
 * 截断到条数与长度上限，再按序分配服务端 id。
 *
 * 去重按归一化文本而不是原样比较：模型重复提同一条（换个大小写或补个句号）并不
 * 罕见，留着会让对账要求两条几乎一样的条目，纯属自找麻烦。
 *
 * @returns 清洗后的清单；一条都不剩时返回空数组（调用方据此拒绝这次提议）
 */
export function normalizeCriteria(raw: unknown): Criterion[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const items: Criterion[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const text = entry.trim().slice(0, MAX_CRITERION_LENGTH);
    if (!text) continue;
    const key = text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ id: criterionId(items.length), text });
    if (items.length >= MAX_CRITERIA) break;
  }
  return items;
}

/** 模型提议验收标准：pending → proposed。已在其他态时返回 undefined（调用方拒掉） */
export function proposeCriteria(goal: Goal, raw: unknown): Goal | undefined {
  if (!isNegotiating(goal.acceptance)) return undefined;
  if (goal.status !== "active") return undefined;
  const items = normalizeCriteria(raw);
  if (items.length === 0) return undefined;
  // 驳回意见带过去（见 Acceptance.proposed 的说明）：用户复审新版时要能对上它
  const feedback =
    goal.acceptance?.status === "pending" ? goal.acceptance.feedback : undefined;
  return {
    ...goal,
    acceptance: { status: "proposed", items, ...(feedback ? { feedback } : {}) },
    updatedAt: Date.now(),
  };
}

/** 用户确认：proposed → confirmed（契约就此定型，之后的完成判定按它对账） */
export function confirmCriteria(goal: Goal): Goal | undefined {
  if (goal.acceptance?.status !== "proposed") return undefined;
  return {
    ...goal,
    acceptance: {
      status: "confirmed",
      items: goal.acceptance.items,
      confirmedAt: Date.now(),
    },
    updatedAt: Date.now(),
  };
}

/**
 * 用户驳回：proposed → pending 并带回意见，下一轮协商从这条意见重来。
 * 模型无从知道用户到底哪里不满意，把意见带进提示词是唯一的信息通道。
 */
export function rejectCriteria(goal: Goal, feedback: string | undefined): Goal | undefined {
  if (goal.acceptance?.status !== "proposed") return undefined;
  const trimmed = (feedback ?? "").trim().slice(0, MAX_GOAL_FEEDBACK_LENGTH);
  return {
    ...goal,
    acceptance: { status: "pending", ...(trimmed ? { feedback: trimmed } : {}) },
    // 驳回后重新计时：用户明确表了态，不该把上一轮的协商计数继续算在模型头上
    negotiationTurns: 0,
    updatedAt: Date.now(),
  };
}

/**
 * 用户跳过验收标准：直接进执行阶段，不做对账。
 *
 * 与「没协商过」必须区分得开——跳过的目标不该再被要求提议标准，也不该在完成时
 * 被硬门拦住（用户已经明确表示不想要这道门）。这就是 skipped 单独成态的理由。
 */
export function skipCriteria(goal: Goal): Goal | undefined {
  if (goal.status === "complete") return undefined;
  if (goal.acceptance?.status === "confirmed") return undefined;
  return { ...goal, acceptance: { status: "skipped" }, updatedAt: Date.now() };
}

/**
 * 用户改目标原文（常驻条上点目标文字改的就是它）。
 *
 * 这是**显式动作**，与「协商阶段那条补充需求的消息」是两回事：那条是往现有目标
 * 上加要求，这条是换掉目标本身。
 *
 * 契约失效规则——改掉的是「要达到什么」，而验收标准是「怎么算达到」，两者不能
 * 各说各话，所以按阶段分别处理：
 *  - proposed / confirmed：标准是按旧目标提的（甚至已经被确认过），一律作废退回
 *    pending 重谈。留着旧标准比没有更糟：模型会拿一套对不上目标的判据去收工
 *  - pending：本来就还没提，保持
 *  - skipped：用户明确说过不要标准这道门，不借这次改动把它装回去
 *
 * @returns 新目标；文本没变时原样返回（同一个对象，调用方据此跳过落盘）；
 *          目标已完成或文本非法时 undefined（调用方拒掉这次改动）
 */
export function setObjective(goal: Goal, raw: string): Goal | undefined {
  // 已完成的目标不接受改：它是收工记录，不是待办。要接着做就新设一个
  if (goal.status === "complete") return undefined;
  if (validateObjective(raw)) return undefined;
  const objective = raw.trim();
  // 文本一字未变：这次「改」没有发生，不该顺手把契约作废
  if (objective === goal.objective) return goal;
  const voided = goal.acceptance?.status === "proposed" || goal.acceptance?.status === "confirmed";
  return {
    ...goal,
    objective,
    acceptance: voided
      ? {
          status: "pending",
          // 作废必须说明原因：不说的话模型多半会把同一份标准原样再提一遍——
          // 它看见的只是一条「再提一次标准」的指令，而旧列表还躺在转录里
          // （文案进提示词的协商块与产物文件，不冒充用户原话）
          feedback:
            "The user edited the goal objective above. Any criteria you proposed earlier are void — " +
            "propose a fresh list for the new objective. Do not resubmit the old one.",
        }
      : goal.acceptance,
    updatedAt: Date.now(),
  };
}

/**
 * 空转协商轮 +1（与 turnCount 无关——那个是执行轮的账，协商轮照样走
 * settleGoalTurn，这里的计数只服务于「连续几轮只说不做就停」这一条）。
 *
 * 调用方负责判「这一轮是不是空转」：勘察轮不该调它，见 decideContinuation。
 */
export function countNegotiationTurn(goal: Goal): Goal {
  return { ...goal, negotiationTurns: goal.negotiationTurns + 1 };
}

/** 勘察轮结算：这一轮读了文件、跑了命令，协商预算直接清零重来（不是不计数，是归零） */
export function resetNegotiationProgress(goal: Goal): Goal {
  return goal.negotiationTurns === 0 ? goal : { ...goal, negotiationTurns: 0 };
}

/**
 * 用户在 proposed 阶段发了普通消息：这条消息是对标准的意见，不是接管目标。
 *
 * 与 pauseForUserInput 的分叉点很实际——用户看到待确认的清单，回一句「第 2 条
 * 不对」，那是在改契约，不是在叫停目标。按接管处理会把刚提交的标准连目标一起
 * 挂起，用户还得再点一次「继续」才能说下一句。
 */
export function acceptanceFeedback(goal: Goal, text: string): Goal | undefined {
  if (goal.acceptance?.status !== "proposed") return undefined;
  return rejectCriteria(goal, text);
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
    // 协商计数一并清零：用户点了继续/纠偏就是一次新的开始，上一轮的「连 N 轮
    // 没提议」不该继续算在模型头上
    negotiationTurns: 0,
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
  // 协商阶段先于 status 判定：此时目标确实是 active，但循环没在跑（turn_end 看到
  // proposed 就停轮等用户）。按 status 渲染会把「等你确认验收标准」写成
  // 「进行中 · 第 1 轮」——条上说一套、实际干另一套，正是这个条最该避免的
  if (goal.status !== "complete" && goal.acceptance?.status === "proposed") {
    return `待你确认验收标准 · ${tokenPart}`;
  }
  switch (goal.status) {
    case "complete":
      return "已完成";
    case "paused":
      return `已暂停 · ${turnPart} · ${tokenPart}`;
    case "blocked":
      return `受阻 · ${turnPart} · ${tokenPart}`;
    default:
      if (goal.acceptance?.status === "pending") {
        return `正在拟定验收标准 · ${tokenPart}`;
      }
      return `进行中 · ${turnPart} · ${tokenPart}`;
  }
}

/**
 * 从持久化行还原一条验收标准契约。
 *
 * 缺失或畸形一律回落 skipped 而不是 pending：老转录行（本字段之前落的）没有它，
 * 回落 pending 会让升级后每一条在跑的历史目标突然停下、要求补一套标准。
 * 畸形值同理——宁可少一道校验，也不能让一条撕裂的 JSON 把在跑的目标卡死。
 */
function normalizeAcceptance(raw: unknown): Acceptance {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { status: "skipped" };
  const a = raw as { status?: unknown; items?: unknown; feedback?: unknown; confirmedAt?: unknown };
  const feedback =
    typeof a.feedback === "string" && a.feedback.trim()
      ? a.feedback.slice(0, MAX_GOAL_FEEDBACK_LENGTH)
      : undefined;
  if (a.status === "pending") {
    return { status: "pending", ...(feedback ? { feedback } : {}) };
  }
  if (a.status === "skipped") return { status: "skipped" };
  if (a.status === "proposed" || a.status === "confirmed") {
    // 回放走的是原样清单：id 已经在提议时定死，不能再分配一次——重开会打乱
    // 对账键，正在跑的模型手里那个 id 就对不上了
    const items = restoreCriteria(a.items);
    // 提议/确认态却没有标准 = 撕裂行，退回 skipped（不把目标卡在等确认上）
    if (items.length === 0) return { status: "skipped" };
    if (a.status === "proposed") {
      return { status: "proposed", items, ...(feedback ? { feedback } : {}) };
    }
    return {
      status: "confirmed",
      items,
      confirmedAt: finite(a.confirmedAt, Date.now()),
    };
  }
  return { status: "skipped" };
}

/** 回放标准清单：只做形状收窄与 id 合法校，不重排、不去重（见 normalizeAcceptance） */
function restoreCriteria(raw: unknown): Criterion[] {
  if (!Array.isArray(raw)) return [];
  const items: Criterion[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const c = entry as { id?: unknown; text?: unknown };
    if (typeof c.id !== "string" || !/^c\d{1,3}$/u.test(c.id)) continue;
    if (typeof c.text !== "string" || !c.text.trim()) continue;
    items.push({ id: c.id, text: c.text });
    if (items.length >= MAX_CRITERIA) break;
  }
  return items;
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
    acceptance: normalizeAcceptance(g.acceptance),
    negotiationTurns: counter(g.negotiationTurns),
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