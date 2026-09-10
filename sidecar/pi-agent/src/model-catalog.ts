/**
 * 模型目录：pi-ai 内置 catalog（39 个 provider）+ 本地凭据，
 * 叠加自定义 OpenAI 兼容提供商（用户配置 baseUrl + apiKey + 模型 id）。
 * 目录在 initStorage 之后通过 getModels() 惰性创建。
 */
import {
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { logErr } from "./log";
import { credentialStore, db } from "./storage";
import type { CustomApiKind, CustomModelSpec } from "./types";

/** 模型目录类型（含 provider 注册/删除、模型查询、凭据查询） */
export type ModelCatalog = ReturnType<typeof builtinModels>;

let catalog: ModelCatalog | undefined;

/** 取模型目录单例（首次调用时基于已初始化的凭据存储构建） */
export function getModels(): ModelCatalog {
  if (!catalog) catalog = builtinModels({ credentials: credentialStore });
  return catalog;
}

/** 当前选中的模型（重启后由前端通过 set_model 恢复） */
let currentModelKey: { provider: string; modelId: string } | null = null;

export function getCurrentModelKey(): {
  provider: string;
  modelId: string;
} | null {
  return currentModelKey;
}

export function setCurrentModelKey(key: {
  provider: string;
  modelId: string;
} | null): void {
  currentModelKey = key;
}

/** 未选模型时的默认策略：catalog 里第一个有凭据的模型 */
export async function defaultModel(): Promise<Model<Api> | undefined> {
  try {
    const available = await getModels().getAvailable();
    logErr(
      "defaultModel: available =",
      available.length,
      available[0]?.provider,
      available[0]?.id,
    );
    return available[0];
  } catch (err) {
    logErr("defaultModel: getAvailable failed:", err);
    return undefined;
  }
}

/** 自定义提供商支持的接口格式 → pi-ai Api 实现工厂 */
const API_FACTORIES: Record<CustomApiKind, typeof openAICompletionsApi> = {
  "openai-chat": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
};

/** UI 值 → pi-ai Api 标识 */
const API_ID: Record<CustomApiKind, Api> = {
  "openai-chat": "openai-completions",
  "openai-responses": "openai-responses",
  "anthropic-messages": "anthropic-messages",
};

/** 任意输入归一化为 CustomApiKind（缺省 openai-chat） */
export const normalizeApi = (v: unknown): CustomApiKind =>
  v === "openai-responses" || v === "anthropic-messages" ? v : "openai-chat";

/** 把一行 custom_providers 记录构造成 provider 并注册进模型目录 */
export function registerCustomProvider(row: {
  id: string;
  name: string;
  base_url: string;
  models: string;
  api?: string;
}) {
  let specs: CustomModelSpec[] = [];
  try {
    specs = JSON.parse(row.models) as CustomModelSpec[];
  } catch {
    specs = [];
  }
  // baseUrl 语义与 OpenAI SDK 一致：完整前缀，API 实现在其后拼各自端点
  // （openai-chat → /chat/completions，openai-responses → /responses，anthropic-messages → /v1/messages）
  const baseUrl = row.base_url.trim().replace(/\/+$/, "");
  const apiKind = normalizeApi(row.api);
  const modelList: Model<Api>[] = specs
    .filter((m) => m && typeof m.id === "string" && m.id.trim())
    .map((m) => ({
      id: m.id.trim(),
      name: m.name?.trim() || m.id.trim(),
      api: API_ID[apiKind],
      provider: row.id,
      baseUrl,
      reasoning: m.reasoning ?? false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow ?? 128_000,
      maxTokens: m.maxTokens ?? 8_192,
    }));
  const provider = createProvider({
    id: row.id,
    name: row.name,
    baseUrl,
    auth: { apiKey: envApiKeyAuth(`${row.name} API key`, []) },
    models: modelList,
    api: API_FACTORIES[apiKind](),
  });
  getModels().setProvider(provider);
}

/** 启动时把已保存的自定义提供商全部注册（停用的跳过）；入口在 initStorage 后调用 */
export function loadCustomProviders() {
  const rows = db
    .query<
      {
        id: string;
        name: string;
        base_url: string;
        models: string;
        enabled: number;
      },
      []
    >("SELECT id, name, base_url, models, enabled FROM custom_providers")
    .all();
  for (const row of rows) {
    if (!row.enabled) continue;
    try {
      registerCustomProvider(row);
    } catch (err) {
      logErr("registerCustomProvider failed for", row.id, err);
    }
  }
}
