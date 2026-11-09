/**
 * local 模式存储实现（bun:sqlite）：建表/迁移与 Rust data.rs 逐条镜像，
 * 仅测试/冒烟路径使用——生产业务表由 Rust 宿主持有（见 ../hostdb.ts 头注释）。
 * local 模式 credentials.api_key 明文落盘：生产加密统一收口在 Rust
 * （secret.rs + data.rs），sidecar 侧无 keychain 可用。
 */
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

import { setTransport, rejectAllPending, type RpcOptions } from "./transport";
import { logErr } from "../../log";

let localDb: Database | null = null;

/**
 * 本地工具执行器注入点（ACP 模式）：本地 SQLite 没有 Electron 宿主，
 * `hostToolCall("tool")` 必须由 sidecar 进程自己执行。默认 null = 维持
 * 测试/冒烟路径的旧行为（未知 kind 报错）。
 */
export type LocalToolHandler = (
  params: Record<string, unknown>,
  opts?: RpcOptions,
) => Promise<unknown>;
let localToolHandler: LocalToolHandler | null = null;

export function setLocalToolHandler(handler: LocalToolHandler | null): void {
  localToolHandler = handler;
}

export function resetLocalToolHandlerForTest(): void {
  localToolHandler = null;
}

/** 测试/冒烟入口：本地 SQLite（建表与迁移逻辑与 Rust data.rs 保持一致） */
export function initLocalStorage(dbPath: string): void {
  localDb = new Database(dbPath);
  localDb.exec("PRAGMA journal_mode = WAL;");
  localDb.exec("PRAGMA busy_timeout = 5000;");
  // 旧表重命名（去掉 pi_ 前缀）：旧表存在且新表不存在时生效，否则忽略。
  // 必须在 CREATE TABLE 之前执行，避免新表先建出来挡住重命名。
  try {
    localDb.exec("ALTER TABLE pi_sessions RENAME TO sessions");
  } catch {
    /* 旧表不存在或已重命名 */
  }
  try {
    localDb.exec("ALTER TABLE pi_models RENAME TO models");
  } catch {
    /* 旧表不存在或已重命名 */
  }
  localDb.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      first_message TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      message_count INTEGER,
      kind TEXT NOT NULL DEFAULT '',
      parent_session TEXT NOT NULL DEFAULT ''
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
      auto_discover INTEGER NOT NULL DEFAULT 0,
      headers TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
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
    );
    CREATE TABLE IF NOT EXISTS session_blocks (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      preview TEXT NOT NULL DEFAULT '',
      search_text TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS session_blocks_session
      ON session_blocks (session_id, seq);
    CREATE TABLE IF NOT EXISTS search_scan (
      session_id TEXT PRIMARY KEY,
      mtime REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifact_blocks (
      session_id TEXT NOT NULL,
      rel TEXT NOT NULL,
      name TEXT NOT NULL,
      preview TEXT NOT NULL DEFAULT '',
      search_text TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (session_id, rel)
    );
    CREATE INDEX IF NOT EXISTS artifact_blocks_session
      ON artifact_blocks (session_id);
    CREATE TABLE IF NOT EXISTS artifact_scan (
      session_id TEXT PRIMARY KEY,
      mtime REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS search_history (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS search_history_created
      ON search_history (created_at DESC);
    CREATE TABLE IF NOT EXISTS knowledge_refs (
      session_id TEXT NOT NULL,
      source TEXT NOT NULL,
      scope_id TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (session_id, source, scope_id, path)
    );
    CREATE INDEX IF NOT EXISTS knowledge_refs_path
      ON knowledge_refs (scope_id, path, ts DESC);
    CREATE INDEX IF NOT EXISTS knowledge_refs_session
      ON knowledge_refs (session_id, ts DESC);
  `);
  // 旧库迁移：补 api / enabled 列（已存在则忽略）
  try {
    localDb.exec("ALTER TABLE custom_providers ADD COLUMN api TEXT NOT NULL DEFAULT 'openai-chat'");
  } catch {
    /* 列已存在 */
  }
  try {
    localDb.exec("ALTER TABLE custom_providers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
  } catch {
    /* 列已存在 */
  }
  // 自定义请求头（JSON 对象字符串）：与 Rust 侧 data.rs 同列同语义
  try {
    localDb.exec("ALTER TABLE custom_providers ADD COLUMN headers TEXT NOT NULL DEFAULT '{}'");
  } catch {
    /* 列已存在 */
  }
  // 动态模型发现开关：开启时注册合并发现缓存里的 AUTO 模型（见 model/dynamic-discovery.ts）
  try {
    localDb.exec("ALTER TABLE custom_providers ADD COLUMN auto_discover INTEGER NOT NULL DEFAULT 0");
  } catch {
    /* 列已存在 */
  }
  // 模型 prompt cache TTL（JSON 对象字符串 {short?,long?}，秒）：cache warmer 依据
  try {
    localDb.exec("ALTER TABLE models ADD COLUMN prompt_cache_json TEXT");
  } catch {
    /* 列已存在 */
  }
  // 旧库迁移：sessions 补 archived 列（已存在则忽略）
  try {
    localDb.exec("ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  } catch {
    /* 列已存在 */
  }
  // 迭代 4：sessions 补 message_count 列（NULL = 未回填，local 模式不做
  // 启动回填——该模式仅冒烟/测试用，计数由 session_touch 增量维护即可）
  try {
    localDb.exec("ALTER TABLE sessions ADD COLUMN message_count INTEGER");
  } catch {
    /* 列已存在 */
  }
  // 会话级偏好（与 Rust data.rs 镜像）：mode / approval_level / 最近一次模型 /
  // 设计主题，NULL = 从未变更过；session_prefs_set 按 COALESCE 语义只更新携带的字段。
  // design_theme 存 JSON 字符串 {scope,id}；"" = 显式不使用主题（区别于 NULL 的"从未设置"）
  for (const col of [
    "mode TEXT",
    "approval_level TEXT",
    "model_provider TEXT",
    "model_id TEXT",
    "thinking_level TEXT",
    "design_theme TEXT",
    "app_mode TEXT",
    // 会话级目标轮数上限（文本存数字）：NULL = 从未定过（建目标回落默认 300）；
    // "0" = 不限。两态必须分得开——「不限」也是一个要记住的选择，不能被当成没设过
    "goal_max_turns TEXT",
    // 验收标准启动模式与目标活跃时长上限（分钟文本）：NULL = 从未定过
    "goal_acceptance_mode TEXT",
    "goal_max_duration TEXT",
    // 辅助会话：kind = "side_chat" 的子会话不进主列表；parent_session 是派生来源
    "kind TEXT NOT NULL DEFAULT ''",
    "parent_session TEXT NOT NULL DEFAULT ''",
  ]) {
    try {
      localDb.exec(`ALTER TABLE sessions ADD COLUMN ${col}`);
    } catch {
      /* 列已存在 */
    }
  }
  localDb.exec(`
    CREATE TABLE IF NOT EXISTS models (
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      name TEXT,
      reasoning INTEGER,
      context_window INTEGER,
      max_tokens INTEGER,
      input_json TEXT,
      cost_json TEXT,
      prompt_cache_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (provider, model_id)
    );
  `);
  // 旧数据迁移：早期版本把未选工作目录的会话 cwd 存成主目录，统一清空
  localDb.query("UPDATE sessions SET cwd = '' WHERE cwd = ?").run(homedir());
  migrateAzureProviderIdLocal();
  migrateCustomProviderModelsLocal();
  migrateProviderModelFiltersLocal();
  // 兜底：若旧 pi_* 表仍在（如新表先被别的版本建出、重命名没成功），把行并入新表后删壳
  drainLegacyTableLocal(
    "pi_sessions",
    "sessions",
    "id, title, first_message, cwd, created_at, updated_at",
  );
  drainLegacyTableLocal(
    "pi_models",
    "models",
    "provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, enabled",
  );
  setTransport(localDispatch);
}

export const isLocalStorage = () => localDb !== null;

/**
 * local 模式的旧数据迁移（与 Rust data.rs 的 migrate_custom_provider_models 镜像）：
 * custom_providers.models JSON 列 → models 行（enabled=1），搬完清空该列（幂等标记）。
 */
const LEGACY_AZURE_PROVIDER = "azure-openai-responses";
const AZURE_PROVIDER = "azure";

/** local 模式镜像 electron/main/data.ts 的 Azure provider id 迁移（幂等）。 */
function migrateAzureProviderIdLocal(): void {
  const db = localDb;
  if (!db) return;
  const step = (label: string, fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      logErr(`[hostdb/local] azure provider migration step "${label}" failed:`, e);
    }
  };

  step("credentials", () => {
    const old = db
      .query("SELECT api_key FROM credentials WHERE provider = ?")
      .get(LEGACY_AZURE_PROVIDER);
    if (!old) return;
    const existing = db
      .query("SELECT provider FROM credentials WHERE provider = ?")
      .get(AZURE_PROVIDER);
    if (!existing) {
      db.query("UPDATE credentials SET provider = ? WHERE provider = ?").run(
        AZURE_PROVIDER,
        LEGACY_AZURE_PROVIDER,
      );
    } else {
      db.query("DELETE FROM credentials WHERE provider = ?").run(
        LEGACY_AZURE_PROVIDER,
      );
    }
  });

  step("models", () => {
    const rows = db
      .query(
        "SELECT model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, enabled FROM models WHERE provider = ?",
      )
      .all(LEGACY_AZURE_PROVIDER) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const modelId = String(row.model_id ?? "");
      if (!modelId) continue;
      const existing = db
        .query("SELECT provider FROM models WHERE provider = ? AND model_id = ?")
        .get(AZURE_PROVIDER, modelId);
      if (!existing) {
        db.query(
          "UPDATE models SET provider = ? WHERE provider = ? AND model_id = ?",
        ).run(AZURE_PROVIDER, LEGACY_AZURE_PROVIDER, modelId);
        continue;
      }
      const name = typeof row.name === "string" ? row.name : null;
      const reasoning = typeof row.reasoning === "number" ? row.reasoning : null;
      const contextWindow =
        typeof row.context_window === "number" ? row.context_window : null;
      const maxTokens =
        typeof row.max_tokens === "number" ? row.max_tokens : null;
      const inputJson =
        typeof row.input_json === "string" ? row.input_json : null;
      const costJson = typeof row.cost_json === "string" ? row.cost_json : null;
      const enabled = typeof row.enabled === "number" ? row.enabled : 1;
      db.query(
        `UPDATE models SET
           name = COALESCE(name, ?),
           reasoning = COALESCE(reasoning, ?),
           context_window = COALESCE(context_window, ?),
           max_tokens = COALESCE(max_tokens, ?),
           input_json = COALESCE(input_json, ?),
           cost_json = COALESCE(cost_json, ?),
           enabled = MAX(enabled, ?)
         WHERE provider = ? AND model_id = ?`,
      ).run(
        name,
        reasoning,
        contextWindow,
        maxTokens,
        inputJson,
        costJson,
        enabled,
        AZURE_PROVIDER,
        modelId,
      );
      db.query("DELETE FROM models WHERE provider = ? AND model_id = ?").run(
        LEGACY_AZURE_PROVIDER,
        modelId,
      );
    }
  });

  step("sessions", () => {
    db.query("UPDATE sessions SET model_provider = ? WHERE model_provider = ?").run(
      AZURE_PROVIDER,
      LEGACY_AZURE_PROVIDER,
    );
  });

  step("kv", () => {
    const row = db
      .query("SELECT value FROM kv WHERE key = 'pi.model'")
      .get() as { value?: string } | null;
    if (row?.value) {
      try {
        const parsed = JSON.parse(row.value) as { provider?: string; modelId?: string };
        if (parsed?.provider === LEGACY_AZURE_PROVIDER) {
          db.query("UPDATE kv SET value = ? WHERE key = 'pi.model'").run(
            JSON.stringify({ ...parsed, provider: AZURE_PROVIDER }),
          );
        }
      } catch {
        /* 坏 JSON：读时别名兜底 */
      }
    }
    const oldKey = `credential.env.${LEGACY_AZURE_PROVIDER}`;
    const newKey = `credential.env.${AZURE_PROVIDER}`;
    const oldEnv = db.query("SELECT value FROM kv WHERE key = ?").get(oldKey);
    if (!oldEnv) return;
    const newEnv = db.query("SELECT value FROM kv WHERE key = ?").get(newKey);
    if (!newEnv) {
      db.query("UPDATE kv SET key = ? WHERE key = ?").run(newKey, oldKey);
    } else {
      db.query("DELETE FROM kv WHERE key = ?").run(oldKey);
    }
  });
}

function migrateCustomProviderModelsLocal(): void {
  const db = localDb;
  if (!db) return;
  const rows = db
    .query<{ id: string; models: string }, []>(
      "SELECT id, models FROM custom_providers WHERE models != '[]'",
    )
    .all();
  for (const { id, models } of rows) {
    let specs: Record<string, unknown>[] = [];
    try {
      specs = JSON.parse(models);
    } catch {
      specs = [];
    }
    for (const spec of specs) {
      const modelId = typeof spec.id === "string" ? spec.id : "";
      if (!modelId.trim()) continue;
      const input = Array.isArray(spec.input) ? JSON.stringify(spec.input) : null;
      const cost = spec.cost && typeof spec.cost === "object" ? JSON.stringify(spec.cost) : null;
      db.query(
        "INSERT OR REPLACE INTO models \
         (provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, enabled) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
      ).run(
        id,
        modelId,
        typeof spec.name === "string" ? spec.name : null,
        typeof spec.reasoning === "boolean" ? (spec.reasoning ? 1 : 0) : null,
        typeof spec.contextWindow === "number" ? Math.trunc(spec.contextWindow) : null,
        typeof spec.maxTokens === "number" ? Math.trunc(spec.maxTokens) : null,
        input,
        cost,
      );
    }
    db.query("UPDATE custom_providers SET models = '[]' WHERE id = ?").run(id);
  }
}

/**
 * local 模式旧数据迁移（与 Rust data.rs 的 migrate_provider_model_filters 镜像）：
 * 旧表 provider_models（过滤白名单，models 列为 JSON string[]）→ models 行，
 * 只迁移 models 表里没有该 provider 行的记录（新数据优先）；搬完删表。幂等。
 */
function migrateProviderModelFiltersLocal(): void {
  const db = localDb;
  if (!db) return;
  const exists = db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'provider_models'",
    )
    .get()!.n;
  if (!exists) return;
  const rows = db
    .query<{ provider: string; models: string }, []>(
      "SELECT provider, models FROM provider_models \
       WHERE models != '[]' AND provider NOT IN (SELECT DISTINCT provider FROM models)",
    )
    .all();
  for (const { provider, models } of rows) {
    let ids: unknown[] = [];
    try {
      ids = JSON.parse(models);
    } catch {
      ids = [];
    }
    for (const id of ids) {
      if (typeof id !== "string" || !id.trim()) continue;
      db.query("INSERT OR IGNORE INTO models (provider, model_id, enabled) VALUES (?, ?, 1)").run(
        provider,
        id,
      );
    }
  }
  db.exec("DROP TABLE provider_models");
}

/**
 * local 模式兜底（与 Rust data.rs 的 drain_legacy_table 镜像）：
 * 旧 pi_* 表未被重命名成功（新表已存在）时，把行并入新表后删除旧表。幂等。
 * columns 为两表共有的列清单（显式列出，不依赖列序）。
 */
function drainLegacyTableLocal(legacy: string, target: string, columns: string): void {
  const db = localDb;
  if (!db) return;
  const exists = db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(legacy)!.n;
  if (!exists) return;
  db.exec(`INSERT OR IGNORE INTO ${target} (${columns}) SELECT ${columns} FROM ${legacy}`);
  db.exec(`DROP TABLE ${legacy}`);
}

/** 与 Rust data.rs 的 models_query 镜像：input_json/cost_json 解析回结构化 JSON */
function modelsQueryLocal(provider?: string): unknown {
  const db = localDb;
  if (!db) throw new Error("local storage not initialized");
  type Row = {
    provider: string;
    model_id: string;
    name: string | null;
    reasoning: number | null;
    context_window: number | null;
    max_tokens: number | null;
    input_json: string | null;
    cost_json: string | null;
    prompt_cache_json: string | null;
    enabled: number;
  };
  const parse = (s: string | null) => {
    if (!s) return null;
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return null;
    }
  };
  const toRow = (r: Row) => ({
    provider: r.provider,
    modelId: r.model_id,
    name: r.name,
    reasoning: r.reasoning === null ? null : r.reasoning === 1,
    contextWindow: r.context_window,
    maxTokens: r.max_tokens,
    input: (() => {
      const v = parse(r.input_json);
      return Array.isArray(v) ? v : null;
    })(),
    cost: (() => {
      const v = parse(r.cost_json);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    })(),
    promptCache: (() => {
      const v = parse(r.prompt_cache_json);
      return v && typeof v === "object" && !Array.isArray(v)
        ? (v as { short?: number; long?: number })
        : null;
    })(),
    enabled: r.enabled === 1,
  });
  if (provider !== undefined)
    return db
      .query<Row, [string]>(
        "SELECT provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, prompt_cache_json, enabled \
         FROM models WHERE provider = ? ORDER BY model_id",
      )
      .all(provider)
      .map(toRow);
  return db
    .query<Row, []>(
      "SELECT provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, prompt_cache_json, enabled \
       FROM models ORDER BY provider, model_id",
    )
    .all()
    .map(toRow);
}

/** 测试专用：local 模式下的底层连接（host 模式为 null）。断言用，勿用于生产路径 */
export const getLocalDb = () => localDb;

/** 测试辅助：重置模式（hostdb.test.ts 换临时库用） */
export function resetStorageForTest(): void {
  localDb?.close();
  localDb = null;
  setTransport(null);
  rejectAllPending();
}

/* ------------------------------ local 模式实现 ------------------------------ */

/** 与 Rust data.rs 镜像的本地查询（bun:sqlite；仅测试/冒烟/ACP 路径） */
function localDispatch(
  kind: string,
  p: Record<string, unknown>,
  opts?: RpcOptions,
): Promise<unknown> {
  const db = localDb;
  if (!db) return Promise.reject(new Error("local storage not initialized"));
  const s = (key: string): string => {
    const v = p[key];
    if (typeof v !== "string") throw new Error(`missing param: ${key}`);
    return v;
  };
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
  const run = (): unknown => {
    switch (kind) {
      case "session_get": {
        const row = db
          .query<
            {
              cwd: string;
              title: string;
              mode: string | null;
              approval_level: string | null;
              model_provider: string | null;
              model_id: string | null;
              thinking_level: string | null;
              design_theme: string | null;
              app_mode: string | null;
              goal_max_turns: string | null;
              goal_acceptance_mode: string | null;
              goal_max_duration: string | null;
              kind: string | null;
              parent_session: string | null;
            },
            [string]
          >(
            "SELECT cwd, title, mode, approval_level, model_provider, model_id, thinking_level, design_theme, app_mode, goal_max_turns, goal_acceptance_mode, goal_max_duration, kind, parent_session FROM sessions WHERE id = ?",
          )
          .get(s("sessionId"));
        return row
          ? {
              cwd: row.cwd,
              title: row.title,
              kind: row.kind ?? "",
              parentSession: row.parent_session ?? "",
              mode: row.mode,
              approvalLevel: row.approval_level,
              modelProvider: row.model_provider,
              modelId: row.model_id,
              thinkingLevel: row.thinking_level,
              designTheme: row.design_theme,
              appMode: row.app_mode,
              goalMaxTurns: row.goal_max_turns,
              goalAcceptanceMode: row.goal_acceptance_mode,
              goalMaxDuration: row.goal_max_duration,
            }
          : null;
      }
      case "session_insert": {
        const now = s("now");
        db.query(
          "INSERT INTO sessions (id, title, first_message, cwd, created_at, updated_at, message_count, kind, parent_session) VALUES (?, '', '', ?, ?, ?, 0, ?, ?)",
        ).run(
          s("sessionId"),
          str(p.cwd),
          now,
          now,
          str(p.kind),
          str(p.parentSession),
        );
        return {};
      }
      case "session_meta_set":
        db.query(
          "UPDATE sessions SET kind = ?, parent_session = ? WHERE id = ?",
        ).run(str(p.kind), str(p.parentSession), s("sessionId"));
        return {};
      case "session_list":
        // 原始行是 snake 列名（同 session_get 约定），map 把偏好列转成
        // SessionRow 的 camel 字段；泛型若直接用 SessionRow 则读不到 r.approval_level
        return db
          .query<
            {
              id: string;
              title: string;
              first_message: string;
              cwd: string;
              archived: number;
              updated_at: string;
              message_count: number;
              mode: string | null;
              approval_level: string | null;
              model_provider: string | null;
              model_id: string | null;
              thinking_level: string | null;
              design_theme: string | null;
              app_mode: string | null;
              goal_max_turns: string | null;
              goal_acceptance_mode: string | null;
              goal_max_duration: string | null;
              kind: string | null;
              parent_session: string | null;
            },
            []
          >(
            "SELECT id, title, first_message, cwd, archived, updated_at, COALESCE(message_count, 0) AS message_count, mode, approval_level, model_provider, model_id, thinking_level, design_theme, app_mode, goal_max_turns, goal_acceptance_mode, goal_max_duration, kind, parent_session FROM sessions ORDER BY updated_at DESC",
          )
          .all()
          .map((r) => ({
            ...r,
            kind: r.kind ?? "",
            parentSession: r.parent_session ?? "",
            mode: r.mode ?? null,
            approvalLevel: r.approval_level ?? null,
            modelProvider: r.model_provider ?? null,
            modelId: r.model_id ?? null,
            thinkingLevel: r.thinking_level ?? null,
            designTheme: r.design_theme ?? null,
            appMode: r.app_mode ?? null,
            goalMaxTurns: r.goal_max_turns ?? null,
            goalAcceptanceMode: r.goal_acceptance_mode ?? null,
            goalMaxDuration: r.goal_max_duration ?? null,
          }));
      case "session_prefs_set":
        db.query(
          "UPDATE sessions SET \
           mode = COALESCE(?2, mode), \
           approval_level = COALESCE(?3, approval_level), \
           model_provider = COALESCE(?4, model_provider), \
           model_id = COALESCE(?5, model_id), \
           thinking_level = COALESCE(?6, thinking_level), \
           design_theme = COALESCE(?7, design_theme), \
           app_mode = COALESCE(?8, app_mode), \
           goal_max_turns = COALESCE(?9, goal_max_turns), \
           goal_acceptance_mode = COALESCE(?10, goal_acceptance_mode), \
           goal_max_duration = COALESCE(?11, goal_max_duration) \
           WHERE id = ?1",
        ).run(
          s("sessionId"),
          typeof p.mode === "string" ? p.mode : null,
          typeof p.approvalLevel === "string" ? p.approvalLevel : null,
          typeof p.modelProvider === "string" ? p.modelProvider : null,
          typeof p.modelId === "string" ? p.modelId : null,
          typeof p.thinkingLevel === "string" ? p.thinkingLevel : null,
          typeof p.designTheme === "string" ? p.designTheme : null,
          typeof p.appMode === "string" ? p.appMode : null,
          typeof p.goalMaxTurns === "string" ? p.goalMaxTurns : null,
          typeof p.goalAcceptanceMode === "string" ? p.goalAcceptanceMode : null,
          typeof p.goalMaxDuration === "string" ? p.goalMaxDuration : null,
        );
        return {};
      case "session_delete":
        db.query("DELETE FROM sessions WHERE id = ?").run(s("sessionId"));
        db.query("DELETE FROM knowledge_refs WHERE session_id = ?").run(s("sessionId"));
        return {};
      case "session_update_cwd":
        db.query("UPDATE sessions SET cwd = ? WHERE id = ?").run(str(p.cwd), s("sessionId"));
        return {};
      case "session_rename":
        db.query("UPDATE sessions SET title = ? WHERE id = ?").run(s("name"), s("sessionId"));
        return {};
      case "session_set_archived":
        db.query("UPDATE sessions SET archived = ? WHERE id = ?").run(
          p.archived === true ? 1 : 0,
          s("sessionId"),
        );
        return {};
      case "session_touch":
        db.query(
          "UPDATE sessions SET updated_at = ?, " +
            "title = CASE WHEN title = '' THEN ? ELSE title END, " +
            "first_message = CASE WHEN first_message = '' THEN ? ELSE first_message END, " +
            "message_count = COALESCE(message_count, 0) + ? " +
            "WHERE id = ?",
        ).run(s("now"), str(p.title), str(p.firstMessage), num(p.added), s("sessionId"));
        return {};
      case "credential_get": {
        const row = db
          .query<{ api_key: string }, [string]>("SELECT api_key FROM credentials WHERE provider = ?")
          .get(s("provider"));
        return row ? { apiKey: row.api_key } : null;
      }
      case "credential_list":
        return db
          .query<{ provider: string }, []>("SELECT provider FROM credentials")
          .all()
          .map((r) => r.provider);
      case "credential_set":
        db.query(
          "INSERT INTO credentials (provider, api_key, updated_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(provider) DO UPDATE SET api_key = excluded.api_key, updated_at = excluded.updated_at",
        ).run(s("provider"), s("apiKey"), s("now"));
        return {};
      case "credential_delete":
        db.query("DELETE FROM credentials WHERE provider = ?").run(s("provider"));
        return {};
      // MCP stdio 子进程的密钥注入：local 模式（测试/冒烟）直接读明文表。
      // 生产路径由宿主 secret_env_resolve 解密，作用域只接受 global。
      case "secret_env_resolve": {
        const requests = Array.isArray(p.requests) ? p.requests.slice(0, 32) : [];
        const env = Object.create(null) as Record<string, string>;
        const stmt = db.query<{ value: string }, [string]>(
          "SELECT value FROM secrets WHERE name = ? AND scope = 'global'",
        );
        const nameRe = /^[A-Za-z_][A-Za-z0-9_]*$/;
        const seen = new Set<string>();
        for (const item of requests) {
          if (!item || typeof item !== "object") continue;
          const r = item as Record<string, unknown>;
          const envName = typeof r.envName === "string" ? r.envName.trim() : "";
          const name = typeof r.name === "string" ? r.name.trim() : "";
          const scope = r.scope === undefined ? "global" : r.scope;
          if (scope !== "global" || !nameRe.test(envName) || !nameRe.test(name)) continue;
          if (seen.has(envName)) continue;
          seen.add(envName);
          const row = stmt.get(name);
          if (row) env[envName] = row.value;
        }
        return { env };
      }
      // 密钥库：local 模式无 Rust secret.rs，**明文存表**（仅测试/冒烟，
      // 生产路径永远是 Rust 侧的 enc:v1: 密文 + OS keychain 主密钥）。
      // 掩码规则与 Rust data.rs mask_secret 对齐：**** + 后四位。
      case "secret_list":
        return db
          .query<{ name: string; scope: string; value: string; updated_at: string }, []>(
            "SELECT name, scope, value, updated_at FROM secrets ORDER BY name, scope",
          )
          .all()
          .map((r) => ({
            name: r.name,
            scope: r.scope,
            masked: r.value.length > 4 ? `****${r.value.slice(-4)}` : "****",
            readable: true,
            updatedAt: r.updated_at,
          }));
      case "secret_set":
        db.query(
          "INSERT INTO secrets (name, scope, value, updated_at) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(name, scope) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        ).run(s("name"), str(p.scope) || "global", s("value"), s("now"));
        return {};
      case "secret_delete":
        db.query("DELETE FROM secrets WHERE name = ? AND scope = ?").run(
          s("name"),
          str(p.scope) || "global",
        );
        return {};
      case "secret_cipher_status":
        // local 模式（测试/冒烟）没有 Electron 主密钥，密钥表是明文
        return { backend: "unavailable" };
      case "custom_providers_list":
        return db
          .query<
            {
              id: string;
              name: string;
              base_url: string;
              models: string;
              api: string;
              enabled: number;
              auto_discover: number;
              headers: string;
            },
            []
          >("SELECT id, name, base_url, models, api, enabled, auto_discover, headers FROM custom_providers")
          .all()
          .map((r) => ({
            id: r.id,
            name: r.name,
            baseUrl: r.base_url,
            models: r.models,
            api: r.api,
            enabled: r.enabled === 1,
            autoDiscover: r.auto_discover === 1,
            headers: r.headers,
          }));
      case "custom_provider_get": {
        const row = db
          .query<
            {
              id: string;
              name: string;
              base_url: string;
              models: string;
              api: string;
              enabled: number;
              auto_discover: number;
              headers: string;
            },
            [string]
          >("SELECT id, name, base_url, models, api, enabled, auto_discover, headers FROM custom_providers WHERE id = ?")
          .get(s("id"));
        return row
          ? {
              id: row.id,
              name: row.name,
              baseUrl: row.base_url,
              models: row.models,
              api: row.api,
              enabled: row.enabled === 1,
              autoDiscover: row.auto_discover === 1,
              headers: row.headers,
            }
          : null;
      }
      case "custom_provider_upsert":
        db.query(
          "INSERT INTO custom_providers (id, name, base_url, models, api, auto_discover, headers) VALUES (?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url, " +
            "models = excluded.models, api = excluded.api, auto_discover = excluded.auto_discover, headers = excluded.headers",
        ).run(
          s("id"),
          s("name"),
          s("baseUrl"),
          s("models"),
          s("api"),
          p.autoDiscover === true ? 1 : 0,
          typeof p.headers === "string" && p.headers ? p.headers : "{}",
        );
        return {};
      case "custom_provider_delete":
        db.query("DELETE FROM custom_providers WHERE id = ?").run(s("id"));
        return {};
      case "custom_provider_set_enabled":
        db.query("UPDATE custom_providers SET enabled = ? WHERE id = ?").run(
          p.enabled === true ? 1 : 0,
          s("id"),
        );
        return {};
      case "models_all":
        return modelsQueryLocal(undefined);
      case "models_list":
        return modelsQueryLocal(s("provider"));
      case "models_replace": {
        const provider = s("provider");
        let items: Record<string, unknown>[] = [];
        try {
          items = JSON.parse(s("models"));
        } catch {
          throw new Error("parse models: invalid JSON");
        }
        const tx = db.transaction(() => {
          db.query("DELETE FROM models WHERE provider = ?").run(provider);
          for (const item of items) {
            const modelId = typeof item.modelId === "string" ? item.modelId : "";
            if (!modelId.trim()) continue;
            const input = Array.isArray(item.input) ? JSON.stringify(item.input) : null;
            const cost =
              item.cost && typeof item.cost === "object" ? JSON.stringify(item.cost) : null;
            const promptCache =
              item.promptCache && typeof item.promptCache === "object"
                ? JSON.stringify(item.promptCache)
                : null;
            db.query(
              "INSERT OR REPLACE INTO models \
               (provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, prompt_cache_json, enabled) \
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ).run(
              provider,
              modelId,
              typeof item.name === "string" ? item.name : null,
              typeof item.reasoning === "boolean" ? (item.reasoning ? 1 : 0) : null,
              typeof item.contextWindow === "number" ? Math.trunc(item.contextWindow) : null,
              typeof item.maxTokens === "number" ? Math.trunc(item.maxTokens) : null,
              input,
              cost,
              promptCache,
              item.enabled === false ? 0 : 1,
            );
          }
        });
        tx();
        return {};
      }
      case "models_set_context_window":
        db.query(
          "UPDATE models SET context_window = ? WHERE provider = ? AND model_id = ?",
        ).run(num(p.contextWindow), s("provider"), s("modelId"));
        return {};
      case "models_delete_provider":
        db.query("DELETE FROM models WHERE provider = ?").run(s("provider"));
        return {};
      case "kv_get": {
        const row = db
          .query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?")
          .get(s("key"));
        return row ? { value: row.value } : null;
      }
      case "kv_set":
        db.query(
          "INSERT INTO kv (key, value) VALUES (?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(s("key"), s("value"));
        return {};
      case "usage_scan_list":
        return db
          .query<
            { sessionId: string; mtime: number; firstTs: number; lastTs: number },
            []
          >("SELECT session_id AS sessionId, mtime, first_ts AS firstTs, last_ts AS lastTs FROM usage_scan")
          .all();
      case "usage_daily_replace": {
        const sessionId = s("sessionId");
        let items: Record<string, unknown>[] = [];
        try {
          items = JSON.parse(s("rows"));
        } catch {
          throw new Error("parse rows: invalid JSON");
        }
        const mtime = typeof p.mtime === "number" ? p.mtime : 0;
        const firstTs = typeof p.firstTs === "number" ? p.firstTs : 0;
        const lastTs = typeof p.lastTs === "number" ? p.lastTs : 0;
        const tx = db.transaction(() => {
          db.query("DELETE FROM usage_daily WHERE session_id = ?").run(sessionId);
          for (const item of items) {
            const date = typeof item.date === "string" ? item.date : "";
            if (!date) continue;
            const num = (v: unknown) => (typeof v === "number" ? Math.round(v) : 0);
            db.query(
              "INSERT INTO usage_daily \
               (session_id, date, input, output, cache_read, cache_write, tokens, messages, by_model) \
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ).run(
              sessionId,
              date,
              num(item.input),
              num(item.output),
              num(item.cacheRead),
              num(item.cacheWrite),
              num(item.tokens),
              num(item.messages),
              typeof item.byModel === "string" ? item.byModel : "{}",
            );
          }
          db.query(
            "INSERT INTO usage_scan (session_id, mtime, first_ts, last_ts) VALUES (?, ?, ?, ?) \
             ON CONFLICT(session_id) DO UPDATE SET mtime = excluded.mtime, \
             first_ts = excluded.first_ts, last_ts = excluded.last_ts",
          ).run(sessionId, mtime, firstTs, lastTs);
        });
        tx();
        return {};
      }
      case "usage_daily_query":
        return db
          .query<
            {
              sessionId: string;
              date: string;
              input: number;
              output: number;
              cacheRead: number;
              cacheWrite: number;
              tokens: number;
              messages: number;
              byModel: string;
            },
            []
          >(
            "SELECT session_id AS sessionId, date, input, output, cache_read AS cacheRead, \
             cache_write AS cacheWrite, tokens, messages, by_model AS byModel \
             FROM usage_daily ORDER BY date",
          )
          .all();
      case "usage_daily_cleanup": {
        const removed = db
          .query(
            "DELETE FROM usage_daily WHERE session_id NOT IN (SELECT id FROM sessions)",
          )
          .run().changes;
        db.query(
          "DELETE FROM usage_scan WHERE session_id NOT IN (SELECT id FROM sessions)",
        ).run();
        return { removed };
      }
      case "search_blocks_upsert": {
        const sessionId = s("sessionId");
        let items: Record<string, unknown>[] = [];
        try {
          items = JSON.parse(s("rows"));
        } catch {
          throw new Error("parse rows: invalid JSON");
        }
        const tx = db.transaction(() => {
          db.query("DELETE FROM session_blocks WHERE session_id = ?").run(sessionId);
          for (const item of items) {
            const seq = item.seq;
            if (!Number.isInteger(seq) || (seq as number) < 0) continue;
            const str = (v: unknown) => (typeof v === "string" ? v : "");
            db.query(
              "INSERT OR REPLACE INTO session_blocks \
               (session_id, seq, role, preview, search_text) VALUES (?, ?, ?, ?, ?)",
            ).run(sessionId, seq as number, str(item.role), str(item.preview), str(item.searchText));
          }
        });
        tx();
        return {};
      }
      case "search_blocks_delete": {
        const sessionId = s("sessionId");
        const tx = db.transaction(() => {
          db.query("DELETE FROM session_blocks WHERE session_id = ?").run(sessionId);
          db.query("DELETE FROM search_scan WHERE session_id = ?").run(sessionId);
        });
        tx();
        return {};
      }
      case "search_blocks_scan_list":
        return db
          .query<{ sessionId: string; mtime: number }, []>(
            "SELECT session_id AS sessionId, mtime FROM search_scan",
          )
          .all();
      case "search_blocks_scan_set": {
        const mtime = typeof p.mtime === "number" ? p.mtime : 0;
        db.query(
          "INSERT INTO search_scan (session_id, mtime) VALUES (?, ?) \
           ON CONFLICT(session_id) DO UPDATE SET mtime = excluded.mtime",
        ).run(s("sessionId"), mtime);
        return {};
      }
      case "session_search": {
        const needle = s("needle").toLowerCase();
        if (!needle) return { sessions: [], messages: [], artifacts: [], truncated: false };
        // LIKE 的 %/_ 是通配符：调用方转义后的 likeNeedle 必须配 ESCAPE 才生效。
        // instr 路径要原始 needle（转义后的 100\% 在正文里搜不到）。
        const likeNeedle = s("likeNeedle").toLowerCase() || needle;
        const limit = Math.min(Math.max(typeof p.limit === "number" ? Math.trunc(p.limit) : 200, 1), 500);
        const sessions = db
          .query(
            `SELECT id, title, first_message AS firstMessage, cwd, archived, updated_at AS updatedAt FROM sessions
             WHERE LOWER(title) LIKE '%' || ?2 || '%' ESCAPE '\\'
                OR LOWER(first_message) LIKE '%' || ?2 || '%' ESCAPE '\\'
             ORDER BY updated_at DESC LIMIT ?3`,
          )
          .all(needle, likeNeedle, limit + 1);
        const messages = db
          .query(
            `SELECT sb.session_id AS sessionId, sb.seq, sb.role, sb.preview,
                    s.title, s.cwd, s.archived, s.updated_at AS updatedAt
             FROM session_blocks sb JOIN sessions s ON s.id = sb.session_id
             WHERE instr(sb.search_text, ?1) > 0
             ORDER BY s.updated_at DESC, sb.session_id, sb.seq LIMIT ?3`,
          )
          .all(needle, likeNeedle, limit + 1);
        const artifacts = db
          .query(
            `SELECT ab.session_id AS ownerKey, ab.rel, ab.name, ab.preview,
                    s.title, s.cwd, s.archived
             FROM artifact_blocks ab
             LEFT JOIN sessions s ON s.id = ab.session_id
             WHERE instr(ab.search_text, ?1) > 0
                OR LOWER(ab.name) LIKE '%' || ?2 || '%' ESCAPE '\\'
             ORDER BY s.updated_at DESC, ab.session_id, ab.rel LIMIT ?3`,
          )
          .all(needle, likeNeedle, limit + 1);
        const truncated =
          sessions.length > limit || messages.length > limit || artifacts.length > limit;
        const normSession = (r: Record<string, unknown>) => ({
          sessionId: r.id,
          title: r.title,
          firstMessage: r.firstMessage,
          cwd: r.cwd,
          archived: Number(r.archived) === 1,
          updatedAt: r.updatedAt,
        });
        return {
          sessions: sessions.slice(0, limit).map((r) => normSession(r as Record<string, unknown>)),
          messages: (messages as Record<string, unknown>[]).slice(0, limit).map((r) => ({
            sessionId: r.sessionId,
            seq: Number(r.seq),
            role: r.role,
            preview: r.preview,
            title: r.title,
            cwd: r.cwd,
            archived: Number(r.archived) === 1,
            updatedAt: r.updatedAt,
          })),
          artifacts: (artifacts as Record<string, unknown>[]).slice(0, limit).map((r) => ({
            sessionId: (r.sessionId ?? r.ownerKey) as string,
            rel: r.rel,
            name: r.name,
            preview: r.preview,
            title: (r.title ?? null) as string | null,
            cwd: (r.cwd ?? "") as string,
            archived: Number(r.archived ?? 0) === 1,
          })),
          truncated,
        };
      }
      case "search_artifacts_upsert": {
        const ownerKey = s("ownerKey");
        let items: Record<string, unknown>[] = [];
        try {
          items = JSON.parse(s("rows"));
        } catch {
          throw new Error("parse rows: invalid JSON");
        }
        const tx = db.transaction(() => {
          db.query("DELETE FROM artifact_blocks WHERE session_id = ?").run(ownerKey);
          for (const item of items) {
            const rel = typeof item.rel === "string" ? item.rel : "";
            if (!rel) continue;
            const str = (v: unknown, fallback = "") =>
              typeof v === "string" ? v : fallback;
            db.query(
              "INSERT OR REPLACE INTO artifact_blocks \
               (session_id, rel, name, preview, search_text) VALUES (?, ?, ?, ?, ?)",
            ).run(ownerKey, rel, str(item.name, rel), str(item.preview), str(item.searchText));
          }
        });
        tx();
        return {};
      }
      case "search_artifacts_delete": {
        const ownerKey = s("ownerKey");
        const tx = db.transaction(() => {
          db.query("DELETE FROM artifact_blocks WHERE session_id = ?").run(ownerKey);
          db.query("DELETE FROM artifact_scan WHERE session_id = ?").run(ownerKey);
        });
        tx();
        return {};
      }
      case "search_artifacts_scan_list":
        return db
          .query<{ ownerKey: string; mtime: number }, []>(
            "SELECT session_id AS ownerKey, mtime FROM artifact_scan",
          )
          .all();
      case "search_artifacts_scan_set": {
        const mtime = typeof p.mtime === "number" ? p.mtime : 0;
        db.query(
          "INSERT INTO artifact_scan (session_id, mtime) VALUES (?, ?) \
           ON CONFLICT(session_id) DO UPDATE SET mtime = excluded.mtime",
        ).run(s("ownerKey"), mtime);
        return {};
      }
      case "library_root_get": {
        return { root: process.env.PI_LIBRARY_ROOT ?? "" };
      }
      case "knowledge_refs_record": {
        const sessionId = s("sessionId");
        const source = s("source");
        const path = s("path");
        const scopeId = typeof p.scopeId === "string" ? p.scopeId : "";
        const ts =
          typeof p.ts === "number" && Number.isFinite(p.ts)
            ? Math.trunc(p.ts)
            : Date.now();
        db.query(
          `INSERT INTO knowledge_refs (session_id, source, scope_id, path, ts)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id, source, scope_id, path)
           DO UPDATE SET ts = excluded.ts`,
        ).run(sessionId, source, scopeId, path, ts);
        return {};
      }
      case "knowledge_refs_stats": {
        const source = s("source");
        const path = s("path");
        const scopeId = typeof p.scopeId === "string" ? p.scopeId : "";
        const row = db
          .query(
            `SELECT COUNT(*) AS n, MAX(ts) AS lastTs FROM knowledge_refs
             WHERE source = ? AND scope_id = ? AND path = ?`,
          )
          .get(source, scopeId, path) as
          | { n: number; lastTs: number | null }
          | undefined;
        return {
          count: Number(row?.n ?? 0),
          lastTs: row?.lastTs == null ? null : Number(row.lastTs),
        };
      }
      case "knowledge_refs_for_path": {
        const source = s("source");
        const path = s("path");
        const scopeId = typeof p.scopeId === "string" ? p.scopeId : "";
        const limit = Math.min(
          Math.max(typeof p.limit === "number" ? Math.trunc(p.limit) : 20, 1),
          100,
        );
        const rows = db
          .query(
            `SELECT kr.session_id AS sessionId, kr.ts, s.title, s.cwd
             FROM knowledge_refs kr
             LEFT JOIN sessions s ON s.id = kr.session_id
             WHERE kr.source = ? AND kr.scope_id = ? AND kr.path = ?
             ORDER BY kr.ts DESC LIMIT ?`,
          )
          .all(source, scopeId, path, limit) as Record<string, unknown>[];
        return rows.map((row) => ({
          sessionId: row.sessionId,
          ts: Number(row.ts),
          title: (row.title ?? null) as string | null,
          cwd: (row.cwd ?? "") as string,
        }));
      }
      case "artifact_search": {
        const ownerKey = s("ownerKey");
        const needle = s("needle").toLowerCase();
        if (!needle) return { hits: [], truncated: false };
        const likeNeedle = s("likeNeedle").toLowerCase() || needle;
        const limit = Math.min(
          Math.max(typeof p.limit === "number" ? Math.trunc(p.limit) : 30, 1),
          200,
        );
        const rows = db
          .query(
            `SELECT rel, name, preview FROM artifact_blocks
             WHERE session_id = ?1 AND (instr(search_text, ?2) > 0
                OR LOWER(name) LIKE '%' || ?3 || '%' ESCAPE '\\')
             ORDER BY rel LIMIT ?4`,
          )
          .all(ownerKey, needle, likeNeedle, limit + 1) as Record<string, unknown>[];
        return {
          hits: rows.slice(0, limit).map((r) => ({
            rel: r.rel,
            name: r.name,
            preview: r.preview,
          })),
          truncated: rows.length > limit,
        };
      }
      case "search_artifacts_recent": {
        const limitN = Math.min(
          Math.max(typeof p.limit === "number" ? Math.trunc(p.limit) : 10, 1),
          50,
        );
        const rows = db
          .query(
            `SELECT ab.session_id AS ownerKey, ab.rel, ab.name, ab.preview,
                    s.title, s.cwd, s.archived
             FROM artifact_blocks ab
             LEFT JOIN sessions s ON s.id = ab.session_id
             ORDER BY ab.rowid LIMIT ?`,
          )
          .all(limitN);
        return (rows as Record<string, unknown>[]).map((r) => ({
          sessionId: (r.sessionId ?? r.ownerKey) as string,
          rel: r.rel,
          name: r.name,
          preview: r.preview,
          title: (r.title ?? null) as string | null,
          cwd: (r.cwd ?? "") as string,
          archived: Number(r.archived ?? 0) === 1,
        }));
      }
      case "search_history_list": {
        const limitN = Math.min(
          Math.max(typeof p.limit === "number" ? Math.trunc(p.limit) : 12, 1),
          50,
        );
        // SQL 里 LIMIT 用占位符，但 GROUP BY 形态下 bun 类型层对 .all(参数)
        // 报 arity（运行时正常）——断言绕过类型侧误报
        return (db.query(
          `SELECT query, MAX(created_at) AS createdAt FROM search_history
           GROUP BY query ORDER BY createdAt DESC LIMIT ?`,
        ) as { all: (...args: unknown[]) => { query: string; createdAt: string }[] }).all(limitN);
      }
      case "search_history_add": {
        const query = s("query").trim().slice(0, 200);
        if (!query) return {};
        // s() 对缺失 key 抛错（不是返回空串）：可选参数必须宽松读
        const id = typeof p.id === "string" && p.id
          ? p.id
          : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const now = typeof p.now === "string" && p.now
          ? p.now
          : new Date().toISOString();
        const tx = db.transaction(() => {
          db.query("DELETE FROM search_history WHERE query = ?").run(query);
          db.query("INSERT INTO search_history (id, query, created_at) VALUES (?, ?, ?)").run(
            id,
            query,
            now,
          );
          db.query(
            `DELETE FROM search_history WHERE id NOT IN (
               SELECT id FROM search_history ORDER BY created_at DESC LIMIT 100)`,
          ).run();
        });
        tx();
        return {};
      }
      case "search_history_clear":
        db.query("DELETE FROM search_history").run();
        return {};
      // ACP/本地模式的工具执行：由 src/local-host 注入（无宿主的进程内实现）。
      // 返回 Promise 会被外层 .then(run) 正确展平。
      case "tool": {
        if (!localToolHandler) {
          throw new Error(
            "local tool handler is not installed (ACP/local mode requires src/local-host)",
          );
        }
        return localToolHandler(p, opts);
      }
      // MCP OAuth 等场景需要宿主代开浏览器；本地模式用平台命令兜底。
      case "open_external": {
        const url = typeof p.url === "string" ? p.url : "";
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error("open_external: invalid url");
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error("open_external: only http(s) urls are allowed");
        }
        const [cmd, args] =
          process.platform === "darwin"
            ? ["open", [url]]
            : process.platform === "win32"
              ? // 不走 cmd.exe：URL 里的 & 会被当成命令分隔符。rundll32 直接收
                // 参数，无 shell 解析面。
                ["rundll32", ["url.dll,FileProtocolHandler", url]]
              : ["xdg-open", [url]];
        const child = spawn(cmd, args, {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        // 等 spawn 结果再回 ok：浏览器没起来时调用方（MCP OAuth）应拿到错误，
        // 而不是一个“已打开”的假成功。1.5s 兜底防止极端平台不触发 spawn。
        return new Promise<{ ok: true }>((resolve, reject) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | null = null;
          const finish = (action: () => void) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            child.off("spawn", onSpawn);
            child.off("error", onError);
            action();
          };
          const onSpawn = () => {
            child.unref();
            finish(() => resolve({ ok: true }));
          };
          const onError = (err: Error) => {
            finish(() => reject(new Error(`open_external failed: ${err.message}`)));
          };
          child.once("spawn", onSpawn);
          child.once("error", onError);
          timer = setTimeout(() => {
            child.unref();
            finish(() => resolve({ ok: true }));
          }, 1_500);
          timer.unref?.();
        });
      }
      default:
        throw new Error(`unknown host_query kind: ${kind}`);
    }
  };
  return Promise.resolve()
    .then(run)
    .catch((err) => {
      throw err instanceof Error ? err : new Error(String(err));
    });
}
