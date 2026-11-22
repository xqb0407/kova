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
  credentialEnvDelete,
  credentialEnvGet,
  credentialEnvSet,
  credentialGet,
  credentialList,
  credentialSet,
  customProviderDelete,
  customProviderGet,
  customProviderSetEnabled,
  customProviderUpsert,
  customProvidersList,
  kvSet,
  modelsAll,
  modelsDeleteProvider,
  modelsList,
  modelsReplace,
  WEBSEARCH_CREDENTIAL_PREFIX,
  type ModelReplaceItem,
} from "../../storage/hostdb";
import {
  applyCustomHeaders,
  applyRowToCatalogModel,
  CUSTOM_MODEL_DEFAULTS,
  defaultModel,
  getCurrentModelKey,
  getModels,
  isCustomProvider,
  lookupCatalogModelSeed,
  mergeModelRowUpdate,
  normalizeApi,
  parseModelCost,
  parseModelInput,
  parseStoredHeaders,
  reconcileLastUsedModel,
  refreshProviderDiscovery,
  registerCustomProvider,
  setCurrentModelKey,
  validateHeaderInput,
  type CatalogModelSeed,
  type DiscoveryRefreshResult,
} from "../../model/model-catalog";
import {
  fetchAllModelPages,
  firstNonEmpty,
  loadAutoModels,
  mergeModelPageBundles,
  modelListCandidateUrls,
  MODEL_MERGE_GRACE_MS,
  normalizeModelBaseUrl,
  redactUrl,
} from "../../model/dynamic-discovery";
import { classifyAgentError, toWireError } from "../../agent/agent-errors";
import { beginOp, endOp } from "../exit";
import { maskApiKey } from "../payloads";
import { scanProviderImports } from "../../model/import";
import { fetchedFromDiscoveredModels } from "../../model/model-metadata";
import { logAt } from "../../log";
import type { CustomModelSpec, StoredModelAttrs } from "../../types";
import type { CommandHandler } from "../command";

/**
 * 被删/停用的 provider 若正挂在全局选中键上：把键改指到目录里另一个可用模型，
 * 而不是清成 null。
 *
 * 清空会殃及无关会话：会话级模型记忆（sessions.model_provider/model_id）只在
 * 「用户在该会话里亲手选过模型」时才有行，没有行的会话显示的是同一个全局
 * 「最近一次使用」值。键一清，这些会话**同时**变成「未选择」——它们从没指向被删
 * 的那个 provider，只是共用了这一份全局视图。改指后它们显示的就是真正会应答的
 * 模型（与 resolveCurrentModel 的回落同一口径，界面不再与实际用模型分叉）。
 * 目录里一个可用模型都没有时才清成 null：前端显示「选择模型」，发送闸门拦下。
 *
 * 必须在 getModels().deleteProvider(provider) 之后调用——否则回落会挑回刚被删
 * 的那个模型。
 */
async function repointCurrentModelAwayFrom(provider: string): Promise<void> {
  if (getCurrentModelKey()?.provider !== provider) return;
  const next = await defaultModel();
  if (!next) {
    setCurrentModelKey(null);
    // 没有 kvDelete：写显式 null 占位（initCurrentModelKey 与前端
    // initModelSettings 都按「解析不出 provider/modelId ⇒ 无选择」处理），
    // 否则重启会把已删 provider 的键读回来
    void kvSet("pi.model", "null").catch(() => {});
    return;
  }
  const key = { provider: next.provider, modelId: next.id };
  setCurrentModelKey(key);
  // 同步落 kv：否则重启后 initCurrentModelKey 又把已删的键读回来
  void kvSet("pi.model", JSON.stringify(key)).catch(() => {});
}

/**
 * 归一化凭据补充字段：只收非空字符串键值对（空值剔除 = 该字段回落
 * process.env）；env 键缺省（未携带）时返回 undefined = 不动已存的 kv。
 */
const parseCredentialEnv = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k && typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
};

/** 异步失败的应答：与 handleLine 的 catch 同形（前端 piRequest 见 error 即抛）。
 *  供两段式 handler 的迟到失败用（optimize 同款，本地副本避免跨域循环依赖）。 */
