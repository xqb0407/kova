/**
 * ACP Agent 实现（SDK 1.3.0 builder API）：方法层 + 会话状态机。
 *
 * 职责边界：
 * - ACP 方法 → 内部命令/prompt（经 AcpBridge）；
 * - 会话表：ACP sessionId ↔ 内部 threadId/sessionId、cwd、模式、模型映射；
 * - 权限卡：data-toolApproval → session/request_permission → tool_confirm；
 * - session/load：thread_snapshot 历史回放；
 * - 模型选择：1.x 协议走 configOptions（session/new|load 下发 +
 *   session/set_config_option 切换），models 字段已在 1.x 移除。
 *
 * 不在这里做 Agent 组装：会话创建/恢复/工具装配全部复用现有
 * resolveSession / dispatchPrompt。
 */
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { logErr } from "../log";
import { getCurrentThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "../model/state";
import { ACP_AGENT_INFO } from "./config";
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

const ACP_CONFIG_MODEL = "model";
const ACP_CONFIG_MODE = "mode";
const ACP_CONFIG_THINKING_EFFORT = "thinking_effort";
const CONFIG_OPTIONS_CAP = 200;

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
  /** 上次推给客户端的会话标题：session_info_update 只在变化时发 */
  lastTitle: string | null;
  /** 会话思考档位（config option 切换 / 恢复自偏好列，缺省跟随全局） */
  thinkingLevel: ThinkingLevel;
  /** 会话定靶模型（config option 切换 / 恢复自偏好列；null = 跟随全局默认） */
  model: { provider: string; modelId: string } | null;
  /** 最近一次 prompt 的客户端上下文：轮收尾的 context_changed 帧到达时
   *  用它推 usage_update（帧在 finish 之后到达，生命周期跨过 prompt 返回） */
  activeClient?: acp.AgentContext;
  /** 上一次成功构建的配置项：目录查询失败时回放，避免广播残缺集合让客户端
   *  把 Model/Thinking 下拉整个丢掉（Mode 的 currentValue 会跟 lastMode 修正） */
  lastConfigOptions?: acp.SessionConfigOption[];
};

