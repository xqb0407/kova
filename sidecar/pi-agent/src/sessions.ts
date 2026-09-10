/**
 * 会话管理：threadId -> Agent 实例的内存映射与会话解析。
 * sessionId 提供时优先恢复该会话（重启续聊）；否则懒建新会话（索引行 + JSONL header）。
 */
import { Agent } from "@earendil-works/pi-agent-core";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  defaultModel,
  getCurrentModelKey,
  getModels,
} from "./model-catalog";
import { buildTools, systemPrompt } from "./tools";
import { readTranscript } from "./transcript";
import { onAgentEvent } from "./stream";
import { db, sessionPath } from "./storage";
import type { Running } from "./types";

/** threadId -> 活动会话（每个前端线程一个 Agent 实例） */
export const running = new Map<string, Running>();

/** 拿到 threadId 对应的 Agent；sessionId 提供时优先恢复该会话（重启续聊） */
export async function resolveSession(
  threadId: string,
  sessionId?: string,
  cwd?: string,
): Promise<Running> {
  const existing = running.get(threadId);
  if (existing) return existing;

  // 持久化 cwd = 用户选择的工作目录（空串 = 未选目录的任务会话）；
  // 运行 cwd 兜底主目录，仅影响 Agent 执行环境，不回写持久化
  let persistedCwd = cwd ?? "";
  let restoredMessages: import("@earendil-works/pi-ai").Message[] = [];
  let persistedSeq = 0;

  if (sessionId) {
    const row = db
      .query<{ cwd: string }, [string]>("SELECT cwd FROM pi_sessions WHERE id = ?")
      .get(sessionId);
    if (!row) throw new Error(`session not found: ${sessionId}`);
    persistedCwd = row.cwd;
    const transcript = readTranscript(sessionId);
    restoredMessages = transcript.map((t) => t.agent);
    persistedSeq = transcript.length;
  } else {
    // 新会话：建索引行 + JSONL header
    sessionId = randomUUID();
    const now = new Date().toISOString();
    db.query(
      "INSERT INTO pi_sessions (id, title, first_message, cwd, created_at, updated_at) VALUES (?, '', '', ?, ?, ?)",
    ).run(sessionId, persistedCwd, now, now);
    writeFileSync(
      sessionPath(sessionId),
      JSON.stringify({ type: "header", schema: 1, id: sessionId, cwd: persistedCwd, created_at: now }) + "\n",
    );
  }

  const resolvedCwd = persistedCwd || homedir();

  const mk = getCurrentModelKey();
  const model = mk
    ? getModels().getModel(mk.provider, mk.modelId)
    : await defaultModel();

  const agent = new Agent({
    streamFn: (m, context, options) =>
      getModels().streamSimple(m, context, options),
    initialState: {
      systemPrompt: systemPrompt(resolvedCwd),
      model,
      tools: buildTools(resolvedCwd),
      messages: restoredMessages,
    },
  });

  const run: Running = { agent, sessionId, cwd: resolvedCwd, persistedSeq };
  agent.subscribe((event) => onAgentEvent(event, run));
  running.set(threadId, run);
  return run;
}
