/**
 * goal 模式的目标槽位 + 两个出口工具（形态仿 todo/todo.ts）：
 * - per-thread 槽位：会话隔离天然由 threadId 成立，线程键迁移时原样挪动
 * - 每次变更经 sendEventChunk 推 data-goal-state 全量快照实时刷新 composer
 *   常驻条；无活跃请求时静默丢弃，UI 靠 get_goal_state 水合兜底
 * - 每次变更同步追加 goal_state 行到 JSONL（appendGoalStateRow），重启后回放
 *
 * 两个工具都必须独占 tool call 批次（modes.ts 的 modeBeforeToolCall 拦）——
 * 它们是整轮自治循环的结算动作，与其他工具并行会排出「这轮调了别的工具、
 * 同一批又宣布完成」的顺序，结算结果与实际执行进度脱节。
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { sendEventChunk } from "../protocol/stream";
import { appendGoalStateRow, readGoalState } from "../sessions/transcript";
import { sessionPrefsSet } from "../storage/hostdb";
import { logAt } from "../log";
import { GOAL_CONTINUE_PREFIX, isGoalContinueText, type GoalState } from "pi-protocol";
import type { Running } from "../types";
import {
  DEFAULT_MAX_AUTO_TURNS,
  GOAL_TOOL_NAMES,
  GOAL_TURN_LIMIT_MAX,
  GOAL_TURN_LIMIT_MIN,
  MAX_CRITERIA,
  MAX_CRITERION_LENGTH,
  MAX_GOAL_ID_LENGTH,
  MAX_GOAL_REASON_LENGTH,
  MAX_GOAL_SUMMARY_LENGTH,
  acceptanceFeedback,
  confirmCriteria,
  confirmedCriteria,
  createGoal,
  formatGoalStatus,
  limitsFor,
  normalizeCriteria,
  normalizeTurnLimitValue,
  proposeCriteria,
  rejectCriteria,
  resetSafetyEpoch,
  setObjective,
  setTurnLimit,
  skipCriteria,
  transitionGoal,
  validateObjective,
  type Goal,
} from "./goal-state";
import { resumeGoal, pauseForUserInput, decideContinuation } from "./goal-continuation";
import { writeGoalArtifactAsync } from "./goal-artifact";

/** threadId -> 当前目标（per-thread 槽，对应 todo 的 todoStates） */
const goals = new Map<string, Goal>();

export function getGoal(threadId: string): Goal | undefined {
  return goals.get(threadId);
}

/**
 * 目标已累计的 token = 已结算的数 + 本次 run 里还没结算的增量。
 *
 * 现累而不是「会话累计 − 基线」：后者有三个毛病——把暂停期间在别的模式里花的
 * token 也算进来、看不见子代理的消耗（它的用量不进父转录）、而且每算一次就把整个
 * JSONL 读一遍（目标每跑一轮一次，O(n²)）。现累的增量没有这三个问题。
 */
export function goalTokensUsed(run: Pick<Running, "usagePending" | "threadId">): number {
  const goal = goals.get(run.threadId);
  return (goal?.tokensUsed ?? 0) + run.usagePending;
}

/** 结算一次目标账：把 run 上攒着的增量折进目标，并把累加器清零 */
function drainUsagePending(run: Running, goal: Goal): number {
  const total = goal.tokensUsed + run.usagePending;
  run.usagePending = 0;
  return total;
}

/** 会话销毁 / 线程销毁时回收槽位 */
export function clearGoal(threadId: string): void {
  goals.delete(threadId);
}

/**
 * 「这条目标动过手」台账：任何非目标工具被放行执行前翻一次。
 *
 * 幂等且**只改内存不落盘**（见 Goal.workSeen）：翻过一次就没必要再写，落盘的权威
 * 副本是 goal_state 行，而这个标记只在活着的这一轮里被读到。
 */
export function markGoalWorkSeen(run: Running): void {
  const goal = goals.get(run.threadId);
  if (!goal || goal.workSeen) return;
  goals.set(run.threadId, { ...goal, workSeen: true });
}

/** 线程键迁移（刷新后 run 改绑新 threadId）：槽位原样挪过去，目标不随改绑丢失 */
export function migrateGoal(oldThreadId: string, newThreadId: string): void {
  const goal = goals.get(oldThreadId);
  if (goal) goals.set(newThreadId, goal);
  goals.delete(oldThreadId);
}

/**
 * 从转录回放目标（resolveSession 恢复分支调用），对齐 replayTodoFromMessages 的时点。
 * token 账随目标行一起回来（它是单调累加值，不需要任何基线补偿）。
 */
