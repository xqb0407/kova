/**
 * pi-agent sidecar 协议层：stdin/stdout 上的 NDJSON。
 *
 * 输入（stdin，每行一个 JSON）：
 *   { "type": "prompt", "id": "<reqId>", "text": "...", "threadId": "...", "sessionId": "...", "cwd": "..." }
 *       sessionId = 会话 id（索引表/JSONL 文件名）；提供则恢复该会话（跨重启），缺省则按 threadId 懒建新会话
 *       cwd = workspace 目录；仅在需要新建会话时使用，缺省为用户主目录
 *   { "type": "abort" }
 *   { "type": "ping", "id" }                                  → { id, type: "pong" }
 *   { "type": "list_sessions", "id" }                         → { id, type: "sessions", sessions: [...] }
 *   { "type": "new_session", "id", "threadId", "cwd" }        → { id, type: "session", sessionId, threadId }
 *   { "type": "get_history", "id", "sessionId" }              → { id, type: "history", messages: UIMessage[] }
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
 *   { "type": "test_provider", "id", "baseUrl", "apiKey", "api", "model" } → { id, type: "tested", ok: true }
 *   { "type": "delete_custom_provider", "id", "provider" }    → { id, type: "custom_provider_deleted", provider }
 *
 * prompt 流（stdout）：{ "id": "<reqId>", "chunk": { ...AI SDK UIMessageChunk } }
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import { logErr } from "./log";
import {
  db,
  credentialStore,
  sessionPath,
} from "./storage";
import {
  getCurrentModelKey,
  getModels,
  normalizeApi,
  registerCustomProvider,
  setCurrentModelKey,
} from "./model-catalog";
import { readTranscript, persist } from "./transcript";
import { running, resolveSession } from "./sessions";
import { beginRun, send, sendChunk, setCurrentReqId } from "./stream";
import type {
  CustomModelSpec,
  SessionSummary,
  UIMessage,
} from "./types";

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
  beginRun();

  sendChunk(reqId, { type: "start" });
  sendChunk(reqId, { type: "start-step" });

  try {
    await run.agent.prompt(String(msg.text ?? ""));
  } catch (err) {
    sendChunk(reqId, { type: "error", errorText: err instanceof Error ? err.message : String(err) });
  } finally {
    sendChunk(reqId, { type: "finish-step" });
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
      for (const run of running.values()) run.agent.abort();
      break;
    }
    case "list_sessions": {
      // 索引在 SQLite，消息计数扫 JSONL 行数（个人桌面应用量级可接受）
      const sessions: SessionSummary[] = db
        .query<
          { id: string; title: string; first_message: string; cwd: string; updated_at: string },
          []
        >("SELECT id, title, first_message, cwd, updated_at FROM pi_sessions ORDER BY updated_at DESC")
        .all()
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
      const messages = readTranscript(sessionId)
        .map((t) => t.ui)
        .filter((m): m is UIMessage => m !== null);
      send({ id: reqId, type: "history", messages });
      break;
    }
    case "delete_session": {
      const sessionId = String(msg.sessionId ?? "");
      for (const [tid, run] of running) {
        if (run.sessionId === sessionId) running.delete(tid);
      }
      db.query("DELETE FROM pi_sessions WHERE id = ?").run(sessionId);
      const file = sessionPath(sessionId);
      if (existsSync(file)) unlinkSync(file);
      send({ id: reqId, type: "deleted" });
      break;
    }
    case "rename_session": {
      const sessionId = String(msg.sessionId ?? "");
      const name = String(msg.name ?? "");
      db.query("UPDATE pi_sessions SET title = ? WHERE id = ?").run(name, sessionId);
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
      const filterRows = db
        .query<{ provider: string; models: string }, []>(
          "SELECT provider, models FROM provider_models",
        )
        .all()
        .map((r) => {
          let ids: string[] = [];
          try {
            ids = JSON.parse(r.models) as string[];
          } catch {
            ids = [];
          }
          return [r.provider, new Set(ids)] as const;
        });
      const filters = new Map(filterRows);
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
      const row = db
        .query<{ models: string }, [string]>(
          "SELECT models FROM provider_models WHERE provider = ?",
        )
        .get(provider);
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
      if (ids.length) {
        db.query(
          "INSERT INTO provider_models (provider, models) VALUES (?, ?) " +
            "ON CONFLICT(provider) DO UPDATE SET models = excluded.models",
        ).run(provider, JSON.stringify(ids));
      } else {
        // 空数组 = 清除过滤，恢复全部
        db.query("DELETE FROM provider_models WHERE provider = ?").run(provider);
      }
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
      await credentialStore.modify(provider, async () => ({ type: "api_key", key: apiKey }));
      send({ id: reqId, type: "credential", provider });
      break;
    }
    case "list_credentials": {
      const credentials = await credentialStore.list();
      send({ id: reqId, type: "credentials", credentials });
      break;
    }
    case "delete_credential": {
      const provider = String(msg.provider ?? "");
      await credentialStore.delete(provider);
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
      db.query(
        "INSERT INTO custom_providers (id, name, base_url, models, api) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url, models = excluded.models, api = excluded.api",
      ).run(id, name, baseUrl, JSON.stringify(modelSpecs), api);
      // apiKey 留空表示保留原有凭据
      if (apiKey) {
        await credentialStore.modify(id, async () => ({ type: "api_key", key: apiKey }));
      }
      // 停用的服务保存后保持停用：不注册进目录，并从目录移除
      const enabledRow = db
        .query<{ enabled: number }, [string]>("SELECT enabled FROM custom_providers WHERE id = ?")
        .get(id);
      if (!enabledRow || enabledRow.enabled) {
        registerCustomProvider({ id, name, base_url: baseUrl, models: JSON.stringify(modelSpecs), api });
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
      const providers = db
        .query<{ id: string; name: string; base_url: string; models: string; api: string; enabled: number }, []>(
          "SELECT id, name, base_url, models, api, enabled FROM custom_providers",
        )
        .all()
        .map((r) => {
          let specs: CustomModelSpec[] = [];
          try {
            specs = JSON.parse(r.models) as CustomModelSpec[];
          } catch {
            specs = [];
          }
          // 明文返回 key 供编辑弹窗回填（仅存本地 SQLite）
          const keyRow = db
            .query<{ api_key: string }, [string]>("SELECT api_key FROM credentials WHERE provider = ?")
            .get(r.id);
          return {
            providerId: r.id,
            name: r.name,
            baseUrl: r.base_url,
            models: specs,
            api: normalizeApi(r.api),
            hasApiKey: keyRow !== undefined,
            apiKey: keyRow?.api_key,
            enabled: r.enabled === 1,
          };
        });
      send({ id: reqId, type: "custom_providers", providers });
      break;
    }
    case "delete_custom_provider": {
      const provider = String(msg.provider ?? "");
      db.query("DELETE FROM custom_providers WHERE id = ?").run(provider);
      await credentialStore.delete(provider);
      getModels().deleteProvider(provider);
      if (getCurrentModelKey()?.provider === provider) setCurrentModelKey(null);
      send({ id: reqId, type: "custom_provider_deleted", provider });
      break;
    }
    case "toggle_custom_provider": {
      // 启用/停用服务：停用时从模型目录移除，启用时重新注册
      const provider = String(msg.provider ?? "");
      const enabled = msg.enabled === true;
      db.query("UPDATE custom_providers SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, provider);
      if (enabled) {
        const row = db
          .query<{ id: string; name: string; base_url: string; models: string; api: string }, [string]>(
            "SELECT id, name, base_url, models, api FROM custom_providers WHERE id = ?",
          )
          .get(provider);
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
    default:
      logErr("unknown message type:", String(msg.type));
      send({ id: reqId, type: "error", errorText: `unknown message type: ${String(msg.type)}` });
  }
}
