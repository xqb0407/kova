/**
 * 数据访问层（双模式，统一 async 接口）：
 * - host 模式（生产）：业务表（pi_sessions/credentials/custom_providers/provider_models）
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

type QueryTransport = (kind: string, params: Record<string, unknown>) => Promise<unknown>;

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
  localDb.exec(`
    CREATE TABLE IF NOT EXISTS pi_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      first_message TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
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
  localDb.exec(`
    CREATE TABLE IF NOT EXISTS provider_models (
      provider TEXT PRIMARY KEY,
      models TEXT NOT NULL DEFAULT '[]'
    );
  `);
  // 旧数据迁移：早期版本把未选工作目录的会话 cwd 存成主目录，统一清空
  localDb.query("UPDATE pi_sessions SET cwd = '' WHERE cwd = ?").run(homedir());
  transport = localDispatch;
}

export const isLocalStorage = () => localDb !== null;

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

function stdoutRpc(kind: string, params: Record<string, unknown>): Promise<unknown> {
  const id = `hq-${++hostSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`host_query timeout: ${kind}（宿主未响应，Rust 侧需含 data.rs）`));
    }, HOST_QUERY_TIMEOUT_MS);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
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
          .query<{ cwd: string }, [string]>("SELECT cwd FROM pi_sessions WHERE id = ?")
          .get(s("sessionId"));
        return row ? { cwd: row.cwd } : null;
      }
      case "session_insert": {
        const now = s("now");
        db.query(
          "INSERT INTO pi_sessions (id, title, first_message, cwd, created_at, updated_at) VALUES (?, '', '', ?, ?, ?)",
        ).run(s("sessionId"), str(p.cwd), now, now);
        return {};
      }
      case "session_list":
        return db
          .query<
            { id: string; title: string; first_message: string; cwd: string; updated_at: string },
            []
          >("SELECT id, title, first_message, cwd, updated_at FROM pi_sessions ORDER BY updated_at DESC")
          .all();
      case "session_delete":
        db.query("DELETE FROM pi_sessions WHERE id = ?").run(s("sessionId"));
        return {};
      case "session_rename":
        db.query("UPDATE pi_sessions SET title = ? WHERE id = ?").run(s("name"), s("sessionId"));
        return {};
      case "session_touch":
        db.query(
          "UPDATE pi_sessions SET updated_at = ?, " +
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
      case "provider_models_all":
        return db.query<{ provider: string; models: string }, []>("SELECT provider, models FROM provider_models").all();
      case "provider_models_get": {
        const row = db
          .query<{ models: string }, [string]>("SELECT models FROM provider_models WHERE provider = ?")
          .get(s("provider"));
        return row ? { models: row.models } : null;
      }
      case "provider_models_set": {
        const models = s("models");
        // 空数组 = 清除过滤，恢复全部
        if (models === "[]") db.query("DELETE FROM provider_models WHERE provider = ?").run(s("provider"));
        else
          db.query(
            "INSERT INTO provider_models (provider, models) VALUES (?, ?) " +
              "ON CONFLICT(provider) DO UPDATE SET models = excluded.models",
          ).run(s("provider"), models);
        return {};
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

async function query<T>(kind: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!transport) throw new Error("storage not initialized (initHostTransport/initLocalStorage)");
  return (await transport(kind, params)) as T;
}

const nowIso = () => new Date().toISOString();

export type SessionRow = {
  id: string;
  title: string;
  first_message: string;
  cwd: string;
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
  query<{ cwd: string } | null>("session_get", { sessionId });

export const sessionInsert = (sessionId: string, cwd: string) =>
  query("session_insert", { sessionId, cwd, now: nowIso() });

export const sessionList = () => query<SessionRow[]>("session_list");

export const sessionDelete = (sessionId: string) => query("session_delete", { sessionId });

export const sessionRename = (sessionId: string, name: string) =>
  query("session_rename", { sessionId, name });

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

export const providerModelsAll = () =>
  query<{ provider: string; models: string }[]>("provider_models_all");

export const providerModelsGet = (provider: string) =>
  query<{ models: string } | null>("provider_models_get", { provider });

export const providerModelsSet = (provider: string, models: string) =>
  query("provider_models_set", { provider, models });

/** 主机工具调用（仅 host 模式可用；bash/read/write/edit 由 Rust 执行） */
export const hostToolCall = (name: string, cwd: string, params: Record<string, unknown>) =>
  query<{ output: string; truncated?: boolean; exitCode?: number | null; totalLines?: number }>("tool", {
    name,
    cwd,
    params,
  });