export function restoreGoal(threadId: string, sessionId: string): void {
  const restored = readGoalState(sessionId);
  if (!restored) return;
  // 回放出来的 active 是个谎报：驱动循环的 run 随进程一起没了，重启后没有任何
  // 东西会调 continueGoalTurn。降级成 paused 并落一行，让「条上说在跑」不再出现
  //（也不自动续跑——重启后没人看着就自动开始烧钱不是好默认，交给用户点「继续」）
  const goal: Goal =
    restored.status === "active"
      ? {
          ...restored,
          status: "paused",
          pauseReason: "sidecar restarted while the goal was running",
          updatedAt: Date.now(),
        }
      : restored;
  goals.set(threadId, goal);
  if (goal !== restored) {
    try {
      appendGoalStateRow(sessionId, goal);
    } catch {
      // 落盘失败不阻断：内存里已经是 paused，下一次变更会再落一遍
    }
  }
}

/* ------------------------------ 变更出口 ------------------------------ */

/** 落盘 + 广播的唯一出口。任何一路失败都不影响内存状态。 */
export function commitGoal(run: Running, goal: Goal | undefined): void {
  const threadId = run.threadId;
  if (goal) {
    goals.set(threadId, goal);
  } else {
    goals.delete(threadId);
  }
  if (run.sessionId) {
    try {
      appendGoalStateRow(run.sessionId, goal ?? null);
    } catch {
      // 落盘失败不阻断（重启后这批目标态丢失，用户重新设一次即可）
    }
  }
  // 目标产物：契约有人读才有意义，所以每次变更都重写同一份文件。清除时**不动**
  // 文件——用户可能正开着它看上一轮为什么被驳回，删掉反而是数据丢失。下一份
  // 目标会重新定名（见 startGoal / syncGoalOnUserPrompt 的路径重置）
  if (goal && run.cwd) {
    writeGoalArtifactAsync(run.cwd, goal, run.goalFilePath, (path) => {
      run.goalFilePath = path;
    });
  }
  emitGoalState(run);
}

/** 推全量快照给常驻条（无活跃请求时 sendEventChunk 自行丢弃） */
export function emitGoalState(run: Running): void {
  sendEventChunk(
    run.threadId,
    { type: "data-goal-state", data: goalStatePayload(run.threadId) },
    run.sessionId,
  );
}

/** 协议投影：只带 UI 要用的字段（指纹、对账明细、工作台账等内部判据不进协议） */
export function goalStatePayload(threadId: string): GoalState {
  const goal = goals.get(threadId);
  if (!goal) return { goal: null };
  const limits = limitsFor(goal);
  const acceptance = goal.acceptance;
  // 驳回/退回意见：pending（等重提）与 proposed（重提后再审）两态都要给 UI——
  // 用户复审新版标准时最需要看到的就是「我提的那点它真改了吗」
  const feedback =
    acceptance?.status === "pending" || acceptance?.status === "proposed"
      ? acceptance.feedback
      : undefined;
  return {
    goal: {
      id: goal.id,
      objective: goal.objective,
      status: goal.status,
      statusLine: formatGoalStatus(goal, limits),
      turnCount: goal.turnCount,
      maxAutoTurns: limits.maxAutoTurns,
      tokensUsed: goal.tokensUsed,
      startedAt: goal.startedAt,
      updatedAt: goal.updatedAt,
      ...(goal.pauseReason === undefined ? {} : { pauseReason: goal.pauseReason }),
      ...(goal.completionSummary === undefined
        ? {}
        : { completionSummary: goal.completionSummary }),
      // 契约阶段必须投影：常驻条靠它决定待确认卡片出不出来、状态行写什么。
      // 漏了它整个验收标准特性在 UI 上就是不可见的（条上只会显示「进行中」，
      // 没有任何确认入口——而循环正停着等确认）
      ...(acceptance === undefined
        ? {}
        : {
            acceptance: {
              status: acceptance.status,
              ...(acceptance.status === "proposed" || acceptance.status === "confirmed"
                ? { items: acceptance.items }
                : {}),
              ...(feedback ? { feedback } : {}),
            },
          }),
    },
  };
}

/* ------------------------------ 对外操作 ------------------------------ */

/**
 * 设定目标（用户首条消息即目标；已有目标时整体替换——换目标就换一个，不是排队）。
 * rawMaxAutoTurns 是用户在常驻条上填的轮数上限（0/null = 不限），不传用默认。
 */
