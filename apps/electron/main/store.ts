/**
 * SQLite KV 存储（对齐 store.rs）：state.db 单连接（同步驱动，天然串行，
 * 对齐 rusqlite Mutex<Connection> 的写序语义）；kv 表 + 业务表 + webhook 表。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "./db";
import { dbPath, sessionsDir } from "./paths";
import { initTables } from "./data";
import { initTables as initWebhookTables } from "./webhook";
import { logError, logInfo } from "./logging";

let db: Db | null = null;

export function getDb(): Db {
  if (!db) throw new Error("db not initialized");
  return db;
}

/** 对齐 store::init：打开 WAL + busy_timeout，建 kv/业务/webhook 表，回填计数 */
export function initStore(): void {
  db = openDb(dbPath());
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  initTables(db);
  initWebhookTables(db);
  backfillMessageCounts(db);
  logInfo("[store] init ok");
}

function backfillMessageCounts(d: Db): void {
  const rows = d.prepare("SELECT id FROM sessions WHERE message_count IS NULL").all() as { id: string }[];
  for (const { id } of rows) {
    let count = 0;
    try {
      const content = readFileSync(join(sessionsDir(), `${id}.jsonl`), "utf8");
      count = content.split("\n").filter((line) => line.includes('"type":"message"')).length;
    } catch {
      count = 0; // 文件缺失 = 0（列表按 >0 过滤自然隐藏）
    }
    d.prepare("UPDATE sessions SET message_count = ?1 WHERE id = ?2 AND message_count IS NULL").run(count, id);
  }
}

/* ------------------------------ 命令与全局访问 ------------------------------ */

export function kvGet(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM kv WHERE key = ?1").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function kvSet(key: string, value: string): void {
  getDb()
    .prepare("INSERT INTO kv(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

export function kvDelete(key: string): void {
  getDb().prepare("DELETE FROM kv WHERE key = ?1").run(key);
}

export function setupStoreCommands(register: (name: string, fn: (args: any) => any) => void): void {
  register("kv_get", (a) => kvGet(String(a.key)));
  register("kv_set", (a) => {
    kvSet(String(a.key), String(a.value));
    return null;
  });
  register("kv_delete", (a) => {
    kvDelete(String(a.key));
    return null;
  });
}

export function storeInitSafe(): void {
  try {
    initStore();
  } catch (e) {
    logError(`[store] init failed: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

export { logError as storeLogError };
