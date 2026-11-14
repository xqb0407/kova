/**
 * ACP Agent 实现：方法层 + 会话状态机。
 *
 * 职责边界：
 * - ACP 方法 → 内部命令/prompt（经 AcpBridge）；
 * - 会话表：ACP sessionId ↔ 内部 threadId/sessionId、cwd、模式、模型映射；
 * - 权限卡：data-toolApproval → session/request_permission → tool_confirm；
 * - session/load：thread_snapshot 历史回放。
 *
 * 不在这里做 Agent 组装：会话创建/恢复/工具装配全部复用现有
 * resolveSession / dispatchPrompt。
 */
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { logErr } from "../log";
import { AcpInternalError, type AcpBridge } from "./bridge";
import { replayHistory, type SnapshotMessage } from "./history";
import {
  permissionInputFor,
  permissionOptionsFor,
  parsePromptContent,
  StreamTranslator,
  toolKindFor,
  toolTitleFor,
  locationsForInput,
  type ToolApprovalData,
} from "./translate";

const ACP_MODES = [
  { id: "agent", name: "Agent", description: "Full tool set; implement the task." },
  { id: "plan", name: "Plan", description: "Read-only research; propose a plan for approval." },
  { id: "ask", name: "Ask", description: "Answer questions without modifying files." },
] as const;

type AcpMode = (typeof ACP_MODES)[number]["id"];

type SessionEntry = {
  acpSessionId: string;
  threadId: string;
  sessionId: string;
  cwd: string;
  lastMode: AcpMode;
  /** 权限等待的取消信号：session/cancel 时 abort */
  promptAbort: AbortController | null;
  cancelled: boolean;
  /** approvalId → toolCallId（data-interactionResolved 兜底用） */
  approvalToolCalls: Map<string, string>;
  modelMap: Map<
    string,
    { provider: string; modelId: string; name?: string; description?: string }
  >;
};

