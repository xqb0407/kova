/**
 * 凭据与模型服务命令：凭据 CRUD、端点模型列表拉取/连通性测试、自定义 provider
 * 全套（增删改/启停/清单）、模型属性编辑。目录与注册见 model/（catalog +
 * custom-providers），表操作见 storage/hostdb.ts。
 */
import { randomUUID } from "node:crypto";
import { send } from "../stream";
import { running } from "../../sessions/sessions";
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
  modelsAll,
  modelsDeleteProvider,
  modelsList,
  modelsReplace,
  type ModelReplaceItem,
} from "../../storage/hostdb";
import {
  applyRowToCatalogModel,
  CUSTOM_MODEL_DEFAULTS,
  getCurrentModelKey,
  getModels,
  lookupCatalogModelSeed,
  normalizeApi,
  parseModelCost,
  parseModelInput,
  registerCustomProvider,
  setCurrentModelKey,
} from "../../model/model-catalog";
import { maskApiKey } from "../payloads";
import type { CustomModelSpec } from "../../types";
import type { CommandHandler } from "../command";

export const handlers: Record<string, CommandHandler> = {
  set_credential: async (reqId, msg) => {
    const provider = String(msg.provider ?? "");
    const apiKey = String(msg.apiKey ?? "");
    if (!provider || !apiKey) throw new Error("provider and apiKey are required");
    await credentialSet(provider, apiKey);
    send({ id: reqId, type: "credential", provider });
  },

  list_credentials: async (reqId) => {
    const providers = await credentialList();
    const credentials = providers.map((providerId) => ({
      providerId,
      type: "api_key" as const,
    }));
    send({ id: reqId, type: "credentials", credentials });
  },

  delete_credential: async (reqId, msg) => {
    const provider = String(msg.provider ?? "");
    await credentialDelete(provider);
    send({ id: reqId, type: "credential_deleted", provider });
  },

  fetch_models: async (reqId, msg) => {
    // 拉取端点的模型列表（添加 AI 服务弹窗"获取列表"用），按接口格式区分：
    //   openai-chat / openai-responses → GET {baseUrl}/models（baseUrl 含 /v1），Bearer
    //   anthropic-messages → GET {baseUrl}/v1/models，x-api-key + anthropic-version
    const baseUrl = String(msg.baseUrl ?? "").trim().replace(/\/+$/, "");
    let apiKey = String(msg.apiKey ?? "").trim();
    const providerId = String(msg.providerId ?? "").trim();
    if (!apiKey && providerId) {
      const stored = await credentialGet(providerId);
      if (stored) apiKey = stored.apiKey;
    }
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
  },

  add_custom_provider: async (reqId, msg) => {
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
    // 模型行统一存 models 表（custom_providers.models 旧列保持 '[]'，仅留 schema 兼容）
    await customProviderUpsert({ id, name, baseUrl, models: "[]", api });
    await modelsReplace(
      id,
      modelSpecs.map((m) => ({
        modelId: m.id.trim(),
        enabled: true,
        name: typeof m.name === "string" ? m.name : null,
        reasoning: typeof m.reasoning === "boolean" ? m.reasoning : null,
        contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : null,
        maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : null,
        input: Array.isArray(m.input) ? m.input : null,
        cost: m.cost && typeof m.cost === "object" && !Array.isArray(m.cost) ? m.cost : null,
      })),
    );
    // apiKey 留空表示保留原有凭据
    if (apiKey) {
      await credentialSet(id, apiKey);
    }
    // 停用的服务保存后保持停用：不注册进目录，并从目录移除
    const enabledRow = await customProviderGet(id);
    if (!enabledRow || enabledRow.enabled) {
      await registerCustomProvider(enabledRow ?? { id, name, baseUrl, api });
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
  },

  list_custom_providers: async (reqId) => {
    const providers = await customProvidersList();
    const out = await Promise.all(
      providers.map(async (r) => {
        // 模型行读 models 表（enabled=1），属性与注册同口径三级兜底：
        // 行值 → 内置目录同名模型种子 → 注册默认值，供编辑表单回填
        const specs: CustomModelSpec[] = (await modelsList(r.id))
          .filter((row) => row.enabled && row.modelId.trim())
          .map((row) => {
            const seed = lookupCatalogModelSeed(row.modelId);
            return {
              id: row.modelId,
              name: row.name?.trim() || row.modelId,
              reasoning:
                row.reasoning ?? seed?.reasoning ?? CUSTOM_MODEL_DEFAULTS.reasoning,
              contextWindow:
                row.contextWindow ??
                seed?.contextWindow ??
                CUSTOM_MODEL_DEFAULTS.contextWindow,
              maxTokens:
                row.maxTokens ?? seed?.maxTokens ?? CUSTOM_MODEL_DEFAULTS.maxTokens,
              input:
                parseModelInput(row.input) ??
                seed?.input ??
                [...CUSTOM_MODEL_DEFAULTS.input],
              cost: {
                ...(parseModelCost(row.cost) ??
                  seed?.cost ??
                  CUSTOM_MODEL_DEFAULTS.cost),
              },
            };
          });
        // 只回掩码：明文 key 不进渲染进程（编辑弹窗输入框留空 = 保持原 key，
        // 见 add_custom_provider 的空串语义）
        const keyRow = await credentialGet(r.id);
        return {
          providerId: r.id,
          name: r.name,
          baseUrl: r.baseUrl,
          models: specs,
          api: normalizeApi(r.api),
          hasApiKey: keyRow !== null,
          apiKeyMasked: keyRow ? maskApiKey(keyRow.apiKey) : undefined,
          enabled: r.enabled,
        };
      }),
    );
    send({ id: reqId, type: "custom_providers", providers: out });
  },

  delete_custom_provider: async (reqId, msg) => {
    const provider = String(msg.provider ?? "");
    await customProviderDelete(provider);
    await modelsDeleteProvider(provider);
    await credentialDelete(provider);
    getModels().deleteProvider(provider);
    if (getCurrentModelKey()?.provider === provider) setCurrentModelKey(null);
    send({ id: reqId, type: "custom_provider_deleted", provider });
  },

  toggle_custom_provider: async (reqId, msg) => {
    // 启用/停用服务：停用时从模型目录移除，启用时重新注册（模型行读 models 表）
    const provider = String(msg.provider ?? "");
    const enabled = msg.enabled === true;
    await customProviderSetEnabled(provider, enabled);
    if (enabled) {
      const row = await customProviderGet(provider);
      if (row) await registerCustomProvider(row);
    } else {
      getModels().deleteProvider(provider);
      if (getCurrentModelKey()?.provider === provider) setCurrentModelKey(null);
    }
    send({ id: reqId, type: "custom_provider_toggled", provider, enabled });
  },

  update_model: async (reqId, msg) => {
    // 模型属性编辑：消息里携带的字段写入 models 表（null = 重置继承内置值，
    // 未携带 = 保留现值），并原地应用到目录模型对象
    const provider = String(msg.provider ?? "");
    const modelId = String(msg.modelId ?? "");
    if (!provider || !modelId) throw new Error("provider and modelId are required");
    const base = (await modelsList(provider)).find((r) => r.modelId === modelId);
    const pick = (key: string, fallback: unknown): unknown =>
      key in msg ? (msg[key] ?? null) : fallback;
    const item: ModelReplaceItem = {
      modelId,
      enabled: base?.enabled ?? true,
      name: pick("name", base?.name ?? null) as string | null,
      reasoning: pick("reasoning", base?.reasoning ?? null) as boolean | null,
      contextWindow: pick("contextWindow", base?.contextWindow ?? null) as number | null,
      maxTokens: pick("maxTokens", base?.maxTokens ?? null) as number | null,
      input: pick("input", base?.input ?? null) as unknown[] | null,
      cost: pick("cost", base?.cost ?? null) as Record<string, unknown> | null,
    };
    await modelsReplace(provider, [item]);
    applyRowToCatalogModel({
      provider,
      modelId,
      name: item.name ?? null,
      reasoning: item.reasoning ?? null,
      contextWindow: item.contextWindow ?? null,
      maxTokens: item.maxTokens ?? null,
      input: item.input ?? null,
      cost: item.cost ?? null,
    });
    send({ id: reqId, type: "model_updated", provider, modelId });
  },

  test_provider: async (reqId, msg) => {
    // 测试服务连通性：按接口格式发一条最小请求。apiKey 留空且给了
    // providerId 时取已存凭据——编辑弹窗不再回传明文 key，测试要能用旧 key
    const baseUrl = String(msg.baseUrl ?? "").trim().replace(/\/+$/, "");
    let apiKey = String(msg.apiKey ?? "").trim();
    const providerId = String(msg.providerId ?? "").trim();
    if (!apiKey && providerId) {
      const stored = await credentialGet(providerId);
      if (stored) apiKey = stored.apiKey;
    }
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
  },
};
