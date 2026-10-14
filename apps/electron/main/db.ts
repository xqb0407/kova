/**
 * SQLite 驱动适配层（对齐 rusqlite 用法）：
 * 优先 node:sqlite（Electron ≥37 内建 Node ≥22），不可用时回退 better-sqlite3。
 * 上层（store/data/webhook/backup…）只依赖本文件的 Db 接口。
 */
export type Row = Record<string, unknown>;

export interface Stmt {
  all(...params: unknown[]): Row[];
  get(...params: unknown[]): Row | undefined;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number };
}

export interface Db {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}

type Ctor = new (file: string, opts?: Record<string, unknown>) => {
  prepare(sql: string): {
    all(...p: unknown[]): unknown[];
    get(...p: unknown[]): unknown;
    run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  };
  exec(sql: string): void;
  close(): void;
};

function openNative(file: string): Db | null {
  // 驱动 1：node:sqlite（node ≥ 22.5）
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("node:sqlite");
    const DB = mod.DatabaseSync as Ctor;
    const raw = new DB(file);
    return wrap(raw);
  } catch {
    /* fall through */
  }
  // 驱动 2：better-sqlite3（若安装）
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Better = require("better-sqlite3");
    const raw = new Better(file);
    return wrap(raw);
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrap(raw: any): Db {
  return {
    prepare(sql: string): Stmt {
      const st = raw.prepare(sql);
      return {
        all(...p: unknown[]): Row[] {
          return st.all(...p.map(castParam));
        },
        get(...p: unknown[]): Row | undefined {
          return st.get(...p.map(castParam)) ?? undefined;
        },
        run(...p: unknown[]) {
          const r = st.run(...p.map(castParam));
          return {
            changes: Number(r.changes ?? 0),
            lastInsertRowid: Number(r.lastInsertRowid ?? 0),
          };
        },
      };
    },
    exec(sql: string) {
      raw.exec(sql);
    },
    transaction<T>(fn: () => T): T {
      raw.exec("BEGIN");
      try {
        const out = fn();
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw e;
      }
    },
    close() {
      raw.close();
    },
  };
}

/** SQLite 参数仅支持 null/number/bigint/string/Uint8Array：布尔与 undefined 先转（对齐 rusqlite params! 用法） */
function castParam(v: unknown): unknown {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === undefined || v === null) return null;
  return v;
}

export function openDb(file: string): Db {
  const db = openNative(file);
  if (!db) throw new Error("no sqlite driver available (node:sqlite / better-sqlite3 both missing)");
  return db;
}