type ModelsPayload = {
  models?: Array<{
    provider: string;
    providerName?: string;
    id: string;
    name?: string;
    enabled?: boolean;
    authed?: boolean;
  }>;
  providers?: Array<{ id: string; name: string; authed?: boolean }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function projectMode(mode: unknown): AcpMode {
  return mode === "plan" ? "plan" : mode === "ask" ? "ask" : "agent";
}

function modeState(current: AcpMode): acp.SessionModeState {
  return {
    availableModes: ACP_MODES.map((mode) => ({
      id: mode.id,
      name: mode.name,
      description: mode.description,
    })),
    currentModeId: current,
  };
}

function toRequestError(err: unknown): acp.RequestError {
  if (err instanceof acp.RequestError) return err;
  if (err instanceof AcpInternalError) {
    // 不要把真实错误塞进 data 而让顶层 message 停在 "Internal error"：
    // ACP 客户端通常只展示 message，模型/网络错误会全部变成不可读的通用文案。
    return new acp.RequestError(
      -32603,
      err.errorText || "Internal error",
      err.payload ? { error: err.payload } : undefined,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new acp.RequestError(-32603, message || "Internal error");
}

export class KovaAcpAgent implements acp.Agent {
  private sessions = new Map<string, SessionEntry>();
  private initialized = false;

  constructor(
    private readonly conn: acp.AgentSideConnection,
    private readonly bridge: AcpBridge,
  ) {}

  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    this.initialized = true;
    void params;
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
      },
      authMethods: [],
    };
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    // 凭据来自环境变量/本地 DB，没有交互式认证流程
    return {};
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    try {
      const cwd = this.validateCwd(params.cwd);
      this.logIgnoredMcpServers(params.mcpServers);
      const threadId = `acp-${randomUUID()}`;
      const res = await this.bridge.request({
        type: "new_session",
        threadId,
        cwd,
      });
      const sessionId = text(res.sessionId);
      if (!sessionId) throw new AcpInternalError("new_session returned no sessionId");

      let currentMode: AcpMode = "agent";
      try {
        const planning = await this.bridge.request({
          type: "get_planning_state",
          threadId,
          sessionId,
        });
        currentMode = projectMode(planning.mode);
        if (planning.mode === "goal") {
          // ACP 不暴露 goal；新建会话若跟随到 goal 档，强制降为 agent，
          // 否则首轮会进入无人值守的自治循环。
          await this.bridge.request({ type: "set_mode", threadId, sessionId, mode: "agent" });
          currentMode = "agent";
        }
      } catch (err) {
        // 模式快照不是建会话的硬依赖：失败就按 agent 暴露，prompt 仍可继续
        logErr("[acp] get_planning_state failed; defaulting to agent:", err);
      }

      const entry: SessionEntry = {
        acpSessionId: sessionId,
        threadId,
        sessionId,
        cwd,
        lastMode: currentMode,
        promptAbort: null,
        cancelled: false,
        approvalToolCalls: new Map(),
        modelMap: new Map(),
      };
      this.sessions.set(sessionId, entry);

      const models = await this.loadModels(entry);
      void this.sendCommands(entry);
      return {
        sessionId,
        modes: modeState(currentMode),
        ...(models ? { models } : {}),
      };
    } catch (err) {
      throw toRequestError(err);
    }
  }

  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    try {
      this.logIgnoredMcpServers(params.mcpServers);
      const sessionId = params.sessionId;
      // 用 session_summary 而不是 list_sessions：list_sessions 会过滤掉
      // messageCount=0 的空会话，刚 new 出来还没发过消息的会话重连后
      // 会被误判为不存在。
      const summaryRes = await this.bridge.request({
        type: "session_summary",
        sessionId,
      });
      const row = isRecord(summaryRes.summary) ? summaryRes.summary : undefined;
      if (!row) throw new AcpInternalError(`session not found: ${sessionId}`);

      const running = await this.bridge.request({ type: "list_running" });
      const runningIds = Array.isArray(running.sessionIds) ? running.sessionIds : [];
      if (runningIds.includes(sessionId)) {
        throw new acp.RequestError(-32600, "session is running; cancel it before loading");
      }

      const snapshotRes = await this.bridge.request({
        type: "thread_snapshot",
        sessionId,
      });
      if (!isRecord(snapshotRes.snapshot)) {
        throw new AcpInternalError(`thread_snapshot returned no snapshot: ${sessionId}`);
      }
      const snapshot = snapshotRes.snapshot;
      const metadata = isRecord(snapshot.metadata) ? snapshot.metadata : {};
      if (metadata.status === "running") {
        throw new acp.RequestError(-32600, "session is running; cancel it before loading");
      }

      const cwd =
        text(metadata.workspacePath) || text(row.cwd) || params.cwd || process.cwd();
      const messages = Array.isArray(snapshot.messages)
        ? (snapshot.messages as SnapshotMessage[])
        : [];

      await replayHistory({
        sessionId,
        cwd,
        messages,
        sendUpdate: (update) => this.sendUpdate(sessionId, update),
      });

      let currentMode = projectMode(row.mode);
      // 偏好列为 NULL（旧会话）或 goal（ACP 不暴露）时，真实模式可能来自
      // kv「最近一次使用」；这时才用 get_planning_state 取权威值，避免每次
      // load 都为普通会话重建 run（大会话的转录读取成本不低）。
      if (row.mode !== "agent" && row.mode !== "plan" && row.mode !== "ask") {
        try {
          const planning = await this.bridge.request({
            type: "get_planning_state",
            threadId: sessionId,
            sessionId,
          });
          currentMode = projectMode(planning.mode);
          if (planning.mode === "goal") {
            await this.bridge.request({
              type: "set_mode",
              threadId: sessionId,
              sessionId,
              mode: "agent",
            });
            currentMode = "agent";
          }
        } catch (err) {
          logErr("[acp] get_planning_state failed on load; using prefs projection:", err);
        }
      }

      const entry: SessionEntry = {
        acpSessionId: sessionId,
        threadId: sessionId,
        sessionId,
        cwd,
        lastMode: currentMode,
        promptAbort: null,
        cancelled: false,
        approvalToolCalls: new Map(),
        modelMap: new Map(),
      };
      this.sessions.set(sessionId, entry);

      const config = isRecord(metadata.config) ? metadata.config : {};
      const preferredProvider = text(config.provider) || text(row.modelProvider);
      const preferredModel = text(config.modelId) || text(row.modelId);
      const models = await this.loadModels(
        entry,
        preferredProvider && preferredModel
          ? { provider: preferredProvider, modelId: preferredModel }
          : undefined,
      );
      void this.sendCommands(entry);
      return {
        modes: modeState(currentMode),
        ...(models ? { models } : {}),
      };
    } catch (err) {
      throw toRequestError(err);
    }
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const entry = this.requireSession(params.sessionId);
    if (!this.initialized) {
      // 兼容不握手直接发 prompt 的客户端：照常处理，仅留日志
      logErr("[acp] session/prompt received before initialize");
    }
    if (this.bridge.hasPrompt(entry.threadId)) {
      throw new acp.RequestError(-32602, "session already has an active prompt");
    }

    const parsed = parsePromptContent(params.prompt, entry.cwd);
    if (!parsed.text && parsed.attachments.length === 0) {
      throw new acp.RequestError(-32602, "prompt contains no text or image content");
    }

    entry.cancelled = false;
    const abort = new AbortController();
    entry.promptAbort = abort;

    const translator: StreamTranslator = new StreamTranslator({
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      initialMode: entry.lastMode,
      sendUpdate: (update) => this.sendUpdate(entry.sessionId, update),
      onPermission: (data): Promise<void> =>
        this.handlePermission(entry, translator, data, abort.signal),
      onQuestion: (data): Promise<void> => this.handleQuestion(entry, data),
      onInteractionResolved: (data): Promise<void> =>
        this.handleInteractionResolved(entry, data),
    });

    const { done } = this.bridge.startPrompt({
      threadId: entry.threadId,
      sessionId: entry.sessionId,
      text: parsed.text,
      cwd: entry.cwd,
      ...(parsed.attachments.length ? { attachments: parsed.attachments } : {}),
      onChunk: (chunk) => translator.handle(chunk),
    });

    // prompt 结束后清理取消状态（即使 ACP 请求已因取消超时提前返回，
    // bridge 的 prompt 流仍会继续到 finish，这个 finally 负责归位）。
    done
      .catch(() => {})
      .finally(() => {
        if (entry.promptAbort === abort) entry.promptAbort = null;
        entry.cancelled = false;
        entry.approvalToolCalls.clear();
      });

    try {
      const result = await this.waitPrompt(entry, done, abort.signal);
      await translator.finishPending();
      return { stopReason: result.stopReason };
    } catch (err) {
      await translator.finishPending();
      // 用 abort.signal 而不是 entry.cancelled：done 的 finally 会先把
      // entry.cancelled 归位，注册顺序上可能早于这里的 catch。
      if (entry.cancelled || abort.signal.aborted) return { stopReason: "cancelled" };
      throw toRequestError(err);
    }
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    const entry = this.sessions.get(params.sessionId);
    if (!entry) return;
    entry.cancelled = true;
    entry.promptAbort?.abort();
    this.bridge.abort(entry.threadId);
  }

  /** 进程退出/客户端断开：中止所有会话并解除权限等待 */
  cancelAll(): void {
    for (const entry of this.sessions.values()) {
      entry.cancelled = true;
      entry.promptAbort?.abort();
    }
    this.bridge.abortAll();
  }

  async setSessionMode(
    params: acp.SetSessionModeRequest,
  ): Promise<acp.SetSessionModeResponse> {
    const entry = this.requireSession(params.sessionId);
    const mode = params.modeId;
    if (!ACP_MODES.some((item) => item.id === mode)) {
      throw new acp.RequestError(-32602, `unknown mode: ${mode}`);
    }
    try {
      await this.bridge.request({
        type: "set_mode",
        threadId: entry.threadId,
        sessionId: entry.sessionId,
        mode,
      });
      entry.lastMode = mode as AcpMode;
      await this.sendUpdate(entry.sessionId, {
        sessionUpdate: "current_mode_update",
        currentModeId: entry.lastMode,
      });
      return {};
    } catch (err) {
      throw toRequestError(err);
    }
  }

  async setSessionModel(
    params: acp.SetSessionModelRequest,
  ): Promise<acp.SetSessionModelResponse> {
    const entry = this.requireSession(params.sessionId);
    let target = entry.modelMap.get(params.modelId);
    if (!target) {
      // 容错：客户端可能用 provider/modelId 原始拼接
      const slash = params.modelId.indexOf("/");
      if (slash > 0) {
        target = {
          provider: params.modelId.slice(0, slash),
          modelId: params.modelId.slice(slash + 1),
        };
      }
    }
    if (!target) {
      throw new acp.RequestError(-32602, `unknown model: ${params.modelId}`);
    }
    try {
      await this.bridge.request({
        type: "set_model",
        threadId: entry.threadId,
        sessionId: entry.sessionId,
        provider: target.provider,
        modelId: target.modelId,
      });
      return {};
    } catch (err) {
      throw toRequestError(err);
    }
  }

  /* ------------------------------ 权限 / 提问 ------------------------------ */

  private async handlePermission(
    entry: SessionEntry,
    translator: StreamTranslator,
    data: ToolApprovalData,
    signal: AbortSignal,
  ): Promise<void> {
    if (!data.approvalId || !data.toolCallId) return;
    entry.approvalToolCalls.set(data.approvalId, data.toolCallId);
    await translator.ensureToolCall(data);

    const options = permissionOptionsFor(data.toolName, data.canRemember);
    const toolCall: acp.ToolCallUpdate = {
      toolCallId: data.toolCallId,
      title: toolTitleFor(data.toolName, data.input),
      kind: toolKindFor(data.toolName, data.input),
      status: "pending",
      rawInput: permissionInputFor(data.toolName, data.input),
      locations: locationsForInput(data.input, entry.cwd),
    };

    let outcome: acp.RequestPermissionResponse["outcome"];
    const abortCleanup: { remove?: () => void } = {};
    let permissionTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const aborted = new Promise<{ outcome: acp.RequestPermissionResponse["outcome"] }>(
        (resolve) => {
          const onAbort = () => resolve({ outcome: { outcome: "cancelled" } });
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          abortCleanup.remove = () => signal.removeEventListener("abort", onAbort);
        },
      );
      const timeout = new Promise<{ outcome: acp.RequestPermissionResponse["outcome"] }>(
        (resolve) => {
          permissionTimer = setTimeout(
            () => resolve({ outcome: { outcome: "cancelled" } }),
            5 * 60 * 1000,
          );
          permissionTimer.unref?.();
        },
      );
      const response = await Promise.race([
        this.conn.requestPermission({
          sessionId: entry.sessionId,
          toolCall,
          options,
        }),
        aborted,
        timeout,
      ]);
      outcome = response.outcome;
    } catch (err) {
      logErr("[acp] requestPermission failed; treating as rejection:", err);
      outcome = { outcome: "cancelled" };
    } finally {
      if (permissionTimer) clearTimeout(permissionTimer);
      abortCleanup.remove?.();
    }

    entry.approvalToolCalls.delete(data.approvalId);
    if (entry.cancelled || signal.aborted) {
      // 内部 abort 已结算挂起审批；不要再补 tool_confirm
      await translator.failToolCall(data.toolCallId, "Cancelled by user.");
      return;
    }

    let approved = false;
    let remember = false;
    let reason = "User rejected this tool call.";
    if (outcome.outcome === "selected") {
      if (outcome.optionId === "allow_once") {
        approved = true;
        reason = "";
      } else if (outcome.optionId === "allow_always") {
        approved = true;
        remember = true;
        reason = "";
      }
    } else {
      reason = "Permission request was cancelled.";
    }

    try {
      await this.bridge.request({
        type: "tool_confirm",
        threadId: entry.threadId,
        sessionId: entry.sessionId,
        approvalId: data.approvalId,
        approved,
        ...(remember ? { remember: true } : {}),
      });
    } catch (err) {
      // 重启/已结算的陈旧条目：内部可能已经没有挂起项，按日志处理即可
      logErr("[acp] tool_confirm failed:", err);
    }
    if (!approved) {
      await translator.failToolCall(data.toolCallId, reason);
    } else {
      // 授权通过：把 pending 推进到 in_progress；随后内部 tool_execution_start
      // 若再发 tool-input-available，会走 update 分支，不会重复 tool_call。
      await translator.markToolRunning(data.toolCallId);
    }
  }

  private async handleQuestion(
    entry: SessionEntry,
    data: Record<string, unknown>,
  ): Promise<void> {
    const questionId = text(data.questionId);
    if (!questionId) return;
    const questions = Array.isArray(data.questions)
      ? (data.questions as Array<Record<string, unknown>>)
      : [];
    const lines: string[] = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const title = text(q.title, `Question ${i + 1}`);
      lines.push(`Q${i + 1}: ${title}`);
      const options = Array.isArray(q.options)
        ? (q.options as Array<Record<string, unknown>>)
        : [];
      for (let j = 0; j < options.length; j++) {
        lines.push(`  - ${text(options[j].title, `option ${j + 1}`)}`);
      }
    }
    const note =
      "\n\n[Interactive question cards are not available over ACP. " +
      "The question was cancelled for this turn; answer in your next message and the agent can continue.]\n" +
      lines.join("\n");
    await this.sendUpdate(entry.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: note },
    });
    try {
      await this.bridge.request({
        type: "question_answer",
        threadId: entry.threadId,
        sessionId: entry.sessionId,
        questionId,
        cancelled: true,
        answers: [],
      });
    } catch (err) {
      logErr("[acp] question auto-cancel failed:", err);
    }
  }

  private async handleInteractionResolved(
    entry: SessionEntry,
    data: Record<string, unknown>,
  ): Promise<void> {
    const interactionId = text(data.interactionId);
    if (!interactionId) return;
    const toolCallId = entry.approvalToolCalls.get(interactionId);
    if (!toolCallId) return;
    entry.approvalToolCalls.delete(interactionId);
    await this.sendUpdate(entry.sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "failed",
      content: [
        {
          type: "content",
          content: { type: "text", text: "The pending interaction was resolved externally." },
        },
      ],
    });
  }

  /* ------------------------------ 辅助 ------------------------------ */

  private async waitPrompt(
    entry: SessionEntry,
    done: Promise<{ stopReason: "end_turn" | "cancelled" }>,
    signal: AbortSignal,
  ): Promise<{ stopReason: "end_turn" | "cancelled" }> {
    // 正常路径直接等 done；一旦 session/cancel 触发，再给内部收尾 30s。
    // 超时先回 cancelled，内部流继续收尾（bridge.hasPrompt 仍会拒绝同一
    // session 的下一次 prompt，直到真正的 finish 到达）。
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancelFallback = new Promise<{ stopReason: "cancelled" }>((resolve) => {
      const onAbort = () => {
        timer = setTimeout(() => resolve({ stopReason: "cancelled" }), 30_000);
        timer.unref?.();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      done
        .finally(() => {
          signal.removeEventListener("abort", onAbort);
          if (timer) clearTimeout(timer);
        })
        .catch(() => {});
    });
    return Promise.race([done, cancelFallback]);
  }

  private requireSession(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new acp.RequestError(-32602, `unknown session: ${sessionId}`);
    return entry;
  }

  private validateCwd(cwd: string): string {
    const value = typeof cwd === "string" ? cwd.trim() : "";
    if (!value || !isAbsolute(value)) {
      throw new acp.RequestError(-32602, "session/new requires an absolute cwd");
    }
    const resolved = resolve(value);
    let stat;
    try {
      stat = statSync(resolved);
    } catch {
      throw new acp.RequestError(-32602, `cwd does not exist: ${resolved}`);
    }
    if (!stat.isDirectory()) {
      throw new acp.RequestError(-32602, `cwd is not a directory: ${resolved}`);
    }
    return resolved;
  }

  private logIgnoredMcpServers(servers: unknown): void {
    if (!Array.isArray(servers) || servers.length === 0) return;
    const names = servers
      .map((server) =>
        server && typeof server === "object" && typeof (server as { name?: unknown }).name === "string"
          ? (server as { name: string }).name
          : "?",
      )
      .join(", ");
    logErr(
      `[acp] session mcpServers ignored (use ~/.kova/mcp.json or workspace .mcp.json): ${names}`,
    );
  }

  private async sendUpdate(
    sessionId: string,
    update: acp.SessionNotification["update"],
  ): Promise<void> {
    try {
      await this.conn.sessionUpdate({ sessionId, update });
    } catch (err) {
      // 客户端断开：后续 update 没有接收方；不阻塞内部 turn 收尾
      logErr("[acp] session/update failed:", err);
    }
  }

  private async sendCommands(entry: SessionEntry): Promise<void> {
    try {
      const res = await this.bridge.request({
        type: "get_commands",
        cwd: entry.cwd,
      });
      const commands = Array.isArray(res.commands)
        ? (res.commands as Array<Record<string, unknown>>)
        : [];
      const availableCommands: acp.AvailableCommand[] = commands.map((command) => ({
        name: text(command.name),
        description: text(command.description),
        ...(typeof command.argumentHint === "string" && command.argumentHint
          ? { input: { hint: command.argumentHint } }
          : {}),
      }));
      if (availableCommands.length === 0) return;
      await this.sendUpdate(entry.sessionId, {
        sessionUpdate: "available_commands_update",
        availableCommands,
      });
    } catch (err) {
      logErr("[acp] get_commands failed:", err);
    }
  }

  private async loadModels(
    entry: SessionEntry,
    preferred?: { provider: string; modelId: string },
  ): Promise<acp.SessionModelState | undefined> {
    try {
      const [currentRes, listRes] = await Promise.all([
        this.bridge.request({ type: "get_model" }),
        this.bridge.request({ type: "list_models", authedOnly: true }),
      ]);
      const payload = listRes as unknown as ModelsPayload;
      const models = Array.isArray(payload.models) ? payload.models : [];
      const available: acp.ModelInfo[] = [];
      entry.modelMap.clear();
      for (const model of models) {
        if (model.enabled === false) continue;
        if (model.authed === false) continue;
        const encoded = `${model.provider}/${model.id}`;
        if (entry.modelMap.has(encoded)) continue;
        entry.modelMap.set(encoded, {
          provider: model.provider,
          modelId: model.id,
          name: model.name || model.id,
          description: model.providerName,
        });
        if (available.length >= 200) continue;
        available.push({
          modelId: encoded,
          name: model.name || model.id,
          description: model.providerName,
        });
      }
      if (available.length === 0) return undefined;

      const preferredProvider = preferred?.provider || text(currentRes.provider);
      const preferredModel = preferred?.modelId || text(currentRes.modelId);
      const preferredKey = `${preferredProvider}/${preferredModel}`;
      if (preferredProvider && preferredModel && !entry.modelMap.has(preferredKey)) {
        // 当前模型不在已认证列表里：宁可不暴露模型选择器，也不要把 current
        // 指到另一个模型上（那会让编辑器显示错误的"当前模型"）。
        return undefined;
      }
      const currentModelId =
        preferredProvider && preferredModel ? preferredKey : available[0].modelId;
      // 列表超过 200 条时 current 可能落在截断之外；ACP 的 currentModelId
      // 应当出现在 availableModels 里，这里补当前项（最多 201 条）。
      if (!available.some((item) => item.modelId === currentModelId)) {
        const target = entry.modelMap.get(currentModelId);
        if (target) {
          available.push({
            modelId: currentModelId,
            name: target.name || target.modelId,
            ...(target.description ? { description: target.description } : {}),
          });
        }
      }
      return { availableModels: available, currentModelId };
    } catch (err) {
      logErr("[acp] list_models failed; model picker disabled:", err);
      return undefined;
    }
  }
}