export function startGoal(
  run: Running,
  objective: string,
  rawMaxAutoTurns?: unknown,
): Goal {
  const invalid = validateObjective(objective);
  if (invalid) throw new Error(invalid);
  const explicit = rawMaxAutoTurns !== undefined && rawMaxAutoTurns !== null;
  // 同上：不能用 ?? —— null 是「明确不限」，不是缺省
  const preset = explicit
    ? normalizeTurnLimitValue(rawMaxAutoTurns)
    : run.goalMaxTurns === undefined
      ? DEFAULT_MAX_AUTO_TURNS
      : run.goalMaxTurns;
  const goal = createGoal(objective, preset);
  // 建目标之前同一 run 里已经花掉的（比如用户先聊了两句才切到目标档）：不算这条目标的
  run.usagePending = 0;
  // 换目标就换一份新产物：路径重置，commitGoal 会按新标题重新定名
  run.goalFilePath = undefined;
  commitGoal(run, goal);
  return goal;
}

/**
 * 用户/安全阀触发的恢复。
 *
 * 只把状态搬回 active 是不够的——循环的唯一驱动源是「有 run 在飞 + turn_end」，
 * 而 paused 意味着那个 run 早就结束了。所以调用方（goal_resume handler）必须在
 * 空闲时补起一轮，见 kickGoalLoop 的说明。这里不直接起轮：goal.ts 不持有协议层
 * 的请求上下文，起轮要带 reqId / sessionId / cwd，属于 handler 的职责。
 */
export function resume(run: Running): Goal | undefined {
  const goal = goals.get(run.threadId);
  if (!goal) return undefined;
  const next = resumeGoal(goal);
  commitGoal(run, next);
  return next;
}

/**
 * 改目标原文（常驻条上点目标文字改的就是它）。
 *
 * 三件副作用都是有意为之：
 * - 安全 epoch 清零：换了要达到的东西，旧目标上攒的轮次与停滞计数没有参考价值，
 *   换来的是新目标一开始就背着旧预算（与用户纠偏、手动 resume 同一处理）
 * - 产物路径重置：文件名按旧标题定的，新目标该有自己的那份契约文件；旧文件留在
 *   盘上作为记录，不删（用户可能正开着它对比）
 * - 契约可能作废：规则见 goal-state 的 setObjective
 */
export function setGoalObjective(run: Running, raw: string): Goal | undefined {
  const goal = goals.get(run.threadId);
  if (!goal) return undefined;
  const next = setObjective(goal, raw);
  if (!next) return undefined;
  // 文本一字未变：原样返回，连落盘都省掉（一次无意义的 goal_state 行）
  if (next === goal) return goal;
  run.goalFilePath = undefined;
  const settled = resetSafetyEpoch(next);
  commitGoal(run, settled);
  return settled;
}

/**
 * 用户确认验收标准（常驻条待确认卡片）：proposed → confirmed。
 *
 * 只改契约、不起轮：起轮由 handler 的 kickGoalLoop 负责（与 resume 同一分工，
 * goal.ts 不持有协议层的请求上下文）。
 */
export function confirmGoalCriteria(run: Running): Goal | undefined {
  const goal = goals.get(run.threadId);
  if (!goal) return undefined;
  const next = confirmCriteria(goal);
  if (!next) return undefined;
  commitGoal(run, next);
  return next;
}

/** 用户驳回验收标准：proposed → pending 并带回意见，下一轮协商据此重来 */
export function rejectGoalCriteria(run: Running, feedback?: string): Goal | undefined {
  const goal = goals.get(run.threadId);
  if (!goal) return undefined;
  const next = rejectCriteria(goal, feedback);
  if (!next) return undefined;
  commitGoal(run, next);
  return next;
}

/** 用户跳过验收标准：直接进执行阶段，完成时不做对账 */
export function skipGoalCriteria(run: Running): Goal | undefined {
  const goal = goals.get(run.threadId);
  if (!goal) return undefined;
  const next = skipCriteria(goal);
  if (!next) return undefined;
  commitGoal(run, next);
  return next;
}

/**
 * 会话偏好列（文本）→ 这条会话的轮数预设。三态分得开，见 Running.goalMaxTurns：
 * NULL / 脏值 = 从未定过（undefined），"0" = 不限（null），其余 = 具体轮数。
 */
export function parseGoalMaxTurnsPref(
  raw: string | null | undefined,
): number | null | undefined {
  if (raw === null || raw === undefined || raw.trim() === "") return undefined;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return undefined;
  return n === 0 ? null : Math.min(GOAL_TURN_LIMIT_MAX, Math.max(GOAL_TURN_LIMIT_MIN, n));
}

