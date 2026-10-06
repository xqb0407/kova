/**
 * 会话命令：压缩、todo 水合、上下文读数、清单、新建/分支/删除/改名/归档、历史。
 * 会话注册表本体在 sessions/sessions.ts，转录与索引见 sessions/transcript.ts。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { send, sendSessionsChanged } from "../stream";
import { logErr } from "../../log";
import { isPromptActive } from "../stream";
import { emitThreadEvent } from "../thread-events";
import { runCompaction, contextInfo } from "../../agent/context";
import { projectContextInfo } from "../../sessions/sessions";
import { stripDirectiveTokens } from "../../sessions/session-title-summarize";
import {
  readTranscript,
  scanTranscript,
  historyToUiMessages,
  isTruncationStoppedRow,
  setSessionName,
  windowTranscriptMessages,
} from "../../sessions/transcript";
import { isAutoContinueMessage, isGoalInternalMessage } from "pi-protocol";
import { dropSessionInteractions } from "../../sessions/pending-interactions";
import { getQueueStateForThread, isTurnBusy } from "../../sessions/prompt-queue";
import { sessionPath } from "../../storage/storage";
import {
  sessionDelete,
  sessionInsert,
  sessionList,
  sessionSetArchived,
  sessionTouch,
  type SessionRow,
} from "../../storage/hostdb";
import {
  dropRun,
  forgetThreadStates,
  listActiveTurnDetails,
  listActiveTurnSessions,
  removeTaskSessionDir,
  resolveSession,
  running,
  setSessionCwd,
} from "../../sessions/sessions";
import { getTodoState, replayTodoFromMessages } from "../../todo/todo";
import {
  getGoal,
  goalStatePayload,
  restoreGoal,
  resume,
  setGoalMaxTurns,
  commitGoal,
  confirmGoalCriteria,
  rejectGoalCriteria,
  setGoalObjective,
  skipGoalCriteria,
} from "../../goal/goal";
import { goalContinueText, goalNegotiationText } from "../../goal/goal-continuation";
import { isNegotiating, limitsFor } from "../../goal/goal-state";
import { ensureGoalMode, persistModePrefs } from "../../agent/modes";
import { dispatchPrompt } from "../prompt-pipeline";
import { getDelegationSnapshot } from "../../subagent/subagent";
import { dropEventSeq, peekEventSeq } from "../event-seq";
import { peekPartial } from "../thread-events";
import type { Running, SessionSummary } from "../../types";
import type { CommandHandler } from "../command";
import type { CompactionRow } from "../../sessions/transcript";

/** 检查点行 → 快照 compactionSummary 消息：generation/summarized 从 details
 *  推出，口径与 get_history 的 data-compaction part 载荷一致（transcript.ts
 *  compactionDividerPart），前端两条路径渲染的分隔线细节相同 */
function compactionSnapMessage(c: CompactionRow) {
  const details = c.details as
    | { generation?: unknown; strategy?: unknown }
    | undefined;
  return {
    role: "compactionSummary",
    summary: c.summary,
    tokensBefore: c.tokensBefore,
    generation: typeof details?.generation === "number" ? details.generation : undefined,
    summarized: details?.strategy !== "fresh_window",
    timestamp: Date.parse(c.createdAt) || 0,
    // 转录行 seq 随消息透传：前端投影用它生成稳定消息 id（下标会因新行落盘漂移）
    __seq: c.seq,
  };
}

/** 索引行 → 会话摘要（list_sessions / session_summary 共用单源）。
 *  偏好的宽松规整在这里统一：列里只认合法字面量，脏值按「从未变更」处理，
 *  前端据此回落全局默认，不会显示出一个非法档位。 */
function sessionSummaryOf(r: SessionRow): SessionSummary {
  return {
    sessionId: r.id,
    name: r.title || undefined,
    firstMessage: r.first_message,
    messageCount: r.message_count,
    modified: r.updated_at,
    cwd: r.cwd,
    archived: r.archived === 1,
    // 会话级偏好（undefined = 从未变更过）：切回会话时前端据此恢复 mode/model
    mode: r.mode === "agent" || r.mode === "plan" || r.mode === "ask" ? r.mode : undefined,
    approvalLevel:
      r.approvalLevel === "ask" ||
      r.approvalLevel === "workspace-write" ||
      r.approvalLevel === "auto-edit" ||
      r.approvalLevel === "auto"
        ? r.approvalLevel
        : undefined,
    modelProvider: r.modelProvider ?? undefined,
    modelId: r.modelId ?? undefined,
    thinkingLevel: r.thinkingLevel ?? undefined,
    // 会话级工作模式（宽松规整，同上）
    appMode:
      r.appMode === "work" || r.appMode === "code" || r.appMode === "design"
        ? r.appMode
        : undefined,
  };
}

