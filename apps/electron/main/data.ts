/**
 * pi-agent 业务数据层（对齐 data.rs 全量 host_query 契约）：
 * sessions / credentials / secrets / custom_providers / models / usage_daily /
 * usage_scan 的建表、迁移与 31 种 kind 的处理。SQL 与返回形状逐条对照源码。
 */
import type { Db, Row } from "./db";
import { decrypt, encrypt, isEncrypted } from "./secret";
import { logWarn } from "./logging";

/* ------------------------------- 建表与迁移 ------------------------------- */

export function initTables(db: Db): void {
  // 旧表重命名（pi_ 前缀）：须在 CREATE 之前，避免新表挡住重命名
  tryRename(db, "ALTER TABLE pi_sessions RENAME TO sessions");
  tryRename(db, "ALTER TABLE pi_models RENAME TO models");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        first_message TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        message_count INTEGER
    );
    CREATE TABLE IF NOT EXISTS credentials (
        provider TEXT PRIMARY KEY,
        api_key TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS secrets (
        name TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'global',
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (name, scope)
    );
    CREATE TABLE IF NOT EXISTS custom_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        models TEXT NOT NULL DEFAULT '[]',
        api TEXT NOT NULL DEFAULT 'openai-chat',
        headers TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS models (
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        name TEXT,
        reasoning INTEGER,
        context_window INTEGER,
        max_tokens INTEGER,
        input_json TEXT,
        cost_json TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (provider, model_id)
    );
    CREATE TABLE IF NOT EXISTS usage_daily (
        session_id TEXT NOT NULL,
        date TEXT NOT NULL,
        input INTEGER NOT NULL DEFAULT 0,
        output INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0,
        tokens INTEGER NOT NULL DEFAULT 0,
        messages INTEGER NOT NULL DEFAULT 0,
        by_model TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (session_id, date)
    );
    CREATE TABLE IF NOT EXISTS usage_scan (
        session_id TEXT PRIMARY KEY,
        mtime REAL NOT NULL,
        first_ts INTEGER NOT NULL DEFAULT 0,
        last_ts INTEGER NOT NULL DEFAULT 0
    );`);

  // 旧库补列（已存在则忽略）
  for (const sql of [
    "ALTER TABLE custom_providers ADD COLUMN api TEXT NOT NULL DEFAULT 'openai-chat';",
    "ALTER TABLE custom_providers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;",
    "ALTER TABLE custom_providers ADD COLUMN headers TEXT NOT NULL DEFAULT '{}';",
    "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE sessions ADD COLUMN message_count INTEGER;",
    "ALTER TABLE sessions ADD COLUMN mode TEXT;",
    "ALTER TABLE sessions ADD COLUMN approval_level TEXT;",
    "ALTER TABLE sessions ADD COLUMN model_provider TEXT;",
    "ALTER TABLE sessions ADD COLUMN model_id TEXT;",
    "ALTER TABLE sessions ADD COLUMN thinking_level TEXT;",
    "ALTER TABLE sessions ADD COLUMN design_theme TEXT;",
    "ALTER TABLE sessions ADD COLUMN app_mode TEXT;",
    "ALTER TABLE sessions ADD COLUMN goal_max_turns TEXT;",
  ]) {
    try {
      db.exec(sql);
    } catch {
      /* 列已存在 */
    }
  }

  // 早期版本把未选目录的会话 cwd 存成主目录：统一清空
  const home = homeDir();
  if (home) {
    try {
      db.prepare("UPDATE sessions SET cwd = '' WHERE cwd = ?1").run(home);
    } catch {
      /* ignore */
    }
  }

  migrateAzureProviderId(db);
  migrateCustomProviderModels(db);
  migrateProviderModelFilters(db);
  drainLegacyTable(db, "pi_sessions", "sessions", "id, title, first_message, cwd, created_at, updated_at");
  drainLegacyTable(
    db,
    "pi_models",
    "models",
    "provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, enabled",
  );
}

function tryRename(db: Db, sql: string): void {
  try {
    db.exec(sql);
  } catch {
    /* 旧表不存在等，忽略（对齐 Rust let _ =） */
  }
}

function homeDir(): string | undefined {
  const v = process.env.USERPROFILE ?? process.env.HOME;
  return v && v.length > 0 ? v : undefined;
}

function tableExists(db: Db, name: string): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?1")
    .get(name) as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}

const LEGACY_AZURE_PROVIDER = "azure-openai-responses";
const AZURE_PROVIDER = "azure";

/**
 * pi-ai 1.0.3 把 Azure provider id 从 `azure-openai-responses` 改为 `azure`。
 * 迁移所有 provider-keyed 数据，保证升级后 Azure 凭据/模型过滤/会话选择不丢。
 * 分步 try/catch：某一步失败不阻塞其它步骤；读时别名仍可兜底。
 */
function migrateAzureProviderId(db: Db): void {
  const step = (label: string, fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      logWarn(`[data] azure provider migration step "${label}" failed: ${e}`);
    }
  };

  step("credentials", () => {
    const old = db
      .prepare("SELECT api_key, updated_at FROM credentials WHERE provider = ?1")
      .get(LEGACY_AZURE_PROVIDER);
    if (!old) return;
    const existing = db
      .prepare("SELECT provider FROM credentials WHERE provider = ?1")
      .get(AZURE_PROVIDER);
    if (!existing) {
      db.prepare("UPDATE credentials SET provider = ?1 WHERE provider = ?2").run(
        AZURE_PROVIDER,
        LEGACY_AZURE_PROVIDER,
      );
    } else {
      // 新行已存在：保留新行，旧行只补空字段后删除
      db.prepare("DELETE FROM credentials WHERE provider = ?1").run(
        LEGACY_AZURE_PROVIDER,
      );
    }
  });

  step("models", () => {
    const rows = db
      .prepare(
        "SELECT model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, enabled FROM models WHERE provider = ?1",
      )
      .all(LEGACY_AZURE_PROVIDER);
    for (const row of rows) {
      const modelId = String(row.model_id ?? "");
      if (!modelId) continue;
      const existing = db
        .prepare("SELECT provider FROM models WHERE provider = ?1 AND model_id = ?2")
        .get(AZURE_PROVIDER, modelId);
      if (!existing) {
        db.prepare(
          "UPDATE models SET provider = ?1 WHERE provider = ?2 AND model_id = ?3",
        ).run(AZURE_PROVIDER, LEGACY_AZURE_PROVIDER, modelId);
        continue;
      }
      // 冲突安全合并：保留新行非空值，旧行只补空；enabled 取并集
      db.prepare(
        `UPDATE models SET
           name = COALESCE(name, ?1),
           reasoning = COALESCE(reasoning, ?2),
           context_window = COALESCE(context_window, ?3),
           max_tokens = COALESCE(max_tokens, ?4),
           input_json = COALESCE(input_json, ?5),
           cost_json = COALESCE(cost_json, ?6),
           enabled = MAX(enabled, ?7)
         WHERE provider = ?8 AND model_id = ?9`,
      ).run(
        row.name ?? null,
        row.reasoning ?? null,
        row.context_window ?? null,
        row.max_tokens ?? null,
        row.input_json ?? null,
        row.cost_json ?? null,
        row.enabled ?? 1,
        AZURE_PROVIDER,
        modelId,
      );
      db.prepare("DELETE FROM models WHERE provider = ?1 AND model_id = ?2").run(
        LEGACY_AZURE_PROVIDER,
        modelId,
      );
    }
  });

  step("sessions", () => {
    db.prepare("UPDATE sessions SET model_provider = ?1 WHERE model_provider = ?2").run(
      AZURE_PROVIDER,
      LEGACY_AZURE_PROVIDER,
    );
  });

  step("kv", () => {
    const row = db.prepare("SELECT value FROM kv WHERE key = 'pi.model'").get();
    const raw = typeof row?.value === "string" ? row.value : "";
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { provider?: string; modelId?: string };
        if (parsed?.provider === LEGACY_AZURE_PROVIDER) {
          db.prepare("UPDATE kv SET value = ?1 WHERE key = 'pi.model'").run(
            JSON.stringify({ ...parsed, provider: AZURE_PROVIDER }),
          );
        }
      } catch {
        /* 坏 JSON：保留原值，读时别名兜底 */
      }
    }
    const oldKey = `credential.env.${LEGACY_AZURE_PROVIDER}`;
    const newKey = `credential.env.${AZURE_PROVIDER}`;
    const oldEnv = db.prepare("SELECT value FROM kv WHERE key = ?1").get(oldKey);
    if (!oldEnv) return;
    const newEnv = db.prepare("SELECT value FROM kv WHERE key = ?1").get(newKey);
    if (!newEnv) {
      db.prepare("UPDATE kv SET key = ?1 WHERE key = ?2").run(newKey, oldKey);
    } else {
      db.prepare("DELETE FROM kv WHERE key = ?1").run(oldKey);
    }
  });
}

function migrateCustomProviderModels(db: Db): void {
  let rows: { id: string; models: string }[];
  try {
    rows = db.prepare("SELECT id, models FROM custom_providers WHERE models != '[]'").all() as any;
  } catch (e) {
    logWarn(`[data] read custom_providers for model migration failed: ${e}`);
    return;
  }
  for (const { id, models } of rows) {
    let specs: any[] = [];
    try {
      specs = JSON.parse(models);
    } catch {
      specs = [];
    }
    for (const spec of specs) {
      const modelId = strOrNull(spec?.id);
      if (!modelId || !modelId.trim()) continue;
      db.prepare(
        `INSERT OR REPLACE INTO models
         (provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        id,
        modelId,
        strOrNull(spec?.name),
        typeof spec?.reasoning === "boolean" ? spec.reasoning : null,
        numOrNull(spec?.contextWindow),
        numOrNull(spec?.maxTokens),
        Array.isArray(spec?.input) ? JSON.stringify(spec.input) : null,
        spec?.cost && typeof spec.cost === "object" ? JSON.stringify(spec.cost) : null,
      );
    }
    db.prepare("UPDATE custom_providers SET models = '[]' WHERE id = ?1").run(id);
  }
}

