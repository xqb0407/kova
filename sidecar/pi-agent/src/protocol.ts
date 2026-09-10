/**
 * pi-agent sidecar 协议层：stdin/stdout 上的 NDJSON。
 *
 * 输入（stdin，每行一个 JSON）：
 *   { "type": "prompt", "id": "<reqId>", "text": "...", "threadId": "...", "sessionId": "...", "cwd": "..." }
 *       sessionId = 会话 id（索引表/JSONL 文件名）；提供则恢复该会话（跨重启），缺省则按 threadId 懒建新会话
 *       cwd = workspace 目录；仅在需要新建会话时使用，缺省为用户主目录
 *       prompt 结束后若有后台子代理（Task 委派）仍在运行，等待其完成并在同一条
 *       reqId 消息流内注入恢复 prompt 投递报告（多 step 收敛），再发 finish
 *   { "type": "abort" }   中止父代理与全部后台子代理
 *   { "type": "ping", "id" }                                  → { id, type: "pong" }
 *   { "type": "list_sessions", "id" }                         → { id, type: "sessions", sessions: [...] }
 *   { "type": "new_session", "id", "threadId", "cwd" }        → { id, type: "session", sessionId, threadId }
 *   { "type": "get_history", "id", "sessionId" }              → { id, type: "history", messages: UIMessage[] }
 *       历史从 agent 消息重建，含工具部件（tool part 的 input/output 与 live 流一致）
 *   { "type": "delete_session", "id", "sessionId" }           → { id, type: "deleted" }
 *   { "type": "rename_session", "id", "sessionId", "name" }   → { id, type: "renamed" }
 *   { "type": "list_models", "id" }                           → { id, type: "models", models: [...], providers: [...] }
 *   { "type": "set_model", "id", "provider", "modelId" }      → { id, type: "model", provider, modelId }
 *   { "type": "set_credential", "id", "provider", "apiKey" }  → { id, type: "credential", provider }
 *   { "type": "list_credentials", "id" }                      → { id, type: "credentials", credentials: [...] }
 *   { "type": "delete_credential", "id", "provider" }         → { id, type: "credential_deleted", provider }
 *   { "type": "fetch_models", "id", "baseUrl", "apiKey", "api" } → { id, type: "fetched_models", models: [...] }
 *       api = openai-chat | openai-responses | anthropic-messages，决定列表端点与鉴权方式
 *   { "type": "add_custom_provider", "providerId"?, "name", "baseUrl", "apiKey", "api", "models": [{ "id", ... }] }
 *                                                             → { id, type: "custom_provider", provider }
 *       providerId = 编辑目标的业务 id（协议 reqId 占用了 "id" 字段，故改名）；缺省为新建
 *   { "type": "list_custom_providers", "id" }                 → { id, type: "custom_providers", providers: [...] }
 *   { "type": "toggle_custom_provider", "id", "provider", "enabled" } → { id, type: "custom_provider_toggled", provider, enabled }
 *   { "type": "set_mode", "id", "threadId", "sessionId"?, "mode" }       → { id, type: "mode_changed", mode, planning, proposal }
 *       mode = agent | plan | goal；切换会热替换工具集与系统提示词
 *   { "type": "approve_plan", "id", "threadId", "sessionId"? }           → { id, type: "planning_state", mode, planning, proposal }
 *       批准未决提案：回 agent 模式（前端随后发批准消息开始实施）
 *   { "type": "reject_plan", "id", "threadId", "sessionId"? }            → { id, type: "planning_state", mode, planning, proposal }
 *       拒绝未决提案：留在契约模式继续修改
 *   { "type": "tool_confirm", "id", "threadId", "sessionId"?, "approvalId", "approved" } → { id, type: "tool_confirmed", approvalId }
 *       结算 bash/write/edit 执行前的逐工具审批（prompt 流内 data-toolApproval chunk 发起）
 *   { "type": "test_provider", "id", "baseUrl", "apiKey", "api", "model" } → { id, type: "tested", ok: true }
 *   { "type": "delete_custom_provider", "id", "provider" }    → { id, type: "custom_provider_deleted", provider }
 *   prompt 流内审批推送：{ id, chunk: { type: "data-planningState", data: { mode, planning, proposal } } }
 *                 审批请求：{ id, chunk: { type: "data-toolApproval", data: { approvalId, toolCallId, toolName, input } } }
 *
 * prompt 流（stdout）：{ "id": "<reqId>", "chunk": { ...AI SDK UIMessageChunk } }
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import { logErr } from "./log";
import { sessionPath } from "./storage";
import { resolveHostResult } from "./hostdb";
import {
  credentialDelete,
  credentialGet,
  credentialList,
  credentialSet,
  customProviderDelete,
  customProviderGet,
  customProviderSetEnabled,
  customProviderUpsert,
  customProvidersList,
  providerModelsAll,
  providerModelsGet,
  providerModelsSet,
  sessionDelete,
  sessionList,
  sessionRename,
} from "./hostdb";
import {
  getCurrentModelKey,
  getModels,
  normalizeApi,
  registerCustomProvider,
  setCurrentModelKey,
} from "./model-catalog";
import { readTranscript, persist, historyToUiMessages } from "./transcript";
import { running, resolveSession } from "./sessions";
import {
  delegationResumeText,
  runningDelegations,
} from "./subagent";
import { beginRun, send, sendChunk, setCurrentReqId } from "./stream";
import {
  applyMode,
  clearPendingToolApprovals,
  closeProposalOnNewPrompt,
  planningPayload,
  resolveToolApproval,
} from "./modes";
import type { CustomModelSpec, SessionSummary } from "./types";

/** stdin 关闭（父进程写完）不等于任务处理完毕，等挂起请求清零再退出 */
let stdinClosed = false;
let pendingOps = 0;
let exiting = false;