/** 轮数预设 → 会话偏好列（"0" = 不限）。null（不限）与 undefined（从没定过）编码不同 */
function encodeGoalMaxTurnsPref(value: number | null | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value === null ? "0" : String(value);
}

/**
 * 把这次定的上限记到会话偏好上（下一条目标从它开始，不用每次重新估）。
 *
 * 只改内存 + 落库，不等回执：这是「顺手记住」而不是一次事务，失败也只是下一条
 * 目标回到默认 300，不值得让改上限这个动作失败。
 */
function rememberGoalMaxTurns(run: Running, value: number | null): void {
  run.goalMaxTurns = value;
  const encoded = encodeGoalMaxTurnsPref(value);
  if (encoded === undefined || !run.sessionId) return;
  void sessionPrefsSet(run.sessionId, { goalMaxTurns: encoded }).catch(() => {});
}

/**
 * 离开 goal 档时收尾（applyMode 调用）：active 目标转 paused。
 *
 * 不这么做的话目标会永远卡在 active：循环的驱动点是 turn_end 里的 continueGoalTurn，
 * 而它被 run.mode === "goal" 门住——切走之后既没人续跑，也没有任何代码会去停机它。
 * paused 的语义正好（等人：等用户切回 goal 档点「继续」），刻意不删目标，
 * 切回来还能接着做。
 */
export function pauseGoalOnModeExit(run: Running): void {
  const goal = goals.get(run.threadId);
  if (!goal || goal.status !== "active") return;
  const paused = transitionGoal(goal, "paused", {
    expectedGoalId: goal.id,
    reason: "user left goal mode while the goal was running",
  });
  if (paused) commitGoal(run, paused);
}

/**
 * 改这条目标的轮次上限（常驻条上点分母改的就是它）。
 *
 * 调低到「已经跑过的轮数」以下时顺手暂停：不暂停就会出现「上限 50、当前已跑
 * 120 轮还在跑」这种自相矛盾的状态，而轮次判定只在轮边界做一次，会一直排不上。
 */
export function setGoalMaxTurns(run: Running, raw: unknown): Goal | undefined {
  const goal = goals.get(run.threadId);
  if (!goal) return undefined;
  let next = setTurnLimit(goal, raw);
  rememberGoalMaxTurns(run, next.maxAutoTurns);
  if (
    next.maxAutoTurns !== null &&
    next.status === "active" &&
    next.turnCount >= next.maxAutoTurns
  ) {
    next =
      transitionGoal(next, "paused", {
        expectedGoalId: next.id,
        reason: `automatic turn limit lowered to ${next.maxAutoTurns} (already at ${next.turnCount})`,
      }) ?? next;
  }
  commitGoal(run, next);
  return next;
}

/**
 * 一个 turn 收尾时的目标续跑（stream.ts 的 turn_end 分支调用，goal 档专用）。
 *
 * 判定全部委托给纯函数 decideContinuation，这里只负责把它算出的新盘面落盘 +
 * 广播，并把续跑消息塞进 followUp 队列——时序契约（turn_end 监听
 * settle 之后、vendor 循环退出之前恰好轮询一次该队列）与长度截断续跑共用同一条。
 *
 * 结算与注入分离是刻意的：注入本身不计轮次，只有 turn_end 走到这里才 +1。
 * 上下文溢出时 dispatchPrompt 会用同一条文本重跑那一轮，若注入时就计数，
 * 重跑会让轮次凭空多算一格。
 */
export function continueGoalTurn(run: Running, assistantMessage: unknown): void {
  const goal = goals.get(run.threadId);
  if (!goal) return;
  const limits = limitsFor(goal);
  const decision = decideContinuation(
    goal,
    assistantMessage,
    drainUsagePending(run, goal),
    limits,
  );
  commitGoal(run, decision.goal);
  if (decision.action === "stop") {
    if (decision.reason) logAt("event", `goal loop stopped: ${decision.reason}`);
    return;
  }
  logAt(
    "event",
    `goal loop ${decision.action}: turn ${decision.goal.turnCount} (${decision.goal.status})`,
  );
  run.agent.followUp(decision.message);
}