export const handlers: Record<string, CommandHandler> = {
  compact: async (reqId, msg) => {
    // 手动压缩上下文：只在空闲回合边界做（prompt 在跑时拒绝），落 checkpoint 行
    const run = await resolveSession(
      String(msg.threadId ?? "default"),
      typeof msg.sessionId === "string" ? msg.sessionId : undefined,
      // 带上 cwd：会话还没建时（比如先点了面板）也能绑上当前工作目录，
      // 不至于落到 homedir（见 sessions.ts rebindRunCwd）
      typeof msg.cwd === "string" ? msg.cwd : undefined,
    );
    if (isPromptActive(String(msg.threadId ?? "default"))) {
      throw new Error("session is busy: wait for the current response to finish");
    }
    const outcome = await runCompaction(run, "manual");
    if (!outcome.ok) throw new Error(outcome.message);
    send({
      id: reqId,
      type: "compacted",
      generation: outcome.generation,
      tokensBefore: outcome.tokensBefore,
      summarized: outcome.summarized,
      summary: outcome.summary,
    });
  },

  get_todo_state: async (reqId, msg) => {
    const threadId = String(msg.threadId ?? "default");
    if (!running.has(threadId)) {
      const sessionId =
        typeof msg.sessionId === "string" ? msg.sessionId : "";
      if (!sessionId) throw new Error(`session not found: ${threadId}`);
      // 内存没有该线程：只读回放转录重建槽位（后续 prompt 直接续用）
      replayTodoFromMessages(
        threadId,
        readTranscript(sessionId).map((e) => e.agent),
      );
    }
    const state = getTodoState(threadId);
    send({
      id: reqId,
      type: "todo_state",
      tasks: state.tasks,
      nextId: state.nextId,
    });
  },

  get_goal_state: async (reqId, msg) => {
    // 目标快照：composer 常驻条的水合入口（刷新 / 切线程 / 切档后）。
    // 与 get_todo_state 同款两段式：内存没有该线程就先只读回放转录里的
    // goal_state 行重建槽位（不建 Agent、不写 running），再回快照。
    // 拿不到 sessionId 时回「无目标」而不是抛——常驻条在还没建会话的新线程上
    // 也会问一次，那不是错误状态
    const threadId = String(msg.threadId ?? "default");
    if (!running.has(threadId)) {
      const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
      if (sessionId) restoreGoal(threadId, sessionId);
    }
    send({ id: reqId, type: "goal_state", ...goalStatePayload(threadId) });
  },

  goal_resume: async (reqId, msg) => {
    // 常驻条「继续」：paused/blocked → active 并清零安全 epoch（轮次与停滞计数）。
    // 必须经 resolveSession 拿到 run：commitGoal 要按 run.threadId 落盘并发事件，
    // 而请求带的 threadId 在改绑后可能不是真键
    const threadId = String(msg.threadId ?? "default");
    const run = await resolveSession(
      threadId,
      typeof msg.sessionId === "string" ? msg.sessionId : undefined,
    );
    const goal = resume(run);
    if (!goal) throw new Error(`no goal to resume: ${threadId}`);
    // 先回快照：UI 立刻看到「进行中」，不用等这一轮的第一个 chunk
    send({ id: reqId, type: "goal_state", ...goalStatePayload(threadId) });
    kickGoalLoop(run);
  },

  goal_clear: async (reqId, msg) => {
    // 常驻条「清除」：连落一行 goal_state（null）而不是删内存键——「已完成」
    // 和「被用户清掉」在重启回放上必须区分得开，否则重启后条会以为目标还在
    const threadId = String(msg.threadId ?? "default");
    const run = await resolveSession(
      threadId,
      typeof msg.sessionId === "string" ? msg.sessionId : undefined,
    );
    commitGoal(run, undefined);
    send({ id: reqId, type: "goal_state", ...goalStatePayload(threadId) });
  },

  // 改这条目标的轮次上限（常驻条上点分母改的就是它）。上限挂在目标上而不是全局
  // 设置里：该跑多少轮取决于任务本身，随目标落盘、随目标回放
  goal_set_limit: async (reqId, msg) => {
    const threadId = String(msg.threadId ?? "default");
    const run = await resolveSession(
      threadId,
      typeof msg.sessionId === "string" ? msg.sessionId : undefined,
    );
    const goal = setGoalMaxTurns(run, msg.maxAutoTurns);
    if (!goal) throw new Error(`no goal to set limit on: ${threadId}`);
    send({ id: reqId, type: "goal_state", ...goalStatePayload(threadId) });
  },

  // 改目标原文（常驻条上点目标文字改的就是它）。存在的理由是「协商阶段那条补充
  // 需求的消息」判不出用户是在加要求还是换目标——猜意图不如给个显式动作：
  // 改原文走这条命令，契约按规则作废重谈（见 goal-state 的 setObjective）
  goal_set_objective: async (reqId, msg) => {
    const threadId = String(msg.threadId ?? "default");
    const run = await resolveSession(
      threadId,
      typeof msg.sessionId === "string" ? msg.sessionId : undefined,
    );
    const goal = setGoalObjective(run, typeof msg.objective === "string" ? msg.objective : "");
    if (!goal) throw new Error(`no goal to set the objective on: ${threadId}`);
    send({ id: reqId, type: "goal_state", ...goalStatePayload(threadId) });
    // 换了目标就要按新目标跑：空闲时补起一轮（协商或执行，按契约阶段选文本）。
    // 正忙时什么也不做——那一轮的 turn_end 自然会按新盘面续
    kickGoalLoop(run);
  },

  // 验收标准契约的三个决定（常驻条待确认卡片上的三个按钮）。三者都只改契约、
  // 然后经 kickGoalLoop 起下一轮——确认要开始干活，驳回/跳过要让模型重新协商或
  // 直接动手，总之都需要一轮。空闲时先回快照再起轮，UI 立刻看到新状态
  goal_confirm_criteria: async (reqId, msg) => {
    const threadId = String(msg.threadId ?? "default");
    const run = await resolveSession(
      threadId,
      typeof msg.sessionId === "string" ? msg.sessionId : undefined,
    );
    // 权限档与确认是同一件事的两半：默认 ask 档下每条 write/bash 都要弹审批卡，
    // 而目标要跑几十上百轮。用户在确认契约时就该一并决定这条目标跑在哪个档
    if (
      msg.approvalLevel === "ask" ||
      msg.approvalLevel === "workspace-write" ||
      msg.approvalLevel === "auto-edit" ||
      msg.approvalLevel === "auto"
    ) {
      run.approvalLevel = msg.approvalLevel;
      persistModePrefs(run);
    }
    const goal = confirmGoalCriteria(run);
    if (!goal) throw new Error(`no proposed criteria to confirm: ${threadId}`);
    send({ id: reqId, type: "goal_state", ...goalStatePayload(threadId) });
    kickGoalLoop(run);
  },

  goal_reject_criteria: async (reqId, msg) => {
    const threadId = String(msg.threadId ?? "default");
    const run = await resolveSession(
      threadId,
      typeof msg.sessionId === "string" ? msg.sessionId : undefined,
    );
    const feedback = typeof msg.feedback === "string" ? msg.feedback : undefined;
    const goal = rejectGoalCriteria(run, feedback);
    if (!goal) throw new Error(`no proposed criteria to reject: ${threadId}`);
    send({ id: reqId, type: "goal_state", ...goalStatePayload(threadId) });
    // 驳回后立刻起新一轮协商：用户在卡片上写了意见，等的就是模型据此重提，
    // 还要再点一次「继续」才算数的话，这个按钮就白点了
    kickGoalLoop(run);
  },

  goal_skip_criteria: async (reqId, msg) => {
    const threadId = String(msg.threadId ?? "default");
    const run = await resolveSession(
      threadId,
      typeof msg.sessionId === "string" ? msg.sessionId : undefined,
    );
    const goal = skipGoalCriteria(run);
    if (!goal) throw new Error(`no criteria to skip: ${threadId}`);
    send({ id: reqId, type: "goal_state", ...goalStatePayload(threadId) });
    kickGoalLoop(run);
  },

  context_info: async (reqId, msg) => {
    // 上下文面板读数：运行中也可查询（只读不阻塞）。
    // 迭代2（P2）：未驻留的会话走只读投影（不建 Agent、不写 running）；
    // 已驻留的现算——顺带保留旧语义（含"请求带 cwd 时补绑"）。
    // 无 sessionId（新线程首开面板）：维持原 resolveSession 落会话的行为。
    const threadId = String(msg.threadId ?? "default");
    const sessionId =
      typeof msg.sessionId === "string" ? msg.sessionId : undefined;
    const cwd = typeof msg.cwd === "string" ? msg.cwd : undefined;
    if (sessionId && !running.has(threadId)) {
      send({
        id: reqId,
        type: "context_info",
        ...(await projectContextInfo(threadId, sessionId)),
      });
    } else {
      const run = await resolveSession(threadId, sessionId, cwd);
      send({ id: reqId, type: "context_info", ...contextInfo(run) });
    }
  },

  list_sessions: async (reqId, msg) => {
    // 迭代 4（P4）：消息计数改读索引表 message_count 列（session_touch
    // 增量维护 + Rust 启动一次性回填），不再逐会话读 JSONL。
    // 回调必须显式标注返回类型：链式 .filter 会截断外部 SessionSummary[] 的
    // 上下文推断，map 返回对象里的字面量类型（"agent"|"plan"）会被放宽成 string
    const all = (await sessionList()).map(sessionSummaryOf).filter((s) => s.messageCount > 0);
    // §6 分页（移动端会话列表）：limit/offset 缺省 = 全量（旧端不破）；
    // nextOffset 存在即表示还有下一页，客户端把它当 cursor 回传
    const limit = Number.isInteger(msg?.limit) && (msg!.limit as number) > 0
      ? (msg!.limit as number)
      : undefined;
    const offset = Number.isInteger(msg?.offset) && (msg!.offset as number) >= 0
      ? (msg!.offset as number)
      : 0;
    const sessions = limit === undefined ? all : all.slice(offset, offset + limit);
    const nextOffset =
      limit !== undefined && offset + sessions.length < all.length
        ? offset + sessions.length
        : undefined;
    send({
      id: reqId,
      type: "sessions",
      sessions,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
    });
  },

  // 单条会话摘要（§6）：列表分页后镜像只含已加载页，切到深页会话时前端
  // 按需补这一条（mode/model/appMode/cwd 水合不能依赖该会话在已加载页里）
  session_summary: async (reqId, msg) => {
    const sessionId = String(msg.sessionId ?? "");
    const row = sessionId ? (await sessionList()).find((r) => r.id === sessionId) : undefined;
    send({ id: reqId, type: "session_summary", ...(row ? { summary: sessionSummaryOf(row) } : {}) });
  },

  list_running: async (reqId) => {
    // 纯内存快照且同步发出（不 await mgmtQueue）：响应行必然写在其后
    // 发生的 turn_changed 之前，前端"先订阅后种子"的合并无空窗
    send({
      id: reqId,
      type: "running",
      sessionIds: listActiveTurnSessions(),
      turns: listActiveTurnDetails(),
    });
  },

  get_subagent_activity: async (reqId, msg) => {
    // 子代理运行活动快照（面板 tab 补水合：刷新后/点开已完成的委派）。
    // delegationId 接受完整 uuid 或 ≥4 位前缀；查不到（sidecar 重启/记录被清）报错。
    const delegationId = String(msg.delegationId ?? "");
    const snapshot = getDelegationSnapshot(delegationId);
    if (!snapshot) throw new Error(`delegation not found: ${delegationId}`);
    send({ id: reqId, type: "subagent_activity_snapshot", ...snapshot });
  },

  new_session: async (reqId, msg) => {
    const threadId = String(msg.threadId ?? `thread-${Date.now()}`);
    const cwd = typeof msg.cwd === "string" ? msg.cwd : undefined;
    const run = await resolveSession(threadId, undefined, cwd);
    send({ id: reqId, type: "session", sessionId: run.sessionId, threadId });
  },

  fork_session: async (reqId, msg) => {
    const sourceId = String(msg.sessionId ?? "");
    // 源会话元数据走 session_list（host 模式 session_get 只回 cwd，没有 title）
    const src = (await sessionList()).find((r) => r.id === sourceId);
    if (!src) throw new Error(`session not found: ${sourceId}`);
    const sourceFile = sessionPath(sourceId);
    if (!existsSync(sourceFile))
      throw new Error(`transcript not found: ${sourceId}`);
    // 逐行复制转录（header 行不拷、撕裂尾行丢弃、未知行型不拷）；
    // 数据行原样保留 seq——seq 是文件内编号空间，跨会话不冲突。
    // 位置分叉（可选 upToSeq，消息气泡「分叉会话」入口）：锚点行（气泡投影
    // 首行的转录 seq）及之前照常复制；之后只延展同一回合的收尾行——非用户
    // 行（悬空 toolResult / 续跑 assistant）与 [[auto-continue]] 注入行（投影
    // 把它们并进同一条气泡），遇到真正的用户输入或压缩检查点即整段截停，
    // 锚点下方的后续轮次不进入新会话
    const upToSeq =
      typeof msg.upToSeq === "number" && Number.isFinite(msg.upToSeq)
        ? msg.upToSeq
        : undefined;
    const dataLines: string[] = [];
    let messageCount = 0;
    let afterAnchor = false;
    for (const line of readFileSync(sourceFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let row: { type?: string; seq?: number; agent?: unknown };
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row || row.type === "header" || typeof row.seq !== "number")
        continue;
      if (upToSeq !== undefined && row.seq > upToSeq) {
        if (afterAnchor) continue;
        // 每条消息行都带 agent（模型面原文，user 行也不例外，见 persist），
        // 「真正的用户输入」这一界标只能按 agent.role 判定
        const payload =
          row.type === "message"
            ? (row.agent as { role?: string } | undefined)
            : undefined;
        const sameRunTail =
          !!payload &&
          (payload.role !== "user" ||
            isAutoContinueMessage(payload) ||
            isGoalInternalMessage(payload));
        if (!sameRunTail) {
          afterAnchor = true;
          continue;
        }
        messageCount += 1;
        dataLines.push(line);
        continue;
      }
      if (row.type === "message") {
        if (!row.agent) continue;
        messageCount += 1;
      } else if (row.type !== "compaction") {
        continue;
      }
      dataLines.push(line);
    }
    const newId = randomUUID();
    // parentSession = fork 溯源（§6 M4，上游 header 同名可选字段；
    // 本项目取源会话 id 而非路径——我们的会话身份是 id）
    writeFileSync(
      sessionPath(newId),
      JSON.stringify({
        type: "header",
        schema: 1,
        id: newId,
        cwd: src.cwd,
        created_at: new Date().toISOString(),
        parentSession: sourceId,
      }) + "\n" + (dataLines.length ? dataLines.join("\n") + "\n" : ""),
    );
    await sessionInsert(newId, src.cwd);
    // 索引行补写：标题加「（分支）」后缀（无名会话用首轮消息行兜底，与
    // list_sessions 的标题回退一致）；first_message 拷贝源值；计数按实拷行数
    const srcTitle = src.title || stripDirectiveTokens(src.first_message).slice(0, 60);
    await sessionTouch(
      newId,
      srcTitle ? `${srcTitle}（分支）` : "",
      src.first_message,
      messageCount,
    );
    sendSessionsChanged("created", newId);
    send({ id: reqId, type: "forked", sessionId: newId });
  },

  truncate_session: async (reqId, msg) => {
    // 编辑/重新生成的服务端截断：丢掉 seq >= beforeSeq 的全部转录行，
    // 前端随后重发替换消息（prompt 走恢复路径重建 Agent，行为与重启续聊一致）。
    // 只在空闲回合边界做（compact 同款守卫）；非 prompt 命令由 handleLine
    // 入 mgmt 串行队列，与在写 prompt 天然互斥。
    const sessionId = String(msg.sessionId ?? "");
    if (!sessionId) throw new Error("sessionId required");
    const beforeSeq = Number(msg.beforeSeq);
    if (!Number.isInteger(beforeSeq) || beforeSeq < 0)
      throw new Error("beforeSeq must be a non-negative integer");
    const file = sessionPath(sessionId);
    if (!existsSync(file)) throw new Error(`transcript not found: ${sessionId}`);
    if (isPromptActive(String(msg.threadId ?? sessionId)))
      throw new Error("session is busy: wait for the current response to finish");
    // 顺序截止：文件按 append 时序单调，命中第一条 seq >= beforeSeq 的行即
    // 截断点，其后整体丢弃（含无 seq 的 model_change 等设定行——回退到该点
    // 之后的上下文设定随之消失，属时间回退语义）。截断点前的行原样保留，
    // 坏行/撕裂尾行不解析不改写。
    const lines = readFileSync(file, "utf8").split("\n");
    const kept: string[] = [];
    let removedMessages = 0;
    let cut = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (!cut) {
        let seq: unknown;
        try {
          seq = (JSON.parse(line) as { seq?: unknown }).seq;
        } catch {
          kept.push(line); // 坏行随保留段原样带走
          continue;
        }
        if (typeof seq === "number" && seq >= beforeSeq) cut = true;
      }
      if (cut) {
        try {
          const row = JSON.parse(line) as { type?: string; agent?: unknown };
          if (row?.type === "message" && row.agent) removedMessages += 1;
        } catch {
          // 计不到就不计：removedMessages 只用于索引计数修正
        }
        continue;
      }
      kept.push(line);
    }
    if (!cut) {
      send({ id: reqId, type: "truncated", sessionId, removed: 0 });
      return;
    }
    writeFileSync(file, kept.length ? kept.join("\n") + "\n" : "");
    // 索引计数按被删消息行做负增量（title/first_message 传 "" 不改原值）
    if (removedMessages > 0) {
      await sessionTouch(sessionId, "", "", -removedMessages);
      // 计数回落到 0 会让会话退出清单可见集合；变化即广播
      sendSessionsChanged("updated", sessionId);
    }
    // 挂起交互台账随行消失（截断窗口内的发起/结算行已不在转录里）
    dropSessionInteractions(sessionId);
    // 驻留 run 的内存上下文与磁盘脱节：驱逐，下一 prompt 走截断后转录重建
    for (const [tid, run] of running) {
      if (run.sessionId === sessionId) {
        dropRun(tid);
        forgetThreadStates(tid);
      }
    }
    send({ id: reqId, type: "truncated", sessionId, removed: removedMessages });
  },

  thread_snapshot: async (reqId, msg) => {
    // PiClient 契约的快照命令（react-pi 迁移阶段 2）：JSONL 转录 → PiThreadSnapshot。
    // 消息 = pi-ai 原生 agent 行直出（前端投影层消费），压缩检查点行按 seq 位置
    // 重建成 compactionSummary 消息；metadata.status 以 activeTurns 为准；
    // seq = per-session 事件水位现读（未盖章过不带 = 冷读）。
    const sessionId = String(msg.sessionId ?? "");
    if (!sessionId) throw new Error("sessionId required");
    const scan = scanTranscript(sessionId);
    const running = listActiveTurnSessions().includes(sessionId);
    const row = (await sessionList()).find((r) => r.id === sessionId);
    // §6 分页窗（移动端无限上翻）：tail/beforeSeq 缺省 = 全量（旧端不破）；
    // 游标 = 消息行 seq，与 get_history 同语义。窗口只从头部裁，
    // 末行之后的行仍在 scan.messages 里（截断判定要它）。
    const beforeSeq = typeof msg.beforeSeq === "number" ? msg.beforeSeq : undefined;
    const { window: msgWindow, meta } = windowTranscriptMessages(scan.messages, {
      tail: typeof msg.tail === "number" ? msg.tail : undefined,
      beforeSeq,
    });
    const winStart = msgWindow.length ? scan.messages.indexOf(msgWindow[0]) : 0;
    const winEnd = winStart + msgWindow.length - 1;
    // 消息与压缩检查点按 seq 归并（两者共用号段，单遍双指针）
    type SnapMessage = Record<string, unknown> & { role?: string };
    const messages: SnapMessage[] = [];
    let ci = 0;
    for (let mi = winStart; mi <= winEnd; mi++) {
      const m = scan.messages[mi];
      while (ci < scan.compactions.length && scan.compactions[ci].seq < m.seq) {
        messages.push(compactionSnapMessage(scan.compactions[ci++]));
      }
      // seq = per-session 转录行水位（落盘后单调不变）；透传给前端做稳定消息 id。
      // 在飞 partial（peekPartial）没有 seq——未落盘，行号还不确定，前端按下标回退。
      // 最终中止标注要在哨兵跳过前算：判定依赖「截断行的下一行是不是哨兵续跑」。
      // 哨兵 user 行必须与 toUiMessage 同口径按前缀隐藏——快照直出原生行，
      // 此前不滤曾把裸前缀当用户提问上屏（桌面气泡泄漏）。
      const truncationStopped = isTruncationStoppedRow(m, scan.messages[mi + 1]);
      if (isAutoContinueMessage(m.agent) || isGoalInternalMessage(m.agent)) continue;
      messages.push({
        ...(m.agent as unknown as SnapMessage),
        __seq: m.seq,
        ...(truncationStopped ? { __truncationStopped: true } : {}),
      });
    }
    while (ci < scan.compactions.length) {
      // 翻旧页（beforeSeq）时游标之后的行不属于这一页：分隔线随页走，避免旧页
      // 被前置后把「未来」的压缩分隔线插到页尾
      if (beforeSeq !== undefined && scan.compactions[ci].seq >= beforeSeq) break;
      messages.push(compactionSnapMessage(scan.compactions[ci++]));
    }
    // 流式中的 partial 并入（react-pi 迁移阶段 3c）：转录只在 message_end 落盘，
    // 运行中刷新靠快照自愈——把事件桥台账里的在飞 assistant 消息接到尾部
    //（仅 running 会话有；空闲时台账已清）。在飞 partial 恒属于会话尾部，
    // 翻旧页不带（否则旧页会顶出一条进行中的消息）
    const partial = beforeSeq === undefined ? peekPartial(sessionId) : undefined;
    if (partial) messages.push(partial as unknown as SnapMessage);
    // 最后一条带 errorMessage 的 assistant 消息 = 会话级 lastError（兜底展示用）；
    // 同理只在整窗/尾窗上算——旧页的 lastError 不是会话级事实
    let lastError: string | undefined;
    if (beforeSeq === undefined) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === "assistant" && typeof m.errorMessage === "string" && m.errorMessage) {
          lastError = m.errorMessage;
          break;
        }
      }
    }
    // 挂起交互行 → hostUiRequests：阶段 2 只映射逐工具审批（permission），
    // 投影层按 toolCallId 挂到工具卡上渲染审批；question 类卡片 UI 在阶段 4 接线。
    // 挂起交互属于尾部状态，同 partial 只在整窗/尾窗上带
    const peek = beforeSeq === undefined ? peekEventSeq(sessionId) : undefined;
    // 队列 → metadata.queuedMessages（4a）：快照权威携带排队条目（id=reqId，
    // mode 恒 followUp——引擎无 steering 常驻），刷新后 state.queue 由快照重建；
    // 内存为空时顺带从 session 回放采纳（sidecar 重启恢复路径）。新链路线程
    // 身份 = sessionId，引擎键同键。
    const queueSnapshotState = getQueueStateForThread(sessionId, sessionId);
    const queuedMessages = (beforeSeq === undefined ? queueSnapshotState?.items ?? [] : []).map((item) => ({
      id: item.reqId,
      mode: "followUp" as const,
      content: item.text,
      // 图片附件随快照回放（与 queue_update/queue_pop 同一形状）：刷新/重启后
      // 前端重建条目与接力泵重发都不丢图
      ...(item.attachments && item.attachments.length > 0
        ? { attachments: item.attachments }
        : {}),
    }));
    const hostUiRequests = (beforeSeq === undefined ? scan.pending : []).flatMap((it): unknown[] => {
      if (it.kind !== "permission") return [];
      const p = it.payload as { approvalId?: string; toolCallId?: string; toolName?: string };
      if (!p.approvalId) return [];
      return [{
        id: p.approvalId,
        kind: "confirm" as const,
        title: p.toolName ?? "工具审批",
        message: p.toolName ? `允许执行 ${p.toolName}？` : "工具等待审批",
        ...(p.toolCallId ? { toolCallId: p.toolCallId } : {}),
      }];
    });
    send({
      id: reqId,
      type: "thread_snapshot",
      snapshot: {
        metadata: {
          id: sessionId,
          title: scan.name || row?.title || undefined,
          workspacePath: row?.cwd || undefined,
          archived: row?.archived === 1,
          status: running ? ("running" as const) : ("idle" as const),
          config: {
            provider: scan.model?.provider ?? row?.modelProvider ?? undefined,
            modelId: scan.model?.modelId ?? row?.modelId ?? undefined,
            ...(scan.thinkingLevel ? { thinkingLevel: scan.thinkingLevel } : {}),
          },
          messageCount: row?.message_count,
          updatedAt: row?.updated_at,
          sessionFile: sessionPath(sessionId),
          ...(queuedMessages.length ? { queuedMessages } : {}),
        },
        messages,
        ...(hostUiRequests.length ? { hostUiRequests } : {}),
        ...(peek !== undefined ? { seq: peek } : {}),
        ...(lastError ? { lastError } : {}),
        // 分页元数据（§6）：缺省请求（无 tail/beforeSeq）时 firstSeq/lastSeq 为全窗首末，
        // hasMore 恒 false——旧端读不到这些字段不受影响
        ...(meta.firstSeq !== null ? { firstSeq: meta.firstSeq } : {}),
        ...(meta.lastSeq !== null ? { lastSeq: meta.lastSeq } : {}),
        hasMore: meta.hasMore,
      },
    });
  },

  get_history: async (reqId, msg) => {
    const sessionId = String(msg.sessionId ?? "");
    // 从 agent 消息重建：text/reasoning 之外还带 tool part（input/output 对齐 live 流）；
    // 压缩检查点行重建为 data-compaction 分隔线 part，刷新后分隔线不丢。
    // 迭代 4：单遍 scanTranscript 同时取消息行与检查点行（此前读两遍文件）
    const scan = scanTranscript(sessionId);
    // §6 分页窗：tail/beforeSeq 缺省 = 全量（旧端不破）；游标 = 消息行 seq，
    // compaction 行不分页（分隔线锚定靠 throughSeq，且量小）
    const { window, meta } = windowTranscriptMessages(scan.messages, {
      tail: typeof msg.tail === "number" ? msg.tail : undefined,
      beforeSeq: typeof msg.beforeSeq === "number" ? msg.beforeSeq : undefined,
    });
    // 窗口是否触及会话末行：截断中止标记的「下一行非续跑」判定在窗口末行处
    // 只能由这个前提背书（防分页窗恰好切在截断行与哨兵续跑行之间造成误标）
    const lastMsgSeq = scan.messages.length
      ? scan.messages[scan.messages.length - 1].seq
      : undefined;
    const messages = historyToUiMessages(window, scan.compactions, {
      reachesSessionEnd:
        lastMsgSeq === undefined ||
        meta.lastSeq == null ||
        meta.lastSeq >= lastMsgSeq,
    });
    // §4：未结算挂起交互随行回放（前端据此重建挂起卡）；firstSeq/lastSeq/hasMore 分页元数据
    send({
      id: reqId,
      type: "history",
      messages,
      pending: scan.pending,
      firstSeq: meta.firstSeq,
      lastSeq: meta.lastSeq,
      hasMore: meta.hasMore,
    });
  },

  delete_session: async (reqId, msg) => {
    const sessionId = String(msg.sessionId ?? "");
    for (const [tid, run] of running) {
      if (run.sessionId === sessionId) {
        dropRun(tid);
        forgetThreadStates(tid); // 迭代2：删会话同样清 per-thread 旁路态（todo）
      }
    }
    await sessionDelete(sessionId);
    dropEventSeq(sessionId); // 水印计数器随会话删除（防 per-session Map 泄漏）
    dropSessionInteractions(sessionId); // 挂起交互台账同清（§4，行随文件消失）
    const file = sessionPath(sessionId);
    if (existsSync(file)) unlinkSync(file);
    // 无目录会话的产物随会话走（<任务工作区>/<sessionId> 递归删；
    // 从未落过盘/项目会话是空操作），否则「我的文件」里只剩无名孤儿目录
    removeTaskSessionDir(sessionId);
    sendSessionsChanged("deleted", sessionId);
    send({ id: reqId, type: "deleted" });
  },

  rename_session: async (reqId, msg) => {
    const sessionId = String(msg.sessionId ?? "");
    const name = String(msg.name ?? "");
    // 转录 session_info 行 = 真值，索引 title 列 = 投影（§6 M4）
    await setSessionName(sessionId, name);
    // 原生事件通道（react-pi 迁移阶段 3）：reducer 的 metadata.title 由它驱动
    emitThreadEvent(sessionId, { type: "session_info_changed", name });
    sendSessionsChanged("updated", sessionId);
    send({ id: reqId, type: "renamed" });
  },

  archive_session: async (reqId, msg) => {
    const sessionId = String(msg.sessionId ?? "");
    const archived = msg.archived !== false;
    await sessionSetArchived(sessionId, archived);
    sendSessionsChanged("updated", sessionId);
    send({ id: reqId, type: "archived" });
  },

  set_session_cwd: async (reqId, msg) => {
    // 中途换/清会话工作目录（前端胶囊）：cwd=""=解绑。非 prompt 命令已由
    // handleLine 整体入 mgmt 串行队列，与 prompt 的会话准备段互斥；
    // "本轮在跑"的拒绝判断在 setSessionCwd 内按驻留 run 的线程键做
    const sessionId = String(msg.sessionId ?? "");
    const cwd = typeof msg.cwd === "string" ? msg.cwd : "";
    await setSessionCwd(sessionId, cwd);
    // 换目录 = 侧边栏项目分组归属变化，其它端需重取清单
    sendSessionsChanged("updated", sessionId);
    // 跨端同步：换目录改的是会话级偏好（清单/项目分组都看它）；发在响应之前，
    // 响应恒为最后一行
    sendSessionsChanged("updated", sessionId);
    send({ id: reqId, type: "session_cwd_set", sessionId, cwd });
  },
};