type ModelsPayload = {
  models?: Array<{
    provider: string;
    providerName?: string;
    id: string;
    name?: string;
    enabled?: boolean;
    authed?: boolean;
    supportedThinkingLevels?: string[];
  }>;
  providers?: Array<{ id: string; name: string; authed?: boolean }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Model 下拉项文案：模型名 · 服务名（与服务卡片/桌面选择器同口径） */
function modelOptionLabel(name: string, providerName?: string): string {
  return `${name}${providerName ? ` · ${providerName}` : ""}`;
}

/** 配置项里是否已有某个取值（我们的 select 都是扁平列表；分组结构按无值处理） */
function configOptionHasValue(option: acp.SessionConfigSelect, value: string): boolean {
  return (option.options as Array<{ value?: string }>).some((item) => item.value === value);
}

function projectMode(mode: unknown): AcpMode {
  return mode === "plan" ? "plan" : mode === "ask" ? "ask" : "agent";
}

/** 思考档位宽松投影：非法/旧值返回 undefined，调用方按优先级回落 */
function projectThinkingLevel(value: unknown): ThinkingLevel | undefined {
  const level = text(value);
  return (THINKING_LEVELS as readonly string[]).includes(level)
    ? (level as ThinkingLevel)
    : undefined;
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

/** ISO 时间戳规整：modified 非 ISO/缺省时回 null（schema 允许 null） */
function isoOrNull(value: unknown): string | null {
  const s = text(value);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
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

export type KovaAcpAgent = {
  app: acp.AgentApp;
  /** 进程退出/客户端断开：中止所有会话并解除权限等待 */
  cancelAll: () => void;
};

export function createKovaAcpAgent(options: {
  bridge: AcpBridge;
  version?: string;
}): KovaAcpAgent {
  const { bridge } = options;
  const sessions = new Map<string, SessionEntry>();

  const notifyUpdate = (
    client: acp.AgentContext,
    sessionId: string,
    update: acp.SessionNotification["update"],
  ): Promise<void> =>
    client
      .notify(acp.methods.client.session.update, { sessionId, update })
      .catch((err) => {
        // 客户端断开：后续 update 没有接收方；不阻塞内部 turn 收尾
        logErr("[acp] session/update failed:", err);
      });

  // 轮收尾的上下文读数 → usage_update（IDEA 的上下文用量指示）
  bridge.setContextUsageListener((sessionId, usage) => {
    const entry = sessions.get(sessionId);
    if (!entry?.activeClient) return;
    void notifyUpdate(entry.activeClient, sessionId, {
      sessionUpdate: "usage_update",
      used: usage.used,
      size: usage.size,
    });
  });

  /** 偏好列无效（NULL/旧值/goal）时的权威模式解析：读 planning 状态，
   *  goal 档降为 agent（ACP 不暴露自治循环档）。load/resume 共用。 */
  const resolveEntryMode = async (
    threadId: string,
    sessionId: string,
    row: Record<string, unknown>,
  ): Promise<AcpMode> => {
    try {
      const planning = await bridge.request({
        type: "get_planning_state",
        threadId,
        sessionId,
      });
      if (planning.mode === "goal") {
        await bridge.request({
          type: "set_mode",
          threadId,
          sessionId,
          mode: "agent",
        });
        return "agent";
      }
      return projectMode(planning.mode);
    } catch (err) {
      logErr("[acp] get_planning_state failed; using prefs projection:", err);
      return projectMode(row.mode);
    }
  };

  /** 已认证模型 + 模式 + 思考档位 → configOptions（1.x 的会话控制载体，
   *  IDEA Air 每个选项渲染为一个下拉）。preferred 是会话应显示的当前模型；
   *  不在列表时降级到首项。 */
  const buildConfigOptions = async (
    entry: SessionEntry,
    preferredOverride?: { provider: string; modelId: string },
  ): Promise<acp.SessionConfigOption[]> => {
    const configOptions: acp.SessionConfigOption[] = [];
    // 模式与模型列表无关：目录查询失败也要下发（否则编辑器连模式都丢）
    configOptions.push({
      type: "select",
      id: ACP_CONFIG_MODE,
      name: "Mode",
      description: "Controls how the agent operates in this Session.",
      category: "mode",
      currentValue: entry.lastMode,
      options: ACP_MODES.map((mode) => ({ value: mode.id, name: mode.name })),
    });
    try {
      const preferred = preferredOverride ?? entry.model ?? undefined;
      const [currentRes, listRes] = await Promise.all([
        bridge.request({ type: "get_model" }),
        bridge.request({ type: "list_models", authedOnly: true }),
      ]);
      const payload = listRes as unknown as ModelsPayload;
      const models = Array.isArray(payload.models) ? payload.models : [];
      const values: Array<{ id: string; label: string }> = [];
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
        if (values.length >= CONFIG_OPTIONS_CAP) continue;
        values.push({
          id: encoded,
          label: modelOptionLabel(model.name || model.id, model.providerName),
        });
      }

      // 当前模型（会话定靶 > 全局）可能被启用过滤或 200 条截断排除在 values
      // 之外，但协议要求 currentValue 必须是 options 之一。目录里查得到就把
      // 这一项补回来：降级到首项会让编辑器显示与实际运行不同的模型。
      const preferredProvider = preferred?.provider || text(currentRes.provider);
      const preferredModel = preferred?.modelId || text(currentRes.modelId);
      const preferredKey =
        preferredProvider && preferredModel ? `${preferredProvider}/${preferredModel}` : "";
      if (preferredKey && !entry.modelMap.has(preferredKey)) {
        const row = models.find((m) => `${m.provider}/${m.id}` === preferredKey);
        if (row) {
          entry.modelMap.set(preferredKey, {
            provider: row.provider,
            modelId: row.id,
            name: row.name || row.id,
            description: row.providerName,
          });
          logErr("[acp] current model filtered out of options; keeping it visible:", preferredKey);
        }
      }

      let currentModel: { provider: string; modelId: string } | undefined;
      if (entry.modelMap.size > 0) {
        let currentValue: string;
        if (preferredKey && entry.modelMap.has(preferredKey)) {
          currentValue = preferredKey;
        } else {
          // 首选模型已不在目录（删模型/换网关）：运行侧 resolveSession 会回落
          // 全局当前模型，下拉跟着全局走比落到首项更接近真值。
          const globalKey = `${text(currentRes.provider)}/${text(currentRes.modelId)}`;
          if (preferredKey && entry.modelMap.has(globalKey)) {
            logErr(
              "[acp] preferred model missing from catalog; falling back to current:",
              preferredKey,
              "->",
              globalKey,
            );
            currentValue = globalKey;
          } else {
            if (preferredKey) {
              // 首选模型不在已认证列表（动态发现模型未镜像/被停用）：降级到首项，
              // 与 resolveCurrentModel 的 getAvailable()[0] 兜底同语义。整体缺席
              // 会让编辑器彻底失去模型选择（2026-11 实测）。
              logErr(
                "[acp] preferred model not in config values, degrading:",
                preferredKey,
                "->",
                values[0]?.id ?? "",
              );
            }
            currentValue = values[0]?.id ?? [...entry.modelMap.keys()][0] ?? "";
          }
        }
        // 200 条截断外 / 被过滤的当前项：补一条（最多 201 条），否则
        // currentValue 指向 options 之外的模型，客户端会显示空选或别的模型。
        if (!values.some((v) => v.id === currentValue)) {
          const target = entry.modelMap.get(currentValue)!;
          values.push({
            id: currentValue,
            label: modelOptionLabel(target.name || target.modelId, target.description),
          });
        }
        currentModel = entry.modelMap.get(currentValue);
        configOptions.push({
          type: "select",
          id: ACP_CONFIG_MODEL,
          name: "Model",
          description: "Selects the model used by subsequent turns in this Session.",
          category: "model",
          currentValue,
          options: values.map((v) => ({ value: v.id, name: v.label })),
        });
      }

      // 思考档位（跟随「实际生效模型」的 supportedThinkingLevels——注意是
      // 降级后的 currentModel，不是 kv 里可能缺席的首选模型；"off" 恒可选 =
      // 关闭思考，是全局默认档）。模型无思考支持时不下发这一项。
      const currentRow = currentModel
        ? models.find((m) => m.provider === currentModel.provider && m.id === currentModel.modelId)
        : undefined;
      const supported = (currentRow?.supportedThinkingLevels ?? []).filter(
        (l): l is string => typeof l === "string",
      );
      const levels = ["off", ...supported];
      if (levels.length > 1) {
        const current = entry.thinkingLevel;
        configOptions.push({
          type: "select",
          id: ACP_CONFIG_THINKING_EFFORT,
          name: "Thinking effort",
          description: "Controls the reasoning effort for the selected model in this Session.",
          category: "thought_level",
          currentValue: levels.includes(current) ? current : levels[0],
          options: levels.map((l) => ({ value: l, name: l })),
        });
      }
    } catch (err) {
      logErr("[acp] config options build failed; keeping last known:", err);
      // 目录查询失败时不要把只剩 Mode 的残缺集合推给客户端——客户端会据此
      // 丢掉 Model/Thinking 下拉。回放上一次成功的集合，并修正当前值：
      // Mode 跟 entry.lastMode；Model 若已切到新模型且旧列表里有这一项，也跟过去。
      const previous = entry.lastConfigOptions;
      if (previous?.length) {
        const modelKey = entry.model
          ? `${entry.model.provider}/${entry.model.modelId}`
          : "";
        return previous.map((option) => {
          if (option.type !== "select") return option;
          if (option.id === ACP_CONFIG_MODE) {
            return { ...option, currentValue: entry.lastMode };
          }
          if (
            option.id === ACP_CONFIG_MODEL &&
            modelKey &&
            configOptionHasValue(option, modelKey)
          ) {
            return { ...option, currentValue: modelKey };
          }
          if (
            option.id === ACP_CONFIG_THINKING_EFFORT &&
            configOptionHasValue(option, entry.thinkingLevel)
          ) {
            return { ...option, currentValue: entry.thinkingLevel };
          }
          return option;
        });
      }
    }
    entry.lastConfigOptions = configOptions;
    return configOptions;
  };

  const sendCommands = async (client: acp.AgentContext, entry: SessionEntry): Promise<void> => {
    try {
      const res = await bridge.request({
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
      await notifyUpdate(client, entry.sessionId, {
        sessionUpdate: "available_commands_update",
        availableCommands,
      });
    } catch (err) {
      logErr("[acp] get_commands failed:", err);
    }
  };

  /** 标题生成（session-title-summarize）完成后推 session_info_update：
   *  只在标题变化时发，让编辑器的会话列表跟上桌面端命名。 */
  const pushTitleUpdate = async (client: acp.AgentContext, entry: SessionEntry): Promise<void> => {
    try {
      const res = await bridge.request({
        type: "session_summary",
        sessionId: entry.sessionId,
      });
      const row = isRecord(res.summary) ? res.summary : undefined;
      const title = text(row?.name);
      if (!title || title === entry.lastTitle) return;
      entry.lastTitle = title;
      await notifyUpdate(client, entry.sessionId, {
        sessionUpdate: "session_info_update",
        title,
      });
    } catch (err) {
      logErr("[acp] session_info_update failed:", err);
    }
  };

  /* ------------------------------ 权限 / 提问 ------------------------------ */

  const handlePermission = async (
    client: acp.AgentContext,
    entry: SessionEntry,
    translator: StreamTranslator,
    data: ToolApprovalData,
    signal: AbortSignal,
  ): Promise<void> => {
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
        client.request(acp.methods.client.session.requestPermission, {
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
      await bridge.request({
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
  };

  const handleQuestion = async (
    client: acp.AgentContext,
    entry: SessionEntry,
    data: Record<string, unknown>,
  ): Promise<void> => {
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
    await notifyUpdate(client, entry.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: note },
    });
    try {
      await bridge.request({
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
  };

  const handleInteractionResolved = async (
    client: acp.AgentContext,
    entry: SessionEntry,
    data: Record<string, unknown>,
  ): Promise<void> => {
    const interactionId = text(data.interactionId);
    if (!interactionId) return;
    const toolCallId = entry.approvalToolCalls.get(interactionId);
    if (!toolCallId) return;
    entry.approvalToolCalls.delete(interactionId);
    await notifyUpdate(client, entry.sessionId, {
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
  };

  const app = acp.agent({ name: "kova-worker" });

  app.onRequest(acp.methods.agent.initialize, async (ctx) => {
    void ctx.params;
    // JetBrains 初始化级斜杠命令（客户端扩展字段，带 inputSchema）：标准
    // available_commands_update 仍按会话推送，这里只是让编辑器启动期就渲染
    // `/` 菜单。目录闸门未放行时最多等 2.5s，超时只走会话级推送。
    let availableCommands:
      | Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
      | undefined;
    try {
      const res = await Promise.race([
        bridge.request({ type: "get_commands" }),
        new Promise<null>((resolve) => {
          const t = setTimeout(() => resolve(null), 2_500);
          t.unref?.();
        }),
      ]);
      const commands = Array.isArray(res?.commands)
        ? (res!.commands as Array<Record<string, unknown>>).slice(0, 100)
        : [];
      const mapped = commands
        .filter((c) => typeof c.name === "string" && c.name)
        .map((c) => ({
          name: String(c.name),
          description: typeof c.description === "string" ? c.description : "",
          inputSchema:
            typeof c.argumentHint === "string" && c.argumentHint
              ? {
                  type: "object",
                  properties: { args: { type: "string", description: c.argumentHint } },
                }
              : { type: "object", properties: {} },
        }));
      if (mapped.length > 0) availableCommands = mapped;
    } catch (err) {
      logErr("[acp] initialize commands build failed:", err);
    }
    const response: acp.InitializeResponse & {
      availableCommands?: Array<{
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
      }>;
    } = {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: ACP_AGENT_INFO.name, title: "Kova", version: ACP_AGENT_INFO.version },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
        sessionCapabilities: {
          list: {},
          resume: {},
          close: {},
        },
      },
      authMethods: [],
      ...(availableCommands ? { availableCommands } : {}),
    };
    return response;
  });

  app.onRequest(acp.methods.agent.authenticate, async () => {
    // 凭据来自环境变量/本地 DB/桌面共享镜像，没有交互式认证流程
    return {};
  });

  app.onRequest(acp.methods.agent.session.new, async (ctx) => {
    try {
      const cwd = validateCwd(ctx.params.cwd);
      logIgnoredMcpServers(ctx.params.mcpServers);
      const threadId = `acp-${randomUUID()}`;
      const res = await bridge.request({
        type: "new_session",
        threadId,
        cwd,
      });
      const sessionId = text(res.sessionId);
      if (!sessionId) throw new AcpInternalError("new_session returned no sessionId");

      let currentMode: AcpMode = "agent";
      try {
        const planning = await bridge.request({
          type: "get_planning_state",
          threadId,
          sessionId,
        });
        currentMode = projectMode(planning.mode);
        if (planning.mode === "goal") {
          // ACP 不暴露 goal；新建会话若跟随到 goal 档，强制降为 agent，
          // 否则首轮会进入无人值守的自治循环。
          await bridge.request({ type: "set_mode", threadId, sessionId, mode: "agent" });
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
        lastTitle: null,
        thinkingLevel: getCurrentThinkingLevel(),
        model: null,
      };
      sessions.set(sessionId, entry);

      const configOptions = await buildConfigOptions(entry);
      void sendCommands(ctx.client, entry);
      return {
        sessionId,
        modes: modeState(currentMode),
        configOptions,
      };
    } catch (err) {
      throw toRequestError(err);
    }
  });

  app.onRequest(acp.methods.agent.session.load, async (ctx) => {
    try {
      logIgnoredMcpServers(ctx.params.mcpServers);
      const sessionId = ctx.params.sessionId;
      // 用 session_summary 而不是 list_sessions：list_sessions 会过滤掉
      // messageCount=0 的空会话，刚 new 出来还没发过消息的会话重连后
      // 会被误判为不存在。
      const summaryRes = await bridge.request({
        type: "session_summary",
        sessionId,
      });
      const row = isRecord(summaryRes.summary) ? summaryRes.summary : undefined;
      if (!row) throw new AcpInternalError(`session not found: ${sessionId}`);

      const running = await bridge.request({ type: "list_running" });
      const runningIds = Array.isArray(running.sessionIds) ? running.sessionIds : [];
      if (runningIds.includes(sessionId)) {
        throw new acp.RequestError(-32600, "session is running; cancel it before loading");
      }

      const snapshotRes = await bridge.request({
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
      // 转录真值（§6 M4）：model_change / thinking_level_change 的扫描结果优先于
      // 偏好列。老会话的偏好列可能为 NULL，只读 row 会把恢复后的下拉显示成
      // 全局模型/档位，而 resolveSession 实际按转录里的模型跑。
      const snapshotConfig = isRecord(metadata.config) ? metadata.config : {};
      const configModel =
        text(snapshotConfig.provider) && text(snapshotConfig.modelId)
          ? {
              provider: text(snapshotConfig.provider),
              modelId: text(snapshotConfig.modelId),
            }
          : null;

      const cwd =
        text(metadata.workspacePath) || text(row.cwd) || ctx.params.cwd || process.cwd();
      const messages = Array.isArray(snapshot.messages)
        ? (snapshot.messages as SnapshotMessage[])
        : [];

      await replayHistory({
        sessionId,
        cwd,
        messages,
        sendUpdate: (update) => notifyUpdate(ctx.client, sessionId, update),
      });
      // 恢复的会话若本进程有缓存读数，立刻回推一次用量（编辑器恢复即见占用）
      const cachedUsage = bridge.lastContextUsage(sessionId);
      if (cachedUsage) {
        await notifyUpdate(ctx.client, sessionId, {
          sessionUpdate: "usage_update",
          used: cachedUsage.used,
          size: cachedUsage.size,
        });
      }

      let currentMode = projectMode(row.mode);
      // 偏好列为 NULL（旧会话）或 goal（ACP 不暴露）时，真实模式可能来自
      // kv「最近一次使用」；这时才用 get_planning_state 取权威值，避免每次
      // load 都为普通会话重建 run（大会话的转录读取成本不低）。
      if (currentMode !== row.mode) {
        currentMode = await resolveEntryMode(sessionId, sessionId, row);
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
        lastTitle: text(row.name) || null,
        thinkingLevel:
          projectThinkingLevel(snapshotConfig.thinkingLevel) ??
          projectThinkingLevel(row.thinkingLevel) ??
          getCurrentThinkingLevel(),
        model:
          configModel ??
          (text(row.modelProvider) && text(row.modelId)
            ? { provider: text(row.modelProvider), modelId: text(row.modelId) }
            : null),
      };
      sessions.set(sessionId, entry);

      const configOptions = await buildConfigOptions(entry);
      void sendCommands(ctx.client, entry);
      return {
        modes: modeState(currentMode),
        configOptions,
      };
    } catch (err) {
      throw toRequestError(err);
    }
  });

  app.onRequest(acp.methods.agent.session.list, async (ctx) => {
    try {
      // includeEmpty：桌面主列表会滤掉 messageCount=0 的空壳，但 ACP 客户端
      // 刚 new 出来的会话必须可见可寻址
      const res = await bridge.request({
        type: "list_sessions",
        includeEmpty: true,
      });
      const rows = Array.isArray(res.sessions)
        ? (res.sessions as Array<Record<string, unknown>>)
        : [];
      const cwdFilter =
        typeof ctx.params.cwd === "string" && ctx.params.cwd.trim()
          ? resolve(ctx.params.cwd)
          : null;
      const mapped: acp.SessionInfo[] = [];
      for (const row of rows) {
        if (row.archived === true) continue;
        const cwd = text(row.cwd);
        if (!cwd) continue;
        if (cwdFilter && resolve(cwd) !== cwdFilter) continue;
        mapped.push({
          sessionId: text(row.sessionId),
          cwd,
          title: text(row.name) || null,
          updatedAt: isoOrNull(row.modified),
        });
      }
      const start = Number.parseInt(ctx.params.cursor ?? "", 10);
      const offset = Number.isFinite(start) && start >= 0 ? start : 0;
      const page = 100;
      const slice = mapped.slice(offset, offset + page);
      const nextCursor =
        offset + page < mapped.length ? String(offset + page) : null;
      return { sessions: slice, ...(nextCursor ? { nextCursor } : {}) };
    } catch (err) {
      throw toRequestError(err);
    }
  });

  app.onRequest(acp.methods.agent.session.resume, async (ctx) => {
    try {
      logIgnoredMcpServers(ctx.params.mcpServers);
      const sessionId = ctx.params.sessionId;
      const summaryRes = await bridge.request({
        type: "session_summary",
        sessionId,
      });
      const row = isRecord(summaryRes.summary) ? summaryRes.summary : undefined;
      if (!row) throw new AcpInternalError(`session not found: ${sessionId}`);
      if (row.archived === true) {
        throw new acp.RequestError(-32602, `session is archived: ${sessionId}`);
      }

      const running = await bridge.request({ type: "list_running" });
      const runningIds = Array.isArray(running.sessionIds) ? running.sessionIds : [];
      if (runningIds.includes(sessionId)) {
        throw new acp.RequestError(-32600, "session is running; cancel it before resuming");
      }

      const cwd = text(row.cwd) || ctx.params.cwd || process.cwd();
      const currentMode = await resolveEntryMode(sessionId, sessionId, row);
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
        lastTitle: text(row.name) || null,
        thinkingLevel:
          projectThinkingLevel(row.thinkingLevel) ?? getCurrentThinkingLevel(),
        model:
          text(row.modelProvider) && text(row.modelId)
            ? { provider: text(row.modelProvider), modelId: text(row.modelId) }
            : null,
      };
      sessions.set(sessionId, entry);

      const configOptions = await buildConfigOptions(entry);
      void sendCommands(ctx.client, entry);
      return {
        modes: modeState(currentMode),
        configOptions,
      };
    } catch (err) {
      throw toRequestError(err);
    }
  });

  app.onRequest(acp.methods.agent.session.close, (ctx) => {
    const entry = sessions.get(ctx.params.sessionId);
    if (!entry) return {};
    entry.cancelled = true;
    entry.promptAbort?.abort();
    bridge.abort(entry.threadId);
    bridge.clearContextUsage(ctx.params.sessionId);
    // ACP 会话关闭即结束：释放 provider 侧会话资源（Anthropic message
    // threads 续传状态、Codex websocket 等）。清理失败只记日志——关闭
    // 本身必须成功，否则客户端会卡在会话上
    try {
      cleanupSessionResources(ctx.params.sessionId);
    } catch (err) {
      logErr("[acp] session resource cleanup failed:", err);
    }
    sessions.delete(ctx.params.sessionId);
    return {};
  });

  app.onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const params = ctx.params;
    const entry = sessions.get(params.sessionId);
    if (!entry) throw new acp.RequestError(-32602, `unknown session: ${params.sessionId}`);
    if (bridge.hasPrompt(entry.threadId)) {
      throw new acp.RequestError(-32602, "session already has an active prompt");
    }

    const parsed = parsePromptContent(params.prompt, entry.cwd);
    if (!parsed.text && parsed.attachments.length === 0) {
      throw new acp.RequestError(-32602, "prompt contains no text or image content");
    }

    entry.cancelled = false;
    entry.activeClient = ctx.client;
    const abort = new AbortController();
    entry.promptAbort = abort;

    const translator: StreamTranslator = new StreamTranslator({
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      initialMode: entry.lastMode,
      // 内部切换模式（plan 审批通过等）也要落到 entry：否则 configOptions 的
      // Mode 当前值和标准 modes 通道会分叉
      onModeChange: (mode) => {
        entry.lastMode = projectMode(mode);
      },
      sendUpdate: (update) => notifyUpdate(ctx.client, entry.sessionId, update),
      onPermission: (data): Promise<void> =>
        handlePermission(ctx.client, entry, translator, data, abort.signal),
      onQuestion: (data): Promise<void> => handleQuestion(ctx.client, entry, data),
      onInteractionResolved: (data): Promise<void> =>
        handleInteractionResolved(ctx.client, entry, data),
    });

    const { done } = bridge.startPrompt({
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
        void pushTitleUpdate(ctx.client, entry);
      });

    try {
      const result = await waitPrompt(entry, done, abort.signal);
      await translator.finishPending();
      return { stopReason: result.stopReason };
    } catch (err) {
      await translator.finishPending();
      // 用 abort.signal 而不是 entry.cancelled：done 的 finally 会先把
      // entry.cancelled 归位，注册顺序上可能早于这里的 catch。
      if (entry.cancelled || abort.signal.aborted) return { stopReason: "cancelled" };
      throw toRequestError(err);
    }
  });

  app.onNotification(acp.methods.agent.session.cancel, (ctx) => {
    const entry = sessions.get(ctx.params.sessionId);
    if (!entry) return;
    entry.cancelled = true;
    entry.promptAbort?.abort();
    bridge.abort(entry.threadId);
  });

  app.onRequest(acp.methods.agent.session.setMode, async (ctx) => {
    const entry = sessions.get(ctx.params.sessionId);
    if (!entry) throw new acp.RequestError(-32602, `unknown session: ${ctx.params.sessionId}`);
    const mode = ctx.params.modeId;
    if (!ACP_MODES.some((item) => item.id === mode)) {
      throw new acp.RequestError(-32602, `unknown mode: ${mode}`);
    }
    try {
      await bridge.request({
        type: "set_mode",
        threadId: entry.threadId,
        sessionId: entry.sessionId,
        mode,
      });
      entry.lastMode = mode as AcpMode;
      await notifyUpdate(ctx.client, entry.sessionId, {
        sessionUpdate: "current_mode_update",
        currentModeId: entry.lastMode,
      });
      // configOptions 里的 Mode 下拉同步：标准 modes 与 config option 两条
      // 客户端路径共享同一份当前值，避免一边切换另一边显示陈旧
      const configOptions = await buildConfigOptions(entry);
      await notifyUpdate(ctx.client, entry.sessionId, {
        sessionUpdate: "config_option_update",
        configOptions,
      });
      return {};
    } catch (err) {
      throw toRequestError(err);
    }
  });

  app.onRequest(acp.methods.agent.session.setConfigOption, async (ctx) => {
    const entry = sessions.get(ctx.params.sessionId);
    if (!entry) throw new acp.RequestError(-32602, `unknown session: ${ctx.params.sessionId}`);
    const value = text(ctx.params.value);
    try {
      switch (ctx.params.configId) {
        case ACP_CONFIG_MODEL: {
          let target = entry.modelMap.get(value);
          if (!target) {
            // 容错：客户端可能用 provider/modelId 原始拼接
            const slash = value.indexOf("/");
            if (slash > 0) {
              target = {
                provider: value.slice(0, slash),
                modelId: value.slice(slash + 1),
              };
            }
          }
          if (!target) {
            throw new acp.RequestError(-32602, `unknown model: ${value}`);
          }
          await bridge.request({
            type: "set_model",
            threadId: entry.threadId,
            sessionId: entry.sessionId,
            provider: target.provider,
            modelId: target.modelId,
          });
          entry.model = { provider: target.provider, modelId: target.modelId };
          // 注意：不重置 entry.thinkingLevel——会话偏好列里的旧档位仍是真值
          // （set_model 会话定靶不动 thinking），重建出的 effort 下拉若不支持
          // 该档位会自行 clamp 显示；实际运行档位由会话定靶/全局默认决定。
          break;
        }
        case ACP_CONFIG_MODE: {
          if (!ACP_MODES.some((item) => item.id === value)) {
            throw new acp.RequestError(-32602, `unknown mode: ${value}`);
          }
          await bridge.request({
            type: "set_mode",
            threadId: entry.threadId,
            sessionId: entry.sessionId,
            mode: value,
          });
          entry.lastMode = value as AcpMode;
          // 标准 modes 通道同步：与 session/set_mode 同口径，走 config 面板
          // 切模式时 current_mode_update 也要发，否则编辑器 modes 条陈旧
          await notifyUpdate(ctx.client, entry.sessionId, {
            sessionUpdate: "current_mode_update",
            currentModeId: entry.lastMode,
          });
          break;
        }
        case ACP_CONFIG_THINKING_EFFORT: {
          if (!(THINKING_LEVELS as readonly string[]).includes(value)) {
            throw new acp.RequestError(-32602, `unknown thinking level: ${value}`);
          }
          await bridge.request({
            type: "set_thinking",
            level: value,
            sessionId: entry.sessionId,
          });
          entry.thinkingLevel = value as ThinkingLevel;
          break;
        }
        default:
          throw new acp.RequestError(-32602, `unknown config option: ${ctx.params.configId}`);
      }
      // 规范要求回传全量配置项（改一项可能影响其他项的取值/支持面）
      const configOptions = await buildConfigOptions(entry);
      // 与 MiniMax 同款：切换后广播 config_option_update，客户端状态保持同步
      await notifyUpdate(ctx.client, entry.sessionId, {
        sessionUpdate: "config_option_update",
        configOptions,
      });
      return { configOptions };
    } catch (err) {
      throw toRequestError(err);
    }
  });

  function validateCwd(cwd: string): string {
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

  function logIgnoredMcpServers(servers: unknown): void {
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

  return {
    app,
    cancelAll: () => {
      for (const entry of sessions.values()) {
        entry.cancelled = true;
        entry.promptAbort?.abort();
      }
      bridge.abortAll();
    },
  };
}

function waitPrompt(
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