function maybeExit() {
  if (exiting || !stdinClosed || pendingOps > 0) return;
  exiting = true;
  // end() 会先冲刷 stdout 队列再退出，避免超长响应行被截断
  process.stdout.end(() => process.exit(0));
}

/** 入口在 stdin 关闭时调用（readline close 事件） */
export function markStdinClosed() {
  stdinClosed = true;
  maybeExit();
}

/** 管理命令串行队列：避免凭据写入与列表查询等异步命令交叠产生竞态 */
let mgmtQueue: Promise<void> = Promise.resolve();

let fallbackSeq = 0;

export function handleLine(raw: string) {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    logErr("unparseable line:", String(raw).slice(0, 200));
    return;
  }

  // 宿主对 host_query 的响应：交给 hostdb 的挂起表结算，不走命令分发
  if (resolveHostResult(msg)) return;

  const reqId = typeof msg.id === "string" ? msg.id : `req-${fallbackSeq++}`;
  const run = async () => {
    try {
      await dispatch(reqId, msg);
    } catch (err) {
      logErr("handleLine failed:", err);
      send({ id: reqId, type: "error", errorText: err instanceof Error ? err.message : String(err) });
    } finally {
      pendingOps -= 1;
      maybeExit();
    }
  };
  pendingOps += 1;
  if (msg.type === "prompt") {
    // prompt 主体是长任务，不占队列；但会话准备（建会话/读凭据）作为队列任务执行，
    // 与 set_credential / new_session 等保持严格先后
    void (async () => {
      try {
        await dispatchPrompt(reqId, msg);
      } catch (err) {
        sendChunk(reqId, { type: "error", errorText: err instanceof Error ? err.message : String(err) });
      } finally {
        pendingOps -= 1;
        maybeExit();
      }
    })();
  } else {
    mgmtQueue = mgmtQueue.then(run, run);
  }
}

