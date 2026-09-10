/**
 * 存储：SQLite（会话索引 + 凭据 + 自定义提供商 + 模型过滤）与会话 JSONL 目录。
 * 通过 initStorage 显式初始化：入口用 env 路径调用，测试用临时目录调用，
 * 避免模块 import 时产生隐藏副作用。
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type {
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

/** SQLite 连接（initStorage 之后可用） */
export let db: Database;
/** 凭据存储（喂给 pi-ai 的 CredentialStore 实现） */
export let credentialStore: CredentialStore;

let sessionsDirPath = "";

/** 会话 JSONL 文件路径 */
export function sessionPath(id: string): string {
  return path.join(sessionsDirPath, `${id}.jsonl`);
}

/** 初始化存储：建目录、打开 DB、建表与旧库迁移（重复调用会重开连接，测试可各自初始化） */
export function initStorage(dbPath: string, sessionsDir: string): void {
  sessionsDirPath = sessionsDir;
  mkdirSync(sessionsDir, { recursive: true });
  db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`
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
  // 旧库迁移：补 api 列（接口格式）
  try {
    db.exec(
      "ALTER TABLE custom_providers ADD COLUMN api TEXT NOT NULL DEFAULT 'openai-chat'",
    );
  } catch {
    // 列已存在
  }
  // 旧库迁移：补 enabled 列（服务启停开关）
  try {
    db.exec(
      "ALTER TABLE custom_providers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1",
    );
  } catch {
    // 列已存在
  }
  // 内置厂商的模型过滤（勾选哪些模型可被前端看到；空/缺省 = 全部）
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_models (
      provider TEXT PRIMARY KEY,
      models TEXT NOT NULL DEFAULT '[]'
    );
  `);

  // 旧数据迁移：早期版本把未选工作目录的会话 cwd 存成用户主目录；统一清空。
  // 侧边栏按"有无 cwd"区分项目/任务会话（用户恰好选了主目录当工作目录的情况会被
  // 误归为任务，概率可忽略）
  db.query("UPDATE pi_sessions SET cwd = '' WHERE cwd = ?").run(homedir());

  credentialStore = {
    async read(providerId: string): Promise<Credential | undefined> {
      const row = db
        .query<{ api_key: string }, [string]>(
          "SELECT api_key FROM credentials WHERE provider = ?",
        )
        .get(providerId);
      return row ? { type: "api_key", key: row.api_key } : undefined;
    },
    async list(): Promise<readonly CredentialInfo[]> {
      const rows = db
        .query<{ provider: string }, []>("SELECT provider FROM credentials")
        .all();
      return rows.map((r) => ({
        providerId: r.provider,
        type: "api_key" as const,
      }));
    },
    async modify(
      providerId: string,
      fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    ): Promise<Credential | undefined> {
      const current = await this.read(providerId);
      const next = await fn(current);
      if (next?.type === "api_key" && next.key) {
        db.query(
          "INSERT INTO credentials (provider, api_key, updated_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(provider) DO UPDATE SET api_key = excluded.api_key, updated_at = excluded.updated_at",
        ).run(providerId, next.key, new Date().toISOString());
      }
      return next;
    },
    async delete(providerId: string): Promise<void> {
      db.query("DELETE FROM credentials WHERE provider = ?").run(providerId);
    },
  };
}
