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
import { isMirroredKvKey } from "./credential-mirror-keys";
import { scheduleCredentialFileSync } from "./credential-file-sync";
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
  backupBeforeProjectMigration(db);
  initTables(db);
  initWebhookTables(db);
  backfillMessageCounts(db);
  // 注意：共享凭据文件镜像（~/.kova/credentials.json）不在这里同步——
  // 此时主密钥尚未初始化（initSecretCipher 在 app.whenReady 后），decrypt
  // 会全部失败，把好镜像覆盖成空凭据。启动同步在 index.ts 的密钥就绪后做。
  logInfo("[store] init ok");
}

/**
 * 项目实体迁移前的整库快照：只在 marker 不存在且确实有旧项目/会话数据时做一次。
 * 用 VACUUM INTO 拿一致副本（WAL 下直接 copy 文件可能缺最新页）。
 */
function backupBeforeProjectMigration(d: Db): void {
  try {
    const migrated = d
      .prepare("SELECT value FROM kv WHERE key='pi.projects.migrated.v1'")
      .get();
    if (migrated) return;
    const hasLegacy = d
      .prepare("SELECT value FROM kv WHERE key='pi.projectDirs'")
      .get();
    // 全新库此时 sessions 还没建（initTables 尚未执行）：不能当成备份失败
    const hasSessionsTable = d
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'")
      .get();
    const sessions = hasSessionsTable
      ? (d.prepare("SELECT count(*) AS n FROM sessions").get() as
          | { n: number }
          | undefined)
      : undefined;
    if (!hasLegacy && Number(sessions?.n ?? 0) === 0) return;
    const target = `${dbPath()}.bak-${Date.now()}`;
    d.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    logInfo(`[store] 项目迁移前备份：${target}`);
  } catch (err) {
    // 备份失败不阻断启动；迁移仍是事务性的，旧 kv 也会保留。
    logError(`[store] 项目迁移前备份失败：${String(err)}`);
  }
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
    const key = String(a.key);
    kvSet(key, String(a.value));
    // 默认模型/发现缓存进共享镜像（sidecar/ACP 读它们）；其余 kv 与镜像无关
    if (isMirroredKvKey(key)) scheduleCredentialFileSync(getDb());
    // 工作区切换：文件触发器的 watch 根跟着走（动态 import 防 store↔watcher 环）
    if (key === "workspace") {
      void import("./trigger-watchers")
        .then((m) => m.setTriggerWorkspace(String(a.value) || null))
        .catch(() => {});
    }
    return null;
  });
  register("kv_delete", (a) => {
    const key = String(a.key);
    kvDelete(key);
    // 清空默认模型也要传播：镜像里 currentModel 缺省 = sidecar 不改现状
    if (isMirroredKvKey(key)) scheduleCredentialFileSync(getDb());
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
