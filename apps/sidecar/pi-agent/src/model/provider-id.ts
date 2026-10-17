/**
 * Provider id 迁移别名。
 *
 * pi-ai 1.0.3 把 Azure provider 的 id 从 `azure-openai-responses` 改为
 * `azure`（api id 仍是 `azure-openai-responses`）。Kova 的转录、SQLite
 * 偏好、kv 与子代理/自动化配置里可能还存着旧 id，统一在这里做读时归一；
 * 表数据另有一次启动迁移（见 electron/main/data.ts 与 hostdb/local.ts）。
 */
const PROVIDER_ID_ALIASES: Readonly<Record<string, string>> = {
  "azure-openai-responses": "azure",
};

/** 新 id → 可能仍留在旧存档里的历史 id（读时兜底用） */
const LEGACY_PROVIDER_IDS: Readonly<Record<string, readonly string[]>> = {
  azure: ["azure-openai-responses"],
};

export function normalizeProviderId(provider: string): string {
  return PROVIDER_ID_ALIASES[provider] ?? provider;
}

export function legacyProviderIds(provider: string): readonly string[] {
  return LEGACY_PROVIDER_IDS[normalizeProviderId(provider)] ?? [];
}