function sendFailure(reqId: string, errorText: string): void {
  send({
    id: reqId,
    type: "error",
    errorText,
    error: toWireError(classifyAgentError(errorText, { opaqueFallback: "runtime" })),
  });
}

/* ------------------------------ 动态模型发现 ------------------------------ */

/**
 * 重注册会重建该 provider 的全部模型对象：运行中会话若正挂着它的模型，把
 * agent.state.model 刷新为新目录对象（与 add_custom_provider 保存路径同款）。
 */
function refreshRunningModelRefs(provider: string): void {
  const key = getCurrentModelKey();
  if (key?.provider !== provider) return;
  const model = getModels().getModel(provider, key.modelId);
  if (!model) return;
  for (const run of running.values()) run.agent.state.model = model;
}

/**
 * 刷新 + 对账：刷新是后台慢操作（网络秒级），期间服务可能被停用/删除——
 * refreshProviderDiscovery 内部的重注册会把它复活进活目录。按存储现值回滚：
 * 行已不在（删除）或已停用，就把 provider 从目录摘除并按未发生处理。
 * 返回 undefined = 无事发生（缓存新鲜）或已回滚，调用方不该广播/应答成功。
 */
async function refreshAndReconcile(
  row: { id: string; name: string; baseUrl: string; api?: string; headers?: string },
  opts: { force?: boolean } = {},
): Promise<DiscoveryRefreshResult | undefined> {
  const result = await refreshProviderDiscovery(row, opts);
  if (!result) return undefined;
  const current = await customProviderGet(row.id);
  if (!current || !current.enabled) {
    getModels().deleteProvider(row.id);
    return undefined;
  }
  refreshRunningModelRefs(row.id);
  return result;
}

/**
 * 保存/启停后的后台发现：按新鲜期刷新 → 重注册 → 广播 dynamic_models_updated
 * 帧（前端重拉清单 + toast）。缓存仍新鲜时无事发生（不联网不打扰）；
 * 失败只记事件日志——保存本身已成功，AUTO 模型下次新鲜期过期后补上。
 */
function queueDiscoveryRefresh(row: {
  id: string;
  name: string;
  baseUrl: string;
  api?: string;
  headers?: string;
}): void {
  void refreshAndReconcile(row)
    .then((result) => {
      if (!result) return;
      send({
        type: "dynamic_models_updated",
        provider: row.id,
        ...result,
        source: "save",
      });
    })
    .catch((err) => {
      logAt("event", `[dynamic-models] ${row.id}: refresh failed: ${err}`);
    });
}