/**
 * 「点继续」之后真正把循环点着。
 *
 * 背景：目标状态是 active ≠ 循环在跑。循环的唯一驱动源是「有 run 在飞 +
 * turn_end 调 continueGoalTurn」——而 paused 意味着那个 run 早就结束了，
 * 光把状态搬回 active 不会让任何东西跑起来（条上显示「进行中」+ 呼吸绿点，
 * 实际什么都没有，这是修复前「继续按钮点了没用」的根因）。
 *
 * 所以空闲时补起一轮。两点讲究：
 * - 用 GOAL_CONTINUE_PREFIX 开头的续跑文本：它会被 syncGoalOnUserPrompt 认出
 *   是系统注入而不是用户接管，否则刚 resume 就被自己暂停；
 * - 合成的 reqId：发起的这一轮流式事件按 sessionId 分流（桌面 pi-client-base），
 *   所以用户照常看到输出，不需要给这次内部起轮接一条前端请求。
 *
 * 线程正忙时什么都不做：状态已是 active，那一轮的 turn_end 自然会续。
 */
function kickGoalLoop(run: Running): void {
  if (isTurnBusy(run.threadId)) return;
  const goal = getGoal(run.threadId);
  if (!goal || goal.status !== "active") return;
  // 等用户确认契约时没有活可干：起一轮只会让模型读着「等用户决定」的系统提示词
  // 收到一条「继续推进目标」的注入，两边打架（而且这个阶段它手里一个目标工具
  // 都没有，收到 execution 指令只会去调不存在的 goal_complete）
  if (goal.acceptance?.status === "proposed") return;
  // 目标只在 goal 档跑：这里的入口都是「继续这条目标」的明确动作，档位不对就先
  // 扶正（理由见 ensureGoalMode）。不对端补一条会话变更帧的话，前端胶囊会停在
  // 旧档位，看起来像"档位自己变了"
  if (ensureGoalMode(run) && run.sessionId) sendSessionsChanged("updated", run.sessionId);
  const reqId = `goal-${run.sessionId}-${Date.now()}`;
  void dispatchPrompt(reqId, {
    threadId: run.threadId,
    sessionId: run.sessionId,
    // 必须是用户选的目录（persistedCwd），**不能**传 run.cwd：后者对无目录会话是
    // 运行时兜底的 <task-workspace>/<sessionId>，而 dispatchPrompt 会把请求里的 cwd
    // 当成「用户后来选了目录」持久化进会话行（resolveSession 的补绑分支）——一次
    // 「继续」就把任务会话变成「项目」会话，侧边栏按 UUID 目录名分组
    cwd: run.persistedCwd,
    // 协商阶段与执行阶段的注入文本不是一回事：前者要模型「别动手，先提标准」，
    // 后者才是「接着干」。用错文本的后果是模型按执行纪律去改文件，
    // 而写类工具正被协商只读门控拦着——它只会一遍遍撞门
    text: isNegotiating(goal.acceptance)
      ? goalNegotiationText(goal)
      : goalContinueText(goal, limitsFor(goal)),
  }).catch((err) => {
    logErr("goal resume: failed to start the continuation turn:", err);
  });
}
