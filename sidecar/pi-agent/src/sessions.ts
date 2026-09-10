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
import { buildTools } from "./tools";
import {
  approvalBeforeToolCall,
  composeModeSystemPrompt,
  toolsForMode,
} from "./modes";
import { getSubagentDefinitions } from "./subagent-definitions";
import { buildSubagentTools } from "./subagent";
import { readCompaction, readTranscript } from "./transcript";
import { checkpointGeneration, projectRestoreContext } from "./context";
import { onAgentEvent } from "./stream";
import { logErr } from "./log";
import { sessionPath } from "./storage";
import { sessionGet, sessionInsert } from "./hostdb";
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
  let jsonlSeq = 0;
  let compactionGeneration = 0;

  if (sessionId) {
    const row = await sessionGet(sessionId);
    if (!row) throw new Error(`session not found: ${sessionId}`);
    persistedCwd = row.cwd;
    const transcript = readTranscript(sessionId);
    const checkpoint = readCompaction(sessionId);
    let maxSeq = -1;
    for (const t of transcript) maxSeq = Math.max(maxSeq, t.seq);
    if (checkpoint) {
      maxSeq = Math.max(maxSeq, checkpoint.seq);
      compactionGeneration = checkpointGeneration(checkpoint.details);
    }
    restoredMessages = projectRestoreContext(transcript, checkpoint);
    persistedSeq = restoredMessages.length;
    jsonlSeq = maxSeq + 1;
  } else {
    // 新会话：建索引行 + JSONL header
    sessionId = randomUUID();
    const now = new Date().toISOString();
    await sessionInsert(sessionId, persistedCwd);
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

  const baseTools = buildTools(resolvedCwd);
  // run 先占位再回填 agent：beforeToolCall 闭包按引用捕获 run，模式校验在运行期才解引用
  const run: Running = {
    agent: undefined as unknown as Agent,
    sessionId: sessionId!,
    cwd: resolvedCwd,
    persistedSeq,
    jsonlSeq,
    compactionGeneration,
    pendingOverflowRecovery: false,
    delegations: new Map(),
    stopRequested: false,
    mode: "agent",
    approvalLevel: "ask",
    planning: "inactive",
    proposal: null,
    baseTools,
    subagentTools: [],
    pendingToolApprovals: new Map(),
  };

  const agent = new Agent({
    // sessionId 透传：OpenAI prompt_cache_key / Anthropic session-affinity（缓存路由）
    sessionId,
    streamFn: (m, context, options) =>
      getModels().streamSimple(m, context, {
        ...options,
        // 可选长缓存（Anthropic 1h TTL / OpenAI 24h retention），compat 守门自动降级
        ...(process.env.PI_CACHE_RETENTION === "long" ? { cacheRetention: "long" } : {}),
      }),
    initialState: {
      systemPrompt: composeModeSystemPrompt("agent", resolvedCwd),
      model,
      tools: baseTools,
      messages: restoredMessages,
    },
    beforeToolCall: async (context) => approvalBeforeToolCall(run, context),
  });
  run.agent = agent;

  const { definitions, diagnostics } = await getSubagentDefinitions();
  for (const d of diagnostics) logErr("subagent:", d);
  run.subagentTools = buildSubagentTools(run, baseTools, definitions);
  // 在基础工具目录上追加 Task 工具组 + 模式切换工具（delegate 的工具按定义从基础目录里取，
  // 绝不包含 Task 组，delegate 不能继续委派）
  agent.state.tools = toolsForMode(run);

  agent.subscribe((event) => onAgentEvent(event, run));
  running.set(threadId, run);
  return run;
}