/** 在 baseUrl 上追加端点路径，保留查询串（baseUrl 可能带 api-version 等参数） */
function appendEndpointPath(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}${path}`;
  return url.toString();
}

/** 协议层地址校验：前缀 + 可解析主机。桌面已拦，这里防直接调用/导入绕过。 */
function assertBaseUrl(baseUrl: string): void {
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error("baseUrl must start with http(s)://");
  }
  try {
    if (!new URL(baseUrl).hostname) throw new Error("missing host");
  } catch {
    throw new Error("baseUrl is invalid");
  }
}

export const handlers: Record<string, CommandHandler> = {
  set_credential: async (reqId, msg) => {
    const provider = String(msg.provider ?? "");
    const apiKey = String(msg.apiKey ?? "");
    // env = 凭据的非密钥补充字段（如 Cloudflare 网关的 Account/Gateway ID）。
    // 只存 Key 解不出凭据的 provider 靠它补齐；apiKey 允许为空 = 只更新 env
    const env = parseCredentialEnv(msg.env);
    if (!provider || (!apiKey && !env)) {
      throw new Error("provider and (apiKey or env) are required");
    }
    if (apiKey) await credentialSet(provider, apiKey);
    if (env) await credentialEnvSet(provider, env);
    // 换密钥 = 换账户（发现缓存指纹含 key 摘要，旧缓存失效）：自动发现服务
    // 主动补一次后台重发现，模型清单跟上新账户（缓存新鲜期不阻挡——指纹已变）
    if (apiKey) {
      const row = await customProviderGet(provider);
      if (row?.enabled && row.autoDiscover) queueDiscoveryRefresh(row);
    }
    send({ id: reqId, type: "credential", provider });
  },

  list_credentials: async (reqId) => {
    // 网页搜索等非模型凭据共用 credentials 表（命名空间 websearch:）：模型账户页
    // 只渲染模型 provider，这里过滤掉，避免出现伪账户
    const providers = (await credentialList()).filter(
      (provider) => !provider.startsWith(WEBSEARCH_CREDENTIAL_PREFIX),
    );
    const credentials = await Promise.all(
      providers.map(async (providerId) => {
        const env = await credentialEnvGet(providerId);
        return {
          providerId,
          type: "api_key" as const,
          ...(Object.keys(env).length > 0 ? { env } : {}),
        };
      }),
    );
    send({ id: reqId, type: "credentials", credentials });
  },

  delete_credential: async (reqId, msg) => {
    const provider = String(msg.provider ?? "");
    await credentialDelete(provider);
    await credentialEnvDelete(provider);
    // 最近使用模型失去凭据：按口径改成默认（没有可用默认则清空）
    await reconcileLastUsedModel();
    send({ id: reqId, type: "credential_deleted", provider });
  },

  fetch_models: async (reqId, msg) => {
    // 拉取端点的模型列表（添加 AI 服务弹窗"获取列表"用），按接口格式区分：
    //   openai-chat / openai-responses → GET {baseUrl}/models（baseUrl 含 /v1），Bearer
    //   anthropic-messages → GET {baseUrl}/v1/models，x-api-key + anthropic-version
    const baseUrl = normalizeModelBaseUrl(String(msg.baseUrl ?? ""));
    let apiKey = String(msg.apiKey ?? "").trim();
    const providerId = String(msg.providerId ?? "").trim();
    if (!apiKey && providerId) {
      const stored = await credentialGet(providerId);
      if (stored) apiKey = stored.apiKey;
    }
    const apiKind = normalizeApi(msg.api);
    // 自定义请求头：表单当前值优先；编辑态不带该字段时回落到已存行（与 test_provider 同口径）
    const customHeaders =
      msg.headers === undefined
        ? parseStoredHeaders(
            providerId ? (await customProviderGet(providerId))?.headers : undefined,
            providerId,
          )
        : validateHeaderInput(msg.headers);
    assertBaseUrl(baseUrl);
    const anthropic = apiKind === "anthropic-messages";
    // 候选端点与自动发现同口径：baseUrl 已带 /v1 时只试一次；不带时
    // /models 与 /v1/models 竞速（用户可能填裸域名，也可能填带前缀的端点）。
    const endpoints = modelListCandidateUrls(baseUrl, apiKind);
    const requestHeaders: Record<string, string> = anthropic
      ? {
          ...(apiKey ? { "x-api-key": apiKey } : {}),
          "anthropic-version": "2023-06-01",
        }
      : apiKey
        ? { Authorization: `Bearer ${apiKey}` }
        : {};
    // 自定义头最后合并（用户显式填的覆盖默认 Authorization 等）
    applyCustomHeaders(requestHeaders, customHeaders);
    // 两段式（受理+迟到帧，optimize_prompt 同款）：网络等待绝不留在 mgmt
    // 串行队列里——否则端点不通时 abort/queue_clear 等「停止类」命令要在
    // 它身后干等满 15s（2026-10-24 test_provider 20s 占队阻塞停止的同类根因）。
    // 前置校验（URL/api 归一/头校验）已在上面同步完成，抛错走 handleLine
    // 的同步 error 帧，不产生迟到帧
    beginOp();
    void (async () => {
      // 候选共享一个超时 controller：到点全部掐断；分出胜负后同样掐掉落选
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      timer.unref?.();
      try {
        const winner = await firstNonEmpty(
          endpoints,
          async (url) => {
            try {
              const bundle = await fetchAllModelPages(url, {
                headers: requestHeaders,
                signal: controller.signal,
                logShape: true,
              });
              logAt(
                "event",
                `[fetch_models] ${redactUrl(url)}: ${bundle.rawRows} raw / ${bundle.models.length} models, ${bundle.pages} page(s)${bundle.truncated ? " (truncated)" : ""}`,
              );
              return bundle.models.length > 0 ? [bundle] : [];
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              const friendly = message
                .replace(/: request timed out$/, ": 获取模型列表超时")
                .replace(/: HTTP (\d+)$/, ": 获取模型列表失败: HTTP $1")
                .replace(/: response is not a model list$/, ": 响应不是模型列表");
              logAt("event", `[fetch_models] ${friendly}`);
              throw new Error(friendly);
            }
          },
          {
            // 预填场景空列表是合法结果：一个端点空、另一个 404 时如实回空，
            // 不升级成错误（自动发现才需要「有失败不得用空列表覆盖缓存」）
            tolerateEmptyWithFailures: true,
            // 两个候选都拉全并合并；先到先得会让较快的子集截胡较全的列表
            merge: (results) => [mergeModelPageBundles(results.flat())],
            mergeGraceMs: MODEL_MERGE_GRACE_MS,
          },
        );
        const bundle = winner[0] ?? { models: [], pages: 0, rawRows: 0, truncated: false };
        const { models, details } = fetchedFromDiscoveredModels(bundle.models);
        logAt(
          "event",
          `[fetch_models] merged ${bundle.rawRows} raw / ${models.length} models from ${bundle.pages} page(s)${bundle.truncated ? " (truncated)" : ""}`,
        );
        send({
          id: reqId,
          type: "fetched_models",
          models,
          ...(details.length > 0 ? { details } : {}),
          // 只在真的撞到页数上限时带上：正常响应保持旧契约，UI 据此提示可能不完整
          ...(bundle.truncated ? { truncated: true, pages: bundle.pages } : {}),
        });
      } catch (err) {
        sendFailure(reqId, err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(timer);
        controller.abort();
        endOp();
      }
    })();
  },

  add_custom_provider: async (reqId, msg) => {
    const name = String(msg.name ?? "").trim();
    const baseUrl = normalizeModelBaseUrl(String(msg.baseUrl ?? ""));
    const apiKey = String(msg.apiKey ?? "").trim();
    const modelSpecs = Array.isArray(msg.models)
      ? (msg.models as CustomModelSpec[]).filter(
          (m) => m && typeof m.id === "string" && m.id.trim(),
        )
      : [];
    if (!name) throw new Error("name is required");
    assertBaseUrl(baseUrl);
    // 开启自动发现时允许零手写模型：模型清单由后台发现补齐（保存后即触发）
    if (!modelSpecs.length && msg.autoDiscover !== true) {
      throw new Error("at least one model id is required");
    }
    const api = normalizeApi(msg.api);
    // 注意：协议层 reqId 占用了 "id" 字段，编辑目标的业务 id 走 "providerId"
    const existingId = typeof msg.providerId === "string" ? msg.providerId.trim() : "";
    const id =
      existingId ||
      `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || randomUUID().slice(0, 8)}`;
    // 自定义请求头：msg 不带该字段（老客户端/导入流程）= 保留原值，不误清；
    // 带了就严格校验（非法名/控制字符直接抛错，见 validateHeaderInput）
    const headersJson =
      msg.headers === undefined
        ? ((await customProviderGet(id))?.headers ?? "{}")
        : JSON.stringify(validateHeaderInput(msg.headers));
    // 模型行统一存 models 表（custom_providers.models 旧列保持 '[]'，仅留 schema 兼容）
    await customProviderUpsert({
      id,
      name,
      baseUrl,
      models: "[]",
      api,
      autoDiscover: msg.autoDiscover === true,
      headers: headersJson,
    });
    // 事件级一行：排"保存没生效"时先看这里存了几个头（曾因前端闭包旧值静默存成 {}）
    logAt(
      "event",
      `[provider] saved ${id} (${name}, ${modelSpecs.length} models, ${Object.keys(parseStoredHeaders(headersJson, id)).length} headers)`,
    );
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
        promptCache:
          m.promptCache && typeof m.promptCache === "object" ? m.promptCache : null,
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
      // 停用会把 provider 从目录移除：最近使用若指向它，一并按默认/清空自愈
      await reconcileLastUsedModel();
    }
    // 已恢复会话若用旧的同名模型定义，同步刷新其 baseUrl 等字段
    if (getCurrentModelKey()?.provider === id) {
      const model = getModels().getModel(id, getCurrentModelKey()!.modelId);
      if (model) for (const run of running.values()) run.agent.state.model = model;
    }
    // 自动发现服务保存后按需后台刷新：缓存过期（含首次开启）才联网，
    // 迟到结果经 dynamic_models_updated 帧广播，前端重拉清单
    if (enabledRow && enabledRow.enabled && enabledRow.autoDiscover) {
      queueDiscoveryRefresh(enabledRow);
    }
    send({ id: reqId, type: "custom_provider", provider: id });
  },

  list_custom_providers: async (reqId) => {
    const providers = await customProvidersList();
    const out = await Promise.all(
      providers.map(async (r) => {
        const rows = await modelsList(r.id);
        // 模型行读 models 表（enabled=1），属性与注册同口径三级兜底：
        // 行值 → 内置目录同名模型种子 → 注册默认值，供编辑表单回填
        const specs: (CustomModelSpec & {
          stored: StoredModelAttrs;
          seedSource: CatalogModelSeed["source"] | null;
          seedMatchedId: string | null;
        })[] = rows
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
              promptCache: row.promptCache ?? undefined,
              // 行里显式存过的值（null = 仍是继承态，生效值来自目录种子或缺省）。
              // 编辑弹窗靠它区分"用户填过"与"算出来的"，保存时才不会把生效值
              // 反写成显式值——那会把目录/归一化命中的真值永久冻住
              stored: {
                name: row.name,
                reasoning: row.reasoning,
                contextWindow: row.contextWindow,
                maxTokens: row.maxTokens,
                input: parseModelInput(row.input),
                cost: parseModelCost(row.cost),
                promptCache: row.promptCache,
              },
              // 种子来源：exact = 完整 id 同名；normalized = 剥掉一层命名空间前缀
              // 后同名。属性弹窗据此把"目录推测"与"目录真值"分开标注
              seedSource: seed?.source ?? null,
              seedMatchedId: seed?.matchedId ?? null,
            };
          });
        // 只回掩码：明文 key 不进渲染进程（编辑弹窗输入框留空 = 保持原 key，
        // 见 add_custom_provider 的空串语义）
        const keyRow = await credentialGet(r.id);
        // 动态发现的 AUTO 模型（autoDiscover 开启时）：缓存里用户没手写的 id
        // 追加在手写行之后，带 auto 标记——编辑弹窗只列手写行（保存会整表
        // 替换 models 行，把 AUTO 一起提交会把发现结果全部晋升为手写），
        // AUTO 由发现流程管理。排除集用全部行（含停用）：显式停用的模型不能
        // 在清单里复活。指纹口径与注册一致（key 进 sha256 摘要）。
        const autoSpecs: (CustomModelSpec & { auto: true })[] = r.autoDiscover
          ? (
              await loadAutoModels(
                r.id,
                {
                  baseUrl: r.baseUrl,
                  api: normalizeApi(r.api),
                  apiKey: keyRow?.apiKey,
                  headers: parseStoredHeaders(r.headers, r.id),
                },
                rows.map((row) => row.modelId.trim()),
              ).catch(() => [])
            ).map((m) => ({
              id: m.id,
              name: m.name ?? m.id,
              reasoning: m.reasoning ?? false,
              ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
              ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
              ...(m.input ? { input: m.input } : {}),
              auto: true as const,
            }))
          : [];
        return {
          providerId: r.id,
          name: r.name,
          baseUrl: r.baseUrl,
          models: [...specs, ...autoSpecs],
          api: normalizeApi(r.api),
          hasApiKey: keyRow !== null,
          apiKeyMasked: keyRow ? maskApiKey(keyRow.apiKey) : undefined,
          enabled: r.enabled,
          autoDiscover: r.autoDiscover,
          // 自定义请求头（解析为对象供编辑弹窗回填；坏值已在解析时丢弃）
          headers: parseStoredHeaders(r.headers, r.id),
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
    await repointCurrentModelAwayFrom(provider);
    await reconcileLastUsedModel();
    send({ id: reqId, type: "custom_provider_deleted", provider });
  },

  toggle_custom_provider: async (reqId, msg) => {
    // 启用/停用服务：停用时从模型目录移除，启用时重新注册（模型行读 models 表）
    const provider = String(msg.provider ?? "");
    const enabled = msg.enabled === true;
    await customProviderSetEnabled(provider, enabled);
    if (enabled) {
      const row = await customProviderGet(provider);
      if (row) {
        await registerCustomProvider(row);
        // 启用自动发现服务：缓存过期才联网补发现，迟到结果广播帧
        if (row.autoDiscover) queueDiscoveryRefresh(row);
      }
    } else {
      getModels().deleteProvider(provider);
      await repointCurrentModelAwayFrom(provider);
      await reconcileLastUsedModel();
    }
    send({ id: reqId, type: "custom_provider_toggled", provider, enabled });
  },

  refresh_dynamic_models: async (reqId, msg) => {
    // 强制刷新动态发现并重注册（服务卡片刷新按钮）。两段式（fetch_models 同款）：
    // 网络等待绝不留在 mgmt 串行队列里，完成/失败走迟到帧配对
    const provider = String(msg.provider ?? "").trim();
    const row = await customProviderGet(provider);
    if (!row) throw new Error("unknown provider");
    if (!row.enabled) throw new Error("provider is disabled");
    if (!row.autoDiscover) throw new Error("auto-discover is disabled for this provider");
    beginOp();
    void (async () => {
      try {
        // force 刷新必然有结果或抛错；undefined = 刷新期间服务被停用/删除，
        // 已对账回滚，按失败应答让按钮明确知道没刷成
        const result = await refreshAndReconcile(row, { force: true });
        if (!result) {
          sendFailure(reqId, "provider was disabled or deleted during refresh");
          return;
        }
        send({
          id: reqId,
          type: "dynamic_models_refreshed",
          provider,
          ...result,
        });
      } catch (err) {
        sendFailure(reqId, err instanceof Error ? err.message : String(err));
      } finally {
        endOp();
      }
    })();
  },

  update_model: async (reqId, msg) => {
    // 模型属性编辑：消息里携带的字段写入 models 表（null = 重置继承内置值，
    // 未携带 = 保留现值），并原地应用到目录模型对象
    const provider = String(msg.provider ?? "");
    const modelId = String(msg.modelId ?? "");
    if (!provider || !modelId) throw new Error("provider and modelId are required");
    const rows = await modelsList(provider);
    const base = rows.find((r) => r.modelId === modelId);
    // AUTO 模型晋升（custom provider + models 表还没有行）：未被编辑的字段钉住
    // 目录当前生效值——行落 null 的话，重启按行重建会退回种子/缺省，丢掉网关
    // 自报的窗口/档位等真值。内置 provider 保持行 null = 恢复目录真值的既有
    // 语义，不钉（目录本身就是权威值）。
    const auto = base || !isCustomProvider(provider)
      ? undefined
      : getModels().getModel(provider, modelId);
    const pick = (key: string, fallback: unknown): unknown =>
      key in msg ? (msg[key] ?? null) : fallback;
    // promptCache 形状校验：{short?,long?} 秒（正数）；非法整体按 null（重置）
    const rawPromptCache = pick("promptCache", base?.promptCache ?? null) as
      | { short?: unknown; long?: unknown }
      | null;
    const ttlOf = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : undefined;
    const promptCache =
      rawPromptCache && typeof rawPromptCache === "object"
        ? {
            ...(ttlOf(rawPromptCache.short) !== undefined ? { short: ttlOf(rawPromptCache.short) } : {}),
            ...(ttlOf(rawPromptCache.long) !== undefined ? { long: ttlOf(rawPromptCache.long) } : {}),
          }
        : null;
    const item: ModelReplaceItem = {
      modelId,
      enabled: base?.enabled ?? true,
      name: pick("name", base?.name ?? auto?.name ?? null) as string | null,
      reasoning: pick("reasoning", base?.reasoning ?? auto?.reasoning ?? null) as boolean | null,
      contextWindow: pick(
        "contextWindow",
        base?.contextWindow ?? auto?.contextWindow ?? null,
      ) as number | null,
      maxTokens: pick("maxTokens", base?.maxTokens ?? auto?.maxTokens ?? null) as number | null,
      input: pick("input", base?.input ?? auto?.input ?? null) as unknown[] | null,
      cost: pick("cost", base?.cost ?? auto?.cost ?? null) as Record<string, unknown> | null,
      promptCache,
    };
    // 单行更新按整包替换契约合并写回（见 mergeModelRowUpdate）——单条直塞会
    // 清空兄弟行
    await modelsReplace(provider, mergeModelRowUpdate(rows, item));
    applyRowToCatalogModel({
      provider,
      modelId,
      name: item.name ?? null,
      reasoning: item.reasoning ?? null,
      contextWindow: item.contextWindow ?? null,
      maxTokens: item.maxTokens ?? null,
      input: item.input ?? null,
      cost: item.cost ?? null,
      promptCache: item.promptCache ?? null,
    });
    send({ id: reqId, type: "model_updated", provider, modelId });
  },

  scan_provider_imports: async (reqId) => {
    // 扫本机其它工具（opencode / Codex / ZCode）的配置，列出可导入的模型服务。
    // 只读命令：写入仍走 add_custom_provider，冲突与启停策略全在那一侧
    const scan = scanProviderImports();
    send({ id: reqId, type: "provider_import_candidates", ...scan });
  },

  test_provider: async (reqId, msg) => {
    // 测试服务连通性：按接口格式发一条最小请求。apiKey 留空且给了
    // providerId 时取已存凭据——编辑弹窗不再回传明文 key，测试要能用旧 key
    const baseUrl = normalizeModelBaseUrl(String(msg.baseUrl ?? ""));
    let apiKey = String(msg.apiKey ?? "").trim();
    const providerId = String(msg.providerId ?? "").trim();
    if (!apiKey && providerId) {
      const stored = await credentialGet(providerId);
      if (stored) apiKey = stored.apiKey;
    }
    const model = String(msg.model ?? "").trim();
    const apiKind = normalizeApi(msg.api);
    // 自定义请求头：表单当前值优先；编辑弹窗不带该字段时回落到已存行的头
    const customHeaders =
      msg.headers === undefined
        ? parseStoredHeaders(
            providerId ? (await customProviderGet(providerId))?.headers : undefined,
            providerId,
          )
        : validateHeaderInput(msg.headers);
    assertBaseUrl(baseUrl);
    if (!model) throw new Error("model is required");
    let url: string;
    let headers: Record<string, string>;
    let body: unknown;
    const anthropicBasePath = new URL(baseUrl).pathname.replace(/\/+$/, "");
    if (apiKind === "anthropic-messages") {
      url = appendEndpointPath(
        baseUrl,
        anthropicBasePath.toLowerCase().endsWith("/v1") ? "/messages" : "/v1/messages",
      );
      headers = {
        "content-type": "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
        "anthropic-version": "2023-06-01",
      };
      body = { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] };
    } else if (apiKind === "openai-responses") {
      url = appendEndpointPath(baseUrl, "/responses");
      headers = {
        "content-type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      };
      body = { model, input: "ping", max_output_tokens: 16 };
    } else {
      url = appendEndpointPath(baseUrl, "/chat/completions");
      headers = {
        "content-type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      };
      body = { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] };
    }
    // 自定义头最后合并：用户显式填的覆盖默认 Authorization 等内容（大小写不敏感）
    applyCustomHeaders(headers, customHeaders);
    // 两段式（受理+迟到帧，optimize_prompt 同款）：端点不通时 fetch 要等满
    // 20s 超时——同步等在 mgmt 串行队列里会挡住 abort/queue_clear 等一切
    // 「停止类」命令（2026-10-24 实测 test_provider 占队 20s，用户点停止干等）。
    // 前置校验已同步完成，抛错走 handleLine 的同步 error 帧，不产生迟到帧
    beginOp();
    void (async () => {
      try {
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
      } catch (err) {
        // 网络错误可能把带 query 的 URL 拼进 message；日志/回执统一脱敏
        sendFailure(reqId, redactUrl(err instanceof Error ? err.message : String(err)));
      } finally {
        endOp();
      }
    })();
  },
};