/**
 * 用户消息进 run 时的目标同步（dispatchPrompt 每轮开跑前调用）。
 *
 * 两个分支合在这里，因为它们判的是同一件事——「这条用户消息和现有目标是什么关系」：
 * - goal 档且没有目标 → 这条消息**就是**目标。这让「切到 goal 档 + 说一句话」成为
 *   唯一的建目标入口，用户不需要学一条 /goal 命令。目标原文必须是用户亲手打的
 *   那段 msg.text，不能是拼了附件提示行的 promptText（那会让拒绝的附件变成目标的一部分）。
 * - goal 档且有 active 目标 → 用户输入接管：暂停 + 清零安全 epoch。
 *
 * 非 goal 档一律不动目标：agent 档里那句「顺便把这个做完」不该复活一个
 * 已经停掉的目标——paused 的语义是「等人」，只有在 goal 档里等人才是人。
 * 目标本身也不删，切回 goal 档仍能看到「上次的目标（已暂停）」。
 *
 * @param rawText 用户原话（未拼接附件提示行）
 * @param rawMaxAutoTurns 用户建这条目标时在常驻条上填的轮数上限（仅新建时生效）
 */
export function syncGoalOnUserPrompt(
  run: Running,
  rawText: string,
  rawMaxAutoTurns?: unknown,
): void {
  if (run.mode !== "goal") return;
  // 我们自己注入的续跑消息也是 user 角色、也走这条路（见 goal-continue 的起轮）。
  // 不在这里短路的话，「点继续 → 起一轮」会被下一行判成「用户接管」，刚 resume
  // 就被自己暂停——循环一步都跑不动
  if (isGoalContinueText(rawText)) return;
  const current = goals.get(run.threadId);
  if (!current) {
    const objective = rawText.trim();
    // 空白消息（纯附件/提示行）建不出目标：跳过，让这一轮按普通请求跑，
    // 不让一条空目标把常驻条卡在「进行中」上
    if (validateObjective(objective)) return;
    // 取值顺序：本次请求显式带的值 → 本会话上次定过的 → 默认 300。
    // 注意 null 在协议里只能是「没带」（Tauri 侧 Option 缺失会序列化成 null），
    // 所以它并按「没带」处理；真正的「不限」在这条链路上表现为数字 0
    const explicit = rawMaxAutoTurns !== undefined && rawMaxAutoTurns !== null;
    // 注意不能用 ??：goalMaxTurns 的三态里 null 是「明确不限」，?? 会把它当成缺省
    const preset = explicit
      ? normalizeTurnLimitValue(rawMaxAutoTurns)
      : run.goalMaxTurns === undefined
        ? DEFAULT_MAX_AUTO_TURNS
        : run.goalMaxTurns;
    // 用户在这次建目标时明确填过 → 记进会话偏好，这个会话的下一条目标就不用再填
    if (explicit) rememberGoalMaxTurns(run, preset);
    // 同一 run 里建目标之前已花的不算这条目标的（见 startGoal 同款说明）
    run.usagePending = 0;
    run.goalFilePath = undefined;
    commitGoal(run, createGoal(objective, preset));
    return;
  }
  // 目标标准还没定下来时，用户这条消息是**对标准的意见**，不是接管目标。
  // 分叉点很实际：用户看着待确认的清单回一句「第 2 条不对」，那是在改契约；
  // 按接管处理会把刚提交的标准连目标一起挂起，用户还得再点一次「继续」
  if (current.acceptance?.status === "proposed") {
    const revised = acceptanceFeedback(current, rawText);
    if (revised) commitGoal(run, revised);
    return;
  }
  // 还在协商（标准都没提出来）：用户插话是**补充需求**，同样不是接管。
  // 模型此刻本来就在读工作区、还没动手，「顺便把 X 也算上」是这一步的常态；
  // 按接管处理会把目标暂停，用户得先点「继续」才能让协商接着走——而那条消息
  // 本身已经进了对话，模型下一轮照样读得到，暂停只是白白多一次点击。
  // 安全 epoch 照清零：用户给了新输入，协商预算与停滞计数该重新起算
  if (current.status === "active" && current.acceptance?.status === "pending") {
    commitGoal(run, resetSafetyEpoch(current));
    return;
  }
  if (current.status !== "active") return;
  const paused = pauseForUserInput(current);
  if (paused !== current) commitGoal(run, paused);
}

/* -------------------------------- 工具 -------------------------------- */

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

/** 过期护栏的统一文案（回给模型的，不是给用户看的） */
function staleRejection(requestedId: unknown, current?: Goal): string {
  const id = typeof requestedId === "string" ? requestedId.trim() : "";
  if (!current) return "goal_complete rejected: there is no active goal.";
  if (!id) return "goal_complete rejected: goal_id is required.";
  if (id !== current.id) {
    return (
      "goal_complete rejected: this goal_id is from an older, replaced or cleared goal. " +
      "The current goal is: " +
      current.objective +
      ". Call goal_complete with the current goal_id if that goal is done."
    );
  }
  return "";
}

