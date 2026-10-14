/** Webhook 推送记录表（对齐 webhook.rs）：webhook_delivery 建表 + 4 命令。 */
import type { Db } from "./db";
import { getDb } from "./store";

export function initTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_delivery (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint    TEXT NOT NULL,
        event       TEXT NOT NULL,
        ok          INTEGER NOT NULL,
        detail      TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
    );`);
}

export function setupWebhookCommands(register: (name: string, fn: (args: any) => any) => void): void {
  register("webhook_delivery_add", (a) => {
    const r = getDb()
      .prepare(
        "INSERT INTO webhook_delivery(endpoint, event, ok, detail, duration_ms, created_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
      )
      .run(String(a.endpoint), String(a.event), a.ok ? 1 : 0, String(a.detail ?? ""), Math.trunc(Number(a.durationMs ?? 0)), Date.now());
    return r.lastInsertRowid;
  });
  register("webhook_delivery_list", (a) => {
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(a.limit ?? 20))));
    const rows = getDb()
      .prepare(
        "SELECT id, endpoint, event, ok, detail, duration_ms, created_at FROM webhook_delivery ORDER BY id DESC LIMIT ?1",
      )
      .all(limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      endpoint: r.endpoint,
      event: r.event,
      ok: Number(r.ok) !== 0,
      detail: r.detail,
      duration_ms: Number(r.duration_ms),
      durationMs: Number(r.duration_ms),
      created_at: Number(r.created_at),
      createdAt: Number(r.created_at),
    }));
  });
  register("webhook_delivery_delete", (a) => {
    const r = getDb().prepare("DELETE FROM webhook_delivery WHERE endpoint = ?1").run(String(a.endpoint));
    return r.changes;
  });
  register("webhook_delivery_prune", (a) => {
    const keep = Math.max(0, Math.trunc(Number(a.keep ?? 20)));
    const r = getDb()
      .prepare(
        "DELETE FROM webhook_delivery WHERE id NOT IN (SELECT id FROM webhook_delivery ORDER BY id DESC LIMIT ?1)",
      )
      .run(keep);
    return r.changes;
  });
}
