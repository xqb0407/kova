/**
 * 数据访问层（双模式，统一 async 接口）：
 * - host 模式（生产）：业务表（sessions/credentials/custom_providers/models）
 *   由 Rust 宿主持有（src-tauri/src/data.rs），本侧经 stdout 上的 host_query RPC 读写，
 *   宿主从 stdin 回写 host_result。
 * - local 模式（测试/冒烟）：直接用 bun:sqlite 打开本地库，SQL 与 data.rs 镜像。
 *
 * 双模式是为了 bun test 在无宿主环境可跑；生产路径上 Rust 是业务表唯一写入方，
 * 消除此前 bun:sqlite / rusqlite 双进程共写同一 state.db 的隐患。
 * 会话 JSONL 正文不在本层（transcript.ts 直写文件，所有权在 sidecar）。
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";

/* ---------------------------------- 模式管理 --------------------------------- */

/** RPC 附加选项：signal 中断时向宿主发 host_cancel；timeoutMs 覆盖默认 15s */
export type RpcOptions = { signal?: AbortSignal; timeoutMs?: number };

type QueryTransport = (
  kind: string,
  params: Record<string, unknown>,
  opts?: RpcOptions,
) => Promise<unknown>;

let transport: QueryTransport | null = null;
let localDb: Database | null = null;