/** 说"没做完"的完成摘要不该被接受为完成——正则粗筛，只做兜底不做主力 */
const INCOMPLETE_CLAIM_PATTERNS: readonly RegExp[] = [
  /(?<!could\s)\bnot\s+(?:yet\s+)?(?:complete|completed|done|finished)\b/i,
  /\bstill\s+(?:incomplete|failing|fails?)\b/i,
  /\bremaining\s+work\b/i,
];

/**
 * 把模型交的对账表收窄成安全形状。id 必须是服务端发的 c<N>，evidence 必填。
 * 这里只做形状校验，集合是否完整由 auditAgainstCriteria 判。
 */
function normalizeAudit(
  raw: unknown,
): Array<{ id: string; met: boolean; evidence: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rows: Array<{ id: string; met: boolean; evidence: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return undefined;
    const r = entry as { id?: unknown; met?: unknown; evidence?: unknown };
    if (typeof r.id !== "string") return undefined;
    if (typeof r.met !== "boolean") return undefined;
    const evidence = typeof r.evidence === "string" ? r.evidence.trim() : "";
    if (!evidence) return undefined;
    rows.push({ id: r.id.trim(), met: r.met, evidence: evidence.slice(0, MAX_GOAL_SUMMARY_LENGTH) });
  }
  return rows;
}

/**
 * 逐条对账：模型的表必须与已确认的标准**集合相等**——缺条目、多条目、id 不认识
 * 都算不合格。
 *
 * 为什么按 id 而不是按文本：模型换个说法（哪怕只是补个句号）就会被判成缺条目，
 * 它会反复重试同一份内容而永远过不了。id 是服务端发的稳定键，模型只需原样回传。
 * 报告里展示的标准原文也一律取服务端那份，不采信模型复述。
 */
function auditAgainstCriteria(
  criteria: readonly { id: string; text: string }[],
  rows: Array<{ id: string; met: boolean; evidence: string }> | undefined,
): { ok: true; rows: Array<{ id: string; text: string; met: boolean; evidence: string }> } | { ok: false; reason: string } {
  const want = new Set(criteria.map((c) => c.id));
  if (!rows) {
    return {
      ok: false,
      reason:
        "results is required and must be an array of { id, met, evidence } — one entry per acceptance criterion. " +
        `The criteria are: ${criteria.map((c) => `${c.id} (${c.text})`).join("; ")}.`,
    };
  }
  const seen = new Set<string>();
  for (const row of rows) {
    if (!want.has(row.id)) {
      return {
        ok: false,
        reason: `results contains unknown criterion id "${row.id}". Use exactly the ids shown in the goal block: ${[...want].join(", ")}.`,
      };
    }
    if (seen.has(row.id)) {
      return { ok: false, reason: `results lists criterion ${row.id} more than once.` };
    }
    seen.add(row.id);
  }
  const missing = criteria.filter((c) => !seen.has(c.id));
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `results is missing ${missing.length} of ${criteria.length} acceptance criteria: ` +
        `${missing.map((c) => `${c.id} (${c.text})`).join("; ")}. ` +
        "Every criterion needs a verdict with the evidence that proves it — go verify the missing ones and call again.",
    };
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    ok: true,
    rows: criteria.map((c) => ({
      id: c.id,
      text: c.text,
      met: byId.get(c.id)!.met,
      evidence: byId.get(c.id)!.evidence,
    })),
  };
}

/**
 * goal 模式工具（只挂 goal 档，见 modes.ts toolsForMode）。
 * 构建时捕获 run 引用（与 plan 三件套同一路子）。
 *
 * 按协商阶段给不同的一组：协商轮只有 propose，等确认时一个都不给（循环本就停着），
 * 契约生效或跳过之后才给 complete / blocked。工具表本身就是「这一轮能做什么」的
 * 第一道边界，把不该出现的工具留在表里只会诱使模型去调它。
 */
export function buildGoalTools(run: Running): AgentTool[] {
  const goal = goals.get(run.threadId);
  const acceptance = goal?.acceptance;
  if (!goal) return [];

  if (acceptance?.status === "pending" || acceptance === undefined) {
    return [buildProposeTool(run)];
  }
  if (acceptance.status === "proposed") return [];
  return [buildCompleteTool(run), buildBlockedTool(run)];
}