function migrateProviderModelFilters(db: Db): void {
  if (!tableExists(db, "provider_models")) return;
  let rows: { provider: string; models: string }[];
  try {
    rows = db
      .prepare(
        `SELECT provider, models FROM provider_models
         WHERE models != '[]' AND provider NOT IN (SELECT DISTINCT provider FROM models)`,
      )
      .all() as any;
  } catch {
    return;
  }
  for (const { provider, models } of rows) {
    let ids: string[] = [];
    try {
      ids = JSON.parse(models);
    } catch {
      ids = [];
    }
    for (const modelId of ids) {
      if (!String(modelId).trim()) continue;
      try {
        db.prepare("INSERT OR IGNORE INTO models (provider, model_id, enabled) VALUES (?, ?, 1)").run(provider, String(modelId));
      } catch {
        /* 单条失败跳过（对齐 filter_map(ok)） */
      }
    }
  }
  try {
    db.exec("DROP TABLE provider_models");
  } catch {
    /* ignore */
  }
}

function drainLegacyTable(db: Db, legacy: string, target: string, columns: string): void {
  if (!tableExists(db, legacy)) return;
  try {
    db.exec(`INSERT OR IGNORE INTO ${target} (${columns}) SELECT ${columns} FROM ${legacy}`);
    db.exec(`DROP TABLE ${legacy}`);
  } catch (e) {
    logWarn(`[data] drain ${legacy} failed: ${e}`);
  }
}