/** 生产入口：走 stdout host_query RPC（index.ts 在读完 env 后调用） */
export function initHostTransport(): void {
  hostSeq = 0;
  transport = stdoutRpc;
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
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credentials (
      provider TEXT PRIMARY KEY,
      api_key TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS custom_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      models TEXT NOT NULL DEFAULT '[]',
      api TEXT NOT NULL DEFAULT 'openai-chat'
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
  // 旧库迁移：sessions 补 archived 列（已存在则忽略）
  try {
    localDb.exec("ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  } catch {
    /* 列已存在 */
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
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (provider, model_id)
    );
  `);
  // 旧数据迁移：早期版本把未选工作目录的会话 cwd 存成主目录，统一清空
  localDb.query("UPDATE sessions SET cwd = '' WHERE cwd = ?").run(homedir());
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
  transport = localDispatch;
}

export const isLocalStorage = () => localDb !== null;

/**
 * local 模式的旧数据迁移（与 Rust data.rs 的 migrate_custom_provider_models 镜像）：
 * custom_providers.models JSON 列 → models 行（enabled=1），搬完清空该列（幂等标记）。
 */
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
    enabled: r.enabled === 1,
  });
  if (provider !== undefined)
    return db
      .query<Row, [string]>(
        "SELECT provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, enabled \
         FROM models WHERE provider = ? ORDER BY model_id",
      )
      .all(provider)
      .map(toRow);
  return db
    .query<Row, []>(
      "SELECT provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, enabled \
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
  transport = null;
  for (const [, p] of pending) p.reject(new Error("storage reset"));
  pending.clear();
}

/* ------------------------------- host 模式 RPC ------------------------------- */

let hostSeq = 0;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

const HOST_QUERY_TIMEOUT_MS = 15_000;
/** 工具类 RPC 在「工具自身超时」之外再等的余量（宿主执行完还要序列化回写） */
const TOOL_RPC_SLACK_MS = 15_000;

function abortAsError(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  if (r instanceof Error) return r;
  return new Error("Operation aborted");
}

/** 告知宿主「放弃这条请求」：Rust 侧据此杀对应工具进程树；无登记则无害 no-op */
function writeHostCancel(id: string): void {
  try {
    process.stdout.write(JSON.stringify({ type: "host_cancel", id }) + "\n");
  } catch {
    // 管道破裂说明宿主已退出，无需再取消
  }
}

function stdoutRpc(
  kind: string,
  params: Record<string, unknown>,
  opts: RpcOptions = {},
): Promise<unknown> {
  const id = `hq-${++hostSeq}`;
  const { signal, timeoutMs = HOST_QUERY_TIMEOUT_MS } = opts;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortAsError(signal));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      pending.delete(id);
      writeHostCancel(id); // bash 等仍在宿主里跑：立即通知杀进程树
      // onAbort 只在 signal 存在时才被注册
      settle(() => reject(abortAsError(signal!)));
    };
    const fail = (fn: () => void) => {
      pending.delete(id);
      writeHostCancel(id); // 超时同样取消，避免宿主在「JS 已报错」后才跑完
      settle(fn);
    };
    timer = setTimeout(
      () =>
        fail(() =>
          reject(
            new Error(`host_query timeout: ${kind}（宿主未响应，Rust 侧需含 data.rs）`),
          ),
        ),
      timeoutMs,
    );
    pending.set(id, {
      resolve: (v) => settle(() => resolve(v)),
      reject: (e) => settle(() => reject(e)),
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    process.stdout.write(JSON.stringify({ type: "host_query", id, kind, params }) + "\n");
  });
}

/** stdin 循环解析出 host_result 行后调用（index.ts 接线） */
export function resolveHostResult(msg: Record<string, unknown>): boolean {
  if (msg?.type !== "host_result") return false;
  const id = typeof msg.id === "string" ? msg.id : "";
  const waiter = pending.get(id);
  if (!waiter) return true; // 无匹配（超时已清理）：吞掉
  pending.delete(id);
  if (msg.ok === true) waiter.resolve(msg.data);
  else waiter.reject(new Error(String(msg.error ?? "host_query failed")));
  return true;
}

/* ------------------------------ local 模式实现 ------------------------------ */

/** 与 Rust data.rs 镜像的本地查询（bun:sqlite；仅测试/冒烟路径） */
function localDispatch(kind: string, p: Record<string, unknown>): Promise<unknown> {
  const db = localDb;
  if (!db) return Promise.reject(new Error("local storage not initialized"));
  const s = (key: string): string => {
    const v = p[key];
    if (typeof v !== "string") throw new Error(`missing param: ${key}`);
    return v;
  };
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const run = (): unknown => {
    switch (kind) {
      case "session_get": {
        const row = db
          .query<{ cwd: string; title: string }, [string]>(
            "SELECT cwd, title FROM sessions WHERE id = ?",
          )
          .get(s("sessionId"));
        return row ? { cwd: row.cwd, title: row.title } : null;
      }
      case "session_insert": {
        const now = s("now");
        db.query(
          "INSERT INTO sessions (id, title, first_message, cwd, created_at, updated_at) VALUES (?, '', '', ?, ?, ?)",
        ).run(s("sessionId"), str(p.cwd), now, now);
        return {};
      }
      case "session_list":
        return db
          .query<
            { id: string; title: string; first_message: string; cwd: string; archived: number; updated_at: string },
            []
          >("SELECT id, title, first_message, cwd, archived, updated_at FROM sessions ORDER BY updated_at DESC")
          .all();
      case "session_delete":
        db.query("DELETE FROM sessions WHERE id = ?").run(s("sessionId"));
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
            "first_message = CASE WHEN first_message = '' THEN ? ELSE first_message END " +
            "WHERE id = ?",
        ).run(s("now"), str(p.title), str(p.firstMessage), s("sessionId"));
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
      case "custom_providers_list":
        return db
          .query<
            { id: string; name: string; base_url: string; models: string; api: string; enabled: number },
            []
          >("SELECT id, name, base_url, models, api, enabled FROM custom_providers")
          .all()
          .map((r) => ({
            id: r.id,
            name: r.name,
            baseUrl: r.base_url,
            models: r.models,
            api: r.api,
            enabled: r.enabled === 1,
          }));
      case "custom_provider_get": {
        const row = db
          .query<
            { id: string; name: string; base_url: string; models: string; api: string; enabled: number },
            [string]
          >("SELECT id, name, base_url, models, api, enabled FROM custom_providers WHERE id = ?")
          .get(s("id"));
        return row
          ? {
              id: row.id,
              name: row.name,
              baseUrl: row.base_url,
              models: row.models,
              api: row.api,
              enabled: row.enabled === 1,
            }
          : null;
      }
      case "custom_provider_upsert":
        db.query(
          "INSERT INTO custom_providers (id, name, base_url, models, api) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url, " +
            "models = excluded.models, api = excluded.api",
        ).run(s("id"), s("name"), s("baseUrl"), s("models"), s("api"));
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
            db.query(
              "INSERT OR REPLACE INTO models \
               (provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, enabled) \
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ).run(
              provider,
              modelId,
              typeof item.name === "string" ? item.name : null,
              typeof item.reasoning === "boolean" ? (item.reasoning ? 1 : 0) : null,
              typeof item.contextWindow === "number" ? Math.trunc(item.contextWindow) : null,
              typeof item.maxTokens === "number" ? Math.trunc(item.maxTokens) : null,
              input,
              cost,
              item.enabled === false ? 0 : 1,
            );
          }
        });
        tx();
        return {};
      }
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

/* -------------------------------- 类型化出口 -------------------------------- */

async function query<T>(
  kind: string,
  params: Record<string, unknown> = {},
  opts?: RpcOptions,
): Promise<T> {
  if (!transport) throw new Error("storage not initialized (initHostTransport/initLocalStorage)");
  return (await transport(kind, params, opts)) as T;
}

const nowIso = () => new Date().toISOString();

export type SessionRow = {
  id: string;
  title: string;
  first_message: string;
  cwd: string;
  archived: number;
  updated_at: string;
};

export type CustomProviderRow = {
  id: string;
  name: string;
  baseUrl: string;
  /** JSON 字符串（CustomModelSpec[]） */
  models: string;
  api: string;
  enabled: boolean;
};

export const sessionGet = (sessionId: string) =>
  query<{ cwd: string; title: string } | null>("session_get", { sessionId });

export const sessionInsert = (sessionId: string, cwd: string) =>
  query("session_insert", { sessionId, cwd, now: nowIso() });

/** 补写会话绑定目录（建会话时未选目录、后来选了：见 sessions.ts rebindRunCwd） */
export const sessionUpdateCwd = (sessionId: string, cwd: string) =>
  query("session_update_cwd", { sessionId, cwd });

export const sessionList = () => query<SessionRow[]>("session_list");

export const sessionDelete = (sessionId: string) => query("session_delete", { sessionId });

export const sessionRename = (sessionId: string, name: string) =>
  query("session_rename", { sessionId, name });

/** 归档 / 取消归档：列表默认隐藏归档会话，正文不动 */
export const sessionSetArchived = (sessionId: string, archived: boolean) =>
  query("session_set_archived", { sessionId, archived });

export const sessionTouch = (sessionId: string, title: string, firstMessage: string) =>
  query("session_touch", { sessionId, now: nowIso(), title, firstMessage });

export const credentialGet = (provider: string) =>
  query<{ apiKey: string } | null>("credential_get", { provider });

export const credentialList = () => query<string[]>("credential_list");

export const credentialSet = (provider: string, apiKey: string) =>
  query("credential_set", { provider, apiKey, now: nowIso() });

export const credentialDelete = (provider: string) => query("credential_delete", { provider });

export const customProvidersList = () => query<CustomProviderRow[]>("custom_providers_list");

export const customProviderGet = (id: string) =>
  query<CustomProviderRow | null>("custom_provider_get", { id });

export const customProviderUpsert = (row: {
  id: string;
  name: string;
  baseUrl: string;
  models: string;
  api: string;
}) => query("custom_provider_upsert", { ...row });

export const customProviderDelete = (id: string) => query("custom_provider_delete", { id });

export const customProviderSetEnabled = (id: string, enabled: boolean) =>
  query("custom_provider_set_enabled", { id, enabled });

/* ------------------------------ models（统一模型目录） ------------------------------ */

/** models 行（Rust models_query 返回结构；NULL attrs = 继承内置值） */
export type ModelRow = {
  provider: string;
  modelId: string;
  name: string | null;
  reasoning: boolean | null;
  contextWindow: number | null;
  maxTokens: number | null;
  /** 结构化 JSON（数组），NULL = 未覆盖 */
  input: unknown[] | null;
  /** 结构化 JSON（对象），NULL = 未覆盖 */
  cost: Record<string, unknown> | null;
  enabled: boolean;
};

export const modelsAll = () => query<ModelRow[]>("models_all");

export const modelsList = (provider: string) =>
  query<ModelRow[]>("models_list", { provider });

/** 整包替换该 provider 的模型行（items 见 ModelReplaceItem；attrs 缺省 = NULL） */
export type ModelReplaceItem = {
  modelId: string;
  enabled?: boolean;
  name?: string | null;
  reasoning?: boolean | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  input?: unknown[] | null;
  cost?: Record<string, unknown> | null;
};

export const modelsReplace = (provider: string, items: ModelReplaceItem[]) =>
  query("models_replace", { provider, models: JSON.stringify(items) });

export const modelsDeleteProvider = (provider: string) =>
  query("models_delete_provider", { provider });

/* ------------------------------ kv（应用级设置） ------------------------------ */

/** 应用级 kv 读取（生产 = Rust 的 state.db kv 表；value 为 JSON 字符串），无值返回 null */
export const kvGet = (key: string) => query<{ value: string } | null>("kv_get", { key });

/** 应用级 kv 写入（Rust 是唯一写入方；本侧经 host_query RPC 落库） */
export const kvSet = (key: string, value: string) => query("kv_set", { key, value });

/* ---------------------- usage（使用统计物化表） ---------------------- */

/** usage_scan 行（每会话扫描水位：JSONL mtime + 首末消息时间戳） */
export type UsageScanRow = {
  sessionId: string;
  mtime: number;
  firstTs: number;
  lastTs: number;
};

/** usage_daily 行（会话 × 本地日聚合；byModel 为 JSON 字符串） */
export type UsageDailyRow = {
  sessionId: string;
  date: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tokens: number;
  messages: number;
  byModel: string;
};

export type UsageDailyRowInput = {
  date: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tokens: number;
  messages: number;
  /** JSON 字符串：{ "provider/model": tokens } */
  byModel: string;
};

export const usageScanList = () => query<UsageScanRow[]>("usage_scan_list");

/** 整会话替换聚合行（幂等：先删后插 + upsert 扫描水位） */
export const usageDailyReplace = (
  sessionId: string,
  rows: UsageDailyRowInput[],
  mtime: number,
  firstTs: number,
  lastTs: number,
) =>
  query("usage_daily_replace", {
    sessionId,
    rows: JSON.stringify(rows),
    mtime,
    firstTs,
    lastTs,
  });

export const usageDailyQuery = () => query<UsageDailyRow[]>("usage_daily_query");

/** 清除已删会话的聚合行与扫描水位，返回清理的聚合行数 */
export const usageDailyCleanup = () =>
  query<{ removed: number }>("usage_daily_cleanup");

/** 工具类 RPC 的超时 = 工具自身超时 + 余量：bash 默认 120s、http 默认 30s（上限 120s），
 *  不能让它们在宿主还在正常执行时先吃 15s 的通用超时 */
function toolRpcTimeoutMs(name: string, params: Record<string, unknown>): number {
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
  if (name === "bash") return (num(params.timeout) ?? 120_000) + TOOL_RPC_SLACK_MS;
  if (name === "http") return (num(params.timeoutMs) ?? 30_000) + TOOL_RPC_SLACK_MS;
  return HOST_QUERY_TIMEOUT_MS; // read/write/edit 是本地文件操作
}

/** 主机工具调用（仅 host 模式可用；bash/read/write/edit/http 由 Rust 执行）；
 *  signal 中断时向宿主发 host_cancel（bash 会立即杀进程树） */
export const hostToolCall = (
  name: string,
  cwd: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) =>
  query<{ output: string; truncated?: boolean; exitCode?: number | null; totalLines?: number }>(
    "tool",
    { name, cwd, params },
    { signal, timeoutMs: toolRpcTimeoutMs(name, params) },
  );

/** Rust handle_http（tool_exec.rs）的返回结构 */
export type HostHttpData = {
  /** 文本类响应 = utf-8 正文；二进制 = base64（见 encoding） */
  output: string;
  status: number;
  statusText: string;
  ok: boolean;
  /** 跟随重定向后的最终 URL */
  url: string;
  contentType: string;
  headers: Record<string, string>;
  totalBytes: number;
  truncated: boolean;
  encoding: "utf-8" | "base64";
};

/** WebFetch/WebSearch 的网络执行出口（仅 host 模式；超时/截断/编码在 Rust 侧完成） */
export const hostHttpCall = (
  cwd: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) =>
  query<HostHttpData>("tool", { name: "http", cwd, params }, {
    signal,
    timeoutMs: toolRpcTimeoutMs("http", params),
  });