/**
 * 协商轮的唯一出口：提出验收标准。
 *
 * 不挂起等待用户（不同于 plan_exit）：提交即改状态，本轮终止，由 UI 上的确认卡片
 * 决定下一步。这样不占用挂起交互台账，而且重启后卡片能从 goal_state 行重建——
 * 挂起式 promise 随进程消亡，恢复要靠另一套台账，不值。
 */
function buildProposeTool(run: Running): AgentTool {
  return {
    name: GOAL_TOOL_NAMES.propose,
    label: "Propose Acceptance Criteria",
    description:
      "Propose the acceptance criteria for the goal you are negotiating. Each criterion must be " +
      "objectively checkable by you later — a command that must pass, an observable behaviour, a " +
      "file that must exist. Do not propose implementation steps; those are yours to decide. " +
      "Must be the only tool call in your message.",
    parameters: Type.Object({
      criteria: Type.Array(
        Type.String({
          description:
            "One acceptance criterion, phrased as a result that can be verified after the work is done.",
          maxLength: MAX_CRITERION_LENGTH,
        }),
        {
          minItems: 1,
          maxItems: MAX_CRITERIA,
          description: "The complete list of acceptance criteria, in the order you will verify them.",
        },
      ),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const current = goals.get(run.threadId);
      if (!current) return textResult("goal_propose_criteria rejected: there is no active goal.");
      const proposed = proposeCriteria(current, params.criteria);
      if (!proposed) {
        const items = normalizeCriteria(params.criteria);
        if (items.length === 0) {
          return textResult(
            "goal_propose_criteria rejected: criteria must be a non-empty list of non-empty strings.",
          );
        }
        return textResult(
          "goal_propose_criteria rejected: the acceptance criteria are already settled for this goal.",
        );
      }
      commitGoal(run, proposed);
      const a = proposed.acceptance as { items: { id: string; text: string }[] };
      return textResult(
        [
          `${a.items.length} acceptance criteria submitted for user confirmation.`,
          ...a.items.map((c) => `- ${c.id}: ${c.text}`),
          "",
          "Stop here. Do not start implementing — the user has to confirm the contract first.",
        ].join("\n"),
        { criteria: a.items },
      );
    },
  } as unknown as AgentTool;
}

/** 完成后收尾：契约生效时逐条对账，通过才转终态 */
function buildCompleteTool(run: Running): AgentTool {
  return {
    name: GOAL_TOOL_NAMES.complete,
    label: "Goal Complete",
    description:
      "Mark the goal as finished. Only call this after every requirement in the objective is " +
      "implemented and verified against real evidence — a passing subset, a plan for the rest, " +
      "or progress you would describe in a status update does not count. " +
      "When the goal has confirmed acceptance criteria you must pass one result per criterion " +
      "(same ids as the goal block), each with the evidence you observed. " +
      "Must be the only tool call in your message.",
    parameters: Type.Object({
      goal_id: Type.String({
        description:
          "The exact goal id shown in the active goal block. Guards against completing a goal " +
          "that has since been replaced or cleared.",
        maxLength: MAX_GOAL_ID_LENGTH,
      }),
      summary: Type.String({
        description:
          "What was completed and what evidence verifies it. Do not use this tool to report " +
          "partial progress, blockers, failures, or remaining work.",
        maxLength: MAX_GOAL_SUMMARY_LENGTH,
      }),
      results: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String({
              description: "Criterion id exactly as shown in the goal block (c1, c2, …).",
            }),
            met: Type.Boolean({ description: "Whether this criterion is met right now." }),
            evidence: Type.String({
              description:
                "The concrete evidence you observed: command output, file state, observed behaviour.",
              maxLength: MAX_GOAL_SUMMARY_LENGTH,
            }),
          }),
          {
            description:
              "One entry per confirmed acceptance criterion. Required when the goal has acceptance criteria.",
          },
        ),
      ),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const requestedId = params.goal_id;
      const current = goals.get(run.threadId);
      const stale = staleRejection(requestedId, current);
      if (stale) return textResult(stale, { goal_id: requestedId ?? null });

      const summary = typeof params.summary === "string" ? params.summary.trim() : "";
      if (!summary) {
        return textResult("goal_complete rejected: summary is required.", {
          goal_id: requestedId,
        });
      }

      // 契约对账：目标带已确认标准时，完成声明必须逐条被验证过
      const criteria = confirmedCriteria(current!.acceptance);
      let audit: Array<{ id: string; text: string; met: boolean; evidence: string }> | undefined;
      if (criteria.length > 0) {
        // 先校形状/完整性再校「有没有干活」：残缺的对账表是更具体的诊断，
        // 先回给模型它就知道该补哪几条，而不是笼统地被告知去干活
        const checked = auditAgainstCriteria(criteria, normalizeAudit(params.results));
        if (!checked.ok) {
          return textResult(`goal_complete rejected: ${checked.reason}`, {
            goal_id: requestedId,
          });
        }
        // 完成声明背后必须有动作。这条挡的是「模型纯靠总结宣布完成」：整条目标
        // 从头到尾没调过任何非目标工具，就没有任何可验证的进展可言——哪怕它
        // 交上来一份格式完美、证据全是编的对账表
        if (!current!.workSeen) {
          return textResult(
            "goal_complete rejected: no tool has been used to work on this goal yet, so there is " +
              "nothing that could verify any criterion. Do the work first.",
            { goal_id: requestedId },
          );
        }
        audit = checked.rows;
        const unmet = audit.filter((r) => !r.met);
        if (unmet.length > 0) {
          // 不转 complete：还有标准没达到，目标就该继续跑。把缺口原样回给模型，
          // 它接着这条继续干——这正是自治循环该有的反应
          return textResult(
            [
              `goal_complete rejected: ${unmet.length} of ${criteria.length} acceptance criteria are not met.`,
              ...unmet.map((r) => `- ${r.id} (${r.text}): ${r.evidence}`),
              "",
              "Keep working on the unmet criteria, then call goal_complete again once every one of them is verified.",
            ].join("\n"),
            { goal_id: requestedId, unmet: unmet.map((r) => r.id) },
          );
        }
      }

      if (INCOMPLETE_CLAIM_PATTERNS.some((p) => p.test(summary))) {
        return textResult(
          "goal_complete rejected: the summary says the work is not complete. " +
            "Either finish it and call again, or call goal_blocked if you are genuinely stuck.",
          { goal_id: requestedId },
        );
      }
      const done = transitionGoal(current!, "complete", {
        expectedGoalId: String(requestedId),
        summary,
      });
      if (!done) return textResult(staleRejection(requestedId, current), { goal_id: requestedId });
      commitGoal(run, audit ? { ...done, completionAudit: audit } : done);
      return textResult(`Goal complete: ${summary}`, {
        goal: done.objective,
        summary,
        ...(audit ? { audit } : {}),
      });
    },
  } as unknown as AgentTool;
}