/* ------------------------------- 辅助函数 ------------------------------- */

export const MAX_SECRET_VALUE_BYTES = 8 * 1024;

export function isValidSecretName(name: string): boolean {
  if (name.length > 128) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export function isValidSecretScope(scope: string): boolean {
  return scope === "global" || (scope.startsWith("workspace:") && scope.length > "workspace:".length);
}

/** 掩码规则与 provider key 一致：`****` + 后四位（码点计数，对齐 Rust chars()） */
function maskSecret(plain: string): string {
  const chars = Array.from(plain);
  if (chars.length > 4) return "****" + chars.slice(-4).join("");
  return "****";
}

function strParam(p: any, key: string): string {
  const v = p?.[key];
  if (typeof v !== "string") throw new Error(`missing param: ${key}`);
  return v;
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

function modelsQuery(db: Db, provider?: string): any[] {
  const sql = provider
    ? "SELECT provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, enabled FROM models WHERE provider = ?1 ORDER BY model_id"
    : "SELECT provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, enabled FROM models ORDER BY provider, model_id";
  const rows = (provider ? db.prepare(sql).all(provider) : db.prepare(sql).all()) as Row[];
  return rows.map((r) => {
    let input: unknown = null;
    let cost: unknown = null;
    try {
      const parsed = JSON.parse(String(r.input_json));
      if (Array.isArray(parsed)) input = parsed;
    } catch {
      /* NULL/非法 = 无 */
    }
    try {
      const parsed = JSON.parse(String(r.cost_json));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cost = parsed;
    } catch {
      /* 同上 */
    }
    return {
      provider: r.provider,
      modelId: r.model_id,
      name: r.name ?? null,
      reasoning: r.reasoning === null || r.reasoning === undefined ? null : Number(r.reasoning) === 1,
      contextWindow: r.context_window ?? null,
      maxTokens: r.max_tokens ?? null,
      input,
      cost,
      enabled: Number(r.enabled) === 1,
    };
  });
}

/* ------------------------------- host_query 分发 ------------------------------- */

/**
 * 对齐 dispatch_host_query：kind="tool" 不进 db 串行（长 bash 不阻塞其他查询——
 * Node 侧由 toolExec 自行异步处理），其余 kind 同步走 handleHostQuery。
 * 返回 JSON 字符串（宿主对 sidecar 的 host_result 行）。
 */
export async function dispatchHostQuery(db: Db, msg: any): Promise<string> {
  const id = typeof msg?.id === "string" ? msg.id : "";
  let reply: unknown;
  try {
    const kind = msg?.kind;
    if (typeof kind !== "string") throw new Error("missing kind");
    const params = msg?.params ?? null;
    let data: unknown;
    if (kind === "tool") {
      // 工具执行（阶段②）：不进 db 串行锁——长 bash 不阻塞其他 host_query
      const envelope = { ...(params ?? {}) };
      const { resolveIntoEnvelope } = await import("./secret-env");
      resolveIntoEnvelope(db, envelope);
      const { handleTool } = await import("./tool-exec");
      data = await handleTool(id, envelope);
    } else {
      data = handleHostQuery(db, kind, params);
    }
    reply = { type: "host_result", id, ok: true, data: data ?? null };
  } catch (err) {
    reply = { type: "host_result", id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return JSON.stringify(reply);
}

export function handleHostQuery(db: Db, kind: string, p: any): unknown {
  switch (kind) {
    /* ------------------------------- sessions ------------------------------- */
    case "session_get": {
      const id = strParam(p, "sessionId");
      const row = db
        .prepare(
          "SELECT cwd, title, mode, approval_level, model_provider, model_id, thinking_level, design_theme, app_mode, goal_max_turns FROM sessions WHERE id = ?1",
        )
        .get(id) as Row | undefined;
      if (!row) return null;
      return {
        cwd: row.cwd,
        title: row.title,
        mode: row.mode ?? null,
        approvalLevel: row.approval_level ?? null,
        modelProvider: row.model_provider ?? null,
        modelId: row.model_id ?? null,
        thinkingLevel: row.thinking_level ?? null,
        designTheme: row.design_theme ?? null,
        appMode: row.app_mode ?? null,
        goalMaxTurns: row.goal_max_turns ?? null,
      };
    }
    case "session_insert": {
      const id = strParam(p, "sessionId");
      const cwd = typeof p?.cwd === "string" ? p.cwd : "";
      const now = strParam(p, "now");
      db.prepare(
        "INSERT INTO sessions (id, title, first_message, cwd, created_at, updated_at, message_count) VALUES (?, '', '', ?, ?, ?, 0)",
      ).run(id, cwd, now, now);
      return {};
    }
    case "session_list": {
      const rows = db
        .prepare(
          "SELECT id, title, first_message, cwd, archived, updated_at, message_count, mode, approval_level, model_provider, model_id, thinking_level, design_theme, app_mode, goal_max_turns FROM sessions ORDER BY updated_at DESC",
        )
        .all() as Row[];
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        first_message: r.first_message,
        cwd: r.cwd,
        archived: Number(r.archived) === 1 ? 1 : 0,
        updated_at: r.updated_at,
        message_count: r.message_count == null ? 0 : Number(r.message_count),
        mode: r.mode ?? null,
        approvalLevel: r.approval_level ?? null,
        modelProvider: r.model_provider ?? null,
        modelId: r.model_id ?? null,
        thinkingLevel: r.thinking_level ?? null,
        designTheme: r.design_theme ?? null,
        appMode: r.app_mode ?? null,
        goalMaxTurns: r.goal_max_turns ?? null,
      }));
    }
    case "session_delete": {
      db.prepare("DELETE FROM sessions WHERE id = ?1").run(strParam(p, "sessionId"));
      return {};
    }
    case "session_rename": {
      db.prepare("UPDATE sessions SET title = ?1 WHERE id = ?2").run(strParam(p, "name"), strParam(p, "sessionId"));
      return {};
    }
    case "session_set_archived": {
      const archived = Boolean(p?.archived);
      db.prepare("UPDATE sessions SET archived = ?1 WHERE id = ?2").run(archived ? 1 : 0, strParam(p, "sessionId"));
      return {};
    }
    case "session_update_cwd": {
      db.prepare("UPDATE sessions SET cwd = ?1 WHERE id = ?2").run(strParam(p, "cwd"), strParam(p, "sessionId"));
      return {};
    }
    case "session_touch": {
      const id = strParam(p, "sessionId");
      const now = strParam(p, "now");
      const title = typeof p?.title === "string" ? p.title : "";
      const firstMessage = typeof p?.firstMessage === "string" ? p.firstMessage : "";
      const added = typeof p?.added === "number" ? Math.trunc(p.added) : 0;
      db.prepare(
        `UPDATE sessions SET updated_at = ?1,
         title = CASE WHEN title = '' THEN ?2 ELSE title END,
         first_message = CASE WHEN first_message = '' THEN ?3 ELSE first_message END,
         message_count = COALESCE(message_count, 0) + ?5
         WHERE id = ?4`,
      ).run(now, title, firstMessage, id, added);
      return {};
    }
    case "session_prefs_set": {
      const id = strParam(p, "sessionId");
      db.prepare(
        `UPDATE sessions SET
         mode = COALESCE(?2, mode),
         approval_level = COALESCE(?3, approval_level),
         model_provider = COALESCE(?4, model_provider),
         model_id = COALESCE(?5, model_id),
         thinking_level = COALESCE(?6, thinking_level),
         design_theme = COALESCE(?7, design_theme),
         app_mode = COALESCE(?8, app_mode),
         goal_max_turns = COALESCE(?9, goal_max_turns)
         WHERE id = ?1`,
      ).run(
        id,
        strOrNull(p?.mode),
        strOrNull(p?.approvalLevel),
        strOrNull(p?.modelProvider),
        strOrNull(p?.modelId),
        strOrNull(p?.thinkingLevel),
        strOrNull(p?.designTheme),
        strOrNull(p?.appMode),
        strOrNull(p?.goalMaxTurns),
      );
      return {};
    }
    /* ------------------------------- credentials ------------------------------- */
    case "credential_get": {
      const provider = strParam(p, "provider");
      const row = db.prepare("SELECT api_key FROM credentials WHERE provider = ?1").get(provider) as { api_key: string } | undefined;
      if (!row) return null;
      const dec = decrypt(row.api_key);
      if (!dec.ok) {
        logWarn(`[data] credential decrypt failed for ${provider}: ${dec.error}`);
        return null;
      }
      return { apiKey: dec.value };
    }
    case "credential_list": {
      const rows = db.prepare("SELECT provider FROM credentials").all() as { provider: string }[];
      return rows.map((r) => r.provider);
    }
    case "credential_set": {
      const provider = strParam(p, "provider");
      const apiKey = encrypt(strParam(p, "apiKey"));
      const now = strParam(p, "now");
      db.prepare(
        `INSERT INTO credentials (provider, api_key, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET api_key = excluded.api_key, updated_at = excluded.updated_at`,
      ).run(provider, apiKey, now);
      return {};
    }
    case "credential_delete": {
      db.prepare("DELETE FROM credentials WHERE provider = ?1").run(strParam(p, "provider"));
      return {};
    }
    /* ------------------------------- 密钥库 ------------------------------- */
    case "secret_list": {
      const rows = db.prepare("SELECT name, scope, value, updated_at FROM secrets ORDER BY name, scope").all() as Row[];
      return rows.map((r) => {
        const dec = decrypt(String(r.value));
        if (!dec.ok) return { name: r.name, scope: r.scope, masked: "****", readable: false, updatedAt: r.updated_at };
        return { name: r.name, scope: r.scope, masked: maskSecret(dec.value), readable: true, updatedAt: r.updated_at };
      });
    }
    case "secret_set": {
      const name = strParam(p, "name");
      if (!isValidSecretName(name)) {
        throw new Error("secret name must match [A-Za-z_][A-Za-z0-9_]* (it becomes an env var name)");
      }
      const scope = typeof p?.scope === "string" ? p.scope : "global";
      if (!isValidSecretScope(scope)) throw new Error('secret scope must be "global" or "workspace:<cwd>"');
      const value = strParam(p, "value");
      if (value.length === 0) throw new Error("secret value is required");
      const byteLen = Buffer.byteLength(value, "utf8");
      if (byteLen > MAX_SECRET_VALUE_BYTES) {
        throw new Error(`secret value too large (${byteLen} bytes > ${MAX_SECRET_VALUE_BYTES})`);
      }
      const now = strParam(p, "now");
      db.prepare(
        `INSERT INTO secrets (name, scope, value, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(name, scope) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(name, scope, encrypt(value), now);
      return {};
    }
    case "secret_delete": {
      const name = strParam(p, "name");
      const scope = typeof p?.scope === "string" ? p.scope : "global";
      db.prepare("DELETE FROM secrets WHERE name = ?1 AND scope = ?2").run(name, scope);
      return {};
    }
    /* ------------------------------- custom providers ------------------------------- */
    case "custom_providers_list": {
      const rows = db
        .prepare("SELECT id, name, base_url, models, api, enabled, headers FROM custom_providers")
        .all() as Row[];
      return rows.map(cpRow);
    }
    case "custom_provider_get": {
      const id = strParam(p, "id");
      const r = db
        .prepare("SELECT id, name, base_url, models, api, enabled, headers FROM custom_providers WHERE id = ?1")
        .get(id) as Row | undefined;
      return r ? cpRow(r) : null;
    }
    case "custom_provider_upsert": {
      const id = strParam(p, "id");
      const name = strParam(p, "name");
      const baseUrl = strParam(p, "baseUrl");
      const models = strParam(p, "models");
      const api = strParam(p, "api");
      const headers = typeof p?.headers === "string" ? p.headers : "{}";
      db.prepare(
        `INSERT INTO custom_providers (id, name, base_url, models, api, headers) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url,
         models = excluded.models, api = excluded.api, headers = excluded.headers`,
      ).run(id, name, baseUrl, models, api, headers);
      return {};
    }
    case "custom_provider_delete": {
      db.prepare("DELETE FROM custom_providers WHERE id = ?1").run(strParam(p, "id"));
      return {};
    }
    case "custom_provider_set_enabled": {
      const enabled = p?.enabled === undefined ? true : Boolean(p.enabled);
      db.prepare("UPDATE custom_providers SET enabled = ?1 WHERE id = ?2").run(enabled ? 1 : 0, strParam(p, "id"));
      return {};
    }
    /* ------------------------------- models ------------------------------- */
    case "models_all":
      return modelsQuery(db);
    case "models_list":
      return modelsQuery(db, strParam(p, "provider"));
    case "models_replace": {
      const provider = strParam(p, "provider");
      let items: any[];
      try {
        items = JSON.parse(strParam(p, "models"));
      } catch (e) {
        throw new Error(`parse models: ${e}`);
      }
      db.transaction(() => {
        db.prepare("DELETE FROM models WHERE provider = ?1").run(provider);
        for (const item of items) {
          const modelId = strOrNull(item?.modelId);
          if (!modelId || !modelId.trim()) continue;
          db.prepare(
            `INSERT OR REPLACE INTO models
             (provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, enabled)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            provider,
            modelId,
            strOrNull(item?.name),
            typeof item?.reasoning === "boolean" ? (item.reasoning ? 1 : 0) : null,
            numOrNull(item?.contextWindow),
            numOrNull(item?.maxTokens),
            Array.isArray(item?.input) ? JSON.stringify(item.input) : null,
            item?.cost && typeof item.cost === "object" && !Array.isArray(item.cost) ? JSON.stringify(item.cost) : null,
            item?.enabled === undefined ? 1 : item.enabled ? 1 : 0,
          );
        }
      });
      return {};
    }
    case "models_delete_provider": {
      db.prepare("DELETE FROM models WHERE provider = ?1").run(strParam(p, "provider"));
      return {};
    }
    /* ------------------------------- kv ------------------------------- */
    case "kv_get": {
      const key = strParam(p, "key");
      const row = db.prepare("SELECT value FROM kv WHERE key = ?1").get(key) as { value: string } | undefined;
      return row ? { value: row.value } : null;
    }
    case "kv_set": {
      const key = strParam(p, "key");
      const value = strParam(p, "value");
      db.prepare(
        "INSERT INTO kv(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(key, value);
      return {};
    }
    /* ------------------------------- usage ------------------------------- */
    case "usage_scan_list": {
      const rows = db.prepare("SELECT session_id, mtime, first_ts, last_ts FROM usage_scan").all() as Row[];
      return rows.map((r) => ({
        sessionId: r.session_id,
        mtime: Number(r.mtime),
        firstTs: Number(r.first_ts),
        lastTs: Number(r.last_ts),
      }));
    }
    case "usage_daily_replace": {
      const sessionId = strParam(p, "sessionId");
      const mtime = p?.mtime;
      if (typeof mtime !== "number") throw new Error("missing mtime");
      const firstTs = typeof p?.firstTs === "number" ? Math.trunc(p.firstTs) : 0;
      const lastTs = typeof p?.lastTs === "number" ? Math.trunc(p.lastTs) : 0;
      let items: any[];
      try {
        items = JSON.parse(strParam(p, "rows"));
      } catch (e) {
        throw new Error(`parse rows: ${e}`);
      }
      db.transaction(() => {
        db.prepare("DELETE FROM usage_daily WHERE session_id = ?1").run(sessionId);
        for (const item of items) {
          db.prepare(
            `INSERT INTO usage_daily
             (session_id, date, input, output, cache_read, cache_write, tokens, messages, by_model)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
          ).run(
            sessionId,
            strOrNull(item?.date) ?? "",
            intOr(item?.input, 0),
            intOr(item?.output, 0),
            intOr(item?.cacheRead, 0),
            intOr(item?.cacheWrite, 0),
            intOr(item?.tokens, 0),
            intOr(item?.messages, 0),
            strOrNull(item?.byModel) ?? "{}",
          );
        }
        db.prepare(
          `INSERT INTO usage_scan (session_id, mtime, first_ts, last_ts) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(session_id) DO UPDATE SET mtime = excluded.mtime,
           first_ts = excluded.first_ts, last_ts = excluded.last_ts`,
        ).run(sessionId, mtime, firstTs, lastTs);
      });
      return {};
    }
    case "usage_daily_query": {
      const rows = db
        .prepare(
          "SELECT session_id, date, input, output, cache_read, cache_write, tokens, messages, by_model FROM usage_daily ORDER BY date",
        )
        .all() as Row[];
      return rows.map((r) => ({
        sessionId: r.session_id,
        date: r.date,
        input: Number(r.input),
        output: Number(r.output),
        cacheRead: Number(r.cache_read),
        cacheWrite: Number(r.cache_write),
        tokens: Number(r.tokens),
        messages: Number(r.messages),
        byModel: r.by_model,
      }));
    }
    case "usage_daily_cleanup": {
      const del = db.prepare("DELETE FROM usage_daily WHERE session_id NOT IN (SELECT id FROM sessions)").run();
      db.prepare("DELETE FROM usage_scan WHERE session_id NOT IN (SELECT id FROM sessions)").run();
      return { removed: del.changes };
    }
    default:
      throw new Error(`unknown host_query kind: ${kind}`);
  }
}

function cpRow(r: Row): any {
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    models: r.models,
    api: r.api,
    enabled: Number(r.enabled) === 1,
    headers: r.headers,
  };
}

function intOr(v: unknown, def: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : def;
}

export { isEncrypted };