/** prompt：会话准备段入管理队列串行执行，agent.prompt 长任务在队列外运行 */
export async function dispatchPrompt(reqId: string, msg: Record<string, unknown>) {
  const task = mgmtQueue.then(() =>
    resolveSession(
      String(msg.threadId ?? "default"),
      typeof msg.sessionId === "string" ? msg.sessionId : undefined,
      typeof msg.cwd === "string" ? msg.cwd : undefined,
    ),
  );
  mgmtQueue = task.then(
    () => {},
    () => {},
  );

  let run;
  try {
    run = await task;
  } catch (err) {
    sendChunk(reqId, { type: "error", errorText: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!run.agent.state.model) {
    sendChunk(reqId, {
      type: "error",
      errorText:
        "No model with credentials available. Open Settings → Model and add an API key.",
    });
    return;
  }
  setCurrentReqId(reqId);
  run.stopRequested = false;
  // 新用户输入隐式关闭未决审批（未点批准/拒绝就直接发消息）
  closeProposalOnNewPrompt(run);
  // 逐工具审批理论上不会跨 turn 遗留（abort 已结算），兜底清理防挂起
  clearPendingToolApprovals(run);
  sendChunk(reqId, { type: "start" });

  // 每段 prompt 是消息流里的一个 step；resume 段前重置内容 id，避免与上一段撞 id
  let stepStarted = false;
  const runStep = async (text: string) => {
    if (stepStarted) sendChunk(reqId, { type: "finish-step" });
    sendChunk(reqId, { type: "start-step" });
    stepStarted = true;
    beginRun();
    await run.agent.prompt(text);
  };

  try {
    await runStep(String(msg.text ?? ""));
    // 后台委派收敛循环（ADR 0089）：turn 结束时若还有运行中的子代理，等它们完成，
    // 把未投递的报告作为恢复 prompt 继续喂给父代理（同一条 reqId 消息流内续跑）。
    // 用户 Stop（stopRequested）直接退出。
    while (!run.stopRequested) {
      const pending = runningDelegations(run);
      if (pending.length > 0) {
        await Promise.all(pending.map((d) => d.completion));
        if (run.stopRequested) break;
      }
      const resume = delegationResumeText(run);
      if (!resume) break;
      await runStep(resume);
    }
  } catch (err) {
    sendChunk(reqId, { type: "error", errorText: err instanceof Error ? err.message : String(err) });
    // 父代理 turn 失败：中止遗留的后台子代理，让会话能回到空闲（D352）
    for (const d of run.delegations.values()) {
      if (d.status === "running") {
        d.stopRequested = true;
        d.abort();
      }
    }
  } finally {
    if (stepStarted) sendChunk(reqId, { type: "finish-step" });
    sendChunk(reqId, { type: "finish" });
    setCurrentReqId(null);
    persist(run);
  }
}

export async function dispatch(reqId: string, msg: Record<string, unknown>) {
  switch (msg.type) {
    case "ping": {
      send({ id: reqId, type: "pong" });
      break;
    }
    case "abort": {
      // 用户 Stop：中止父代理与全部后台子代理，并让收敛循环退出；
      // 挂起的逐工具审批按拒绝结算，避免 beforeToolCall 永久挂起
      for (const run of running.values()) {
        run.stopRequested = true;
        clearPendingToolApprovals(run);
        for (const d of run.delegations.values()) {
          if (d.status === "running") {
            d.stopRequested = true;
            d.abort();
          }
        }
        run.agent.abort();
      }
      break;
    }
    case "list_sessions": {
      // 索引经 hostdb（宿主 RPC），消息计数扫 JSONL 行数（个人桌面应用量级可接受）
      const sessions: SessionSummary[] = (await sessionList())
        .map((r) => {
          const file = sessionPath(r.id);
          let messageCount = 0;
          if (existsSync(file)) {
            const content = readFileSync(file, "utf8");
            for (const line of content.split("\n")) {
              if (line.includes('"type":"message"')) messageCount++;
            }
          }
          return {
            sessionId: r.id,
            name: r.title || undefined,
            firstMessage: r.first_message,
            messageCount,
            modified: r.updated_at,
            cwd: r.cwd,
          };
        })
        .filter((s) => s.messageCount > 0);
      send({ id: reqId, type: "sessions", sessions });
      break;
    }
    case "new_session": {
      const threadId = String(msg.threadId ?? `thread-${Date.now()}`);
      const cwd = typeof msg.cwd === "string" ? msg.cwd : undefined;
      const run = await resolveSession(threadId, undefined, cwd);
      send({ id: reqId, type: "session", sessionId: run.sessionId, threadId });
      break;
    }
    case "get_history": {
      const sessionId = String(msg.sessionId ?? "");
      // 从 agent 消息重建：text/reasoning 之外还带 tool part（input/output 对齐 live 流）
      const messages = historyToUiMessages(readTranscript(sessionId));
      send({ id: reqId, type: "history", messages });
      break;
    }
    case "delete_session": {
      const sessionId = String(msg.sessionId ?? "");
      for (const [tid, run] of running) {
        if (run.sessionId === sessionId) running.delete(tid);
      }
      await sessionDelete(sessionId);
      const file = sessionPath(sessionId);
      if (existsSync(file)) unlinkSync(file);
      send({ id: reqId, type: "deleted" });
      break;
    }
    case "rename_session": {
      const sessionId = String(msg.sessionId ?? "");
      const name = String(msg.name ?? "");
      await sessionRename(sessionId, name);
      send({ id: reqId, type: "renamed" });
      break;
    }
    case "list_models": {
      const models = getModels();
      const out: {
        provider: string;
        providerName: string;
        id: string;
        name: string;
        reasoning: boolean;
        contextWindow: number;
        authed: boolean;
      }[] = [];
      const providerMap = new Map<string, { id: string; name: string; authed: boolean }>();
      for (const p of models.getProviders()) {
        let authed = false;
        try {
          authed = (await models.getAuth(p.id)) !== undefined;
        } catch {
          authed = false;
        }
        providerMap.set(p.id, { id: p.id, name: p.name, authed });
        for (const m of p.getModels()) {
          out.push({
            provider: p.id,
            providerName: p.name,
            id: m.id,
            name: m.name,
            reasoning: m.reasoning,
            contextWindow: m.contextWindow,
            authed,
          });
        }
      }
      // 应用内置厂商的模型过滤（勾选集之外的模型不出现在前端目录里）
      const filterRows = await providerModelsAll();
      const filters = new Map(
        filterRows.map((r) => {
          let ids: string[] = [];
          try {
            ids = JSON.parse(r.models) as string[];
          } catch {
            ids = [];
          }
          return [r.provider, new Set(ids)] as const;
        }),
      );
      const filtered = out.filter(
        (m) => !filters.has(m.provider) || filters.get(m.provider)!.has(m.id),
      );
      send({
        id: reqId,
        type: "models",
        models: filtered,
        providers: [...providerMap.values()],
      });
      break;
    }
    case "get_provider_filter": {
      const provider = String(msg.provider ?? "");
      const row = await providerModelsGet(provider);
      let modelIds: string[] | null = null;
      if (row) {
        try {
          modelIds = JSON.parse(row.models) as string[];
        } catch {
          modelIds = null;
        }
      }
      send({ id: reqId, type: "provider_filter", provider, models: modelIds });
      break;
    }
    case "set_provider_filter": {
      const provider = String(msg.provider ?? "");
      const ids = Array.isArray(msg.models)
        ? [...new Set((msg.models as unknown[]).filter((s): s is string => typeof s === "string" && !!s.trim()))]
        : [];
      await providerModelsSet(provider, JSON.stringify(ids));
      send({ id: reqId, type: "provider_filter", provider, models: ids.length ? ids : null });
      break;
    }
    case "set_model": {
      const provider = String(msg.provider ?? "");
      const modelId = String(msg.modelId ?? "");
      const model = getModels().getModel(provider, modelId);
      if (!model) throw new Error(`model not found: ${provider}/${modelId}`);
      const auth = await getModels().getAuth(provider).catch(() => undefined);
      if (!auth) throw new Error(`no credentials configured for ${provider}/${modelId}`);
      setCurrentModelKey({ provider, modelId });
      for (const run of running.values()) run.agent.state.model = model;
      send({ id: reqId, type: "model", provider, modelId });
      break;
    }
    case "set_credential": {
      const provider = String(msg.provider ?? "");
      const apiKey = String(msg.apiKey ?? "");
      if (!provider || !apiKey) throw new Error("provider and apiKey are required");
      await credentialSet(provider, apiKey);
      send({ id: reqId, type: "credential", provider });
      break;
    }
    case "list_credentials": {
      const providers = await credentialList();
      const credentials = providers.map((providerId) => ({
        providerId,
        type: "api_key" as const,
      }));
      send({ id: reqId, type: "credentials", credentials });
      break;
    }
    case "delete_credential": {
      const provider = String(msg.provider ?? "");
      await credentialDelete(provider);
      send({ id: reqId, type: "credential_deleted", provider });
      break;
    }
    case "fetch_models": {
      // 拉取端点的模型列表（添加 AI 服务弹窗"获取列表"用），按接口格式区分：
      //   openai-chat / openai-responses → GET {baseUrl}/models（baseUrl 含 /v1），Bearer
      //   anthropic-messages → GET {baseUrl}/v1/models，x-api-key + anthropic-version
      const baseUrl = String(msg.baseUrl ?? "").trim().replace(/\/+$/, "");
      const apiKey = String(msg.apiKey ?? "").trim();
      const apiKind = normalizeApi(msg.api);
      if (!/^https?:\/\//.test(baseUrl)) throw new Error("baseUrl must start with http(s)://");
      const anthropic = apiKind === "anthropic-messages";
      const url = anthropic
        ? `${baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`}/models?limit=1000`
        : `${baseUrl}/models`;
      const res = await fetch(url, {
        headers: anthropic
          ? {
              ...(apiKey ? { "x-api-key": apiKey } : {}),
              "anthropic-version": "2023-06-01",
            }
          : apiKey
            ? { Authorization: `Bearer ${apiKey}` }
            : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`获取模型列表失败: HTTP ${res.status}`);
      const json = (await res.json()) as { data?: unknown };
      const raw = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
      const ids = raw
        .map((m) => (typeof m === "string" ? m : (m as { id?: unknown })?.id))
        .filter((s): s is string => typeof s === "string" && !!s.trim());
      send({ id: reqId, type: "fetched_models", models: [...new Set(ids)] });
      break;
    }
    case "add_custom_provider": {
      const name = String(msg.name ?? "").trim();
      const baseUrl = String(msg.baseUrl ?? "").trim();
      const apiKey = String(msg.apiKey ?? "").trim();
      const modelSpecs = Array.isArray(msg.models)
        ? (msg.models as CustomModelSpec[]).filter(
            (m) => m && typeof m.id === "string" && m.id.trim(),
          )
        : [];
      if (!name) throw new Error("name is required");
      if (!/^https?:\/\//.test(baseUrl)) throw new Error("baseUrl must start with http(s)://");
      if (!modelSpecs.length) throw new Error("at least one model id is required");
      const api = normalizeApi(msg.api);
      // 注意：协议层 reqId 占用了 "id" 字段，编辑目标的业务 id 走 "providerId"
      const existingId = typeof msg.providerId === "string" ? msg.providerId.trim() : "";
      const id =
        existingId ||
        `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || randomUUID().slice(0, 8)}`;
      await customProviderUpsert({ id, name, baseUrl, models: JSON.stringify(modelSpecs), api });
      // apiKey 留空表示保留原有凭据
      if (apiKey) {
        await credentialSet(id, apiKey);
      }
      // 停用的服务保存后保持停用：不注册进目录，并从目录移除
      const enabledRow = await customProviderGet(id);
      if (!enabledRow || enabledRow.enabled) {
        registerCustomProvider(enabledRow ?? { id, name, baseUrl, models: JSON.stringify(modelSpecs), api });
      } else {
        getModels().deleteProvider(id);
        if (getCurrentModelKey()?.provider === id) setCurrentModelKey(null);
      }
      // 已恢复会话若用旧的同名模型定义，同步刷新其 baseUrl 等字段
      if (getCurrentModelKey()?.provider === id) {
        const model = getModels().getModel(id, getCurrentModelKey()!.modelId);
        if (model) for (const run of running.values()) run.agent.state.model = model;
      }
      send({ id: reqId, type: "custom_provider", provider: id });
      break;
    }
    case "list_custom_providers": {
      const providers = await customProvidersList();
      const out = await Promise.all(
        providers.map(async (r) => {
          let specs: CustomModelSpec[] = [];
          try {
            specs = JSON.parse(r.models) as CustomModelSpec[];
          } catch {
            specs = [];
          }
          // 明文返回 key 供编辑弹窗回填（仅存本地库）
          const keyRow = await credentialGet(r.id);
          return {
            providerId: r.id,
            name: r.name,
            baseUrl: r.baseUrl,
            models: specs,
            api: normalizeApi(r.api),
            hasApiKey: keyRow !== null,
            apiKey: keyRow?.apiKey,
            enabled: r.enabled,
          };
        }),
      );
      send({ id: reqId, type: "custom_providers", providers: out });
      break;
    }
    case "delete_custom_provider": {
      const provider = String(msg.provider ?? "");
      await customProviderDelete(provider);
      await credentialDelete(provider);
      getModels().deleteProvider(provider);
      if (getCurrentModelKey()?.provider === provider) setCurrentModelKey(null);
      send({ id: reqId, type: "custom_provider_deleted", provider });
      break;
    }
    case "toggle_custom_provider": {
      // 启用/停用服务：停用时从模型目录移除，启用时重新注册
      const provider = String(msg.provider ?? "");
      const enabled = msg.enabled === true;
      await customProviderSetEnabled(provider, enabled);
      if (enabled) {
        const row = await customProviderGet(provider);
        if (row) registerCustomProvider(row);
      } else {
        getModels().deleteProvider(provider);
        if (getCurrentModelKey()?.provider === provider) setCurrentModelKey(null);
      }
      send({ id: reqId, type: "custom_provider_toggled", provider, enabled });
      break;
    }
    case "test_provider": {
      // 测试服务连通性：按接口格式发一条最小请求
      const baseUrl = String(msg.baseUrl ?? "").trim().replace(/\/+$/, "");
      const apiKey = String(msg.apiKey ?? "").trim();
      const model = String(msg.model ?? "").trim();
      const apiKind = normalizeApi(msg.api);
      if (!/^https?:\/\//.test(baseUrl)) throw new Error("baseUrl must start with http(s)://");
      if (!model) throw new Error("model is required");
      let url: string;
      let headers: Record<string, string>;
      let body: unknown;
      if (apiKind === "anthropic-messages") {
        url = `${baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`}/messages`;
        headers = {
          "content-type": "application/json",
          ...(apiKey ? { "x-api-key": apiKey } : {}),
          "anthropic-version": "2023-06-01",
        };
        body = { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] };
      } else if (apiKind === "openai-responses") {
        url = `${baseUrl}/responses`;
        headers = {
          "content-type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        };
        body = { model, input: "ping", max_output_tokens: 16 };
      } else {
        url = `${baseUrl}/chat/completions`;
        headers = {
          "content-type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        };
        body = { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] };
      }
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        throw new Error(`连接失败: HTTP ${res.status}${text ? ` · ${text}` : ""}`);
      }
      send({ id: reqId, type: "tested", ok: true });
      break;
    }
    case "tool_confirm": {
      // 结算逐工具审批：approved = 放行执行，false = 拦截（模型收到 blocked 工具结果）
      const run = await resolveSession(
        String(msg.threadId ?? "default"),
        typeof msg.sessionId === "string" ? msg.sessionId : undefined,
      );
      const approvalId = String(msg.approvalId ?? "");
      if (!resolveToolApproval(run, approvalId, Boolean(msg.approved))) {
        throw new Error(`no pending tool approval: ${approvalId}`);
      }
      send({ id: reqId, type: "tool_confirmed", approvalId });
      break;
    }
    case "set_mode": {
      // 手动切换会话模式（agent/plan/goal），可选携带审批级别（agent 模式的
      // ask/auto-edit/auto 对应前端"变更前确认/自动编辑/完全访问"）；重建工具集与系统提示词
      const run = await resolveSession(
        String(msg.threadId ?? "default"),
        typeof msg.sessionId === "string" ? msg.sessionId : undefined,
        typeof msg.cwd === "string" ? msg.cwd : undefined,
      );
      const mode = String(msg.mode ?? "agent");
      if (mode !== "agent" && mode !== "plan" && mode !== "goal") {
        throw new Error(`invalid mode: ${mode}`);
      }
      if (typeof msg.approvalLevel === "string") {
        if (msg.approvalLevel !== "ask" && msg.approvalLevel !== "auto-edit" && msg.approvalLevel !== "auto") {
          throw new Error(`invalid approval level: ${msg.approvalLevel}`);
        }
        run.approvalLevel = msg.approvalLevel;
      }
      applyMode(run, mode);
      send({ id: reqId, type: "mode_changed", ...planningPayload(run) });
      break;
    }
    case "approve_plan": {
      // 批准未决提案：回 agent 模式，由前端随后走正常 prompt 管道发批准消息
      const run = await resolveSession(
        String(msg.threadId ?? "default"),
        typeof msg.sessionId === "string" ? msg.sessionId : undefined,
      );
      if (run.planning !== "awaiting_approval" || !run.proposal) {
        throw new Error("no proposal awaiting approval");
      }
      run.proposal = null;
      applyMode(run, "agent");
      send({ id: reqId, type: "planning_state", ...planningPayload(run) });
      break;
    }
    case "reject_plan": {
      // 拒绝未决提案：留在当前模式继续修改（planning），用户输入反馈后重新提交
      const run = await resolveSession(
        String(msg.threadId ?? "default"),
        typeof msg.sessionId === "string" ? msg.sessionId : undefined,
      );
      if (run.planning !== "awaiting_approval" || !run.proposal) {
        throw new Error("no proposal awaiting approval");
      }
      run.proposal = null;
      run.planning = "planning";
      send({ id: reqId, type: "planning_state", ...planningPayload(run) });
      break;
    }
    default:
      logErr("unknown message type:", String(msg.type));
      send({ id: reqId, type: "error", errorText: `unknown message type: ${String(msg.type)}` });
  }
}