function buildBlockedTool(run: Running): AgentTool {
  return {
    name: GOAL_TOOL_NAMES.blocked,
    label: "Goal Blocked",
    description:
      "Stop the goal at a true impasse. Use this only when the same blocker has survived at " +
      "least three separate turns and you have concrete evidence that the user or an external " +
      "party must act. Do not use it for ordinary uncertainty, incomplete work, slow progress, " +
      "or a recoverable tool failure. Must be the only tool call in your message.",
    parameters: Type.Object({
      goal_id: Type.String({
        description: "The exact goal id shown in the active goal block.",
        maxLength: MAX_GOAL_ID_LENGTH,
      }),
      reason: Type.String({
        description: "The specific user or external action needed to unblock the goal.",
        maxLength: MAX_GOAL_REASON_LENGTH,
      }),
      evidence: Type.String({
        description:
          "Concrete evidence from the repeated attempts — what was tried, what happened. " +
          "This is what makes it an impasse rather than a hard task.",
        maxLength: MAX_GOAL_SUMMARY_LENGTH,
      }),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const requestedId = params.goal_id;
      const current = goals.get(run.threadId);
      const stale = staleRejection(requestedId, current);
      if (stale) return textResult(stale, { goal_id: requestedId ?? null });

      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      const evidence = typeof params.evidence === "string" ? params.evidence.trim() : "";
      if (!reason) {
        return textResult("goal_blocked rejected: reason is required.", {
          goal_id: requestedId,
        });
      }
      if (!evidence) {
        return textResult(
          "goal_blocked rejected: evidence is required — name what you tried and what happened.",
          { goal_id: requestedId },
        );
      }
      const blocked = transitionGoal(current!, "blocked", {
        expectedGoalId: String(requestedId),
        reason,
      });
      if (!blocked) return textResult(staleRejection(requestedId, current), { goal_id: requestedId });
      commitGoal(run, blocked);
      return textResult(`Goal blocked: ${reason}`, {
        goal: blocked.objective,
        reason,
        evidence,
      });
    },
  } as unknown as AgentTool;
}
