/**
 * 会话命令：压缩、todo 水合、上下文读数、清单、新建/分支/删除/改名/归档、历史。
 * 会话注册表本体在 sessions/sessions.ts，转录与索引见 sessions/transcript.ts。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { send } from "../stream";
import { isPromptActive } from "../stream";
import { runCompaction, contextInfo } from "../../agent/context";
import { projectContextInfo } from "../../sessions/sessions";
import { stripDirectiveTokens } from "../../sessions/session-title-summarize";
import {
  readTranscript,
  scanTranscript,
  historyToUiMessages,
  setSessionName,
  windowTranscriptMessages,
} from "../../sessions/transcript";
import { dropSessionInteractions } from "../../sessions/pending-interactions";
import { sessionPath } from "../../storage/storage";
import {
  sessionDelete,
  sessionInsert,
  sessionList,
  sessionSetArchived,
  sessionTouch,
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
import { getDelegationSnapshot } from "../../subagent/subagent";
import { dropEventSeq } from "../event-seq";
import type { SessionSummary } from "../../types";
import type { CommandHandler } from "../command";

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

  list_sessions: async (reqId) => {
    // 迭代 4（P4）：消息计数改读索引表 message_count 列（session_touch
    // 增量维护 + Rust 启动一次性回填），不再逐会话读 JSONL。
    // 回调必须显式标注返回类型：链式 .filter 会截断外部 SessionSummary[] 的
    // 上下文推断，map 返回对象里的字面量类型（"agent"|"plan"）会被放宽成 string
    const sessions: SessionSummary[] = (await sessionList())
      .map((r): SessionSummary => ({
        sessionId: r.id,
        name: r.title || undefined,
        firstMessage: r.first_message,
        messageCount: r.message_count,
        modified: r.updated_at,
        cwd: r.cwd,
        archived: r.archived === 1,
        // 会话级偏好（undefined = 从未变更过）：切回会话时前端据此恢复 mode/model
        mode: r.mode === "agent" || r.mode === "plan" ? r.mode : undefined,
        approvalLevel:
          r.approvalLevel === "ask" || r.approvalLevel === "auto-edit" || r.approvalLevel === "auto"
            ? r.approvalLevel
            : undefined,
        modelProvider: r.modelProvider ?? undefined,
        modelId: r.modelId ?? undefined,
      }))
      .filter((s) => s.messageCount > 0);
    send({ id: reqId, type: "sessions", sessions });
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
    // 数据行原样保留 seq——seq 是文件内编号空间，跨会话不冲突
    const dataLines: string[] = [];
    let messageCount = 0;
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
    send({ id: reqId, type: "forked", sessionId: newId });
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
    const messages = historyToUiMessages(window, scan.compactions);
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
    send({ id: reqId, type: "deleted" });
  },

  rename_session: async (reqId, msg) => {
    const sessionId = String(msg.sessionId ?? "");
    const name = String(msg.name ?? "");
    // 转录 session_info 行 = 真值，索引 title 列 = 投影（§6 M4）
    await setSessionName(sessionId, name);
    send({ id: reqId, type: "renamed" });
  },

  archive_session: async (reqId, msg) => {
    const sessionId = String(msg.sessionId ?? "");
    const archived = msg.archived !== false;
    await sessionSetArchived(sessionId, archived);
    send({ id: reqId, type: "archived" });
  },

  set_session_cwd: async (reqId, msg) => {
    // 中途换/清会话工作目录（前端胶囊）：cwd=""=解绑。非 prompt 命令已由
    // handleLine 整体入 mgmt 串行队列，与 prompt 的会话准备段互斥；
    // "本轮在跑"的拒绝判断在 setSessionCwd 内按驻留 run 的线程键做
    const sessionId = String(msg.sessionId ?? "");
    const cwd = typeof msg.cwd === "string" ? msg.cwd : "";
    await setSessionCwd(sessionId, cwd);
    send({ id: reqId, type: "session_cwd_set", sessionId, cwd });
  },
};
